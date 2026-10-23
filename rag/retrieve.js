import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 检索模块刻意不感知 Pi 会话或工具。它把外部检索服务归一成小而可审计的结果结构，
 * 请求的 AbortSignal 和预算由工具执行层传入。
 */

const DEFAULT_LOCAL_KB_DIR = fileURLToPath(new URL("../../分析资料", import.meta.url));
const DEFAULT_RAGFLOW_BASE_URL = "http://localhost:80";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_SIMILARITY = 0.35;
const DEFAULT_TOP_K = 2;
const DEFAULT_WEB_LIMIT = 5;
const MAX_QUERY_LENGTH = 2_000;
const MAX_RESULT_TEXT_LENGTH = 16_000;

/** @type {Readonly<Record<string, string>>} */
const ERROR_MESSAGES = Object.freeze({
	CANCELLED: "Retrieval was cancelled",
	RETRIEVAL_TIMEOUT: "Retrieval timed out",
	RETRIEVAL_HTTP_ERROR: "Retrieval service returned an HTTP error",
	RETRIEVAL_RESPONSE_INVALID: "Retrieval service returned an invalid response",
	RETRIEVAL_BUSINESS_ERROR: "Retrieval service returned a business error",
	RAGFLOW_NOT_CONFIGURED: "Knowledge base is not configured",
	RAGFLOW_UNAVAILABLE: "Knowledge base is unavailable",
	LOCAL_RETRIEVAL_FAILED: "Local knowledge-base fallback failed",
	WEB_SEARCH_UNAVAILABLE: "Web search service is unavailable",
	SEARCH_PROVIDER_UNSUPPORTED: "Configured web search provider is unsupported",
	SEARCH_PROVIDER_NOT_CONFIGURED: "Configured web search provider is missing credentials",
});

/** 服务故障使用的稳定错误类型，调用方通过 code 进行分支处理。 */
export class RetrievalError extends Error {
	/** @param {string} code @param {string} [message] @param {unknown} [cause] */
	constructor(code, message = ERROR_MESSAGES[code] ?? code, cause) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RetrievalError";
		this.code = code;
	}
}

/** 判断未知值是否为非数组对象，供响应边界校验使用。 @param {unknown} value */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 识别 DOMException 或普通对象形式的 AbortError。 @param {unknown} value */
function isAbortError(value) {
	return typeof DOMException !== "undefined" && value instanceof DOMException
		? value.name === "AbortError"
		: isRecord(value) && value.name === "AbortError";
}

/** 只接受有限数字，异常值返回 undefined 以便调用方采用默认值。 @param {unknown} value */
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把非空字符串去掉首尾空白，其他值视为缺失。 @param {unknown} value */
function asNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 解析正整数配置；不合法时回退到给定默认值。 @param {unknown} value @param {number | undefined} fallback */
function asPositiveInteger(value, fallback) {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 解析非负整数配置；不合法时回退到给定默认值。 @param {unknown} value @param {number | undefined} fallback */
function asNonNegativeInteger(value, fallback) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** 将环境变量中的布尔文本解析为布尔值，无法识别时保留默认值。 @param {unknown} value @param {boolean} fallback */
function parseBoolean(value, fallback) {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return fallback;
}

/** 解析逗号分隔配置并去掉空项。 @param {string} value */
function parseCsv(value) {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * 延迟读取环境默认值，使调用方在导入模块后仍能注入测试或部署配置。
 * options 中的字段优先于环境变量，最终结果统一供各后端使用。
 *
 * @param {RetrievalRequestOptions} options
 */
function resolveConfig(options = {}) {
	const env = options.env ?? process.env;
	const configuredDatasetIds = options.datasetIds ?? parseCsv(env.RAGFLOW_DATASET_IDS ?? "");
	const datasetIds = Array.isArray(configuredDatasetIds)
		? configuredDatasetIds.map((id) => String(id).trim()).filter(Boolean)
		: [];
	const minSimilarity = options.minSimilarity ?? Number(env.PCB_KB_MIN_SIMILARITY ?? DEFAULT_MIN_SIMILARITY);
	const topK = options.topK ?? asPositiveInteger(Number(env.PCB_KB_TOP_K), DEFAULT_TOP_K);
	const timeoutMs = options.timeoutMs ?? asPositiveInteger(Number(env.PCB_RETRIEVAL_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
	const provider = String(options.searchProvider ?? env.SEARCH_PROVIDER ?? "duckduckgo").toLowerCase();
	return {
		datasetIds,
		ragflowBaseUrl: String(options.ragflowBaseUrl ?? env.RAGFLOW_BASE_URL ?? DEFAULT_RAGFLOW_BASE_URL),
		ragflowApiKey: String(options.ragflowApiKey ?? env.RAGFLOW_API_KEY ?? ""),
		localKbDir: String(options.localKbDir ?? env.LOCAL_KB_DIR ?? DEFAULT_LOCAL_KB_DIR),
		allowLocalFallback: options.allowLocalFallback ?? parseBoolean(env.PCB_ALLOW_LOCAL_FALLBACK, false),
		minSimilarity:
			Number.isFinite(minSimilarity) && minSimilarity >= 0 && minSimilarity <= 1
				? minSimilarity
				: DEFAULT_MIN_SIMILARITY,
		topK: asPositiveInteger(topK, DEFAULT_TOP_K),
		timeoutMs: asPositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
		provider,
		tavilyApiKey: String(options.tavilyApiKey ?? env.TAVILY_API_KEY ?? ""),
		fetch: options.fetch ?? globalThis.fetch,
	};
}

/** 校验并规范化查询文本，统一拒绝空查询和超长输入。 @param {string} query */
function validateQuery(query) {
	if (typeof query !== "string" || query.trim().length === 0) {
		throw new RetrievalError("INVALID_QUERY", "Search query must not be empty");
	}
	const normalized = query.trim();
	if (normalized.length > MAX_QUERY_LENGTH) {
		throw new RetrievalError("INVALID_QUERY", `Search query must be at most ${MAX_QUERY_LENGTH} characters`);
	}
	return normalized;
}

/** 解析结果数量；允许调用方缩小范围，但不会超过后端上限。 @param {unknown} limit @param {number} fallback @param {number} maximum */
function resolveLimit(limit, fallback, maximum) {
	if (limit === undefined) return fallback;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RetrievalError("INVALID_LIMIT", "Search result limit must be a positive integer");
	}
	return Math.min(limit, maximum);
}

/** 在发起后端请求前检查取消信号。 @param {AbortSignal | undefined} signal */
function assertNotAborted(signal) {
	if (signal?.aborted) throw new RetrievalError("CANCELLED", ERROR_MESSAGES.CANCELLED, signal.reason);
}

/** 只接受 http/https URL，避免把任意字符串暴露为来源链接。 @param {string} value */
function asHttpUrl(value) {
	const url = asNonEmptyString(value);
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 将不同后端的原始条目映射到统一 Evidence 字段，并保留可用的定位元数据。
 * 没有合法文本的条目被丢弃；没有稳定 ID 时按内容生成可复现的 ev_ ID。
 * @param {string} sourceType @param {Record<string, unknown>} raw @param {object} context
 */
function normalizeEvidence(sourceType, raw, context) {
	const text = asNonEmptyString(raw.text ?? raw.content ?? raw.content_with_weight);
	if (!text) return undefined;
	const documentId = asNonEmptyString(raw.documentId ?? raw.document_id ?? raw.doc_id);
	const chunkId = asNonEmptyString(raw.chunkId ?? raw.chunk_id ?? raw.id);
	const title =
		asNonEmptyString(raw.title ?? raw.documentName ?? raw.document_name ?? raw.document_keyword ?? raw.doc_name) ??
		(sourceType === "web"
			? "Web result"
			: sourceType === "local"
				? "Local knowledge-base result"
				: "Knowledge-base result");
	const url = asHttpUrl(raw.url ?? raw.link ?? raw.firstUrl ?? raw.FirstURL);
	const page = asNonNegativeInteger(raw.page ?? raw.pageNumber ?? raw.page_num, undefined);
	const similarity = asFiniteNumber(raw.similarity ?? raw.score);
	const retrievedAt = context.now();
	const rawEvidenceId = asNonEmptyString(raw.evidenceId);
	const evidenceId = rawEvidenceId?.startsWith("ev_")
		? rawEvidenceId
		: context.makeId({ sourceType, documentId, chunkId, title, text, url, rawEvidenceId });
	const evidence = {
		evidenceId,
		sourceType,
		text: text.slice(0, MAX_RESULT_TEXT_LENGTH),
		title,
		retrievedAt,
	};
	// 可选字段只在原始响应确实提供时写入，避免用默认值伪造来源位置。
	if (documentId) evidence.documentId = documentId;
	if (chunkId) evidence.chunkId = chunkId;
	if (page !== undefined) evidence.page = page;
	if (url) evidence.url = url;
	if (similarity !== undefined) evidence.similarity = similarity;
	return evidence;
}

/** 构造时间和证据 ID 工厂；测试可注入固定时钟和 ID 生成器。 @param {object} options */
function makeEvidenceContext(options) {
	const now = options.now ?? (() => new Date().toISOString());
	const idFactory = options.idFactory;
	return {
		now: () => {
			const value = now();
			return value instanceof Date ? value.toISOString() : String(value);
		},
		makeId: (parts) => {
			if (idFactory) {
				// 外部 ID 工厂必须返回约定格式，否则退回内容哈希而不是暴露不稳定 ID。
				const id = String(idFactory(parts));
				if (/^ev_[A-Za-z0-9_-]+$/.test(id)) return id;
			}
			const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
			return `ev_${digest}`;
		},
	};
}

/**
 * 用调用方信号和本地超时执行一次 fetch。调用方取消的请求不会重试，也不会在本模块内切换到其他后端。
 *
 * @param {string | URL} input
 * @param {RequestInit} init
 * @param {RetrievalRequestOptions & { fetch: typeof fetch, service?: "ragflow" | "web" }} options
 */
async function fetchJson(input, init, options) {
	assertNotAborted(options.signal);
	if (typeof options.fetch !== "function") {
		throw new RetrievalError("FETCH_UNAVAILABLE", "No fetch implementation is available");
	}
	const controller = new AbortController();
	let timedOut = false;
	let timer;
	const abortFromCaller = () => controller.abort(options.signal?.reason);
	if (options.signal) {
		if (options.signal.aborted) abortFromCaller();
		else options.signal.addEventListener("abort", abortFromCaller, { once: true });
	}
	const timeoutMs = asPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	if (timeoutMs !== Number.POSITIVE_INFINITY) {
		// 超时只中止本次请求；异常会在 catch 中转换成稳定的 RETRIEVAL_TIMEOUT。
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error("retrieval timeout"));
		}, timeoutMs);
	}
	try {
		let response;
		try {
			response = await options.fetch(input, { ...init, signal: controller.signal });
		} catch (error) {
			if (timedOut) throw new RetrievalError("RETRIEVAL_TIMEOUT", ERROR_MESSAGES.RETRIEVAL_TIMEOUT, error);
			if (options.signal?.aborted || isAbortError(error)) {
				throw new RetrievalError("CANCELLED", ERROR_MESSAGES.CANCELLED, error);
			}
			throw new RetrievalError(
				options.service === "web" ? "WEB_SEARCH_UNAVAILABLE" : "RAGFLOW_UNAVAILABLE",
				options.service === "web" ? ERROR_MESSAGES.WEB_SEARCH_UNAVAILABLE : ERROR_MESSAGES.RAGFLOW_UNAVAILABLE,
				error,
			);
		}
		if (!response || typeof response.ok !== "boolean") {
			throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
		}
		if (!response.ok) {
			throw new RetrievalError(
				"RETRIEVAL_HTTP_ERROR",
				`${ERROR_MESSAGES.RETRIEVAL_HTTP_ERROR} (${response.status})`,
			);
		}
		try {
			// 只在 HTTP 成功后解析 JSON，解析失败视为响应格式错误。
			return await response.json();
		} catch (error) {
			throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID, error);
		}
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

/** 从 RAGFlow 响应提取 chunks，并把业务错误与结构错误分开标记。 @param {unknown} payload */
function getRagflowChunks(payload) {
	if (!isRecord(payload)) {
		throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
	}
	const code = payload.code ?? payload.status_code;
	if (code !== undefined && code !== 0 && code !== "0" && code !== 200 && code !== "200" && code !== "success") {
		const message =
			asNonEmptyString(payload.message ?? payload.msg ?? payload.error) ?? ERROR_MESSAGES.RETRIEVAL_BUSINESS_ERROR;
		throw new RetrievalError("RETRIEVAL_BUSINESS_ERROR", message);
	}
	const data = payload.data ?? payload.result;
	// 兼容 data 直接为数组或 data.chunks 的响应形状，其他形状不可安全投影为证据。
	const chunks = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.chunks) ? data.chunks : undefined;
	if (!chunks) {
		throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
	}
	return chunks;
}

/** 调用 RAGFlow 权威知识库，按相似度阈值过滤并截断为请求数量。 @param {string} query @param {RetrievalRequestOptions} options */
async function searchRagflow(query, options) {
	const config = resolveConfig(options);
	const limit = resolveLimit(options.limit, config.topK, 20);
	const payload = await fetchJson(
		new URL("/api/v1/retrieval", config.ragflowBaseUrl),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(config.ragflowApiKey ? { Authorization: `Bearer ${config.ragflowApiKey}` } : {}),
			},
			body: JSON.stringify({ question: query, dataset_ids: config.datasetIds, top_k: limit }),
		},
		{ ...options, ...config, fetch: config.fetch, service: "ragflow" },
	);
	const context = makeEvidenceContext(options);
	const evidence = [];
	for (const raw of getRagflowChunks(payload)) {
		if (!isRecord(raw)) continue;
		const similarity = asFiniteNumber(raw.similarity ?? raw.score);
		// 缺少相似度或低于阈值的 chunk 不进入结果，避免把弱匹配当作有效证据。
		if (similarity === undefined || similarity < config.minSimilarity) continue;
		const item = normalizeEvidence("knowledge_base", raw, context);
		if (item) evidence.push(item);
		if (evidence.length >= limit) break;
	}
	// 没有通过阈值的条目是完成但为空的 no_results，不等同于后端故障。
	return {
		status: evidence.length > 0 ? "ok" : "no_results",
		backend: "ragflow",
		evidence,
		query,
		retrievedAt: context.now(),
	};
}

/**
 * 扫描本地 txt 知识库作为显式降级路径；结果始终标记 degraded，并保留触发降级的 warningCode。
 * @param {string} query @param {RetrievalRequestOptions} options @param {string} warningCode
 */
async function searchLocal(query, options, warningCode) {
	const config = resolveConfig(options);
	const limit = resolveLimit(options.limit, config.topK, 20);
	const context = makeEvidenceContext(options);
	try {
		const files = (await readdir(config.localKbDir)).filter((file) => file.toLowerCase().endsWith(".txt")).sort();
		assertNotAborted(options.signal);
		const terms = tokenize(query);
		if (terms.length === 0) {
			// 查询无法分词时仍是降级路径已完成，但没有可检索的证据。
			return { status: "degraded", backend: "local", evidence: [], warningCode, query, retrievedAt: context.now() };
		}
		const hits = [];
		for (const file of files) {
			assertNotAborted(options.signal);
			const content = await readFile(join(config.localKbDir, file), "utf8");
			const lines = content.split(/\r?\n/);
			for (let index = 0; index < lines.length; index += 1) {
				assertNotAborted(options.signal);
				const text = lines[index].trim();
				if (!text) continue;
				const normalized = tokenize(text);
				const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
				// 分数是命中词项数量，仅用于本地候选排序，不冒充 RAGFlow 相似度。
				if (score === 0) continue;
				hits.push({ file, index, text, score });
			}
		}
		assertNotAborted(options.signal);
		hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.index - b.index);
		const evidence = hits
			.slice(0, limit)
			.map((hit) =>
				normalizeEvidence(
					"local",
					{ text: hit.text, title: hit.file, documentId: hit.file, chunkId: `${hit.file}:${hit.index + 1}` },
					context,
				),
			);
		return {
			status: "degraded",
			backend: "local",
			evidence: evidence.filter(Boolean),
			warningCode,
			query,
			retrievedAt: context.now(),
		};
	} catch (error) {
		if (error instanceof RetrievalError && error.code === "CANCELLED") throw error;
		throw new RetrievalError("LOCAL_RETRIEVAL_FAILED", ERROR_MESSAGES.LOCAL_RETRIEVAL_FAILED, error);
	}
}

/**
 * 知识库检索。已配置的 RAGFlow 是权威后端；本地文本匹配只有在显式开启时才作为降级路径，且结果标记 degraded。
 *
 * @param {string} query
 * @param {RetrievalRequestOptions} [options]
 */
export async function searchKnowledgeBase(query, options = {}) {
	const normalizedQuery = validateQuery(query);
	const config = resolveConfig(options);
	assertNotAborted(options.signal);
	if (config.datasetIds.length === 0) {
		// 没有数据集配置时不猜测远端目标；仅在显式允许时进入本地降级。
		if (!config.allowLocalFallback)
			throw new RetrievalError("RAGFLOW_NOT_CONFIGURED", ERROR_MESSAGES.RAGFLOW_NOT_CONFIGURED);
		return searchLocal(normalizedQuery, options, "RAGFLOW_NOT_CONFIGURED");
	}
	try {
		return await searchRagflow(normalizedQuery, options);
	} catch (error) {
		// 取消必须原样抛出；其他错误只有在开启本地 fallback 时才允许换后端。
		if (error instanceof RetrievalError && error.code === "CANCELLED") throw error;
		assertNotAborted(options.signal);
		if (!config.allowLocalFallback) throw error;
		try {
			return await searchLocal(
				normalizedQuery,
				options,
				error instanceof RetrievalError ? error.code : "RAGFLOW_UNAVAILABLE",
			);
		} catch (fallbackError) {
			// fallback 自身取消仍保持取消语义，其他异常报告为本地检索失败。
			if (fallbackError instanceof RetrievalError && fallbackError.code === "CANCELLED") throw fallbackError;
			if (fallbackError instanceof RetrievalError) throw fallbackError;
			throw new RetrievalError("LOCAL_RETRIEVAL_FAILED", ERROR_MESSAGES.LOCAL_RETRIEVAL_FAILED, fallbackError);
		}
	}
}

/** 使用 Tavily 执行网络检索；缺少凭据时明确失败，不静默切换 provider。 @param {string} query @param {RetrievalRequestOptions} options */
async function searchTavily(query, options) {
	const config = resolveConfig(options);
	if (!config.tavilyApiKey)
		throw new RetrievalError("SEARCH_PROVIDER_NOT_CONFIGURED", ERROR_MESSAGES.SEARCH_PROVIDER_NOT_CONFIGURED);
	const limit = resolveLimit(options.limit, DEFAULT_WEB_LIMIT, 20);
	const payload = await fetchJson(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: config.tavilyApiKey, query, max_results: limit }),
		},
		{ ...options, ...config, fetch: config.fetch, service: "web" },
	);
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
	}
	const context = makeEvidenceContext(options);
	const evidence = payload.results
		.map((item) => (isRecord(item) ? normalizeEvidence("web", item, context) : undefined))
		.filter(Boolean)
		.slice(0, limit);
	return {
		status: evidence.length > 0 ? "ok" : "no_results",
		backend: "tavily",
		evidence,
		query,
		retrievedAt: context.now(),
	};
}

/** 使用 DuckDuckGo JSON 接口执行网络检索，并把摘要和主题展开为证据条目。 @param {string} query @param {RetrievalRequestOptions} options */
async function searchDuckDuckGo(query, options) {
	const config = resolveConfig(options);
	const limit = resolveLimit(options.limit, DEFAULT_WEB_LIMIT, 20);
	const url = new URL("https://api.duckduckgo.com/");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("no_html", "1");
	url.searchParams.set("skip_disambig", "1");
	const payload = await fetchJson(
		url,
		{ method: "GET", headers: { Accept: "application/json" } },
		{ ...options, ...config, fetch: config.fetch, service: "web" },
	);
	if (!isRecord(payload))
		throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
	const context = makeEvidenceContext(options);
	const rawResults = [];
	// DuckDuckGo 的摘要和 RelatedTopics 结构不同，先扁平化再统一规范化。
	if (asNonEmptyString(payload.AbstractText)) {
		rawResults.push({ title: payload.Heading, text: payload.AbstractText, url: payload.AbstractURL });
	}
	const topics = Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : [];
	for (const topic of topics) {
		if (isRecord(topic) && asNonEmptyString(topic.Text)) {
			rawResults.push({ title: topic.Text.split(" - ")[0], text: topic.Text, url: topic.FirstURL });
		}
		if (isRecord(topic) && Array.isArray(topic.Topics)) {
			for (const nested of topic.Topics) {
				if (isRecord(nested) && asNonEmptyString(nested.Text)) {
					rawResults.push({ title: nested.Text.split(" - ")[0], text: nested.Text, url: nested.FirstURL });
				}
			}
		}
	}
	const evidence = rawResults
		.map((item) => normalizeEvidence("web", item, context))
		.filter(Boolean)
		.slice(0, limit);
	return {
		status: evidence.length > 0 ? "ok" : "no_results",
		backend: "duckduckgo",
		evidence,
		query,
		retrievedAt: context.now(),
	};
}

/**
 * 网络检索。provider 选择是显式的；Tavily 凭据缺失不会静默切到 DuckDuckGo，取消的调用也不会进入另一条路径。
 *
 * @param {string} query
 * @param {RetrievalRequestOptions} [options]
 */
export async function webSearch(query, options = {}) {
	const normalizedQuery = validateQuery(query);
	const config = resolveConfig(options);
	assertNotAborted(options.signal);
	// provider 只按配置分派，未知值直接报错以避免来源策略被意外绕过。
	if (config.provider === "tavily") return searchTavily(normalizedQuery, options);
	if (config.provider === "duckduckgo") return searchDuckDuckGo(normalizedQuery, options);
	throw new RetrievalError(
		"SEARCH_PROVIDER_UNSUPPORTED",
		`${ERROR_MESSAGES.SEARCH_PROVIDER_UNSUPPORTED}: ${config.provider}`,
	);
}

/** 创建带固定默认项的适配器函数，适合会话级配置或测试注入。 */
export function createRetrievalClient(defaults = {}) {
	return {
		searchKnowledgeBase: (query, options = {}) => searchKnowledgeBase(query, { ...defaults, ...options }),
		webSearch: (query, options = {}) => webSearch(query, { ...defaults, ...options }),
	};
}

/** 在结果暴露给 Pi 工具前验证状态、证据 ID 和后端/来源类型的一致性。 */
export function isRetrievalResult(value) {
	if (!isRecord(value) || !["ok", "no_results", "degraded"].includes(value.status)) return false;
	if (!(typeof value.backend === "string" && ["ragflow", "local", "tavily", "duckduckgo"].includes(value.backend)))
		return false;
	if (!Array.isArray(value.evidence)) return false;
	// no_results 是确定的空结果；如果带证据则响应自相矛盾。
	if (value.status === "no_results" && value.evidence.length > 0) return false;
	const seenIds = new Set();
	return value.evidence.every((item) => {
		if (!isRecord(item)) return false;
		if (
			typeof item.evidenceId !== "string" ||
			!/^ev_[A-Za-z0-9_-]+$/.test(item.evidenceId) ||
			seenIds.has(item.evidenceId)
		)
			return false;
		if (!(item.sourceType === "knowledge_base" || item.sourceType === "local" || item.sourceType === "web"))
			return false;
		if (
			typeof item.text !== "string" ||
			item.text.trim().length === 0 ||
			typeof item.title !== "string" ||
			item.title.trim().length === 0
		)
			return false;
		if (typeof item.retrievedAt !== "string" || item.retrievedAt.trim().length === 0) return false;
		if (item.documentId !== undefined && (typeof item.documentId !== "string" || item.documentId.trim().length === 0))
			return false;
		if (item.chunkId !== undefined && (typeof item.chunkId !== "string" || item.chunkId.trim().length === 0))
			return false;
		if (item.page !== undefined && (!Number.isSafeInteger(item.page) || item.page < 0)) return false;
		if (item.url !== undefined && !asHttpUrl(item.url)) return false;
		if (item.similarity !== undefined && asFiniteNumber(item.similarity) === undefined) return false;
		if (
			(value.backend === "ragflow" && item.sourceType !== "knowledge_base") ||
			(value.backend === "local" && item.sourceType !== "local") ||
			((value.backend === "tavily" || value.backend === "duckduckgo") && item.sourceType !== "web")
		)
			return false;
		// 每个证据 ID 在同一结果中只能出现一次，避免回查索引产生歧义。
		seenIds.add(item.evidenceId);
		return true;
	});
}

export function assertRetrievalResult(value) {
	if (!isRetrievalResult(value))
		throw new RetrievalError("RETRIEVAL_RESPONSE_INVALID", ERROR_MESSAGES.RETRIEVAL_RESPONSE_INVALID);
	return value;
}

/**
 * 提取英文/数字词和中文相邻双字词。中文双字词保留短语的局部匹配能力，
 * 例如“板面划伤”可以命中包含相邻词组的行，
 * 不要求本地降级路径把整句当成一个词。
 */
export function tokenize(text) {
	const terms = [];
	for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9]{2,}/gu)) {
		const token = match[0];
		if (/^[\p{Script=Han}]+$/u.test(token)) {
			if (token.length === 1) terms.push(token);
			else for (let index = 0; index < token.length - 1; index += 1) terms.push(token.slice(index, index + 2));
		} else terms.push(token);
	}
	return [...new Set(terms)];
}
