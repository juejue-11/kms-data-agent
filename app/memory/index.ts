/**
 * 业务记忆模块的公共入口：统一转出扩展工厂、工具结果类型和存储层类型。
 * 具体实现仍分别位于 extension.ts 与 store.ts，避免调用方依赖内部文件路径。
 */
export {
	createMemoryExtension,
	MEMORY_EXTENSION_TOOL_NAMES,
	type MemoryExtensionOptions,
	type MemorySource,
	type MemoryToolDetails,
} from "./extension.ts";
export {
	type JsonPrimitive,
	type JsonValue,
	type MemoryActor,
	type MemoryConfirmationStatus,
	type MemoryDraft,
	type MemoryPrincipal,
	type MemoryQuery,
	type MemoryRecord,
	type MemoryScope,
	MemoryStore,
	MemoryStoreError,
	type MemoryStoreOptions,
	type MemoryUpdate,
} from "./store.ts";
