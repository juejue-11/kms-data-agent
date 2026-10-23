/**
 * 检索层对外的最小类型契约。知识库和网络后端都归一为同一结果结构，工具层据此做证据投影。
 */
export type RetrievalStatus = "ok" | "no_results" | "degraded";
export type RetrievalBackend = "ragflow" | "local" | "tavily" | "duckduckgo";
export type RetrievalSourceType = "knowledge_base" | "local" | "web";

export interface Evidence {
	/** 稳定的 ev_ 前缀 ID，供工具结果展示和后续证据回查使用。 */
	evidenceId: string;
	/** 来源类型必须与后端一致：知识库、降级本地库或网络。 */
	sourceType: RetrievalSourceType;
	text: string;
	title: string;
	documentId?: string;
	chunkId?: string;
	page?: number;
	url?: string;
	similarity?: number;
	retrievedAt: string;
}

export interface RetrievalResult {
	/** no_results 必须没有 evidence；degraded 可带有降级来源和 warningCode。 */
	status: RetrievalStatus;
	backend: RetrievalBackend;
	evidence: Evidence[];
	warningCode?: string;
	query?: string;
	retrievedAt?: string;
}

export interface RetrievalRequestOptions {
	/** signal 取消优先于超时和后端降级；其余字段覆盖环境默认值。 */
	signal?: AbortSignal;
	timeoutMs?: number;
	limit?: number;
	minSimilarity?: number;
	topK?: number;
	datasetIds?: readonly string[];
	ragflowBaseUrl?: string;
	ragflowApiKey?: string;
	localKbDir?: string;
	allowLocalFallback?: boolean;
	searchProvider?: string;
	tavilyApiKey?: string;
	fetch?: typeof fetch;
	now?: () => Date | string;
	idFactory?: (parts: Record<string, unknown>) => string;
	env?: NodeJS.ProcessEnv;
}

export class RetrievalError extends Error {
	/** 稳定错误码供策略区分取消、配置缺失、后端故障和响应无效。 */
	readonly code: string;
	constructor(code: string, message?: string, cause?: unknown);
}

/** 先访问配置的权威知识库，只有显式允许时才使用本地降级后端。 */
export function searchKnowledgeBase(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
/** 按显式 provider 配置执行网络检索，不因一个 provider 缺失而静默切换。 */
export function webSearch(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
/** 将固定默认项合并到每次检索请求，适合会话或测试注入。 */
export function createRetrievalClient(defaults?: RetrievalRequestOptions): {
	searchKnowledgeBase(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
	webSearch(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
};
/** 验证后端响应的状态、ID、来源类型以及后端/来源匹配关系。 */
export function isRetrievalResult(value: unknown): value is RetrievalResult;
/** 验证失败时抛出 RetrievalError，否则返回同一个结果对象。 */
export function assertRetrievalResult(value: unknown): RetrievalResult;
/** 提取英文/数字词和中文相邻双字词，供本地降级匹配使用。 */
export function tokenize(text: string): string[];
