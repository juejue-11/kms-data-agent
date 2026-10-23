// 通过真实 Pi 工具循环验证记忆的来源、跨会话访问、更正/删除、用户隔离与共享预算。
// 模型和检索均为离线替身，不读取生产凭据。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { assertSourceRuntime, createService } from "../../app/bootstrap.ts";
import { loadConfig } from "../../app/config.ts";
import { runtimeFromModel } from "../../app/runtime/pi-runtime.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.ts";

test("opt-in native memory tools validate source ownership and share the request budget across sessions", async () => {
	assertSourceRuntime();
	const root = mkdtempSync(join(tmpdir(), "pcb-memory-integration-"));
	const harness = await createHarness();
	const config = loadConfig({
		PCB_DATA_DIR: root,
		PCB_WORKSPACE_DIR: join(root, "workspace"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PCB_MEMORY_ENABLED: "true",
	});
	const service = createService(
		config,
		runtimeFromModel(config, harness.session.modelRuntime, () =>
			SettingsManager.inMemory({
				defaultProvider: harness.getModel().provider,
				defaultModel: harness.getModel().id,
				cacheWarming: "off",
				retry: { enabled: false },
			}),
		),
		{ searchKnowledgeBase: async () => ({ status: "no_results", backend: "ragflow", evidence: [] }) },
	);
	const submit = async (owner: string, sessionId: string, message: string) => {
		const result = service.submit(owner, sessionId, { requestId: randomUUID(), message });
		result.start!();
		return await result.done!;
	};
	const toolText = (sessionId: string, toolName: string) => {
		const message = service.registry.instances
			.get(sessionId)!
			.manager.getBranch()
			.findLast(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName,
			);
		assert.ok(message?.type === "message");
		return getMessageText(message.message);
	};
	const toolRecord = (sessionId: string, toolName: string) =>
		JSON.parse(toolText(sessionId, toolName)) as Record<string, unknown>;
	try {
		const first = service.create("alice").sessionId;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("memory_save", { kind: "板厚", value: "1.6mm", confirmationStatus: "statement" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已按用户陈述保存。"),
		]);
		assert.equal((await submit("alice", first, "请记住板厚1.6mm")).status, "succeeded");
		const saved = toolRecord(first, "memory_save");
		assert.ok(typeof saved.memoryId === "string" && typeof saved.sourceEntryId === "string");
		assert.equal(saved.sourceSessionId, first);
		assert.ok(
			service.registry.instances
				.get(first)!
				.manager.getBranch()
				.some((entry) => entry.id === saved.sourceEntryId),
		);
		const second = service.create("alice").sessionId;
		// 新会话不会自动携带旧事实，只有显式调用记忆工具才取得授权记录。
		harness.setResponses([
			(context) => {
				assert.doesNotMatch(JSON.stringify(context), /1\.6mm/);
				return fauxAssistantMessage(fauxToolCall("memory_list", { query: "*" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("记忆中板厚为用户陈述的1.6mm。"),
		]);
		await submit("alice", second, "查看我的记忆");
		assert.equal((toolRecord(second, "memory_list").memories as unknown[]).length, 1);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_update", { memoryId: saved.memoryId, value: "2.0mm" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已更正。"),
		]);
		await submit("alice", second, "更正板厚为2.0mm");
		const corrected = toolRecord(second, "memory_update");
		assert.ok(typeof corrected.memoryId === "string");
		assert.equal(corrected.supersedes, saved.memoryId);
		const other = service.create("bob").sessionId;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_list", { query: "*" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("没有本人的记忆。"),
		]);
		await submit("bob", other, "查看我的记忆");
		assert.equal((toolRecord(other, "memory_list").memories as unknown[]).length, 0);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("memory_save", {
					kind: "非法来源",
					value: "x",
					confirmationStatus: "statement",
					sourceSessionId: first,
					sourceEntryId: saved.sourceEntryId,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("来源未获授权。"),
		]);
		await submit("bob", other, "不应接入别人的来源");
		assert.match(toolText(other, "memory_save"), /SESSION_NOT_FOUND/);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_delete", { memoryId: corrected.memoryId }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已删除当前有效记忆。"),
			fauxAssistantMessage(fauxToolCall("memory_list", { query: "*" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("没有有效记忆。"),
		]);
		await submit("alice", second, "删除板厚记忆");
		await submit("alice", second, "再次查看我的记忆");
		assert.equal((toolRecord(second, "memory_list").memories as unknown[]).length, 0);
		config.maxToolCalls = 1;
		// 同一模型批次里的记忆和检索也占用同一预算，第二个工具不得绕过上限。
		const limited = service.create("alice").sessionId;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("memory_list", { query: "*" }), fauxToolCall("search_knowledge_base", { query: "板厚" })],
				{ stopReason: "toolUse" },
			),
		]);
		const limitResult = await submit("alice", limited, "查看记忆并查资料");
		assert.equal(limitResult.errorCode, "TOOL_BUDGET_EXCEEDED");
	} finally {
		await service.close();
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
