import type { RetrievalResult } from "../../rag/retrieve.d.ts";

export type PcbToolName = "search_knowledge_base" | "search_web" | "get_evidence";
export type KnowledgeBaseStatus = "not_run" | "ok" | "no_results" | "degraded" | "error";
export type RetrievalPolicyErrorCode =
	| "REQUEST_CANCELLED"
	| "TOOL_BUDGET_EXCEEDED"
	| "WEB_SEARCH_DISABLED"
	| "KB_REQUIRED_BEFORE_WEB"
	| "WEB_SEARCH_NOT_ALLOWED_AFTER_KB_ERROR";

/** 请求级开关；maxToolCalls 必须为正整数，signal 绑定当前请求的取消生命周期。 */
export interface RetrievalPolicyConfig {
	maxToolCalls: number;
	allowWebSearch: boolean;
	allowWebOnKbError: boolean;
	signal?: AbortSignal;
}

/** 可观测的策略状态；kbEvidenceCount 是多次知识库调用的内部证据累计值。 */
export interface RetrievalPolicySnapshot {
	toolCalls: number;
	maxToolCalls: number;
	kbAttempts: number;
	kbEvidenceCount: number;
	kbCompleted: boolean;
	lastKbStatus: KnowledgeBaseStatus;
	allowWebSearch: boolean;
	allowWebOnKbError: boolean;
	cancelled: boolean;
	budgetExceeded: boolean;
}

/** allowed=false 时 code 说明拒绝原因，terminate=true 表示应停止当前请求。 */
export interface RetrievalPolicyDecision {
	allowed: boolean;
	code?: RetrievalPolicyErrorCode;
	terminate?: boolean;
}

/**
 * 扩展只依赖这组小协议。它与 HTTP 和会话层解耦，因此请求监管器可以为每个请求创建、重置
 * 一个状态对象，而不把请求生命周期交给 Pi 扩展管理。
 */
export interface RetrievalPolicy {
	/** 应用共享的请求调用预算；知识库和网络检索还会分别执行顺序约束。 */
	before(toolName: string): RetrievalPolicyDecision;
	/** 累加本次知识库返回的内部证据，并记录其完成状态。 */
	recordKnowledgeBase(result: RetrievalResult): void;
	/** 记录知识库错误，使允许降级时网络检索可以按配置判断是否放行。 */
	recordKnowledgeBaseError(error?: unknown): void;
	/** 将当前请求标记为取消，后续工具调用都应终止。 */
	markCancelled(): void;
	/** 将所有计数和知识库状态恢复为新请求初始值。 */
	reset(): void;
	/** 返回快照副本，避免调用方修改内部策略状态。 */
	snapshot(): RetrievalPolicySnapshot;
}

export const DEFAULT_RETRIEVAL_POLICY_CONFIG: RetrievalPolicyConfig = {
	maxToolCalls: 8,
	allowWebSearch: false,
	allowWebOnKbError: false,
};

function normalizeConfig(config: Partial<RetrievalPolicyConfig> = {}): RetrievalPolicyConfig {
	const maxToolCalls = config.maxToolCalls ?? DEFAULT_RETRIEVAL_POLICY_CONFIG.maxToolCalls;
	if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
		throw new Error("maxToolCalls must be a positive integer");
	}
	return {
		maxToolCalls,
		allowWebSearch: config.allowWebSearch ?? DEFAULT_RETRIEVAL_POLICY_CONFIG.allowWebSearch,
		allowWebOnKbError: config.allowWebOnKbError ?? DEFAULT_RETRIEVAL_POLICY_CONFIG.allowWebOnKbError,
		signal: config.signal,
	};
}

export function createRetrievalPolicy(config: Partial<RetrievalPolicyConfig> = {}): RetrievalPolicy {
	const normalized = normalizeConfig(config);
	let snapshot: RetrievalPolicySnapshot = createInitialSnapshot(normalized);

	const reset = (): void => {
		snapshot = createInitialSnapshot(normalized);
	};

	return {
		before(toolName) {
			// 取消优先于预算；预算耗尽是终止请求的硬限制。
			if (normalized.signal?.aborted) snapshot = { ...snapshot, cancelled: true };
			if (snapshot.cancelled) return { allowed: false, code: "REQUEST_CANCELLED", terminate: true };
			if (snapshot.toolCalls >= snapshot.maxToolCalls) {
				snapshot = { ...snapshot, budgetExceeded: true };
				return { allowed: false, code: "TOOL_BUDGET_EXCEEDED", terminate: true };
			}
			const nextCalls = snapshot.toolCalls + 1;
			snapshot = { ...snapshot, toolCalls: nextCalls };
			if (toolName === "search_knowledge_base") {
				// 每次知识库尝试都会先计数，即使适配器随后失败或返回空结果。
				snapshot = { ...snapshot, kbAttempts: snapshot.kbAttempts + 1 };
				return { allowed: true };
			}
			if (toolName !== "search_web") return { allowed: true };
			// 网络检索必须显式启用，并且必须先完成一次知识库检索。
			if (!snapshot.allowWebSearch) return { allowed: false, code: "WEB_SEARCH_DISABLED" };
			if (!snapshot.kbCompleted) return { allowed: false, code: "KB_REQUIRED_BEFORE_WEB" };
			// 只要内部证据累计大于零，就不应再转向网络来源。
			if (snapshot.kbEvidenceCount > 0) return { allowed: false, code: "KB_REQUIRED_BEFORE_WEB" };
			if (snapshot.lastKbStatus === "error" || snapshot.lastKbStatus === "degraded") {
				// 知识库故障/降级是否允许网络兜底由单独开关控制，避免隐式扩大来源范围。
				if (!snapshot.allowWebOnKbError) return { allowed: false, code: "WEB_SEARCH_NOT_ALLOWED_AFTER_KB_ERROR" };
			}
			if (
				snapshot.lastKbStatus !== "no_results" &&
				snapshot.lastKbStatus !== "error" &&
				snapshot.lastKbStatus !== "degraded"
			) {
				return { allowed: false, code: "KB_REQUIRED_BEFORE_WEB" };
			}
			return { allowed: true };
		},
		recordKnowledgeBase(result) {
			// 统计内部来源的证据数量而非数组总数；多次调用采用累计值，防止有证据时误放行网络搜索。
			const internalEvidenceCount = result.evidence.filter(
				(item) => item.sourceType === "knowledge_base" || item.sourceType === "local",
			).length;
			snapshot = {
				...snapshot,
				kbCompleted: true,
				kbEvidenceCount: snapshot.kbEvidenceCount + internalEvidenceCount,
				lastKbStatus: result.status,
			};
		},
		recordKnowledgeBaseError() {
			// 错误也算知识库已完成，避免网络工具把失败误判为“尚未尝试”。
			snapshot = { ...snapshot, kbCompleted: true, lastKbStatus: "error" };
		},
		markCancelled() {
			snapshot = { ...snapshot, cancelled: true };
		},
		reset,
		snapshot() {
			return { ...snapshot };
		},
	};
}

function createInitialSnapshot(config: RetrievalPolicyConfig): RetrievalPolicySnapshot {
	return {
		toolCalls: 0,
		maxToolCalls: config.maxToolCalls,
		kbAttempts: 0,
		kbEvidenceCount: 0,
		kbCompleted: false,
		lastKbStatus: "not_run",
		allowWebSearch: config.allowWebSearch,
		allowWebOnKbError: config.allowWebOnKbError,
		cancelled: false,
		budgetExceeded: false,
	};
}
