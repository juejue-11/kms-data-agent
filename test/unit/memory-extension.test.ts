// 记忆工具契约：默认关闭、服务端身份与来源校验、显式操作、参数限制和取消后不落盘。
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createMemoryExtension, MEMORY_EXTENSION_TOOL_NAMES, MemoryStore } from "../../app/memory/index.ts";

function fakeApi(tools: ToolDefinition[] = []): ExtensionAPI {
	return {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
}

function context(): ExtensionToolContext {
	return {} as ExtensionToolContext;
}

describe("createMemoryExtension", () => {
	it("is disabled by default and does not subscribe to chat events", async () => {
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({ store: new MemoryStore(), ownerId: "alice" })(fakeApi(tools));
		expect(tools).toEqual([]);
	});

	it("registers explicit list/save/update/delete tools only when enabled", async () => {
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({ store: new MemoryStore(), ownerId: "alice", enabled: true })(fakeApi(tools));
		expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_EXTENSION_TOOL_NAMES]);
	});

	it("uses the authenticated owner and never exposes another owner's records", async () => {
		const store = new MemoryStore();
		await store.save("bob", {
			kind: "preference",
			value: "hidden",
			confirmationStatus: "statement",
			sourceSessionId: "bob-session",
			sourceEntryId: "bob-entry",
		});
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({ store, ownerId: "alice", enabled: true })(fakeApi(tools));
		const listTool = tools.find((tool) => tool.name === "memory_list");
		expect(listTool).toBeDefined();
		const result = await listTool?.execute("call-1", { query: "hidden" } as never, undefined, undefined, context());
		expect(result?.details).toMatchObject({ ok: true, operation: "list" });
		expect(result?.content[0]).toMatchObject({ type: "text", text: '{"memories":[]}' });
	});

	it("supports an explicit '*' query for listing the current user's effective memories", async () => {
		const store = new MemoryStore();
		await store.save("alice", {
			kind: "first-memory",
			value: "first",
			confirmationStatus: "statement",
			sourceSessionId: "session-1",
			sourceEntryId: "entry-1",
		});
		await store.save("bob", {
			kind: "other-owner-memory",
			value: "other",
			confirmationStatus: "statement",
			sourceSessionId: "session-2",
			sourceEntryId: "entry-2",
		});
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({ store, ownerId: "alice", enabled: true })(fakeApi(tools));
		const listTool = tools.find((tool) => tool.name === "memory_list");
		const result = await listTool?.execute("call-all", { query: "*" } as never, undefined, undefined, context());
		const memories = JSON.parse(result?.content[0].type === "text" ? result.content[0].text : "{}").memories;
		expect(memories).toHaveLength(1);
		expect(memories[0].kind).toBe("first-memory");

		const empty = await listTool?.execute("call-empty", { query: "   " } as never, undefined, undefined, context());
		expect(empty?.details).toMatchObject({ ok: false, errorCode: "INVALID_MEMORY" });
	});

	it("saves and corrects memories through explicit tool calls", async () => {
		const store = new MemoryStore();
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({ store, ownerId: "alice", enabled: true })(fakeApi(tools));
		const saveTool = tools.find((tool) => tool.name === "memory_save");
		const updateTool = tools.find((tool) => tool.name === "memory_update");
		expect(saveTool).toBeDefined();
		expect(updateTool).toBeDefined();

		const saved = await saveTool?.execute(
			"call-1",
			{
				kind: "process-parameter",
				value: { lineWidthMm: 0.15 },
				confirmationStatus: "confirmed",
				sourceSessionId: "session-1",
				sourceEntryId: "entry-1",
			} as never,
			undefined,
			undefined,
			context(),
		);
		const savedRecord = JSON.parse(saved?.content[0].type === "text" ? saved.content[0].text : "{}");
		const updated = await updateTool?.execute(
			"call-2",
			{ memoryId: savedRecord.memoryId, value: { lineWidthMm: 0.2 } } as never,
			undefined,
			undefined,
			context(),
		);
		const updatedRecord = JSON.parse(updated?.content[0].type === "text" ? updated.content[0].text : "{}");
		expect(updatedRecord.supersedes).toBe(savedRecord.memoryId);
		expect(await store.get("alice", savedRecord.memoryId)).toBeUndefined();
	});

	it("runs host guards and validates the final source pair on correction", async () => {
		const store = new MemoryStore();
		const tools: ToolDefinition[] = [];
		const beforeCalls: number[] = [];
		const sourceCalls: string[] = [];
		await createMemoryExtension({
			store,
			ownerId: "alice",
			enabled: true,
			beforeExecute: (signal) => {
				signal?.throwIfAborted();
				beforeCalls.push(1);
			},
			validateSource: (sessionId, entryId) => {
				sourceCalls.push(`${sessionId}/${entryId}`);
			},
		})(fakeApi(tools));
		const saveTool = tools.find((tool) => tool.name === "memory_save");
		const updateTool = tools.find((tool) => tool.name === "memory_update");
		const saved = await saveTool?.execute(
			"call-1",
			{
				kind: "preference",
				value: "value",
				confirmationStatus: "statement",
				sourceSessionId: "session-1",
				sourceEntryId: "entry-1",
			} as never,
			undefined,
			undefined,
			context(),
		);
		const savedRecord = JSON.parse(saved?.content[0].type === "text" ? saved.content[0].text : "{}");
		await updateTool?.execute(
			"call-2",
			{ memoryId: savedRecord.memoryId, sourceSessionId: "session-2" } as never,
			undefined,
			undefined,
			context(),
		);

		expect(beforeCalls).toHaveLength(2);
		expect(sourceCalls).toEqual(["session-1/entry-1", "session-2/entry-1"]);
	});

	it("injects a service-owned current source when save omits Pi ids", async () => {
		const store = new MemoryStore();
		const tools: ToolDefinition[] = [];
		await createMemoryExtension({
			store,
			ownerId: "alice",
			enabled: true,
			getDefaultSource: () => ({ sourceSessionId: "business-session", sourceEntryId: "user-entry" }),
			validateSource: (sessionId, entryId) => {
				expect(`${sessionId}/${entryId}`).toBe("business-session/user-entry");
			},
		})(fakeApi(tools));
		const saveTool = tools.find((tool) => tool.name === "memory_save");
		const saved = await saveTool?.execute(
			"call-default-source",
			{
				kind: "preference",
				value: "injected source",
				confirmationStatus: "statement",
			} as never,
			undefined,
			undefined,
			context(),
		);
		const record = JSON.parse(saved?.content[0].type === "text" ? saved.content[0].text : "{}");
		expect(record.sourceSessionId).toBe("business-session");
		expect(record.sourceEntryId).toBe("user-entry");
	});

	it("enforces tool limits and does not write after cancellation", async () => {
		const store = new MemoryStore();
		const tools: ToolDefinition[] = [];
		const controller = new AbortController();
		await createMemoryExtension({ store, ownerId: "alice", enabled: true })(fakeApi(tools));
		const saveTool = tools.find((tool) => tool.name === "memory_save");
		const listTool = tools.find((tool) => tool.name === "memory_list");

		controller.abort();
		const cancelled = await saveTool?.execute(
			"call-cancelled",
			{
				kind: "cancelled",
				value: "should not be saved",
				confirmationStatus: "statement",
				sourceSessionId: "session-1",
				sourceEntryId: "entry-1",
			} as never,
			controller.signal,
			undefined,
			context(),
		);
		expect(cancelled?.details).toMatchObject({ ok: false });
		expect(await store.search("alice", "cancelled")).toEqual([]);

		const oversized = await saveTool?.execute(
			"call-large",
			{
				kind: "large",
				value: "x".repeat(9000),
				confirmationStatus: "statement",
				sourceSessionId: "session-1",
				sourceEntryId: "entry-1",
			} as never,
			undefined,
			undefined,
			context(),
		);
		expect(oversized?.details).toMatchObject({ ok: false, errorCode: "INVALID_MEMORY" });

		const tooMany = await listTool?.execute(
			"call-limit",
			{ query: "anything", limit: 21 } as never,
			undefined,
			undefined,
			context(),
		);
		expect(tooMany?.details).toMatchObject({ ok: false, errorCode: "INVALID_MEMORY" });
	});
});
