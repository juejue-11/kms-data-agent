// 策略不变量：本轮 KB 优先、证据状态累积、所有工具共享预算，取消后禁止继续执行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetrievalPolicy } from "../../app/tools/retrieval-policy.ts";

const noResults = { status: "no_results" as const, backend: "ragflow" as const, evidence: [] };

test("web requires a completed empty KB search in the same policy round", () => {
	const policy = createRetrievalPolicy({ allowWebSearch: true, allowWebOnKbError: false, maxToolCalls: 4 });
	assert.equal(policy.before("search_web").code, "KB_REQUIRED_BEFORE_WEB");
	assert.equal(policy.before("search_knowledge_base").allowed, true);
	policy.recordKnowledgeBase(noResults);
	assert.equal(policy.before("search_web").allowed, true);
});

test("KB evidence remains blocking after a later empty result or failure", () => {
	const policy = createRetrievalPolicy({ allowWebSearch: true, allowWebOnKbError: true, maxToolCalls: 8 });
	assert.equal(policy.before("search_knowledge_base").allowed, true);
	policy.recordKnowledgeBase({
		status: "ok",
		backend: "ragflow",
		evidence: [{ evidenceId: "ev_a", sourceType: "knowledge_base", text: "x", title: "doc", retrievedAt: "now" }],
	});
	policy.recordKnowledgeBase(noResults);
	assert.equal(policy.before("search_web").code, "KB_REQUIRED_BEFORE_WEB");

	const afterError = createRetrievalPolicy({ allowWebSearch: true, allowWebOnKbError: true, maxToolCalls: 8 });
	assert.equal(afterError.before("search_knowledge_base").allowed, true);
	afterError.recordKnowledgeBase({
		status: "ok",
		backend: "ragflow",
		evidence: [{ evidenceId: "ev_b", sourceType: "local", text: "x", title: "doc", retrievedAt: "now" }],
	});
	afterError.recordKnowledgeBaseError(new Error("offline"));
	assert.equal(afterError.before("search_web").code, "KB_REQUIRED_BEFORE_WEB");
});

test("unknown tools consume the shared budget and an aborted request blocks them", () => {
	const policy = createRetrievalPolicy({ maxToolCalls: 1 });
	assert.equal(policy.before("memory_before_execute").allowed, true);
	assert.equal(policy.before("memory_before_execute").code, "TOOL_BUDGET_EXCEEDED");

	const controller = new AbortController();
	const cancelled = createRetrievalPolicy({ signal: controller.signal });
	controller.abort();
	assert.equal(cancelled.before("memory_before_execute").code, "REQUEST_CANCELLED");
});
