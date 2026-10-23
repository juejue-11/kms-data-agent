import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	JsonValue,
	MemoryConfirmationStatus,
	MemoryDraft,
	MemoryPrincipal,
	MemoryScope,
	MemoryStore,
	MemoryUpdate,
} from "./store.ts";
import { MemoryStoreError } from "./store.ts";

export interface MemoryExtensionOptions {
	store: MemoryStore;
	/** 显式 opt-in 开关；除非严格为 true，否则扩展不会注册任何工具。 */
	enabled?: boolean;
	/** 为每次工具调用解析已认证的归属主体。 */
	getPrincipal?: (ctx: ExtensionToolContext) => MemoryPrincipal | undefined | Promise<MemoryPrincipal | undefined>;
	/** 适用于已在嵌入式会话中完成认证的固定主体。 */
	principal?: MemoryPrincipal;
	ownerId?: string;
	organizationId?: string;
	defaultLimit?: number;
	/** 模型省略来源 ID 时解析当前 Pi 业务会话/用户条目来源。 */
	getDefaultSource?: (ctx: ExtensionToolContext) => MemorySource | undefined | Promise<MemorySource | undefined>;
	/** 宿主共享的预算/取消策略钩子，在每个工具体执行前调用。 */
	beforeExecute?: (signal: AbortSignal | undefined, ctx: ExtensionToolContext) => void | Promise<void>;
	/** 校验来源 ID 是否属于已认证会话/条目的宿主钩子。 */
	validateSource?: (sourceSessionId: string, sourceEntryId: string, ctx: ExtensionToolContext) => void | Promise<void>;
	/** 默认前缀为 memory_；只有宿主明确需要无前缀工具名时才设为空字符串。 */
	toolPrefix?: string;
}

export const MEMORY_EXTENSION_TOOL_NAMES = ["memory_list", "memory_save", "memory_update", "memory_delete"] as const;

type MemoryToolOperation = "list" | "save" | "update" | "delete";

export interface MemoryToolDetails {
	/** 工具统一返回结构化成功/失败状态，失败时附带稳定错误码。 */
	ok: boolean;
	operation: MemoryToolOperation;
	errorCode?: string;
	message?: string;
	records?: JsonValue;
	record?: JsonValue;
	deleted?: boolean;
}

export interface MemorySource {
	/** 记忆必须能回指产生它的业务会话和用户条目。 */
	sourceSessionId: string;
	sourceEntryId: string;
}

const MAX_QUERY_LENGTH = 1000;
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_TOOL_LIMIT = 20;

// 工具层限制输入规模，存储层还会再次校验，避免绕过扩展直接写入非法数据。
const JSON_VALUE = Type.Unsafe<JsonValue>(Type.Unknown());
const SCOPE = Type.Union([
	Type.String({ maxLength: MAX_QUERY_LENGTH }),
	Type.Object({
		kind: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
		id: Type.Optional(Type.String({ maxLength: MAX_QUERY_LENGTH })),
	}),
]);

const LIST_PARAMETERS = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_LENGTH,
		description: "An explicit query; use '*' to list all effective memories within the authorized scope.",
	}),
	kind: Type.Optional(Type.String({ maxLength: MAX_QUERY_LENGTH })),
	scope: Type.Optional(SCOPE),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOOL_LIMIT })),
});

const SAVE_PARAMETERS = Type.Object({
	kind: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
	value: JSON_VALUE,
	confirmationStatus: Type.Union([Type.Literal("statement"), Type.Literal("confirmed"), Type.Literal("inference")]),
	sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
	sourceEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
	scope: Type.Optional(SCOPE),
	organizationId: Type.Optional(Type.String({ maxLength: MAX_QUERY_LENGTH })),
	validFrom: Type.Optional(Type.String({ maxLength: 64 })),
	validTo: Type.Optional(Type.String({ maxLength: 64 })),
});

const UPDATE_PARAMETERS = Type.Object({
	memoryId: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
	kind: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
	value: Type.Optional(JSON_VALUE),
	confirmationStatus: Type.Optional(
		Type.Union([Type.Literal("statement"), Type.Literal("confirmed"), Type.Literal("inference")]),
	),
	sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
	sourceEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
	scope: Type.Optional(SCOPE),
	organizationId: Type.Optional(Type.String({ maxLength: MAX_QUERY_LENGTH })),
	validFrom: Type.Optional(Type.String({ maxLength: 64 })),
	validTo: Type.Optional(Type.String({ maxLength: 64 })),
});

const DELETE_PARAMETERS = Type.Object({ memoryId: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }) });

function textResult(details: MemoryToolDetails, text: string): AgentToolResult<MemoryToolDetails> {
	// 所有成功路径同时提供模型可读文本和可供宿主检查的 details。
	return { content: [{ type: "text", text }], details };
}

function errorResult(operation: MemoryToolOperation, error: unknown): AgentToolResult<MemoryToolDetails> {
	// 存储错误转成工具错误结果，避免异常直接丢失稳定的 operation/errorCode 信息。
	const errorCode = error instanceof MemoryStoreError ? error.code : "MEMORY_ERROR";
	const message = error instanceof Error ? error.message : String(error);
	return {
		...textResult({ ok: false, operation, errorCode, message }, `Memory ${operation} failed: ${message}`),
		isError: true,
	};
}

function assertOptionalText(value: unknown, field: string): void {
	if (
		value !== undefined &&
		(typeof value !== "string" || value.trim().length === 0 || value.length > MAX_QUERY_LENGTH)
	) {
		throw new MemoryStoreError("INVALID_MEMORY", `${field} must be 1-${MAX_QUERY_LENGTH} characters`);
	}
}

function scopeFromInput(value: unknown): MemoryScope | undefined {
	// 扩展接受字符串或 { kind, id? }，实际归属授权仍由 MemoryStore 按主体判断。
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		assertOptionalText(value, "scope");
		return value;
	}
	if (value && typeof value === "object" && "kind" in value && typeof value.kind === "string") {
		assertOptionalText(value.kind, "scope.kind");
		const id = "id" in value && typeof value.id === "string" ? value.id : undefined;
		assertOptionalText(id, "scope.id");
		return id ? { kind: value.kind, id } : { kind: value.kind };
	}
	throw new MemoryStoreError("INVALID_MEMORY", "scope must be a string or { kind, id? }");
}

function asJsonValue(value: unknown): JsonValue {
	return value as JsonValue;
}

function assertQuery(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > MAX_QUERY_LENGTH) {
		throw new MemoryStoreError("INVALID_MEMORY", `query must be 1-${MAX_QUERY_LENGTH} characters`);
	}
}

function assertLimit(value: unknown, fallback: number): number {
	const limit = value === undefined ? fallback : value;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_LIMIT) {
		throw new MemoryStoreError("INVALID_MEMORY", `limit must be an integer between 1 and ${MAX_TOOL_LIMIT}`);
	}
	return limit;
}

function assertValueSize(value: unknown): void {
	// 按 UTF-8 字节而非 JavaScript 字符数限制 JSON，和存储层的约束保持一致。
	let serialised: string | undefined;
	try {
		serialised = JSON.stringify(value);
	} catch {
		throw new MemoryStoreError("INVALID_MEMORY", "value must be JSON serialisable");
	}
	if (typeof serialised !== "string" || new TextEncoder().encode(serialised).byteLength > MAX_VALUE_BYTES) {
		throw new MemoryStoreError("INVALID_MEMORY", `value must be at most ${MAX_VALUE_BYTES} bytes as JSON`);
	}
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted();
}

function requireSource(source: Partial<MemorySource>): MemorySource {
	// 来源是审计链的一部分，不能用缺失的 session/entry ID 保存记忆。
	if (
		typeof source.sourceSessionId !== "string" ||
		source.sourceSessionId.trim().length === 0 ||
		typeof source.sourceEntryId !== "string" ||
		source.sourceEntryId.trim().length === 0
	) {
		throw new MemoryStoreError("INVALID_MEMORY", "sourceSessionId and sourceEntryId are required");
	}
	if (source.sourceSessionId.length > MAX_QUERY_LENGTH || source.sourceEntryId.length > MAX_QUERY_LENGTH) {
		throw new MemoryStoreError("INVALID_MEMORY", `source ids must be at most ${MAX_QUERY_LENGTH} characters`);
	}
	return {
		sourceSessionId: source.sourceSessionId.trim(),
		sourceEntryId: source.sourceEntryId.trim(),
	};
}

/**
 * 构建可选的业务记忆 Pi 扩展。它只暴露显式记忆工具；不监听聊天或会话事件，因此不会抽取整段聊天。
 */
export function createMemoryExtension(options: MemoryExtensionOptions): ExtensionFactory {
	const prefix = options.toolPrefix ?? "memory_";
	const defaultLimit =
		options.defaultLimit === undefined
			? MAX_TOOL_LIMIT
			: Math.min(Math.max(Math.trunc(options.defaultLimit), 1), MAX_TOOL_LIMIT);
	const names = {
		list: `${prefix}list`,
		save: `${prefix}save`,
		update: `${prefix}update`,
		delete: `${prefix}delete`,
	};

	return async (pi: ExtensionAPI): Promise<void> => {
		// 记忆能力必须由宿主显式启用，默认关闭可避免未授权的跨会话数据写入。
		if (options.enabled !== true) return;

		const resolvePrincipal = async (ctx: ExtensionToolContext): Promise<MemoryPrincipal> => {
			// 优先使用动态主体，其次使用固定主体或 ownerId；没有认证主体则拒绝操作。
			const principal = options.getPrincipal
				? await options.getPrincipal(ctx)
				: (options.principal ??
					(options.ownerId ? { ownerId: options.ownerId, organizationId: options.organizationId } : undefined));
			if (!principal) throw new MemoryStoreError("UNAUTHORISED", "No authenticated memory owner is available");
			return principal;
		};
		const beforeExecute = async (signal: AbortSignal | undefined, ctx: ExtensionToolContext): Promise<void> => {
			// 宿主策略前后各检查一次取消，避免钩子执行期间取消后仍进入存储操作。
			assertNotAborted(signal);
			await options.beforeExecute?.(signal, ctx);
			assertNotAborted(signal);
		};

		const listTool: ToolDefinition<typeof LIST_PARAMETERS, MemoryToolDetails> = {
			name: names.list,
			label: "List memories",
			description: "Explicitly search effective business memories owned by the current user.",
			promptSnippet: "Search explicitly saved PCB business memories",
			parameters: LIST_PARAMETERS,
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					// query="*" 是显式列出授权范围内有效记忆的约定，普通查询只匹配 kind 和 JSON value。
					await beforeExecute(signal, ctx);
					assertQuery(params.query);
					assertOptionalText(params.kind, "kind");
					scopeFromInput(params.scope);
					const limit = assertLimit(params.limit, defaultLimit);
					const principal = await resolvePrincipal(ctx);
					assertNotAborted(signal);
					const records = await options.store.search(principal, params.query, {
						kind: params.kind,
						scope: scopeFromInput(params.scope),
						limit,
					});
					return textResult(
						{ ok: true, operation: "list", records: records as unknown as JsonValue },
						JSON.stringify({ memories: records }),
					);
				} catch (error) {
					// 列表失败仍返回统一结构，调用方可按 errorCode 决定是否继续。
					return errorResult("list", error);
				}
			},
		};

		const saveTool: ToolDefinition<typeof SAVE_PARAMETERS, MemoryToolDetails> = {
			name: names.save,
			label: "Save memory",
			description: "Explicitly save one user-authorised cross-session business memory.",
			promptSnippet: "Save a specifically requested PCB business memory",
			parameters: SAVE_PARAMETERS,
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					// 保存需要显式主体、范围和来源；缺失任一来源字段时才尝试宿主提供的默认来源。
					await beforeExecute(signal, ctx);
					assertValueSize(params.value);
					assertOptionalText(params.kind, "kind");
					assertOptionalText(params.sourceSessionId, "sourceSessionId");
					assertOptionalText(params.sourceEntryId, "sourceEntryId");
					scopeFromInput(params.scope);
					const principal = await resolvePrincipal(ctx);
					const defaultSource =
						params.sourceSessionId === undefined || params.sourceEntryId === undefined
							? await options.getDefaultSource?.(ctx)
							: undefined;
					const source = requireSource({
						sourceSessionId: params.sourceSessionId ?? defaultSource?.sourceSessionId,
						sourceEntryId: params.sourceEntryId ?? defaultSource?.sourceEntryId,
					});
					// 来源归属校验发生在写入前，防止把其他会话的条目挂到当前主体名下。
					const draft: MemoryDraft = {
						kind: params.kind,
						value: asJsonValue(params.value),
						confirmationStatus: params.confirmationStatus as MemoryConfirmationStatus,
						sourceSessionId: source.sourceSessionId,
						sourceEntryId: source.sourceEntryId,
						scope: scopeFromInput(params.scope),
						organizationId: params.organizationId,
						validFrom: params.validFrom,
						validTo: params.validTo,
					};
					await options.validateSource?.(source.sourceSessionId, source.sourceEntryId, ctx);
					assertNotAborted(signal);
					const record = await options.store.save(principal, draft);
					return textResult(
						{ ok: true, operation: "save", record: record as unknown as JsonValue },
						JSON.stringify(record),
					);
				} catch (error) {
					// 保存失败时返回统一错误结果；成功路径才返回存储层生成的 ID、版本和持久化记录。
					return errorResult("save", error);
				}
			},
		};

		const updateTool: ToolDefinition<typeof UPDATE_PARAMETERS, MemoryToolDetails> = {
			name: names.update,
			label: "Correct memory",
			description: "Correct one memory by creating a new version and invalidating the previous version.",
			promptSnippet: "Correct a saved PCB business memory",
			parameters: UPDATE_PARAMETERS,
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					// 更新在存储层创建新版本并使旧版本失效；这里先校验可能变更的来源归属。
					await beforeExecute(signal, ctx);
					assertOptionalText(params.memoryId, "memoryId");
					if (params.value !== undefined) assertValueSize(params.value);
					assertOptionalText(params.kind, "kind");
					assertOptionalText(params.sourceSessionId, "sourceSessionId");
					assertOptionalText(params.sourceEntryId, "sourceEntryId");
					scopeFromInput(params.scope);
					const principal = await resolvePrincipal(ctx);
					const patch: MemoryUpdate = {
						kind: params.kind,
						value: params.value === undefined ? undefined : asJsonValue(params.value),
						confirmationStatus: params.confirmationStatus as MemoryConfirmationStatus | undefined,
						sourceSessionId: params.sourceSessionId,
						sourceEntryId: params.sourceEntryId,
						scope: scopeFromInput(params.scope),
						organizationId: params.organizationId,
						validFrom: params.validFrom,
						validTo: params.validTo,
					};
					if (options.validateSource) {
						// 未提供新来源字段时，校验当前记录的来源；记录不存在也必须明确报错。
						const current = await options.store.get(principal, params.memoryId);
						if (!current)
							throw new MemoryStoreError("MEMORY_NOT_FOUND", `Memory ${params.memoryId} was not found`);
						await options.validateSource(
							patch.sourceSessionId ?? current.sourceSessionId,
							patch.sourceEntryId ?? current.sourceEntryId,
							ctx,
						);
					}
					assertNotAborted(signal);
					const record = await options.store.update(principal, params.memoryId, patch);
					return textResult(
						{ ok: true, operation: "update", record: record as unknown as JsonValue },
						JSON.stringify(record),
					);
				} catch (error) {
					// 版本替换失败不会被吞掉，统一转为带操作名的错误结果。
					return errorResult("update", error);
				}
			},
		};

		const deleteTool: ToolDefinition<typeof DELETE_PARAMETERS, MemoryToolDetails> = {
			name: names.delete,
			label: "Delete memory",
			description: "Delete one explicitly saved business memory so it is no longer retrievable.",
			promptSnippet: "Delete a saved PCB business memory",
			parameters: DELETE_PARAMETERS,
			defaultActive: true,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					// 删除按主体和范围授权执行，存储层返回是否找到并删除目标记录。
					await beforeExecute(signal, ctx);
					assertOptionalText(params.memoryId, "memoryId");
					const principal = await resolvePrincipal(ctx);
					assertNotAborted(signal);
					const deleted = await options.store.delete(principal, params.memoryId);
					return textResult(
						{ ok: true, operation: "delete", deleted },
						JSON.stringify({ memoryId: params.memoryId, deleted }),
					);
				} catch (error) {
					// 删除失败仍保留统一错误码，避免模型把失败误判成已删除。
					return errorResult("delete", error);
				}
			},
		};

		pi.registerTool(listTool);
		pi.registerTool(saveTool);
		pi.registerTool(updateTool);
		pi.registerTool(deleteTool);
	};
}
