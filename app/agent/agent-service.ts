import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { AppConfig } from "../config.ts";
import { AppError, type BusinessEvent, isTerminal, type RequestResult, requireId } from "../contracts/protocol.ts";
import { adaptPiEvent } from "../runtime/event-adapter.ts";
import { type AgentSession, type PiRuntime, type SessionEntry, SessionManager } from "../runtime/pi-runtime.ts";
import { type LiveSession, SessionRegistry } from "../sessions/session-registry.ts";
import { type RequestMetadata, type SessionMetadata, SessionStore } from "../sessions/session-store.ts";

// 运行上下文只把当前请求的身份、取消信号和停止入口暴露给业务工具。
export interface RunContext {
	requestId: string;
	signal: AbortSignal;
	stop: (code: string) => void;
}
// AgentService 的外部依赖由调用方注入，便于固定工具白名单并隔离 Pi 运行时。
export interface ServiceOptions {
	config: AppConfig;
	runtime: PiRuntime;
	tools: (input: {
		ownerId: string;
		sessionId: string;
		manager: SessionManager;
		getRun: () => RunContext | undefined;
	}) => { extensions: ExtensionFactory[]; toolNames: string[] };
	validate: (reply: string, entries: SessionEntry[]) => Pick<RequestResult, "sources" | "citationValidation">;
	log?: (record: Record<string, unknown>) => void;
}
// active 记录一个正在执行的请求；键是 sessionId，因此同一会话始终只有一个活动请求。
interface ActiveRun {
	metadata: RequestMetadata;
	controller: AbortController;
	stopCode?: string;
	session?: AgentSession;
	listeners: Set<(event: BusinessEvent) => void>;
	sequence: number;
	compactionFailed?: boolean;
	done: Promise<RequestResult>;
	resolve: (result: RequestResult) => void;
}
// submit 返回初始投影；新请求还会提供完成 Promise、事件订阅和幂等启动入口。
export interface Submission {
	duplicate: boolean;
	result: RequestResult;
	done?: Promise<RequestResult>;
	start?: () => void;
	subscribe?: (listener: (event: BusinessEvent) => void) => () => void;
}
// 业务服务负责把持久化会话、Pi 分支和 HTTP 层请求状态编排在一起。
export class AgentService {
	readonly store: SessionStore;
	readonly registry: SessionRegistry;
	private readonly options: ServiceOptions;
	private readonly active = new Map<string, ActiveRun>();
	private readonly reaper: ReturnType<typeof setInterval>;
	private closing = false;
	constructor(options: ServiceOptions) {
		this.options = options;
		this.store = new SessionStore(options.config.dataDir);
		this.registry = new SessionRegistry(options.config, this.store);
		this.reaper = setInterval(() => this.reap(), Math.min(options.config.idleTtlMs, 30000));
		this.reaper.unref();
	}
	// 回收空闲的 Pi 会话；活动请求由 active 集合保护，不会被误释放。
	reap(now?: number): void {
		this.registry.reap(new Set(this.active.keys()), now);
	}
	// 创建业务会话并立即写入对应的 Pi 会话标识，后续请求复用同一历史文件。
	create(ownerId: string): { sessionId: string; createdAt: string; updatedAt: string; status: string } {
		if (this.closing) throw new AppError("SERVICE_BUSY", 503);
		const sessionId = randomUUID();
		const manager = SessionManager.create(
			this.options.config.workspaceDir,
			join(this.store.sessionDir(ownerId, sessionId), "pi"),
		);
		const now = new Date().toISOString();
		const metadata: SessionMetadata = {
			schemaVersion: 1,
			sessionId,
			ownerId,
			piSessionId: manager.getSessionId(),
			piSessionFile: basename(manager.getSessionFile()!),
			createdAt: now,
			updatedAt: now,
			configVersion: this.options.config.configVersion,
			hasConversation: false,
		};
		this.store.writeSession(metadata);
		return { sessionId, createdAt: now, updatedAt: now, status: "idle" };
	}
	// 按更新时间倒序分页列出会话；游标是上一页最后一个 sessionId。
	list(ownerId: string, before?: string, limit = 30) {
		const all = this.store.listSessions(ownerId);
		const index = before ? all.findIndex((item) => item.sessionId === requireId(before)) + 1 : 0;
		const sessions = all.slice(index, index + limit).map((metadata) => this.describe(metadata));
		return { sessions, nextCursor: index + limit < all.length ? sessions.at(-1)?.sessionId : undefined };
	}
	// 读取单个会话的轻量状态，不为查询强制初始化 Pi AgentSession。
	get(ownerId: string, sessionId: string) {
		return this.describe(this.store.readSession(ownerId, requireId(sessionId)));
	}
	private describe(metadata: SessionMetadata) {
		const active = this.active.get(metadata.sessionId);
		return {
			sessionId: metadata.sessionId,
			createdAt: metadata.createdAt,
			updatedAt: metadata.updatedAt,
			status: active ? "running" : "idle",
			activeRequestId: active?.metadata.requestId,
		};
	}
	// 获取可执行的 LiveSession，并让工具通过 getRun 访问当前请求的取消边界。
	private async live(metadata: SessionMetadata): Promise<LiveSession> {
		return this.registry.get(metadata, async (manager) => {
			const tools = this.options.tools({
				ownerId: metadata.ownerId,
				sessionId: metadata.sessionId,
				manager,
				getRun: () => {
					const active = this.active.get(metadata.sessionId);
					return active
						? {
								requestId: active.metadata.requestId,
								signal: active.controller.signal,
								stop: (code) => this.stopRun(active, code),
							}
						: undefined;
				},
			});
			return this.options.runtime.createSession(manager, tools.extensions, tools.toolNames, (type, payload) => {
				const active = this.active.get(metadata.sessionId);
				if (!active) return;
				if (type === "compaction_failed") active.compactionFailed = true;
				else this.publish(metadata.sessionId, active, type, payload);
			});
		});
	}
	// 同步读取需要 Pi manager 时优先复用已打开或正在初始化的 manager。
	private manager(metadata: SessionMetadata): SessionManager {
		return this.registry.peekManager(metadata.sessionId) ?? this.registry.openManager(metadata);
	}
	// 从 Pi 当前分支投影出业务消息；未完成请求会先依据持久化状态尝试恢复。
	messages(ownerId: string, sessionId: string, before?: string, limit = 50) {
		const metadata = this.store.readSession(ownerId, requireId(sessionId));
		const manager = this.manager(metadata);
		const branch = manager.getBranch();
		const requests = this.store.listRequests(ownerId, sessionId);
		for (const request of requests) {
			if (!isTerminal(request.status) && this.active.get(sessionId)?.metadata.requestId !== request.requestId)
				this.recover(metadata, request);
		}
		const answerRequests = new Map(
			requests.filter((request) => request.answerEntryId).map((request) => [request.answerEntryId!, request]),
		);
		const requestsById = new Map(requests.map((request) => [request.requestId, request]));
		let requestId: string | undefined;
		const messages: {
			entryId: string;
			requestId?: string;
			role: string;
			content: string;
			status?: string;
			sources?: RequestResult["sources"];
			citationValidation?: RequestResult["citationValidation"];
		}[] = [];
		for (const entry of branch) {
			// request_state 是请求边界；它把后续用户消息和最终助手回答关联起来。
			if (entry.type === "custom" && entry.customType === "pcb.request_state") {
				const data = entry.data as Partial<RequestMetadata> | undefined;
				if (typeof data?.requestId === "string") requestId = data.requestId;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user")
				messages.push({
					entryId: entry.id,
					requestId,
					role: "user",
					content: textOf(message),
					status: requestId ? requestsById.get(requestId)?.status : undefined,
				});
			if (message.role === "assistant") {
				const request = answerRequests.get(entry.id);
				// 中间助手或工具调用轮次不是独立的最终回答，只有已登记 answerEntryId 的消息对外可见。
				if (request)
					messages.push({
						entryId: entry.id,
						requestId: request.requestId,
						role: "assistant",
						content: textOf(message),
						status: request.status,
						...this.options.validate(textOf(message), branch),
					});
			}
		}
		const end = before ? messages.findIndex((message) => message.entryId === before) : messages.length;
		if (end < 0) throw new AppError("INVALID_INPUT", 400);
		const start = Math.max(0, end - limit);
		return { messages: messages.slice(start, end), nextCursor: start > 0 ? messages[start]?.entryId : undefined };
	}
	// 查询单个请求；进程重启后，仍未结束且没有活动执行体的请求会先进入恢复流程。
	request(ownerId: string, sessionId: string, requestId: string): RequestResult {
		const metadata = this.store.readSession(ownerId, requireId(sessionId));
		const request = this.store.readRequest(ownerId, sessionId, requireId(requestId));
		if (!request) throw new AppError("REQUEST_NOT_FOUND", 404);
		if (!isTerminal(request.status) && this.active.get(sessionId)?.metadata.requestId !== requestId)
			this.recover(metadata, request);
		return this.project(metadata, request);
	}
	// 用 Pi 中最后一条终态 request_state 恢复元数据；找不到终态时保守标为 interrupted。
	private recover(metadata: SessionMetadata, request: RequestMetadata): void {
		const manager = this.manager(metadata);
		const state = manager
			.getBranch()
			.findLast(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "pcb.request_state" &&
					(entry.data as Partial<RequestMetadata>)?.requestId === request.requestId &&
					isTerminal((entry.data as RequestMetadata).status),
			);
		if (state?.type === "custom") {
			const saved = state.data as RequestMetadata;
			Object.assign(request, {
				status: saved.status,
				startEntryId: saved.startEntryId,
				answerEntryId: saved.answerEntryId,
				errorCode: saved.errorCode,
			});
		} else {
			request.status = "interrupted";
			request.errorCode = "REQUEST_INTERRUPTED";
			const branch = manager.getBranch();
			const start = branch.findIndex(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "pcb.request_state" &&
					(entry.data as Partial<RequestMetadata>)?.requestId === request.requestId,
			);
			if (start >= 0) {
				request.startEntryId = branch[start].id;
				const next = branch.findIndex(
					(entry, index) =>
						index > start &&
						entry.type === "custom" &&
						entry.customType === "pcb.request_state" &&
						(entry.data as Partial<RequestMetadata>)?.requestId !== request.requestId,
				);
				const answer = branch
					.slice(start + 1, next >= 0 ? next : undefined)
					.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				request.answerEntryId = answer?.id;
			}
		}
		request.updatedAt = new Date().toISOString();
		this.store.writeRequest(metadata.ownerId, metadata.sessionId, request);
	}
	// 将请求元数据和 Pi 分支投影为协议结果，并只统计当前请求边界内的用量。
	private project(metadata: SessionMetadata, request: RequestMetadata, entries?: SessionEntry[]): RequestResult {
		const branch =
			entries ?? (isTerminal(request.status) && request.answerEntryId ? this.manager(metadata).getBranch() : []);
		const answer = branch.find((entry) => entry.id === request.answerEntryId);
		const reply = answer?.type === "message" && answer.message.role === "assistant" ? textOf(answer.message) : "";
		const usageEntries = request.startEntryId
			? branch.slice(branch.findIndex((entry) => entry.id === request.startEntryId) + 1)
			: [];
		const usage: NonNullable<RequestResult["usage"]> = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		};
		for (const entry of usageEntries) {
			if (
				entry.type === "custom" &&
				entry.customType === "pcb.request_state" &&
				(entry.data as Partial<RequestMetadata>)?.requestId !== request.requestId
			)
				break;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const current = entry.message.usage;
				usage.input += current.input;
				usage.output += current.output;
				usage.cacheRead += current.cacheRead;
				usage.cacheWrite += current.cacheWrite;
				usage.totalTokens += current.totalTokens;
				usage.cost += current.cost.total;
			}
		}
		const message = answer?.type === "message" && answer.message.role === "assistant" ? answer.message : undefined;
		return {
			sessionId: metadata.sessionId,
			requestId: request.requestId,
			status: request.status,
			reply,
			...this.options.validate(reply, branch),
			errorCode: request.errorCode,
			model: message ? `${message.provider}/${message.model}` : undefined,
			usage,
		};
	}
	// 受理请求时先校验、持久化并占用会话，再异步启动执行；相同 requestId 通过消息哈希幂等返回。
	submit(ownerId: string, sessionId: string, input: { requestId: unknown; message: unknown }): Submission {
		requireId(sessionId);
		const requestId = requireId(input.requestId);
		if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 16000)
			throw new AppError("INVALID_INPUT", 400);
		const metadata = this.store.readSession(ownerId, sessionId);
		const hash = createHash("sha256").update(input.message).digest("hex");
		const previous = this.store.readRequest(ownerId, sessionId, requestId);
		if (previous) {
			if (previous.messageHash !== hash) throw new AppError("REQUEST_ID_CONFLICT", 409);
			return { duplicate: true, result: this.request(ownerId, sessionId, requestId) };
		}
		if (this.closing) throw new AppError("SERVICE_BUSY", 503);
		if (this.active.has(sessionId)) throw new AppError("SESSION_BUSY", 409);
		if (this.active.size >= this.options.config.maxActiveRequests) throw new AppError("SERVICE_BUSY", 429);
		// 校验、持久化受理和资源预留同步完成，避免检查与使用之间出现竞态窗口。
		const now = new Date().toISOString();
		const request: RequestMetadata = {
			schemaVersion: 1,
			requestId,
			messageHash: hash,
			status: "accepted",
			createdAt: now,
			updatedAt: now,
		};
		this.store.writeRequest(ownerId, sessionId, request);
		let resolve!: ActiveRun["resolve"];
		const done = new Promise<RequestResult>((finish) => {
			resolve = finish;
		});
		const run: ActiveRun = {
			metadata: request,
			controller: new AbortController(),
			listeners: new Set(),
			sequence: 0,
			done,
			resolve,
		};
		this.active.set(sessionId, run);
		let started = false;
		const message = input.message;
		const start = () => {
			if (!started) {
				started = true;
				void this.execute(metadata, run, message);
			}
		};
		queueMicrotask(start);
		return {
			duplicate: false,
			result: this.project(metadata, request),
			done,
			subscribe: (listener) => {
				run.listeners.add(listener);
				return () => run.listeners.delete(listener);
			},
			start,
		};
	}
	// 记录一次停止原因并立即触发请求信号，再异步通知 Pi；不在 Pi 回调内等待 abort，避免回调自等待。
	private stopRun(run: ActiveRun, code: string): void {
		if (isTerminal(run.metadata.status)) return;
		run.stopCode ??= code;
		run.controller.abort();
		queueMicrotask(() => {
			void run.session?.abort().catch(() => {});
		});
	}
	// 取消只作用于仍由本实例持有的目标请求；完成请求直接返回已有结果。
	async cancel(ownerId: string, sessionId: string, requestId: string): Promise<RequestResult> {
		const result = this.request(ownerId, sessionId, requestId);
		if (isTerminal(result.status)) return result;
		const run = this.active.get(sessionId);
		if (!run || run.metadata.requestId !== requestId) return result;
		this.stopRun(run, "REQUEST_CANCELLED");
		return run.done;
	}
	// 执行生命周期：发出开始事件、运行 Pi、记录终态和用量、持久化，再完成等待者。
	private async execute(metadata: SessionMetadata, run: ActiveRun, message: string): Promise<void> {
		const started = Date.now();
		const emit = (type: string, payload: unknown) => this.publish(metadata.sessionId, run, type, payload);
		const timer = setTimeout(() => this.stopRun(run, "REQUEST_TIMEOUT"), this.options.config.requestTimeoutMs);
		let unsubscribe: (() => void) | undefined;
		let live: LiveSession | undefined;
		let result: RequestResult;
		try {
			emit("request_started", { status: "accepted" });
			live = await this.live(metadata);
			run.session = live.session;
			run.controller.signal.throwIfAborted();
			run.metadata.status = "running";
			run.metadata.startEntryId = live.manager.appendCustomEntry("pcb.request_state", { ...run.metadata });
			this.store.writeRequest(metadata.ownerId, metadata.sessionId, run.metadata);
			const beforeIds = new Set(live.manager.getBranch().map((entry) => entry.id));
			unsubscribe = live.session.subscribe((event) => {
				if (event.type === "compaction_start") run.compactionFailed = false;
				const mapped = adaptPiEvent(event);
				if (event.type === "compaction_end" && run.compactionFailed)
					emit("context_compacted", { reason: event.reason, status: "failed", errorCode: "COMPACTION_FAILED" });
				else if (mapped) emit(mapped.type, mapped.payload);
				if (["tool_execution_end", "compaction_end", "auto_retry_start"].includes(event.type))
					this.options.log?.({
						sessionId: metadata.sessionId,
						requestId: run.metadata.requestId,
						type: mapped?.type,
						elapsedMs: Date.now() - started,
						payload: mapped?.payload,
					});
			});
			if (!live.session.model) throw new AppError("MODEL_UNAVAILABLE", 503);
			// HTTP 边界把输入视为字面文本，不在这里解释技能或斜杠命令。
			await live.session.prompt(message, { expandPromptTemplates: false });
			await live.session.waitForIdle();
			const answer = live.manager
				.getBranch()
				.findLast(
					(entry) => !beforeIds.has(entry.id) && entry.type === "message" && entry.message.role === "assistant",
				);
			if (answer?.type === "message" && answer.message.role === "assistant") {
				run.metadata.answerEntryId = answer.id;
				const reason = answer.message.stopReason;
				run.metadata.status =
					!run.stopCode && reason === "stop"
						? "succeeded"
						: run.stopCode === "REQUEST_CANCELLED" || run.stopCode === "SERVICE_SHUTDOWN"
							? "cancelled"
							: "failed";
				if (run.metadata.status !== "succeeded")
					run.metadata.errorCode = run.stopCode ?? (reason === "length" ? "OUTPUT_LIMIT" : "MODEL_ERROR");
			} else {
				run.metadata.status = run.stopCode === "REQUEST_CANCELLED" ? "cancelled" : "failed";
				run.metadata.errorCode = run.stopCode ?? "MODEL_ERROR";
			}
		} catch (error) {
			run.metadata.status =
				run.stopCode === "REQUEST_CANCELLED" || run.stopCode === "SERVICE_SHUTDOWN" ? "cancelled" : "failed";
			run.metadata.errorCode = run.stopCode ?? (error instanceof AppError ? error.code : "AGENT_ERROR");
			if (live) {
				await live.session.abort().catch(() => {});
				const branch = live.manager.getBranch();
				const start = branch.findIndex((entry) => entry.id === run.metadata.startEntryId);
				const answer = branch
					.slice(start + 1)
					.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (answer) run.metadata.answerEntryId = answer.id;
			}
		} finally {
			clearTimeout(timer);
			unsubscribe?.();
		}
		// 结束时先（若已建立 live 会话）把终态 request_state 写入 Pi 分支，再写请求索引；两步非原子，重启恢复以分支终态快照修复索引。
		try {
			run.metadata.updatedAt = new Date().toISOString();
			if (live) {
				live.manager.appendCustomEntry("pcb.request_state", { ...run.metadata });
				metadata.hasConversation = live.manager
					.getBranch()
					.some((entry) => entry.type === "message" && entry.message.role === "user");
				metadata.updatedAt = run.metadata.updatedAt;
				live.lastUsed = Date.now();
				this.store.writeSession(metadata);
			}
			this.store.writeRequest(metadata.ownerId, metadata.sessionId, run.metadata);
			result = this.project(metadata, run.metadata, live?.manager.getBranch());
		} catch {
			run.metadata.status = "interrupted";
			result = {
				sessionId: metadata.sessionId,
				requestId: run.metadata.requestId,
				status: "interrupted",
				reply: "",
				sources: [],
				citationValidation: { status: "not_applicable", invalidIds: [] },
				errorCode: "REQUEST_PERSISTENCE_FAILED",
			};
		}
		this.active.delete(metadata.sessionId);
		emit("request_finished", result);
		run.listeners.clear();
		run.resolve(result);
		this.options.log?.({
			sessionId: metadata.sessionId,
			requestId: run.metadata.requestId,
			status: result.status,
			errorCode: result.errorCode,
			model: result.model,
			usage: result.usage,
			elapsedMs: Date.now() - started,
		});
	}
	// 为每个业务事件分配单调序号；失效的订阅者会被移除，不影响请求本身。
	private publish(sessionId: string, run: ActiveRun, type: string, payload: unknown): void {
		const event: BusinessEvent = {
			sessionId,
			requestId: run.metadata.requestId,
			sequence: ++run.sequence,
			type,
			payload,
		};
		for (const listener of run.listeners) {
			try {
				listener(event);
			} catch {
				run.listeners.delete(listener);
			}
		}
	}
	// 停止接收新请求，取消并等待所有活动请求，再释放缓存的 Pi 会话。
	async close(): Promise<void> {
		this.closing = true;
		clearInterval(this.reaper);
		for (const run of this.active.values()) this.stopRun(run, "SERVICE_SHUTDOWN");
		await Promise.all([...this.active.values()].map((run) => run.done));
		await Promise.allSettled(this.registry.pending.values());
		this.registry.dispose();
	}
}
// Pi 消息内容可能是纯字符串或多段内容；这里只提取文本段供业务协议使用。
function textOf(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
