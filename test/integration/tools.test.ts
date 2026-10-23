// 使用真实 Pi 工具调度验证上下文检索、允许列表、KB 优先、预算、取消和证据回查。
// 检索通过依赖注入替换，不连接外部知识库或搜索服务。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { AgentService } from "../../app/agent/agent-service.ts";
import { loadConfig } from "../../app/config.ts";
import { projectEvidence, validate } from "../../app/evidence/evidence-service.ts";
import { runtimeFromModel } from "../../app/runtime/pi-runtime.ts";
import { type PcbExtensionDeps, tools } from "../../app/tools/pcb-extension.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.ts";
import type { RetrievalResult } from "../../rag/retrieve.d.ts";

const empty: RetrievalResult = { status: "no_results", backend: "ragflow", evidence: [] };
const evidence: RetrievalResult = {
	status: "ok",
	backend: "ragflow",
	evidence: [
		{
			evidenceId: "ev_scratch",
			sourceType: "knowledge_base",
			title: "划伤判定资料",
			text: "确认板面划伤深度、是否露铜，按受控检验标准区分。",
			retrievedAt: "2026-10-21T00:00:00Z",
			documentId: "doc-scratch",
			chunkId: "chunk-1",
		},
	],
};
async function setup(deps: PcbExtensionDeps = {}, configOverrides: NodeJS.ProcessEnv = {}) {
	// 保留生产工具扩展与会话流程，只替换模型响应和检索适配器。
	const root = mkdtempSync(join(tmpdir(), "pcb-tools-integration-"));
	const harness = await createHarness();
	const config = loadConfig({
		PCB_DATA_DIR: root,
		PCB_WORKSPACE_DIR: join(root, "workspace"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		...configOverrides,
	});
	const service = new AgentService({
		config,
		runtime: runtimeFromModel(config, harness.session.modelRuntime, () =>
			SettingsManager.inMemory({
				defaultProvider: harness.getModel().provider,
				defaultModel: harness.getModel().id,
				retry: { enabled: false },
				cacheWarming: "off",
				compaction: { keepRecentTokens: 20, reserveTokens: 256 },
			}),
		),
		validate,
		tools: (input) => {
			const pcb = tools({
				...input,
				policyConfig: {
					maxToolCalls: config.maxToolCalls,
					allowWebSearch: config.allowWebSearch,
					allowWebOnKbError: config.allowWebOnKbError,
				},
				deps: {
					retrievalTimeoutMs: 1000,
					searchKnowledgeBase: async () => evidence,
					searchWeb: async () => {
						throw new Error("Unexpected external search");
					},
					...deps,
				},
			});
			return { extensions: pcb.extensions, toolNames: [...pcb.toolNames] };
		},
	});
	return {
		root,
		harness,
		config,
		service,
		async run(sessionId: string, message: string) {
			const request = service.submit("owner", sessionId, { requestId: randomUUID(), message });
			request.start!();
			return await request.done!;
		},
		async cleanup() {
			await service.close();
			harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("real Pi tools consume conversational queries, persist evidence and expose only the allowlist", async () => {
	const queries: string[] = [];
	const env = await setup({
		searchKnowledgeBase: async (query) => {
			queries.push(query);
			return evidence;
		},
	});
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			(context) => {
				const actual = JSON.stringify(context);
				assert.match(actual, /PCB/);
				assert.doesNotMatch(
					actual,
					/Development Rules|expert coding assistant|"name":"bash"|"name":"read"|"name":"write"/,
				);
				return fauxAssistantMessage(fauxToolCall("search_knowledge_base", { query: "板面划伤" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("需要确认划伤深度。[E:ev_scratch]"),
		]);
		const first = await env.run(sessionId, "板面有划伤");
		assert.equal(first.citationValidation.status, "valid");
		assert.equal(first.sources[0].evidenceId, "ev_scratch");
		env.harness.setResponses([
			(context) => {
				assert.ok(context.messages.some((message) => getMessageText(message).includes("板面有划伤")));
				return fauxAssistantMessage(fauxToolCall("search_knowledge_base", { query: "板面划伤处理及露铜判据" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("先确认是否露铜和划伤深度。[E:ev_scratch]"),
		]);
		const second = await env.run(sessionId, "这种缺陷怎么处理？");
		assert.equal(second.status, "succeeded");
		assert.deepEqual(queries, ["板面划伤", "板面划伤处理及露铜判据"]);
		const live = env.service.registry.instances.get(sessionId)!;
		assert.deepEqual(live.session.getActiveToolNames().sort(), [
			"get_evidence",
			"search_knowledge_base",
			"search_web",
		]);
		assert.equal(projectEvidence(live.manager.getBranch()).length, 1);
		assert.equal(
			live.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.length,
			2,
		);
	} finally {
		await env.cleanup();
	}
});

test("same-batch tools execute in order and web policy is checked at execution time", async () => {
	// 故意先请求联网，再查 KB，再联网，确保策略按实际执行顺序而非整批预判。
	const order: string[] = [];
	const env = await setup(
		{
			searchKnowledgeBase: async () => {
				order.push("kb");
				return empty;
			},
			searchWeb: async () => {
				order.push("web");
				return {
					status: "ok",
					backend: "duckduckgo",
					evidence: [
						{
							evidenceId: "ev_web",
							sourceType: "web",
							text: "网络候选，需对照内部标准。",
							title: "外部说明",
							url: "https://example.com/pcb",
							retrievedAt: "now",
						},
					],
				};
			},
		},
		{ PCB_ALLOW_WEB_SEARCH: "true" },
	);
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("search_web", { query: "板面划伤" }),
					fauxToolCall("search_knowledge_base", { query: "板面划伤" }),
					fauxToolCall("search_web", { query: "板面划伤" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("内部无命中，网络资料仅作为候选。[E:ev_web]"),
		]);
		const result = await env.run(sessionId, "板面划伤");
		assert.equal(result.status, "succeeded");
		assert.deepEqual(order, ["kb", "web"]);
		assert.equal(result.sources[0].sourceType, "web");
	} finally {
		await env.cleanup();
	}
});

test("disabled web and KB failure cannot be mistaken for a successful empty search", async () => {
	let webCalls = 0;
	for (const allowWeb of [false, true]) {
		const env = await setup(
			{
				searchKnowledgeBase: async () => {
					throw new Error("controlled KB outage");
				},
				searchWeb: async () => {
					webCalls++;
					return empty;
				},
			},
			{ PCB_ALLOW_WEB_SEARCH: String(allowWeb) },
		);
		try {
			const { sessionId } = env.service.create("owner");
			env.harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("search_knowledge_base", { query: "板面划伤" }),
						fauxToolCall("search_web", { query: "板面划伤" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("知识库服务故障，资料不足，请稍后重试。"),
			]);
			const result = await env.run(sessionId, "板面划伤");
			assert.equal(result.citationValidation.status, "not_applicable");
			const branch = env.service.registry.instances.get(sessionId)!.manager.getBranch();
			assert.ok(
				branch.some(
					(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
				),
			);
		} finally {
			await env.cleanup();
		}
	}
	assert.equal(webCalls, 0);
});

test("budget exhaustion terminates the native run without extra adapter or model calls", async () => {
	let searches = 0;
	const env = await setup(
		{
			searchKnowledgeBase: async () => {
				searches++;
				return empty;
			},
		},
		{ PCB_MAX_TOOL_CALLS: "2" },
	);
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("search_knowledge_base", { query: "划伤一" }),
					fauxToolCall("search_knowledge_base", { query: "划伤二" }),
					fauxToolCall("search_knowledge_base", { query: "划伤三" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const result = await env.run(sessionId, "板面划伤");
		assert.equal(result.status, "failed");
		assert.equal(result.errorCode, "TOOL_BUDGET_EXCEEDED");
		assert.equal(searches, 2);
		assert.equal(env.harness.faux.state.callCount, 1);
	} finally {
		await env.cleanup();
	}
});

test("cancel aborts in-flight retrieval and frees the session for the next request", async () => {
	// 等检索真正进入等待后再取消，验证信号传到活动工具而非仅改请求状态。
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let sawAbort = false;
	const env = await setup({
		searchKnowledgeBase: async (_query, options) => {
			entered();
			await new Promise<void>((resolve) => {
				options!.signal!.addEventListener(
					"abort",
					() => {
						sawAbort = true;
						resolve();
					},
					{ once: true },
				);
			});
			return empty;
		},
	});
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("search_knowledge_base", { query: "板面划伤" }), { stopReason: "toolUse" }),
		]);
		const requestId = randomUUID();
		const request = env.service.submit("owner", sessionId, { requestId, message: "板面划伤" });
		request.start!();
		await started;
		const result = await env.service.cancel("owner", sessionId, requestId);
		assert.equal(result.status, "cancelled");
		assert.ok(sawAbort);
		env.harness.setResponses([fauxAssistantMessage("可继续使用")]);
		assert.equal((await env.run(sessionId, "继续")).status, "succeeded");
	} finally {
		await env.cleanup();
	}
});

test("get_evidence recovers original persisted tool evidence after native compaction and invalid citations remain visible", async () => {
	const env = await setup();
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("search_knowledge_base", { query: "板面划伤" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("待确认深度及露铜。[E:ev_scratch]"),
			fauxAssistantMessage("已记录厚度1.6mm并排除起泡。"),
		]);
		await env.run(sessionId, "板面有划伤");
		await env.run(sessionId, "厚度1.6mm，排除起泡");
		const live = env.service.registry.instances.get(sessionId)!;
		const captured: string[] = [];
		const summary: FauxResponseStep = (context) => {
			captured.push(context.messages.map(getMessageText).join("\n"));
			return fauxAssistantMessage("板面划伤，1.6mm，排除起泡，证据[E:ev_scratch]，待确认深度和露铜。");
		};
		env.harness.setResponses([summary, summary]);
		await live.session.compact();
		assert.ok(captured.some((text) => text.includes("ev_scratch")));
		env.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("get_evidence", { evidenceIds: ["ev_scratch", "ev_other"] }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const original = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "get_evidence",
				);
				assert.match(getMessageText(original), /确认板面划伤深度、是否露铜/);
				assert.match(getMessageText(original), /missing_evidence_ids=ev_other/);
				return fauxAssistantMessage("原始资料见[E:ev_scratch]，未知引用[E:ev_other]需核对。");
			},
		]);
		const result = await env.run(sessionId, "请取回原始证据");
		assert.equal(result.citationValidation.status, "invalid");
		assert.deepEqual(result.citationValidation.invalidIds, ["ev_other"]);
		assert.equal(result.sources[0].evidenceId, "ev_scratch");
	} finally {
		await env.cleanup();
	}
});

test("request deadline cancels a native model call and records a stable timeout terminal", async () => {
	const env = await setup({}, { PCB_REQUEST_TIMEOUT_MS: "200" });
	try {
		const { sessionId } = env.service.create("owner");
		env.harness.setResponses([
			async (_context, options) => {
				assert.ok(options?.signal);
				await new Promise<void>((resolve) => {
					if (options.signal!.aborted) resolve();
					else options.signal!.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("未完成", { stopReason: "aborted" });
			},
		]);
		const result = await env.run(sessionId, "等待到超时");
		assert.equal(result.status, "failed");
		assert.equal(result.errorCode, "REQUEST_TIMEOUT");
		env.harness.setResponses([fauxAssistantMessage("超时后可继续")]);
		assert.equal((await env.run(sessionId, "重新提问")).status, "succeeded");
	} finally {
		await env.cleanup();
	}
});
