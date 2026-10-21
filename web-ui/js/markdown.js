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

function appendInline(parent, tokens) {
	for (const token of tokens || []) appendInlineToken(parent, token);
}

function appendInlineToken(parent, token) {
	switch (token.type) {
		case "text":
			if (token.tokens?.length) appendInline(parent, token.tokens);
			else parent.appendChild(document.createTextNode(token.text || ""));
			break;

		case "escape":
			parent.appendChild(document.createTextNode(token.text || ""));
			break;

		case "strong": {
			const strong = document.createElement("strong");
			appendInline(strong, token.tokens);
			parent.appendChild(strong);
			break;
		}

		case "em": {
			const em = document.createElement("em");
			appendInline(em, token.tokens);
			parent.appendChild(em);
			break;
		}

		case "del": {
			const del = document.createElement("del");
			appendInline(del, token.tokens);
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
			if (token.tokens?.length) appendInline(link, token.tokens);
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
			if (token.tokens?.length) appendInline(parent, token.tokens);
			else if (typeof token.text === "string") parent.appendChild(document.createTextNode(token.text));
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
