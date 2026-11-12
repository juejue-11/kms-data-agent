// 前端 Markdown 渲染器：marked 词法分析 -> DOM 节点。
//
// 实现方式参考 OpenAI Codex 的 markdown_render（codex-rs/tui/src/markdown_render.rs）：
// 1. 解析与渲染分离：marked 只负责产出 token 流，本模块逐块、逐行内 token 生成 DOM；
// 2. 不拼接 HTML 字符串，因此不存在 HTML 注入面；原始 HTML 按纯文本原样显示；
// 3. 链接与图片统一走协议白名单，危险协议降级为纯文本；
// 4. ```md / ```markdown 围栏中的表格拆掉围栏，交给 marked 按原生表格解析。

const ALLOWED_URL_SCHEMES = /^(https?|mailto|tel|ftp)$/i;
const FENCE_OPEN_REGEX = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})\s*$/;
const TABLE_DELIMITER_CELL_REGEX = /^:?-+:?$/;
const EVIDENCE_CITATION_REGEX = /\[E:(ev_[A-Za-z0-9_-]+)\]/g;
const HTML_TABLE_REGEX = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;
const CSV_RECORD_SEPARATOR_REGEX = /\s*——\s*Data\s*/i;
let citationIndex = 0;

/**
 * 清洗链接地址：去掉控制字符，只放行常见安全协议；相对路径与锚点保持原样。
 * 返回 null 表示该地址不可用，调用方应降级为纯文本。
 */
function sanitizeUrl(value) {
	const href = String(value || "")
		.trim()
		.replace(/[\u0000-\u001f\u007f]/g, "");
	if (!href) return href;

	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
	if (scheme && !ALLOWED_URL_SCHEMES.test(scheme[1])) return null;
	return href;
}

function isTableDelimiterRow(line) {
	const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_CELL_REGEX.test(cell.trim()));
}

// 表格围栏的判定保持保守：只有表头行紧跟着分隔行时才拆围栏，
// 普通 markdown 代码块仍按代码显示。
function containsTable(lines) {
	for (let i = 1; i < lines.length; i++) {
		if (lines[i - 1].includes("|") && isTableDelimiterRow(lines[i])) return true;
	}
	return false;
}

function isMarkdownFence(info) {
	const language = info.split(/\s+/)[0].toLowerCase();
	return language === "md" || language === "markdown";
}

function parseFenceOpen(line) {
	const match = FENCE_OPEN_REGEX.exec(line);
	if (!match) return null;

	return {
		marker: match[2][0],
		length: match[2].length,
		info: match[3].trim(),
		opening: line,
	};
}

function isFenceClose(line, fence) {
	const match = FENCE_CLOSE_REGEX.exec(line);
	return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

/**
 * 拆掉包裹表格的 ```md / ```markdown 围栏，让 marked 按表格渲染。
 * 非 markdown 围栏、不含表格的围栏、未闭合围栏都原样保留，退化为代码块。
 */
function normalizeMarkdown(source) {
	if (!source.includes("```") && !source.includes("~~~")) return source;

	const lines = source.split("\n");
	const output = [];
	let fence = null;

	for (const line of lines) {
		if (fence) {
			if (!isFenceClose(line, fence)) {
				fence.body.push(line);
				continue;
			}

			if (isMarkdownFence(fence.info) && containsTable(fence.body)) {
				output.push(...fence.body);
			} else {
				output.push(fence.opening, ...fence.body, line);
			}
			fence = null;
			continue;
		}

		const opening = parseFenceOpen(line);
		if (opening) {
			fence = { ...opening, body: [] };
		} else {
			output.push(line);
		}
	}

	// 未闭合围栏按代码块保留，避免流式输出中途丢内容。
	if (fence) output.push(fence.opening, ...fence.body);
	return output.join("\n");
}

function normalizeEvidenceTables(source) {
	if (!HTML_TABLE_REGEX.test(source) || typeof DOMParser !== "function") return source;
	HTML_TABLE_REGEX.lastIndex = 0;
	return source.replace(HTML_TABLE_REGEX, (markup) => {
		const table = new DOMParser().parseFromString(markup, "text/html").querySelector("table");
		if (!table) return markup;
		const rows = [...table.querySelectorAll("tr")]
			.map((row) =>
				[...row.querySelectorAll("th, td")].map((cell) =>
					escapeTableCell(
						String(cell.textContent || "")
							.replace(/\s+/g, " ")
							.trim(),
					),
				),
			)
			.filter((row) => row.length > 0);
		if (rows.length === 0) return "";
		return `\n\n${formatMarkdownTable(rows)}\n\n`;
	});
}

function escapeTableCell(value) {
	return value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/([|*_`[\]()~])/g, "\\$1");
}

function formatMarkdownTable(rows) {
	const width = Math.max(...rows.map((row) => row.length));
	const formatRow = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
	return `${formatRow(rows[0])}\n${formatRow(Array(width).fill("---"))}${rows
		.slice(1)
		.map((row) => `\n${formatRow(row)}`)
		.join("")}`;
}

function parseKeyValueRecords(source) {
	const records = source
		.replace(/^\uFEFF/, "")
		.split(CSV_RECORD_SEPARATOR_REGEX)
		.map((record) => record.replace(/^\s*Data\s+/i, "").trim())
		.filter(Boolean);
	const keys = [];
	const parsed = [];
	for (const record of records) {
		const fields = record.split(/[;；]\s*/).map((field) => {
			const separator = field.search(/[:：]/);
			if (separator < 1) return null;
			const key = field
				.slice(0, separator)
				.replace(/^\s*Data\s+/i, "")
				.trim();
			const value = field.slice(separator + 1).trim();
			if (!key) return null;
			if (!keys.includes(key)) keys.push(key);
			return { key, value };
		});
		if (fields.some((field) => field === null)) return null;
		parsed.push(Object.fromEntries(fields.map((field) => [field.key, escapeTableCell(field.value)])));
	}
	return keys.length > 1 ? [keys, parsed.map((record) => keys.map((key) => record[key] || ""))] : null;
}

function parseCsvRows(source) {
	const rows = [];
	let row = [];
	let value = "";
	let quoted = false;
	const text = source.replace(/^\uFEFF/, "");
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				value += '"';
				index += 1;
			} else if (character === '"') quoted = false;
			else value += character;
		} else if (character === '"' && value.length === 0) quoted = true;
		else if (character === ",") {
			row.push(value.trim());
			value = "";
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && text[index + 1] === "\n") index += 1;
			row.push(value.trim());
			if (row.some(Boolean)) rows.push(row);
			row = [];
			value = "";
		} else value += character;
	}
	if (quoted) return null;
	row.push(value.trim());
	if (row.some(Boolean)) rows.push(row);
	const width = rows[0]?.length || 0;
	return rows.length > 1 && width > 1 && rows.every((item) => item.length === width)
		? rows.map((item) => item.map(escapeTableCell))
		: null;
}

function normalizeEvidenceCsv(source) {
	const keyValueRows = parseKeyValueRecords(source);
	if (keyValueRows)
		return `\n\n${formatMarkdownTable([keyValueRows[0].map(escapeTableCell), ...keyValueRows[1]])}\n\n`;
	const csvRows = parseCsvRows(source);
	return csvRows ? `\n\n${formatMarkdownTable(csvRows)}\n\n` : source;
}

function normalizeEvidenceText(source) {
	return source
		.split(/\r?\n/)
		.map((line) => {
			const fields = line
				.split(/\s+\|\s+/)
				.map((field) => field.trim())
				.filter(Boolean);
			if (fields.length < 4) return line;
			const groups = [];
			let group = { marker: "", fields: [] };
			for (const field of fields) {
				if (/^[★☆]{1,3}$/.test(field)) {
					if (group.fields.length) groups.push(group);
					group = { marker: field, fields: [] };
				} else group.fields.push(field);
			}
			if (group.fields.length) groups.push(group);
			return groups
				.map(({ marker, fields: groupFields }, groupIndex) => {
					const title = groupFields.shift();
					if (!title) return "";
					const headingParts = [title];
					if (marker && groupFields.length) headingParts.push(groupFields.shift());
					const heading = marker
						? `### ${marker} ${headingParts[0]}${headingParts[1] ? ` · ${headingParts[1]}` : ""}`
						: `### ${headingParts[0]}`;
					const entries = [heading];
					for (const field of groupFields) {
						if (/目视|十倍镜|AOI|显微镜|检验方式|检查方法/.test(field)) {
							entries.push(`**检查方法：** ${field}`);
							continue;
						}
						const matches = [...field.matchAll(/(?:^|\s)(\d+)\.(?!\d)\s*/g)];
						if (matches.length) {
							const prefix = field.slice(0, matches[0]?.index ?? 0).trim();
							if (prefix) entries.push(`**控制要求：** ${prefix}`);
							entries.push(
								...matches.map((match, index) => {
									const start = (match.index || 0) + match[0].length;
									const end = matches[index + 1]?.index ?? field.length;
									return `${match[1]}. ${field.slice(start, end).trim()}`;
								}),
							);
							continue;
						}
						entries.push(groupIndex === 0 && !marker ? `**适用条件：** ${field}` : `- ${field}`);
					}
					return entries.join("\n");
				})
				.filter(Boolean)
				.join("\n\n");
		})
		.join("\n");
}

function renderEvidenceCode(source, language) {
	return renderCodeBlock({ lang: language, text: source });
}

function appendInline(parent, tokens, options = {}) {
	for (const token of tokens || []) appendInlineToken(parent, token, options);
}

function appendCitationText(parent, text) {
	const value = String(text || "");
	let cursor = 0;
	for (const match of value.matchAll(EVIDENCE_CITATION_REGEX)) {
		const index = match.index ?? 0;
		if (index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, index)));
		const button = document.createElement("button");
		button.type = "button";
		button.className = "citation-link";
		button.dataset.evidenceId = match[1];
		button.dataset.previewEvidence = "true";
		const number = ++citationIndex;
		button.title = `引用材料 ${number}：${match[1]}`;
		button.setAttribute("aria-label", `预览引用材料 ${number}（${match[1]}）`);
		button.textContent = String(number);
		parent.appendChild(button);
		cursor = index + match[0].length;
	}
	if (cursor === 0) parent.appendChild(document.createTextNode(value));
	else if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

function appendInlineToken(parent, token, options = {}) {
	switch (token.type) {
		case "text":
			if (token.tokens?.length) appendInline(parent, token.tokens, options);
			else if (options.citations === false) parent.appendChild(document.createTextNode(token.text || ""));
			else appendCitationText(parent, token.text || "");
			break;

		case "escape":
			if (options.citations === false) parent.appendChild(document.createTextNode(token.text || ""));
			else appendCitationText(parent, token.text || "");
			break;

		case "strong": {
			const strong = document.createElement("strong");
			appendInline(strong, token.tokens, options);
			parent.appendChild(strong);
			break;
		}

		case "em": {
			const em = document.createElement("em");
			appendInline(em, token.tokens, options);
			parent.appendChild(em);
			break;
		}

		case "del": {
			const del = document.createElement("del");
			appendInline(del, token.tokens, options);
			parent.appendChild(del);
			break;
		}

		case "codespan": {
			const code = document.createElement("code");
			code.textContent = token.text || "";
			parent.appendChild(code);
			break;
		}

		case "link": {
			const href = sanitizeUrl(token.href);
			if (href === null) {
				appendInline(parent, token.tokens);
				break;
			}

			const link = document.createElement("a");
			link.href = href;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			if (token.title) link.title = token.title;
			if (token.tokens?.length) appendInline(link, token.tokens, { citations: false });
			else link.textContent = token.text || href;
			parent.appendChild(link);
			break;
		}

		case "image": {
			const src = sanitizeUrl(token.href);
			if (src === null) {
				parent.appendChild(document.createTextNode(token.text || ""));
				break;
			}

			const image = document.createElement("img");
			image.src = src;
			image.alt = token.text || "";
			image.loading = "lazy";
			if (token.title) image.title = token.title;
			parent.appendChild(image);
			break;
		}

		case "br":
			parent.appendChild(document.createElement("br"));
			break;

		case "html":
			parent.appendChild(document.createTextNode(token.raw || token.text || ""));
			break;

		default:
			if (token.tokens?.length) appendInline(parent, token.tokens, options);
			else if (typeof token.text === "string") {
				if (options.citations === false) parent.appendChild(document.createTextNode(token.text));
				else appendCitationText(parent, token.text);
			}
	}
}

function renderList(token) {
	const list = document.createElement(token.ordered ? "ol" : "ul");
	if (token.ordered && typeof token.start === "number" && token.start !== 1) list.start = token.start;

	for (const item of token.items) {
		const listItem = document.createElement("li");

		if (item.task) {
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.disabled = true;
			checkbox.checked = Boolean(item.checked);
			listItem.appendChild(checkbox);
		}

		for (const child of item.tokens || []) {
			if (child.type === "text" || child.type === "paragraph") {
				appendInline(listItem, child.tokens?.length ? child.tokens : [child]);
			} else if (child.type === "list") {
				listItem.appendChild(renderList(child));
			} else {
				appendBlock(listItem, child);
			}
		}

		list.appendChild(listItem);
	}

	return list;
}

function renderTable(token) {
	const table = document.createElement("table");
	const head = document.createElement("thead");
	const headRow = document.createElement("tr");

	token.header.forEach((cell, index) => {
		const th = document.createElement("th");
		applyTableAlignment(th, token.align[index]);
		appendInline(th, cell.tokens);
		headRow.appendChild(th);
	});
	head.appendChild(headRow);
	table.appendChild(head);

	const body = document.createElement("tbody");
	for (const row of token.rows) {
		const tr = document.createElement("tr");
		row.forEach((cell, index) => {
			const td = document.createElement("td");
			applyTableAlignment(td, token.align[index]);
			appendInline(td, cell.tokens);
			tr.appendChild(td);
		});
		body.appendChild(tr);
	}
	table.appendChild(body);
	return table;
}

function applyTableAlignment(cell, alignment) {
	if (alignment === "center" || alignment === "right") cell.style.textAlign = alignment;
}

function renderCodeBlock(token) {
	const wrapper = document.createElement("div");
	wrapper.className = "md-code";

	const language = (token.lang || "").split(/\s+/)[0];
	if (language) {
		const label = document.createElement("div");
		label.className = "md-code-lang";
		label.textContent = language;
		wrapper.appendChild(label);
	}

	const pre = document.createElement("pre");
	const code = document.createElement("code");
	code.textContent = token.text || "";
	pre.appendChild(code);
	wrapper.appendChild(pre);
	return wrapper;
}

function appendBlock(parent, token) {
	switch (token.type) {
		case "heading": {
			const heading = document.createElement(`h${Math.min(Math.max(token.depth, 1), 6)}`);
			appendInline(heading, token.tokens);
			parent.appendChild(heading);
			break;
		}

		case "paragraph": {
			const paragraph = document.createElement("p");
			appendInline(paragraph, token.tokens);
			parent.appendChild(paragraph);
			break;
		}

		case "text": {
			const paragraph = document.createElement("p");
			appendInline(paragraph, token.tokens?.length ? token.tokens : [token]);
			parent.appendChild(paragraph);
			break;
		}

		case "code":
			parent.appendChild(renderCodeBlock(token));
			break;

		case "blockquote": {
			const quote = document.createElement("blockquote");
			for (const child of token.tokens || []) appendBlock(quote, child);
			parent.appendChild(quote);
			break;
		}

		case "list":
			parent.appendChild(renderList(token));
			break;

		case "table":
			parent.appendChild(renderTable(token));
			break;

		case "hr":
			parent.appendChild(document.createElement("hr"));
			break;

		case "html": {
			const paragraph = document.createElement("p");
			paragraph.textContent = (token.raw || token.text || "").trim();
			parent.appendChild(paragraph);
			break;
		}

		// space 只表示块间空行，间距交给 CSS 控制。
		case "space":
			break;

		default:
			appendInline(parent, token.tokens?.length ? token.tokens : [token]);
	}
}

/**
 * 将 Markdown 文本渲染为 DOM 节点。
 * 返回容器而非 HTML 字符串，调用方直接 append 即可。
 */
function renderMarkdown(source) {
	const container = document.createElement("div");
	container.className = "md-body";
	citationIndex = 0;

	const text = String(source || "");
	if (!window.marked) {
		container.textContent = text;
		return container;
	}

	for (const token of window.marked.lexer(normalizeMarkdown(text))) appendBlock(container, token);
	return container;
}

if (window.marked) {
	window.marked.use({
		gfm: true,
		breaks: false,
		tokenizer: {
			// 与 Codex 一致：原始 HTML 不当标签执行，按纯文本显示。
			html() {
				return undefined;
			},
			tag() {
				return undefined;
			},
		},
	});
}

window.renderMarkdown = renderMarkdown;
window.renderEvidenceMarkdown = (source, title = "") => {
	const text = String(source || "");
	const fileName = String(title).split(/[?#]/, 1)[0].split(/[\\/]/).pop() || "";
	const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() || "";
	if (extension === "json") {
		try {
			return renderEvidenceCode(JSON.stringify(JSON.parse(text), null, 2), "json");
		} catch {
			return renderMarkdown(normalizeEvidenceTables(text));
		}
	}
	if (["xml", "yaml", "yml", "log"].includes(extension)) return renderEvidenceCode(text, extension);
	const normalized =
		extension === "csv"
			? normalizeEvidenceCsv(text)
			: extension === "txt"
				? normalizeEvidenceTables(normalizeEvidenceText(text))
				: normalizeEvidenceTables(text);
	return renderMarkdown(normalized);
};
