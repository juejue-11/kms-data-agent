// 证据只能来自允许的 Pi 工具结果；验证未知引用可见且展示信息不凭空补造。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	projectEvidence,
	projectEvidenceLookup,
	projectRetrievalResult,
	validate,
	validateCitations,
} from "../../app/evidence/evidence-service.ts";

const evidence = {
	evidenceId: "ev_doc1",
	sourceType: "knowledge_base" as const,
	text: "检查压合温度",
	title: "工艺规范",
	documentId: "doc-1",
	chunkId: "chunk-1",
	page: 2,
	retrievedAt: "2026-10-21T00:00:00.000Z",
};

test("evidence index reads Pi tool-result details and ignores unrelated history", () => {
	const entries = [
		{
			type: "message",
			id: "m1",
			message: {
				role: "toolResult",
				toolName: "search_knowledge_base",
				details: {
					kind: "pcb_evidence",
					version: 1,
					toolName: "search_knowledge_base",
					status: "ok",
					backend: "ragflow",
					evidence: [evidence],
				},
			},
		},
		{
			type: "message",
			id: "m2",
			message: {
				role: "toolResult",
				toolName: "bash",
				details: { kind: "pcb_evidence", version: 1, toolName: "search_knowledge_base", evidence: [evidence] },
			},
		},
	];
	const projected = projectEvidence(entries);
	assert.equal(projected.length, 1);
	assert.equal(projected[0]?.page, 2);
});

test("citation validation marks unknown IDs and maps only real source metadata", () => {
	const invalid = validateCitations("依据 [E:ev_doc1] 和 [E:ev_unknown]", [evidence]);
	assert.equal(invalid.status, "invalid");
	assert.deepEqual(invalid.invalidIds, ["ev_unknown"]);
	assert.deepEqual(invalid.sources[0], {
		evidenceId: "ev_doc1",
		sourceType: "knowledge_base",
		title: "工艺规范",
		text: "检查压合温度",
		documentId: "doc-1",
		chunkId: "chunk-1",
		page: 2,
	});
	assert.equal(validateCitations("没有引用", [evidence]).status, "not_applicable");
	assert.deepEqual(
		validate("依据 [E:ev_doc1]", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "search_knowledge_base",
					details: {
						kind: "pcb_evidence",
						version: 1,
						toolName: "search_knowledge_base",
						status: "ok",
						backend: "ragflow",
						evidence: [evidence],
					},
				},
			},
		]),
		{
			sources: [
				{
					evidenceId: "ev_doc1",
					sourceType: "knowledge_base",
					title: "工艺规范",
					text: "检查压合温度",
					documentId: "doc-1",
					chunkId: "chunk-1",
					page: 2,
				},
			],
			citationValidation: { status: "valid", invalidIds: [] },
		},
	);
});

test("projection puts IDs and key text in content while preserving details", () => {
	const projection = projectRetrievalResult("search_knowledge_base", {
		status: "ok",
		backend: "ragflow",
		evidence: [evidence],
		query: "划伤",
	});
	assert.match(projection.content[0]?.text ?? "", /\[E:ev_doc1\]/);
	assert.equal(projection.details.evidence[0]?.documentId, "doc-1");
	const lookup = projectEvidenceLookup("get_evidence", ["ev_doc1", "ev_unknown"], [evidence]);
	assert.deepEqual(lookup.details.missingIds, ["ev_unknown"]);
});
