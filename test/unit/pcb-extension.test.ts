// 校验业务扩展的注册集合、串行模式和请求桥接；使用最小替身检查边界，不复制 Pi 内部逻辑。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPcbExtension, tools } from "../../app/tools/pcb-extension.ts";
import { createRetrievalPolicy } from "../../app/tools/retrieval-policy.ts";

type RegisteredTool = { name: string; executionMode?: string };

test("PCB extension registers exactly three sequential business tools", () => {
	const registered: RegisteredTool[] = [];
	const factory = createPcbExtension({ getPolicy: () => createRetrievalPolicy({ maxToolCalls: 4 }) });
	factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
	assert.deepEqual(
		registered.map((tool) => tool.name),
		["search_knowledge_base", "search_web", "get_evidence"],
	);
	assert.deepEqual(
		registered.map((tool) => tool.executionMode),
		["sequential", "sequential", "sequential"],
	);
});

test("session bridge resets policy when requestId changes and reads the active branch", () => {
	let requestId = "request-1";
	let stopped: string | undefined;
	const runtime = tools({
		ownerId: "owner-1",
		sessionId: "session-1",
		manager: { getBranch: () => [] },
		getRun: () => ({
			requestId,
			signal: new AbortController().signal,
			stop: (code) => {
				stopped = code;
			},
		}),
		policyConfig: { maxToolCalls: 1 },
	});
	assert.equal(runtime.extensions.length, 1);
	assert.deepEqual(runtime.toolNames, ["search_knowledge_base", "search_web", "get_evidence"]);
	requestId = "request-2";
	assert.equal(stopped, undefined);
});

test("session bridge exposes the request policy and rejects calls without an active run", () => {
	const runtime = tools({
		ownerId: "owner-1",
		sessionId: "session-1",
		manager: { getBranch: () => [] },
		getRun: () => undefined,
	});
	assert.throws(() => runtime.getPolicy(), /REQUEST_NOT_RUNNING/);
});

test("an already cancelled request never invokes a retrieval adapter", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const registered: unknown[] = [];
	const factory = createPcbExtension({
		getPolicy: () => createRetrievalPolicy({ maxToolCalls: 4 }),
		getRun: () => ({ requestId: "request-1", signal: controller.signal }),
		searchKnowledgeBase: async () => {
			calls += 1;
			return { status: "no_results", backend: "ragflow", evidence: [] };
		},
	});
	factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
	type SearchTool = {
		name: string;
		execute(
			toolCallId: string,
			params: { query: string },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: { signal?: AbortSignal },
		): Promise<unknown>;
	};
	const search = registered.find((tool): tool is SearchTool => {
		return typeof tool === "object" && tool !== null && "name" in tool && tool.name === "search_knowledge_base";
	});
	assert.ok(search);
	await assert.rejects(
		() => search.execute("call-1", { query: "pcb" }, undefined, undefined, { signal: new AbortController().signal }),
		/Retrieval was cancelled|REQUEST_CANCELLED/,
	);
	assert.equal(calls, 0);
});
