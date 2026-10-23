import type { AgentToolResult, ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RetrievalRequestOptions, RetrievalResult } from "../../rag/retrieve.d.ts";
import {
	assertRetrievalResult,
	searchKnowledgeBase as defaultSearchKnowledgeBase,
	webSearch as defaultWebSearch,
	RetrievalError,
} from "../../rag/retrieve.js";
import {
	type EvidenceLookupProjection,
	type EvidenceProjection,
	type PcbHistoryEntry,
	projectEvidence,
	projectEvidenceLookup,
	projectRetrievalResult,
} from "../evidence/evidence-service.ts";
import {
	createRetrievalPolicy,
	type PcbToolName,
	type RetrievalPolicy,
	type RetrievalPolicyConfig,
} from "./retrieval-policy.ts";

const DEFAULT_MAX_QUERY_CHARS = 2_000;
const DEFAULT_MAX_EVIDENCE_IDS = 20;
const DEFAULT_MAX_RESULTS = 5;

const searchParameters = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: DEFAULT_MAX_QUERY_CHARS,
		description: "PCB question or search phrase.",
	}),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of evidence items." })),
});

const evidenceParameters = Type.Object({
	evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
		minItems: 1,
		maxItems: DEFAULT_MAX_EVIDENCE_IDS,
		description: "Evidence IDs returned by an earlier PCB search tool call.",
	}),
});

export type RetrievalAdapter = (query: string, options?: RetrievalRequestOptions) => Promise<RetrievalResult>;

export interface PcbExtensionDeps {
	/** 内部知识库检索适配器；未提供时使用 rag/retrieve.js 的实现。 */
	searchKnowledgeBase?: RetrievalAdapter;
	/** 已配置的网络检索适配器；未提供时使用 rag/retrieve.js 的实现。 */
	searchWeb?: RetrievalAdapter;
	/** 单个请求范围的策略对象，由请求监管器初始化，并在请求变更时重置。 */
	getPolicy?: () => RetrievalPolicy;
	/** Pi SessionManager 当前活动分支中的条目；证据回查只读取这条分支。 */
	getEntries?: () => readonly PcbHistoryEntry[];
	/** 策略要求停止当前 Pi 运行时调用，传入预算或超时原因。 */
	onLimit?: (code: "TOOL_BUDGET_EXCEEDED" | "REQUEST_TIMEOUT") => void;
	/** 当前请求句柄；会话桥接层用它拒绝已过期的工具调用。 */
	getRun?: () => { requestId: string; signal: AbortSignal } | undefined;
	sessionId?: string;
	/** 检索调用的单次截止时间；工具层将其与调用方取消信号合并。 */
	retrievalTimeoutMs?: number;
	/** 查询、证据 ID、结果数量和展示文本的运行时上限。 */
	maxQueryChars?: number;
	maxEvidenceIds?: number;
	maxResults?: number;
	maxContentChars?: number;
	/** 转发给检索适配器的默认项，例如测试用 fetch 和知识库配置。 */
	retrievalOptions?: Omit<RetrievalRequestOptions, "signal" | "timeoutMs" | "limit">;
}

export interface PcbToolRuntimeInput {
	/** 会话桥接层提供的调用方归属标识，供宿主把运行时绑定到正确主体。 */
	ownerId: string;
	/** 当前业务会话标识，写入证据详情以便后续追踪；它不是 Pi 原生会话 ID。 */
	sessionId: string;
	/** 活动分支供证据回查使用；工具不自行读取其他会话历史。 */
	manager: { getBranch(): readonly PcbHistoryEntry[] };
	/** 当前请求句柄；stop 只在策略要求终止时调用。 */
	getRun: () =>
		| { requestId: string; signal: AbortSignal; stop(code: "TOOL_BUDGET_EXCEEDED" | "REQUEST_TIMEOUT"): void }
		| undefined;
	policyConfig?: Partial<RetrievalPolicyConfig>;
	deps?: Omit<PcbExtensionDeps, "getPolicy" | "getEntries" | "onLimit" | "getRun" | "sessionId">;
}

export interface PcbToolRuntime {
	/** 每个会话只注册一个扩展工厂，且工具名固定为以下三项。 */
	extensions: ExtensionFactory[];
	toolNames: readonly ["search_knowledge_base", "search_web", "get_evidence"];
	getPolicy: () => RetrievalPolicy;
}

interface PolicyDetails {
	kind: "pcb_policy";
	version: 1;
	toolName: PcbToolName;
	code: string;
}

type PcbToolDetails = EvidenceProjection["details"] | EvidenceLookupProjection["details"] | PolicyDetails;

/**
 * 返回只注册三个 PCB 工具的 Pi 扩展工厂。
 * 扩展注册表是工具声明和执行元数据的唯一来源，避免会话层重复声明工具。
 */
export function createPcbExtension(deps: PcbExtensionDeps = {}): ExtensionFactory {
	const fallbackPolicy = createRetrievalPolicy({
		maxToolCalls: 8,
		allowWebSearch: false,
		allowWebOnKbError: false,
	});
	const searchKnowledgeBase = deps.searchKnowledgeBase ?? defaultSearchKnowledgeBase;
	const searchWeb = deps.searchWeb ?? defaultWebSearch;
	return (pi: ExtensionAPI): void => {
		// 知识库、网络检索和证据回查共享同一套请求级依赖，但各自有独立的工具名和策略入口。
		pi.registerTool(createSearchTool("search_knowledge_base", searchKnowledgeBase, deps, fallbackPolicy));
		pi.registerTool(createSearchTool("search_web", searchWeb, deps, fallbackPolicy));
		pi.registerTool(createEvidenceTool(deps, fallbackPolicy));
	};
}

/**
 * 服务运行时使用的会话级桥接层。每个 Pi 会话只创建一个扩展工厂；requestId 或取消信号变化时
 * 换用新的策略状态，避免前一个请求的预算和取消状态泄漏到后一个请求。
 */
export function tools(input: PcbToolRuntimeInput): PcbToolRuntime {
	let activeRequestId: string | undefined;
	let activeSignal: AbortSignal | undefined;
	let policy: RetrievalPolicy | undefined;
	const getPolicy = (): RetrievalPolicy => {
		const run = input.getRun();
		if (!run) throw requestNotRunning();
		// 同一 requestId 下复用预算；请求句柄变化时必须重新建立策略。
		if (!policy || activeRequestId !== run.requestId || activeSignal !== run.signal) {
			activeRequestId = run.requestId;
			activeSignal = run.signal;
			policy = createRetrievalPolicy({ ...input.policyConfig, signal: run.signal });
		}
		// 让策略在工具真正进入 before() 前感知外部取消，保证后续调用立即终止。
		if (run.signal.aborted) policy.markCancelled();
		return policy;
	};
	const extension = createPcbExtension({
		...input.deps,
		getPolicy,
		getEntries: () => input.manager.getBranch(),
		getRun: () => {
			const run = input.getRun();
			return run ? { requestId: run.requestId, signal: run.signal } : undefined;
		},
		onLimit: (code) => input.getRun()?.stop(code),
		sessionId: input.sessionId,
	});
	return {
		extensions: [extension],
		toolNames: ["search_knowledge_base", "search_web", "get_evidence"],
		getPolicy,
	};
}

function createSearchTool(
	toolName: "search_knowledge_base" | "search_web",
	adapter: RetrievalAdapter,
	deps: PcbExtensionDeps,
	fallbackPolicy: RetrievalPolicy,
): ToolDefinition<typeof searchParameters, PcbToolDetails> {
	const isKnowledgeBase = toolName === "search_knowledge_base";
	// 两种检索共用参数校验、请求截止时间和证据投影；差异由策略及适配器决定。
	return {
		name: toolName,
		label: toolName,
		description: isKnowledgeBase
			? "Search the PCB internal knowledge base for manufacturing evidence before using web search."
			: "Search the web for PCB evidence only after an internal knowledge-base search completed with no usable evidence.",
		promptSnippet: isKnowledgeBase ? "Search internal PCB evidence" : "Search web evidence after internal retrieval",
		parameters: searchParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const run = deps.getRun?.();
			if (deps.getRun && !run) throw requestNotRunning();
			const policy = deps.getPolicy?.() ?? fallbackPolicy;
			const effectiveSignal = mergeSignals(signal, ctx.signal, run?.signal);
			// before() 同时检查取消、总调用预算以及知识库优先的网络检索顺序。
			const decision = policy.before(toolName);
			if (!decision.allowed) return policyDenied(toolName, decision, deps);
			const query = normalizeQuery(params.query, deps.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS);
			const limit = normalizeLimit(params.limit, deps.maxResults ?? DEFAULT_MAX_RESULTS);
			try {
				const result = await runWithDeadline(
					(mergedSignal) =>
						adapter(query, {
							...deps.retrievalOptions,
							limit,
							timeoutMs: deps.retrievalTimeoutMs,
							signal: mergedSignal,
						}),
					effectiveSignal,
					deps.retrievalTimeoutMs,
				);
				const validResult = assertRetrievalResult(result);
				// 只有知识库结果会更新后续网络检索的前置条件；证据数按请求累计。
				if (isKnowledgeBase) policy.recordKnowledgeBase(validResult);
				return asAgentResult(
					projectRetrievalResult(toolName, validResult, {
						sessionId: deps.sessionId,
						maxContentChars: deps.maxContentChars,
					}),
				);
			} catch (error) {
				// 知识库失败也要落入策略状态，配置允许时网络检索才可据此放行。
				if (isKnowledgeBase) policy.recordKnowledgeBaseError(error);
				if (effectiveSignal?.aborted) policy.markCancelled();
				throw error;
			}
		},
	};
}

function createEvidenceTool(
	deps: PcbExtensionDeps,
	fallbackPolicy: RetrievalPolicy,
): ToolDefinition<typeof evidenceParameters, PcbToolDetails> {
	/**
	 * 证据回查从当前活动分支的工具结果中恢复原始记录；它不重新检索，也不跨分支读取历史。
	 */
	return {
		name: "get_evidence",
		label: "get_evidence",
		description: "Retrieve original evidence from earlier PCB search tool results in this active Pi session branch.",
		promptSnippet: "Retrieve original PCB evidence by ID",
		parameters: evidenceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const run = deps.getRun?.();
			if (deps.getRun && !run) throw requestNotRunning();
			const policy = deps.getPolicy?.() ?? fallbackPolicy;
			const decision = policy.before("get_evidence");
			if (!decision.allowed) return policyDenied("get_evidence", decision, deps);
			const effectiveSignal = mergeSignals(signal, ctx.signal, run?.signal);
			if (effectiveSignal?.aborted) {
				policy.markCancelled();
				return policyDenied("get_evidence", { allowed: false, code: "REQUEST_CANCELLED", terminate: true }, deps);
			}
			const maxIds = deps.maxEvidenceIds ?? DEFAULT_MAX_EVIDENCE_IDS;
			// 去重后再限制数量，保证同一个 ID 不重复占用回查配额。
			const ids = [...new Set(params.evidenceIds.map((id) => id.trim()).filter(Boolean))];
			if (ids.length === 0 || ids.length > maxIds)
				throw new Error(`evidenceIds must contain 1-${maxIds} unique IDs`);
			const entries = deps.getEntries?.() ?? [];
			const records = projectEvidence(entries);
			const byId = new Map(records.map((record) => [record.evidenceId, record]));
			const found = ids.flatMap((id) => {
				const record = byId.get(id);
				return record ? [record] : [];
			});
			// projectEvidenceLookup 保留请求顺序，并显式返回找不到的 ID，便于模型区分空结果。
			return asAgentResult(
				projectEvidenceLookup("get_evidence", ids, found, {
					sessionId: deps.sessionId,
					maxContentChars: deps.maxContentChars,
				}),
			);
		},
	};
}

function normalizeQuery(value: string, maxChars: number): string {
	// 工具层先收紧空白和长度；适配器仍会对外部返回值做独立校验。
	const query = value.trim();
	if (query.length === 0) throw new Error("query must not be empty");
	if (query.length > maxChars) throw new Error(`query must be at most ${maxChars} characters`);
	return query;
}

function normalizeLimit(value: number | undefined, maxResults: number): number {
	// 调用方可以请求更小的数量，但不能越过运行时设置的结果上限。
	if (value === undefined) return maxResults;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit must be a positive integer");
	return Math.min(value, maxResults);
}

function policyDenied(
	toolName: PcbToolName,
	decision: { allowed: boolean; code?: string; terminate?: boolean },
	deps: PcbExtensionDeps,
): AgentToolResult<PolicyDetails> {
	// 预算耗尽需要通知运行时停止本次 Pi 请求；普通策略拒绝只返回工具错误。
	const code = decision.code ?? "TOOL_NOT_ALLOWED";
	if (decision.terminate && code === "TOOL_BUDGET_EXCEEDED") deps.onLimit?.("TOOL_BUDGET_EXCEEDED");
	return {
		content: [{ type: "text", text: `Tool ${toolName} was not executed: ${code}.` }],
		details: { kind: "pcb_policy", version: 1, toolName, code },
		isError: true,
		terminate: decision.terminate,
	};
}

function requestNotRunning(): Error {
	const error = new Error("REQUEST_NOT_RUNNING");
	error.name = "REQUEST_NOT_RUNNING";
	return error;
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
	// 同一信号只保留一次；多个来源合并后，任一层取消都会终止检索。
	const uniqueSignals = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
	if (uniqueSignals.length === 0) return undefined;
	if (uniqueSignals.length === 1) return uniqueSignals[0];
	return AbortSignal.any(uniqueSignals);
}

function asAgentResult<T>(projection: { content: AgentToolResult<T>["content"]; details: T }): AgentToolResult<T> {
	return { content: projection.content, details: projection.details };
}

async function runWithDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<T> {
	// 适配器负责具体请求，这里统一补上调用方取消和本地超时，并把两者映射为稳定错误码。
	if (signal?.aborted) throw new RetrievalError("CANCELLED", "Retrieval was cancelled", signal.reason);
	const controller = new AbortController();
	const timeout = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = (): void => {
			controller.abort(signal?.reason);
			finish(() => reject(new RetrievalError("CANCELLED", "Retrieval was cancelled", signal?.reason)));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeout !== undefined) {
			timer = setTimeout(() => {
				controller.abort(new Error("retrieval timeout"));
				finish(() => reject(new RetrievalError("RETRIEVAL_TIMEOUT", "Retrieval timed out")));
			}, timeout);
		}
		let operationPromise: Promise<T>;
		try {
			operationPromise = operation(controller.signal);
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		operationPromise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}
