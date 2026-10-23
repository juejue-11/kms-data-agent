import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 显式授权的跨会话业务记忆存储。读取按 owner、范围和有效时间过滤，写入按主体和范围授权；
 * 持久化快照使用临时文件写入后 rename，避免进程中断留下半个 JSON 文件。
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export type MemoryConfirmationStatus = "statement" | "confirmed" | "inference";

/** 范围保持为小型可序列化值，由调用方决定其租户模型。 */
export type MemoryScope = string | { kind: string; id?: string };

export interface MemoryPrincipal {
	ownerId: string;
	organizationId?: string;
	/** 调用方显式授权的附加范围键。 */
	scopes?: readonly MemoryScope[];
}

export interface MemoryDraft {
	/** save 的输入必须带确认状态和来源；scope/时间字段可省略并由存储层补默认值。 */
	kind: string;
	value: JsonValue;
	confirmationStatus: MemoryConfirmationStatus;
	sourceSessionId: string;
	sourceEntryId: string;
	scope?: MemoryScope;
	organizationId?: string;
	validFrom?: string | Date;
	validTo?: string | Date;
}

export interface MemoryUpdate {
	/** update 的字段均可选；未提供的字段沿用当前版本。 */
	kind?: string;
	value?: JsonValue;
	confirmationStatus?: MemoryConfirmationStatus;
	sourceSessionId?: string;
	sourceEntryId?: string;
	scope?: MemoryScope;
	organizationId?: string;
	validFrom?: string | Date;
	validTo?: string | Date;
}

export interface MemoryRecord {
	/** 每个版本有独立 memoryId；ownerId 和 scope 决定可见性。 */
	memoryId: string;
	ownerId: string;
	organizationId?: string;
	kind: string;
	value: JsonValue;
	confirmationStatus: MemoryConfirmationStatus;
	scope: MemoryScope;
	sourceSessionId: string;
	sourceEntryId: string;
	validFrom: string;
	validTo?: string;
	createdAt: string;
	updatedAt: string;
	version: number;
	/** 由 update() 创建时指向被替换的上一版本。 */
	supersedes?: string;
}

export interface MemoryQuery {
	/** 对 kind 和 JSON value 的显式文本查询；search("*") 表示显式列出全部有效记忆。 */
	text?: string;
	kind?: string;
	scope?: MemoryScope;
	confirmationStatus?: MemoryConfirmationStatus | readonly MemoryConfirmationStatus[];
	at?: string | Date;
	limit?: number;
}

export interface MemoryStoreOptions {
	/** 可选的 JSON 快照路径；省略时使用隔离的内存存储。 */
	storagePath?: string;
	now?: () => Date;
	idFactory?: () => string;
}

interface StoredMemoryRecord extends MemoryRecord {
	deletedAt?: string;
	supersededBy?: string;
}

export type MemoryActor = MemoryPrincipal | string;

export class MemoryStoreError extends Error {
	readonly code: "INVALID_MEMORY" | "UNAUTHORISED" | "MEMORY_NOT_FOUND" | "INVALID_TIME_RANGE" | "STORAGE_ERROR";

	constructor(code: MemoryStoreError["code"], message: string) {
		super(message);
		this.name = "MemoryStoreError";
		this.code = code;
	}
}

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_QUERY_LENGTH = 1000;
const MAX_VALUE_BYTES = 8 * 1024;

function clone<T>(value: T): T {
	// 返回与内部 Map 脱离的 JSON 副本，防止调用方直接修改存储状态。
	return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeActor(actor: MemoryActor): MemoryPrincipal {
	// 兼容只传 ownerId 的简写，同时把主体字段规范化后用于所有授权判断。
	const principal = typeof actor === "string" ? { ownerId: actor } : actor;
	if (!principal || typeof principal.ownerId !== "string" || principal.ownerId.trim().length === 0) {
		throw new MemoryStoreError("UNAUTHORISED", "A non-empty ownerId is required");
	}
	return {
		ownerId: principal.ownerId.trim(),
		organizationId: principal.organizationId?.trim() || undefined,
		scopes: principal.scopes,
	};
}

function normalizeScope(scope: MemoryScope | undefined, ownerId: string): MemoryScope {
	// 未指定范围时绑定到 owner；对象范围只保留 kind/id，后续以稳定键比较。
	if (scope === undefined) return { kind: "owner", id: ownerId };
	if (typeof scope === "string") {
		const value = scope.trim();
		if (!value) throw new MemoryStoreError("INVALID_MEMORY", "scope must not be empty");
		return value;
	}
	if (!scope || typeof scope.kind !== "string" || scope.kind.trim().length === 0) {
		throw new MemoryStoreError("INVALID_MEMORY", "scope.kind must not be empty");
	}
	return { kind: scope.kind.trim(), id: scope.id?.trim() || undefined };
}

function scopeKey(scope: MemoryScope): string {
	// 字符串范围和对象范围归一成同一比较键，供授权和查询过滤复用。
	return typeof scope === "string" ? scope : `${scope.kind}${scope.id ? `:${scope.id}` : ""}`;
}

function isOwnerScope(scope: MemoryScope, ownerId: string): boolean {
	// owner 范围允许默认归属或当前 ownerId；记录级 ownerId 过滤会阻止读取别人的默认记忆。
	if (typeof scope === "string") return scope === "owner" || scope === `owner:${ownerId}`;
	return scope.kind === "owner" && (!scope.id || scope.id === ownerId);
}

function isScopeAuthorised(principal: MemoryPrincipal, scope: MemoryScope): boolean {
	// 授权顺序为 owner、主体显式范围/通配符、同组织范围；任何未命中的范围都拒绝。
	if (isOwnerScope(scope, principal.ownerId)) return true;
	const requested = scopeKey(scope);
	const authorised = new Set((principal.scopes ?? []).map(scopeKey));
	if (authorised.has(requested) || authorised.has("*")) return true;
	if (
		typeof scope === "string" &&
		scope.startsWith("organization:") &&
		scope.slice("organization:".length) === principal.organizationId
	) {
		return true;
	}
	if (typeof scope !== "string" && scope.kind === "organization" && scope.id === principal.organizationId) {
		return true;
	}
	return false;
}

function parseTime(value: string | Date | undefined, field: string, fallback: Date): string {
	// 所有时间统一转 ISO 字符串，保证快照和比较逻辑使用同一时区表示。
	const date = value === undefined ? fallback : value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new MemoryStoreError("INVALID_MEMORY", `${field} must be a valid date`);
	}
	return date.toISOString();
}

function isEffective(record: StoredMemoryRecord, at: Date): boolean {
	// 只有未删除、未被替换且处于 [validFrom, validTo) 的版本才可被读取。
	if (record.deletedAt || record.supersededBy) return false;
	const timestamp = at.getTime();
	const from = Date.parse(record.validFrom);
	const to = record.validTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(record.validTo);
	return timestamp >= from && timestamp < to;
}

function validateTimeRange(validFrom: string, validTo: string | undefined): void {
	// 结束时间必须严格晚于开始时间，避免产生永远无效的记忆版本。
	if (validTo !== undefined && Date.parse(validTo) <= Date.parse(validFrom)) {
		throw new MemoryStoreError("INVALID_TIME_RANGE", "validTo must be later than validFrom");
	}
}

function validateDraft(draft: MemoryDraft | MemoryUpdate, partial: boolean): void {
	// save 要求完整字段，update 允许部分字段；两者共用值大小、确认状态和来源校验。
	if (!partial || draft.kind !== undefined) {
		if (typeof draft.kind !== "string" || draft.kind.trim().length === 0) {
			throw new MemoryStoreError("INVALID_MEMORY", "kind must not be empty");
		}
	}
	if (!partial || draft.value !== undefined) {
		if (draft.value === undefined) throw new MemoryStoreError("INVALID_MEMORY", "value is required");
		try {
			const serialised = JSON.stringify(draft.value);
			if (typeof serialised !== "string") throw new Error("value is not JSON serialisable");
			if (new TextEncoder().encode(serialised).byteLength > MAX_VALUE_BYTES) {
				throw new MemoryStoreError("INVALID_MEMORY", `value must be at most ${MAX_VALUE_BYTES} bytes as JSON`);
			}
		} catch (error) {
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError("INVALID_MEMORY", "value must be JSON serialisable and within the size limit");
		}
	}
	if (!partial || draft.confirmationStatus !== undefined) {
		if (!["statement", "confirmed", "inference"].includes(draft.confirmationStatus ?? "")) {
			throw new MemoryStoreError("INVALID_MEMORY", "confirmationStatus is invalid");
		}
	}
	for (const field of ["sourceSessionId", "sourceEntryId"] as const) {
		if (!partial || draft[field] !== undefined) {
			if (typeof draft[field] !== "string" || draft[field].trim().length === 0) {
				throw new MemoryStoreError("INVALID_MEMORY", `${field} must not be empty`);
			}
		}
	}
}

function validateStoredRecord(value: unknown): value is StoredMemoryRecord {
	// 从磁盘读取的对象必须拒绝未知字段和非法时间/范围，防止损坏快照污染内存状态。
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const allowedKeys = new Set([
		"memoryId",
		"ownerId",
		"organizationId",
		"kind",
		"value",
		"confirmationStatus",
		"scope",
		"sourceSessionId",
		"sourceEntryId",
		"validFrom",
		"validTo",
		"createdAt",
		"updatedAt",
		"version",
		"supersedes",
		"deletedAt",
		"supersededBy",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	const record = value as Partial<StoredMemoryRecord>;
	return (
		typeof record.memoryId === "string" &&
		record.memoryId.trim().length > 0 &&
		typeof record.ownerId === "string" &&
		record.ownerId.trim().length > 0 &&
		typeof record.kind === "string" &&
		record.kind.trim().length > 0 &&
		record.value !== undefined &&
		["statement", "confirmed", "inference"].includes(record.confirmationStatus ?? "") &&
		isValidScope(record.scope) &&
		typeof record.sourceSessionId === "string" &&
		record.sourceSessionId.trim().length > 0 &&
		typeof record.sourceEntryId === "string" &&
		record.sourceEntryId.trim().length > 0 &&
		typeof record.validFrom === "string" &&
		!Number.isNaN(Date.parse(record.validFrom)) &&
		(record.validTo === undefined ||
			(typeof record.validTo === "string" && !Number.isNaN(Date.parse(record.validTo)))) &&
		(record.validTo === undefined || Date.parse(record.validTo) > Date.parse(record.validFrom)) &&
		typeof record.createdAt === "string" &&
		!Number.isNaN(Date.parse(record.createdAt)) &&
		typeof record.updatedAt === "string" &&
		!Number.isNaN(Date.parse(record.updatedAt)) &&
		typeof record.version === "number" &&
		Number.isInteger(record.version) &&
		record.version > 0 &&
		(record.organizationId === undefined ||
			(typeof record.organizationId === "string" && record.organizationId.trim().length > 0)) &&
		(record.deletedAt === undefined ||
			(typeof record.deletedAt === "string" && !Number.isNaN(Date.parse(record.deletedAt)))) &&
		(record.supersedes === undefined ||
			(typeof record.supersedes === "string" && record.supersedes.trim().length > 0)) &&
		(record.supersededBy === undefined ||
			(typeof record.supersededBy === "string" && record.supersededBy.trim().length > 0)) &&
		isJsonValueWithinLimit(record.value)
	);
}

function isValidScope(value: unknown): value is MemoryScope {
	// 范围只能是非空字符串或仅含 kind/id 的对象。
	if (typeof value === "string") return value.trim().length > 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const scope = value as { kind?: unknown; id?: unknown };
	if (Object.keys(scope).some((key) => key !== "kind" && key !== "id")) return false;
	return (
		typeof scope.kind === "string" &&
		scope.kind.trim().length > 0 &&
		(scope.id === undefined || (typeof scope.id === "string" && scope.id.trim().length > 0))
	);
}

function isJsonValueWithinLimit(value: unknown): value is JsonValue {
	// 用与写入路径相同的 JSON UTF-8 字节上限验证快照中的 value。
	try {
		const serialised = JSON.stringify(value);
		return typeof serialised === "string" && new TextEncoder().encode(serialised).byteLength <= MAX_VALUE_BYTES;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 独立且需显式启用的业务记忆存储。本类从不读取 Pi 会话历史，记录只会在显式 save/update 调用后出现。
 */
export class MemoryStore {
	private readonly storagePath: string | undefined;
	private readonly now: () => Date;
	private readonly idFactory: () => string;
	private readonly records = new Map<string, StoredMemoryRecord>();
	private loaded = false;
	private loading: Promise<void> | undefined;
	private mutations: Promise<void> = Promise.resolve();

	constructor(options: MemoryStoreOptions = {}) {
		// storagePath 为空时只保存在当前实例；提供路径时懒加载快照并串行化后续变更。
		this.storagePath = options.storagePath;
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? (() => `mem_${randomUUID()}`);
	}

	async save(actor: MemoryActor, draft: MemoryDraft): Promise<MemoryRecord>;
	async save(draft: MemoryDraft & { ownerId: string }): Promise<MemoryRecord>;
	async save(
		actorOrDraft: MemoryActor | (MemoryDraft & { ownerId: string }),
		maybeDraft?: MemoryDraft,
	): Promise<MemoryRecord> {
		// 先解析主体并加载快照，再在串行 mutation 中分配 ID、校验时间并写入新版本。
		const { principal, draft } = maybeDraft
			? { principal: normalizeActor(actorOrDraft as MemoryActor), draft: maybeDraft }
			: {
					principal: normalizeActor((actorOrDraft as MemoryDraft & { ownerId: string }).ownerId),
					draft: actorOrDraft as MemoryDraft,
				};
		await this.ensureLoaded();
		validateDraft(draft, false);
		const scope = normalizeScope(draft.scope, principal.ownerId);
		if (!isScopeAuthorised(principal, scope)) {
			throw new MemoryStoreError("UNAUTHORISED", "The principal is not authorised for this memory scope");
		}
		return this.mutate(async () => {
			const now = this.now();
			const validFrom = parseTime(draft.validFrom, "validFrom", now);
			const validTo = draft.validTo === undefined ? undefined : parseTime(draft.validTo, "validTo", now);
			validateTimeRange(validFrom, validTo);
			const record: StoredMemoryRecord = {
				memoryId: this.idFactory(),
				ownerId: principal.ownerId,
				organizationId: draft.organizationId ?? principal.organizationId,
				kind: draft.kind.trim(),
				value: clone(draft.value),
				confirmationStatus: draft.confirmationStatus,
				scope,
				sourceSessionId: draft.sourceSessionId.trim(),
				sourceEntryId: draft.sourceEntryId.trim(),
				validFrom,
				validTo,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				version: 1,
			};
			this.records.set(record.memoryId, record);
			return { changed: true, result: clone(record) };
		});
	}

	async get(actor: MemoryActor, memoryId: string): Promise<MemoryRecord | undefined> {
		// get 只返回当前主体可见且在查询时刻有效的版本；找不到时保持 undefined。
		const principal = normalizeActor(actor);
		await this.ensureLoaded();
		await this.mutations;
		const record = this.activeRecord(principal, memoryId, this.now());
		return record ? clone(record) : undefined;
	}

	async list(actor: MemoryActor, query: MemoryQuery = {}): Promise<MemoryRecord[]> {
		// list 先按有效时间、owner 和范围过滤，再按更新时间倒序截断，避免泄露无权记录。
		const principal = normalizeActor(actor);
		await this.ensureLoaded();
		await this.mutations;
		const at = query.at === undefined ? this.now() : new Date(query.at);
		if (Number.isNaN(at.getTime())) throw new MemoryStoreError("INVALID_MEMORY", "query.at must be a valid date");
		const limit = query.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
			throw new MemoryStoreError("INVALID_MEMORY", `limit must be an integer between 1 and ${MAX_LIMIT}`);
		}
		const scopeFilter =
			query.scope === undefined ? undefined : scopeKey(normalizeScope(query.scope, principal.ownerId));
		const statuses =
			query.confirmationStatus === undefined
				? undefined
				: new Set(
						(Array.isArray(query.confirmationStatus) ? query.confirmationStatus : [query.confirmationStatus]).map(
							(status) => status,
						),
					);
		const rawText = query.text?.trim();
		if (rawText !== undefined && rawText.length > MAX_QUERY_LENGTH) {
			throw new MemoryStoreError("INVALID_MEMORY", `query must be at most ${MAX_QUERY_LENGTH} characters`);
		}
		const text = rawText?.toLocaleLowerCase();
		const records = [...this.records.values()]
			.filter((record) => isEffective(record, at))
			.filter((record) => record.ownerId === principal.ownerId)
			.filter((record) => isScopeAuthorised(principal, record.scope))
			.filter((record) => scopeFilter === undefined || scopeKey(record.scope) === scopeFilter)
			.filter((record) => query.kind === undefined || record.kind === query.kind)
			.filter((record) => statuses === undefined || statuses.has(record.confirmationStatus))
			.filter((record) => {
				if (!text) return true;
				return `${record.kind} ${JSON.stringify(record.value)}`.toLocaleLowerCase().includes(text);
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, limit);
		return records.map((record) => clone(record));
	}

	async search(actor: MemoryActor, text: string, query: Omit<MemoryQuery, "text"> = {}): Promise<MemoryRecord[]> {
		// 搜索必须是显式非空输入；"*" 仅作为列出当前授权范围的特殊查询。
		if (typeof text !== "string" || text.trim().length === 0) {
			throw new MemoryStoreError("INVALID_MEMORY", "An explicit non-empty search query is required");
		}
		const normalizedText = text.trim();
		if (normalizedText.length > MAX_QUERY_LENGTH) {
			throw new MemoryStoreError("INVALID_MEMORY", `query must be at most ${MAX_QUERY_LENGTH} characters`);
		}
		return this.list(actor, normalizedText === "*" ? query : { ...query, text: normalizedText });
	}

	async update(actor: MemoryActor, memoryId: string, patch: MemoryUpdate): Promise<MemoryRecord> {
		// 更新采用追加版本：新记录获得新 ID 和递增 version，旧记录通过 supersededBy 失效。
		const principal = normalizeActor(actor);
		await this.ensureLoaded();
		await this.mutations;
		const current = this.activeRecord(principal, memoryId, this.now());
		if (!current) throw new MemoryStoreError("MEMORY_NOT_FOUND", `Memory ${memoryId} was not found`);
		validateDraft(patch, true);
		const nextScope = patch.scope === undefined ? current.scope : normalizeScope(patch.scope, principal.ownerId);
		if (!isScopeAuthorised(principal, nextScope)) {
			throw new MemoryStoreError("UNAUTHORISED", "The principal is not authorised for this memory scope");
		}
		return this.mutate(async () => {
			const current = this.activeRecord(principal, memoryId, this.now());
			if (!current) throw new MemoryStoreError("MEMORY_NOT_FOUND", `Memory ${memoryId} was not found`);
			const now = this.now();
			const nextScope = patch.scope === undefined ? current.scope : normalizeScope(patch.scope, principal.ownerId);
			if (!isScopeAuthorised(principal, nextScope)) {
				throw new MemoryStoreError("UNAUTHORISED", "The principal is not authorised for this memory scope");
			}
			const validFrom = parseTime(patch.validFrom, "validFrom", new Date(current.validFrom));
			const validTo = patch.validTo === undefined ? current.validTo : parseTime(patch.validTo, "validTo", now);
			validateTimeRange(validFrom, validTo);
			const next: StoredMemoryRecord = {
				...current,
				memoryId: this.idFactory(),
				kind: patch.kind?.trim() ?? current.kind,
				value: patch.value === undefined ? clone(current.value) : clone(patch.value),
				confirmationStatus: patch.confirmationStatus ?? current.confirmationStatus,
				scope: nextScope,
				organizationId: patch.organizationId ?? current.organizationId,
				sourceSessionId: patch.sourceSessionId?.trim() ?? current.sourceSessionId,
				sourceEntryId: patch.sourceEntryId?.trim() ?? current.sourceEntryId,
				validFrom,
				validTo,
				createdAt: current.createdAt,
				updatedAt: now.toISOString(),
				version: current.version + 1,
				supersedes: current.memoryId,
			};
			current.supersededBy = next.memoryId;
			this.records.set(next.memoryId, next);
			return { changed: true, result: clone(next) };
		});
	}

	async delete(actor: MemoryActor, memoryId: string): Promise<boolean> {
		// 删除只对 owner 和授权范围内的记录生效；当前实现从 Map 移除而不是保留删除墓碑。
		const principal = normalizeActor(actor);
		await this.ensureLoaded();
		return this.mutate(async () => {
			const current = this.records.get(memoryId);
			if (!current || current.ownerId !== principal.ownerId || !isScopeAuthorised(principal, current.scope))
				return { changed: false, result: false };
			this.records.delete(current.memoryId);
			return { changed: true, result: true };
		});
	}

	private activeRecord(principal: MemoryPrincipal, memoryId: string, at: Date): StoredMemoryRecord | undefined {
		// 将归属授权与时间有效性集中在一个入口，供 get/update 复用。
		const record = this.records.get(memoryId);
		if (!record || record.ownerId !== principal.ownerId || !isScopeAuthorised(principal, record.scope))
			return undefined;
		return isEffective(record, at) ? record : undefined;
	}

	private async ensureLoaded(): Promise<void> {
		// 并发首次访问共享一个 loading Promise，避免重复读取或相互覆盖快照。
		if (this.loaded) return;
		if (this.loading) return this.loading;
		this.loading = this.loadSnapshot();
		try {
			await this.loading;
		} finally {
			this.loading = undefined;
		}
	}

	private async loadSnapshot(): Promise<void> {
		// 无路径表示空内存库；有路径时严格检查 schemaVersion、字段集合和每条记录。
		if (!this.storagePath) {
			this.loaded = true;
			return;
		}
		try {
			const raw = await readFile(this.storagePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("snapshot must be an object");
			}
			const snapshot = parsed as { schemaVersion?: unknown; records?: unknown; [key: string]: unknown };
			const keys = Object.keys(snapshot);
			if (keys.some((key) => key !== "schemaVersion" && key !== "records")) {
				throw new Error("snapshot contains unknown fields");
			}
			if (snapshot.schemaVersion !== SCHEMA_VERSION) {
				throw new Error(`unsupported schemaVersion ${String(snapshot.schemaVersion)}`);
			}
			if (!Array.isArray(snapshot.records)) throw new Error("snapshot.records must be an array");
			const records = new Map<string, StoredMemoryRecord>();
			for (const value of snapshot.records) {
				if (!validateStoredRecord(value)) throw new Error("snapshot contains an invalid memory record");
				if (records.has(value.memoryId)) throw new Error(`duplicate memoryId ${value.memoryId}`);
				records.set(value.memoryId, clone(value));
			}
			this.records.clear();
			for (const [memoryId, record] of records) this.records.set(memoryId, record);
			this.loaded = true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				this.loaded = true;
				return;
			}
			throw new MemoryStoreError("STORAGE_ERROR", `Unable to load memory store: ${errorMessage(error)}`);
		}
	}

	private async mutate<T>(operation: () => Promise<{ changed: boolean; result: T }>): Promise<T> {
		// 变更按链串行执行；持久化失败或业务异常时恢复操作前的完整 Map 快照。
		const run = this.mutations.then(async () => {
			const before = new Map<string, StoredMemoryRecord>(
				[...this.records.entries()].map(([memoryId, record]) => [memoryId, clone(record)]),
			);
			try {
				const outcome = await operation();
				if (outcome.changed) await this.persist();
				return outcome.result;
			} catch (error) {
				this.records.clear();
				for (const [memoryId, record] of before) this.records.set(memoryId, record);
				throw error;
			}
		});
		this.mutations = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async persist(): Promise<void> {
		// 先写同目录随机临时文件，再原子 rename 到目标路径，降低半写快照被读取的风险。
		if (!this.storagePath) return;
		const snapshot = JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: [...this.records.values()] }, null, 2);
		const temporaryPath = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await mkdir(dirname(this.storagePath), { recursive: true });
			await writeFile(temporaryPath, snapshot, "utf8");
			await rename(temporaryPath, this.storagePath);
		} catch (error) {
			throw new MemoryStoreError("STORAGE_ERROR", `Unable to persist memory store: ${errorMessage(error)}`);
		}
	}
}
