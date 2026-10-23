import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Evidence, RetrievalResult, RetrievalSourceType } from "../../rag/retrieve.d.ts";

export const PCB_EVIDENCE_DETAILS_KIND = "pcb_evidence";
export const PCB_EVIDENCE_LOOKUP_DETAILS_KIND = "pcb_evidence_lookup";
const EVIDENCE_ID_PATTERN = /^ev_[A-Za-z0-9_-]+$/;
const CITATION_PATTERN = /\[E:([^\]\s]+)\]/g;

export interface PcbHistoryMessage {
	/** Pi 工具结果消息只需提供以下可选字段，具体结构由运行时决定。 */
	role?: string;
	toolName?: string;
	details?: unknown;
	content?: unknown;
}

export interface PcbHistoryEntry {
	/** 条目由会话分支提供；projectEvidence 只接受 type=message 的 toolResult。 */
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: PcbHistoryMessage;
}

export interface EvidenceRecord extends Evidence {
	/** 以下字段是检索结果投影时补上的上下文，便于回查和 HTTP 响应追踪。 */
	backend?: RetrievalResult["backend"];
	status?: RetrievalResult["status"];
	query?: string;
	warningCode?: string;
	sessionId?: string;
	toolName?: string;
}

export interface EvidenceToolDetails {
	/** version 与 kind 共同约束持久化的工具结果结构，读取时会严格校验。 */
	kind: typeof PCB_EVIDENCE_DETAILS_KIND;
	version: 1;
	toolName: "search_knowledge_base" | "search_web";
	sessionId?: string;
	/** status/backend 与原始 RetrievalResult 保持一致，evidence 是完整结构化条目。 */
	status: RetrievalResult["status"];
	backend: RetrievalResult["backend"];
	query?: string;
	warningCode?: string;
	evidence: EvidenceRecord[];
}

export interface EvidenceLookupDetails {
	/** 回查同时返回 requestedIds、missingIds，调用方可以区分空结果和未找到的 ID。 */
	kind: typeof PCB_EVIDENCE_LOOKUP_DETAILS_KIND;
	version: 1;
	toolName: "get_evidence";
	sessionId?: string;
	requestedIds: string[];
	missingIds: string[];
	evidence: EvidenceRecord[];
}

export interface EvidenceProjection {
	content: TextContent[];
	details: EvidenceToolDetails;
}

export interface EvidenceLookupProjection {
	content: TextContent[];
	details: EvidenceLookupDetails;
}

export interface CitationSource {
	evidenceId: string;
	sourceType: RetrievalSourceType;
	title: string;
	text?: string;
	documentId?: string;
	chunkId?: string;
	page?: number;
	url?: string;
}

export interface CitationValidation {
	/** citedIds 保留回复顺序并去重，invalidIds 列出格式错误或不在当前证据索引中的引用。 */
	status: "valid" | "invalid" | "not_applicable";
	citedIds: string[];
	invalidIds: string[];
	sources: CitationSource[];
}

export interface ValidationProjection {
	sources: CitationSource[];
	citationValidation: {
		status: CitationValidation["status"];
		invalidIds: string[];
	};
}

/**
 * 从 Pi 工具结果条目持久化的 details 中投影证据。调用方传入活动分支，因此其他分支的条目
 * 不会被意外当作证据；同一 evidenceId 后出现的记录覆盖先前记录。
 */
export function projectEvidence(entries: readonly PcbHistoryEntry[]): EvidenceRecord[] {
	const byId = new Map<string, EvidenceRecord>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const toolName = entry.message.toolName;
		if (toolName !== "search_knowledge_base" && toolName !== "search_web") continue;
		const details = readEvidenceDetails(entry.message.details);
		if (!details || details.toolName !== toolName) continue;
		for (const evidence of details.evidence) {
			if (isEvidenceRecord(evidence)) byId.set(evidence.evidenceId, { ...evidence, toolName });
		}
	}
	return [...byId.values()];
}

/** 为会话适配器提供语义更直观的别名。 */
export const evidenceFromSessionEntries = projectEvidence;

/** 将已规范化的检索响应投影为 Pi 原生工具结果，并同时保留结构化证据详情。 */
export function projectRetrievalResult(
	toolName: "search_knowledge_base" | "search_web",
	result: RetrievalResult,
	options: { sessionId?: string; maxContentChars?: number } = {},
): EvidenceProjection {
	// 每条证据都携带检索结果上下文，回查时无需重新依赖原始响应。
	const evidence = result.evidence.map((item) => ({
		...item,
		backend: result.backend,
		status: result.status,
		query: result.query,
		warningCode: result.warningCode,
		sessionId: options.sessionId,
		toolName,
	}));
	const lines = [
		`status=${result.status}; backend=${result.backend}; evidence_ids=${evidence.map((item) => item.evidenceId).join(",") || "none"}`,
	];
	if (result.warningCode) lines.push(`warning=${result.warningCode}`);
	if (evidence.length === 0) {
		// no_results 表示检索完成但没有匹配项；其他空结果表示后端降级且没有可用证据。
		lines.push(
			result.status === "no_results"
				? "No matching evidence was found."
				: "No evidence was available from the degraded source.",
		);
	} else {
		// 文本展示带有稳定的 [E:id] 标记，最终回复可以据此做引用校验。
		for (const item of evidence) {
			const location =
				item.url ??
				[item.documentId, item.chunkId, item.page === undefined ? undefined : `page ${item.page}`]
					.filter(Boolean)
					.join(" / ");
			lines.push(`[E:${item.evidenceId}] ${item.title}${location ? ` (${location})` : ""}\n${item.text}`);
		}
	}
	// 内容可截断以控制模型上下文，但 details 中仍保留完整证据记录。
	const text = truncateText(lines.join("\n\n"), options.maxContentChars ?? 12_000);
	const details: EvidenceToolDetails = {
		kind: PCB_EVIDENCE_DETAILS_KIND,
		version: 1,
		toolName,
		sessionId: options.sessionId,
		status: result.status,
		backend: result.backend,
		query: result.query,
		warningCode: result.warningCode,
		evidence,
	};
	return { content: [{ type: "text", text }], details };
}

/** 将证据回查结果投影为模型可读的工具结果，并显式列出缺失 ID。 */
export function projectEvidenceLookup(
	toolName: "get_evidence",
	requestedIds: readonly string[],
	evidence: readonly EvidenceRecord[],
	options: { sessionId?: string; maxContentChars?: number } = {},
): EvidenceLookupProjection {
	// 回查的 sessionId 以当前调用为准，requestedIds 则保留调用方原始顺序。
	const found = evidence.map((item) => ({ ...item, sessionId: options.sessionId }));
	const foundIds = new Set(found.map((item) => item.evidenceId));
	const missingIds = requestedIds.filter((id) => !foundIds.has(id));
	const lines = [`evidence_ids=${found.map((item) => item.evidenceId).join(",") || "none"}`];
	if (missingIds.length > 0) lines.push(`missing_evidence_ids=${missingIds.join(",")}`);
	for (const item of found) {
		const location =
			item.url ??
			[item.documentId, item.chunkId, item.page === undefined ? undefined : `page ${item.page}`]
				.filter(Boolean)
				.join(" / ");
		lines.push(`[E:${item.evidenceId}] ${item.title}${location ? ` (${location})` : ""}\n${item.text}`);
	}
	const details: EvidenceLookupDetails = {
		kind: PCB_EVIDENCE_LOOKUP_DETAILS_KIND,
		version: 1,
		toolName,
		sessionId: options.sessionId,
		requestedIds: [...requestedIds],
		missingIds,
		evidence: found,
	};
	return {
		content: [{ type: "text", text: truncateText(lines.join("\n\n"), options.maxContentChars ?? 12_000) }],
		details,
	};
}

/**
 * 构造 HTTP 响应使用的来源投影，只暴露原始证据元数据中实际存在的位置字段，避免伪造定位信息。
 */
export function projectSources(evidence: readonly EvidenceRecord[]): CitationSource[] {
	return evidence.map(({ evidenceId, sourceType, title, text, documentId, chunkId, page, url }) => ({
		evidenceId,
		sourceType,
		title,
		...(text === undefined ? {} : { text }),
		...(documentId === undefined ? {} : { documentId }),
		...(chunkId === undefined ? {} : { chunkId }),
		...(page === undefined ? {} : { page }),
		...(url === undefined ? {} : { url }),
	}));
}

/** 从最终回复文本中提取去重后的 [E:ev_xxx] 引用标记。 */
export function extractCitations(reply: string): string[] {
	if (typeof reply !== "string") return [];
	const citations: string[] = [];
	for (const match of reply.matchAll(CITATION_PATTERN)) {
		const id = match[1];
		if (id && !citations.includes(id)) citations.push(id);
	}
	return citations;
}

/** 将最终回复中的引用与活动分支证据索引比对，并标记格式错误或不存在的 evidenceId。 */
export function validateCitations(
	reply: string,
	evidence: readonly EvidenceRecord[] | ReadonlyMap<string, EvidenceRecord>,
): CitationValidation {
	const citedIds = extractCitations(reply);
	if (citedIds.length === 0) return { status: "not_applicable", citedIds, invalidIds: [], sources: [] };
	const records: readonly EvidenceRecord[] = Array.isArray(evidence) ? evidence : [...evidence.values()];
	// 使用索引查找，既支持数组也支持调用方已构建的 Map。
	const byId = new Map(records.map((item) => [item.evidenceId, item]));
	const invalidIds = citedIds.filter((id) => !EVIDENCE_ID_PATTERN.test(id) || !byId.has(id));
	const sources = citedIds.flatMap((id) => {
		const item = byId.get(id);
		return item ? projectSources([item]) : [];
	});
	return { status: invalidIds.length > 0 ? "invalid" : "valid", citedIds, invalidIds, sources };
}

/** 直接用当前 Pi 活动分支验证最终答案，并返回可供 HTTP 层使用的来源信息。 */
export function validate(reply: string, entries: readonly PcbHistoryEntry[]): ValidationProjection {
	const result = validateCitations(reply, projectEvidence(entries));
	return {
		sources: result.sources,
		citationValidation: { status: result.status, invalidIds: result.invalidIds },
	};
}

/** 在需要时把投影转换为通用 AgentToolResult 类型；运行时结构本身不变。 */
export function asAgentToolResult<T extends EvidenceToolDetails | EvidenceLookupDetails>(
	projection: EvidenceProjection | EvidenceLookupProjection,
): AgentToolResult<T> {
	return projection as AgentToolResult<T>;
}

function readEvidenceDetails(value: unknown): EvidenceToolDetails | undefined {
	// 工具结果可能来自持久化数据，先检查 kind/version/数组再进行类型断言。
	if (!isRecord(value) || value.kind !== PCB_EVIDENCE_DETAILS_KIND || value.version !== 1) return undefined;
	if (value.toolName !== "search_knowledge_base" && value.toolName !== "search_web") return undefined;
	if (!Array.isArray(value.evidence)) return undefined;
	return value as unknown as EvidenceToolDetails;
}

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
	// 回查边界只接受最小且稳定的证据字段，防止任意 toolResult details 被当作证据。
	return (
		isRecord(value) &&
		typeof value.evidenceId === "string" &&
		EVIDENCE_ID_PATTERN.test(value.evidenceId) &&
		(value.sourceType === "knowledge_base" || value.sourceType === "local" || value.sourceType === "web") &&
		typeof value.text === "string" &&
		typeof value.title === "string" &&
		typeof value.retrievedAt === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
	// 保留固定尾部标记，让调用方知道内容被截断；非正整数使用安全默认值。
	const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 12_000;
	if (value.length <= limit) return value;
	if (limit <= 32) return value.slice(0, limit);
	return `${value.slice(0, limit - 32)}\n...[truncated]`;
}
