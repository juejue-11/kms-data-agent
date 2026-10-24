import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppConfig } from "../config.ts";
import { AppError } from "../contracts/protocol.ts";
import { type AgentSession, SessionManager } from "../runtime/pi-runtime.ts";
import type { SessionMetadata, SessionStore } from "./session-store.ts";

// 已打开的 Pi manager、AgentSession 及最近使用时间组成一个可复用的活动会话。
export interface LiveSession {
	manager: SessionManager;
	session: AgentSession;
	lastUsed: number;
}
// SessionRegistry 去重并发初始化，同时按空闲时间释放 AgentSession。
export class SessionRegistry {
	readonly instances = new Map<string, LiveSession>();
	readonly pending = new Map<string, Promise<LiveSession>>();
	readonly initializingManagers = new Map<string, SessionManager>();
	private readonly config: AppConfig;
	private readonly store: SessionStore;
	constructor(config: AppConfig, store: SessionStore) {
		this.config = config;
		this.store = store;
	}
	// 同步查询优先拿到已完成实例，其次返回正在初始化的 manager 供恢复读取。
	peekManager(sessionId: string): SessionManager | undefined {
		return this.instances.get(sessionId)?.manager ?? this.initializingManagers.get(sessionId);
	}
	// 打开并校验 Pi 历史；缺失文件只允许在没有任何持久化对话证据时新建。
	openManager(metadata: SessionMetadata): SessionManager {
		const dir = join(this.store.sessionDir(metadata.ownerId, metadata.sessionId), "pi");
		const file = join(dir, metadata.piSessionFile);
		if (!existsSync(file)) {
			const requests = this.store.listRequests(metadata.ownerId, metadata.sessionId);
			if (
				metadata.hasConversation ||
				requests.some(
					(request) =>
						request.answerEntryId ||
						(request.startEntryId && ["running", "succeeded", "interrupted"].includes(request.status)),
				)
			)
				throw new AppError("SESSION_RECOVERY_FAILED", 500);
			const manager = SessionManager.create(this.config.workspaceDir, dir);
			metadata.piSessionId = manager.getSessionId();
			metadata.piSessionFile = basename(manager.getSessionFile()!);
			this.store.writeSession(metadata);
			return manager;
		}
		try {
			// Pi 读取器会容忍坏行，业务恢复必须先拒绝损坏的历史文件。
			const lines = readFileSync(file, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			if (lines[0]?.type !== "session" || lines[0]?.id !== metadata.piSessionId)
				throw new Error("Invalid Pi header");
			const ids = new Set<string>();
			for (const entry of lines.slice(1)) {
				// 每个条目只能出现一次，父节点必须已在前文出现，保证树结构完整。
				if (
					typeof entry.id !== "string" ||
					!entry.id ||
					ids.has(entry.id) ||
					(entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
				)
					throw new Error("Invalid Pi entry tree");
				ids.add(entry.id);
			}
			const manager = SessionManager.open(file, dir, this.config.workspaceDir);
			if (manager.getSessionId() !== metadata.piSessionId) throw new Error("Pi session mismatch");
			// 元数据声称有对话时，至少要能在 Pi 分支中找到用户或助手消息。
			if (
				metadata.hasConversation &&
				!manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
					)
			)
				throw new Error("Pi conversation is missing");
			return manager;
		} catch {
			throw new AppError("SESSION_RECOVERY_FAILED", 500);
		}
	}
	// 复用现有实例，并以 pending Promise 合并同一会话的并发初始化请求。
	async get(
		metadata: SessionMetadata,
		factory: (manager: SessionManager) => Promise<AgentSession>,
	): Promise<LiveSession> {
		const current = this.instances.get(metadata.sessionId);
		if (current) {
			current.lastUsed = Date.now();
			return current;
		}
		const pending = this.pending.get(metadata.sessionId);
		if (pending) return pending;
		const task = (async () => {
			const manager = this.openManager(metadata);
			// 初始化期间登记 manager，使同步恢复路径不会重复打开同一文件。
			this.initializingManagers.set(metadata.sessionId, manager);
			const session = await factory(manager);
			const live = { manager, session, lastUsed: Date.now() };
			this.instances.set(metadata.sessionId, live);
			return live;
		})();
		this.pending.set(metadata.sessionId, task);
		try {
			return await task;
		} finally {
			this.pending.delete(metadata.sessionId);
			this.initializingManagers.delete(metadata.sessionId);
		}
	}
	// 只回收不忙、不在初始化且超过空闲 TTL 的实例。
	reap(busy: ReadonlySet<string>, now = Date.now()): void {
		for (const [id, live] of this.instances) {
			if (!busy.has(id) && !this.pending.has(id) && now - live.lastUsed >= this.config.idleTtlMs) {
				live.session.dispose();
				this.instances.delete(id);
			}
		}
	}
	// 删除前等待正在初始化的 AgentSession，避免目录清理后异步工厂又写回 Pi 文件。
	async waitForInitialization(sessionId: string): Promise<void> {
		const pending = this.pending.get(sessionId);
		if (pending) await Promise.allSettled([pending]);
	}
	// 删除会话时先释放缓存实例和初始化残留；调用方需先等待 pending 完成。
	disposeSession(sessionId: string): void {
		const live = this.instances.get(sessionId);
		live?.session.dispose();
		this.instances.delete(sessionId);
		this.initializingManagers.delete(sessionId);
	}
	// 服务关闭时释放所有 AgentSession；未完成的初始化由调用方先等待。
	dispose(): void {
		for (const live of this.instances.values()) live.session.dispose();
		this.instances.clear();
		this.initializingManagers.clear();
	}
}
