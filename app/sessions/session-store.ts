import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError, type RequestStatus, requireId } from "../contracts/protocol.ts";

// 会话元数据把业务会话与 Pi 历史文件绑定，并记录恢复所需的持久化状态。
export interface SessionMetadata {
	schemaVersion: 1;
	sessionId: string;
	ownerId: string;
	piSessionId: string;
	piSessionFile: string;
	createdAt: string;
	updatedAt: string;
	configVersion: string;
	hasConversation: boolean;
}
// 请求元数据是幂等、恢复和结果投影的持久化索引，不替代 Pi 分支本身。
export interface RequestMetadata {
	schemaVersion: 1;
	requestId: string;
	messageHash: string;
	status: RequestStatus;
	createdAt: string;
	updatedAt: string;
	startEntryId?: string;
	answerEntryId?: string;
	errorCode?: string;
}
// 通过同目录临时文件加 rename 原子替换 JSON，避免读到半写入内容。
export function atomicJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}
// SessionStore 统一管理按 owner/session 隔离的元数据和请求记录。
export class SessionStore {
	readonly dataDir: string;
	constructor(dataDir: string) {
		this.dataDir = dataDir;
	}
	// owner 使用哈希进入目录名，sessionId 仍经过 requireId 校验，避免路径穿越。
	sessionDir(ownerId: string, sessionId: string): string {
		const ownerKey = createHash("sha256").update(ownerId).digest("hex");
		return join(this.dataDir, "owners", ownerKey, "sessions", requireId(sessionId));
	}
	// 写入完整会话元数据；目录和文件权限由 atomicJson 统一设置。
	writeSession(metadata: SessionMetadata): void {
		atomicJson(join(this.sessionDir(metadata.ownerId, metadata.sessionId), "metadata.json"), metadata);
	}
	// 读取时重新验证身份、文件名和对话标记，损坏数据统一转为恢复失败。
	readSession(ownerId: string, sessionId: string): SessionMetadata {
		const path = join(this.sessionDir(ownerId, sessionId), "metadata.json");
		if (!existsSync(path)) throw new AppError("SESSION_NOT_FOUND", 404);
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
			if (
				value.schemaVersion !== 1 ||
				value.ownerId !== ownerId ||
				value.sessionId !== sessionId ||
				!requireId(value.piSessionId) ||
				!/^[^/\\]+\.jsonl$/.test(value.piSessionFile) ||
				typeof value.hasConversation !== "boolean"
			)
				throw new Error("Invalid metadata");
			return value;
		} catch {
			throw new AppError("SESSION_RECOVERY_FAILED", 500);
		}
	}
	// 只枚举合法 UUID 目录，并按更新时间倒序返回可分页的会话元数据。
	listSessions(ownerId: string): SessionMetadata[] {
		const root = dirname(this.sessionDir(ownerId, randomUUID()));
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
			.map((id) => this.readSession(ownerId, id))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	// 请求文件与 Pi request_state 共同构成恢复记录；这里使用原子写入。
	writeRequest(ownerId: string, sessionId: string, metadata: RequestMetadata): void {
		atomicJson(
			join(this.sessionDir(ownerId, sessionId), "requests", `${requireId(metadata.requestId)}.json`),
			metadata,
		);
	}
	// 读取幂等键对应的请求，并校验状态和消息哈希格式以阻止伪造记录参与恢复。
	readRequest(ownerId: string, sessionId: string, requestId: string): RequestMetadata | undefined {
		const path = join(this.sessionDir(ownerId, sessionId), "requests", `${requireId(requestId)}.json`);
		if (!existsSync(path)) return undefined;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as RequestMetadata;
			if (
				value.schemaVersion !== 1 ||
				value.requestId !== requestId ||
				!["accepted", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(value.status) ||
				!/^[a-f0-9]{64}$/.test(value.messageHash)
			)
				throw new Error("Invalid request");
			return value;
		} catch {
			throw new AppError("SESSION_RECOVERY_FAILED", 500);
		}
	}
	// 枚举一个会话的请求记录；每个文件名都必须能通过 requestId 校验。
	listRequests(ownerId: string, sessionId: string): RequestMetadata[] {
		const path = join(this.sessionDir(ownerId, sessionId), "requests");
		if (!existsSync(path)) return [];
		return readdirSync(path)
			.filter((file) => file.endsWith(".json"))
			.map((file) => this.readRequest(ownerId, sessionId, file.slice(0, -5))!);
	}
}
