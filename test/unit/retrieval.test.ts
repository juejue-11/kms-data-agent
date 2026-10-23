// 检索适配契约：校验远端结构、保留真实元数据，区分空结果/故障/本地降级，并验证提前取消。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	RetrievalError as RetrievalErrorType,
	RetrievalRequestOptions,
	RetrievalResult,
} from "../../rag/retrieve.d.ts";

interface RetrievalModule {
	RetrievalError: new (code: string, message?: string, cause?: unknown) => RetrievalErrorType;
	searchKnowledgeBase(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
	webSearch(query: string, options?: RetrievalRequestOptions): Promise<RetrievalResult>;
	tokenize(text: string): string[];
}

const { RetrievalError, searchKnowledgeBase, tokenize, webSearch } = createRequire(import.meta.url)(
	["..", "..", "rag", "retrieve.js"].join("/"),
) as RetrievalModule;

function response(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("RAGFlow response is validated and real metadata is retained", async () => {
	const result = await searchKnowledgeBase("板面划伤", {
		datasetIds: ["dataset-1"],
		minSimilarity: 0.35,
		topK: 3,
		fetch: async (_input, init) => {
			assert.equal(init?.method, "POST");
			return response({
				code: 0,
				data: {
					chunks: [
						{
							content: "valid",
							document_id: "doc-1",
							chunk_id: "chunk-7",
							page: 4,
							similarity: 0.88,
							document_name: "缺陷判定",
						},
						{ content: "below threshold", document_id: "doc-2", similarity: 0.1 },
					],
				},
			});
		},
		now: () => "2026-10-21T00:00:00.000Z",
	});
	assert.equal(result.status, "ok");
	assert.equal(result.backend, "ragflow");
	assert.deepEqual(result.evidence[0], {
		evidenceId: result.evidence[0]?.evidenceId,
		sourceType: "knowledge_base",
		text: "valid",
		title: "缺陷判定",
		documentId: "doc-1",
		chunkId: "chunk-7",
		page: 4,
		similarity: 0.88,
		retrievedAt: "2026-10-21T00:00:00.000Z",
	});
	assert.match(result.evidence[0]?.evidenceId ?? "", /^ev_/);
});

test("successful empty KB result is distinct from service failure and local degradation", async () => {
	const empty = await searchKnowledgeBase("not found", {
		datasetIds: ["dataset-1"],
		fetch: async () => response({ code: 0, data: { chunks: [] } }),
	});
	assert.equal(empty.status, "no_results");
	assert.equal(empty.backend, "ragflow");

	const dir = await mkdtemp(join(tmpdir(), "pcb-retrieval-"));
	try {
		await writeFile(join(dir, "defects.txt"), "板面划伤应检查压合温度\n");
		const degraded = await searchKnowledgeBase("板面划伤", {
			datasetIds: ["dataset-1"],
			allowLocalFallback: true,
			localKbDir: dir,
			fetch: async () => {
				throw new Error("offline");
			},
		});
		assert.equal(degraded.status, "degraded");
		assert.equal(degraded.backend, "local");
		assert.equal(degraded.warningCode, "RAGFLOW_UNAVAILABLE");
		assert.equal(degraded.evidence[0]?.sourceType, "local");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("local tokenization handles Chinese phrases without full-sentence matching", () => {
	const terms = tokenize("板面划伤怎么处理");
	assert.ok(terms.includes("板面"));
	assert.ok(terms.includes("划伤"));
});

test("web provider configuration and cancellation fail before another request", async () => {
	await assert.rejects(
		() => webSearch("pcb", { searchProvider: "tavily", tavilyApiKey: "" }),
		(error: unknown) => error instanceof RetrievalError && error.code === "SEARCH_PROVIDER_NOT_CONFIGURED",
	);
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	await assert.rejects(
		() =>
			webSearch("pcb", {
				signal: controller.signal,
				fetch: async () => {
					calls += 1;
					return response({});
				},
			}),
		(error: unknown) => error instanceof RetrievalError && error.code === "CANCELLED",
	);
	assert.equal(calls, 0);
});
