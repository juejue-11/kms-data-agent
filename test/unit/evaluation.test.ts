// 离线评分器自检：检索正确不等于结论正确；缺失结果、合成样例和实测基线必须区分。
import { describe, expect, it } from "vitest";
import { PCB_EVALUATION_CASES } from "../evals/fixtures.ts";
import { evaluatePcbResults, parseEvaluationResults, scoreFinal, scoreRetrieval } from "../evals/score.ts";
import type { EvaluationActualResult } from "../evals/types.ts";

function passingResults(): EvaluationActualResult[] {
	// 按标注构造结构化正例，只验证评分规则，不代表真实模型已经达到这些效果。
	return PCB_EVALUATION_CASES.map((fixture) => {
		const retrieval = fixture.expectation.retrieval;
		const answer = fixture.expectation.answer;
		return {
			caseId: fixture.id,
			retrieval: {
				status: retrieval.expectedStatus,
				hits: retrieval.shouldHit
					? (retrieval.requiredEvidenceIds ?? []).map((evidenceId, index) => ({
							evidenceId,
							label: retrieval.acceptedLabels?.[index] ?? retrieval.acceptedLabels?.[0],
						}))
					: [],
			},
			answer: {
				predictedDefect: answer.expectedDefect,
				criteria: answer.requiredCriteria,
				followUpQuestions: answer.requiredFollowUps,
				asked: answer.mustAsk,
				refused: answer.mustRefuseConclusion,
				conflictAcknowledged: answer.mustAcknowledgeConflict,
				conclusionType: answer.expectedConclusionType,
			},
		};
	});
}

describe("PCB business evaluation", () => {
	it("scores retrieval independently from final decision quality", () => {
		const fixture = PCB_EVALUATION_CASES.find((item) => item.id === "similar-line-whitening-vs-open");
		expect(fixture).toBeDefined();
		const actual: EvaluationActualResult = {
			caseId: fixture?.id ?? "",
			retrieval: { status: "ok", hits: [{ evidenceId: "ev_similar_line_whitening", label: "line-whitening" }] },
			answer: { predictedDefect: "open-circuit", criteria: ["continuity remains intact"] },
		};
		expect(scoreRetrieval(fixture as (typeof PCB_EVALUATION_CASES)[number], actual).passed).toBe(true);
		expect(scoreFinal(fixture as (typeof PCB_EVALUATION_CASES)[number], actual).passed).toBe(false);
	});

	it("requires an explicit refusal and follow-up when retrieval has no hit", () => {
		const fixture = PCB_EVALUATION_CASES.find((item) => item.category === "no_hit");
		if (!fixture) throw new Error("no_hit fixture is required");
		const missing: EvaluationActualResult = {
			caseId: fixture.id,
			retrieval: { status: "no_results", hits: [] },
			answer: {},
		};
		const report = evaluatePcbResults([fixture], [missing]);
		expect(report.retrieval.passedCases).toBe(1);
		expect(report.final.passedCases).toBe(0);
		expect(report.cases[0]?.final.dimensions.refusal.passed).toBe(false);
		expect(report.cases[0]?.final.dimensions.followUp.passed).toBe(false);
	});

	it("accepts structured actual-run JSON and leaves reply text insufficient by itself", () => {
		const fixture = PCB_EVALUATION_CASES[0];
		const parsed = parseEvaluationResults({
			results: [
				{
					caseId: fixture.id,
					search: { status: "ok", evidence: [{ id: "ev_alias_solder_mask", source: "solder-mask-exposure" }] },
					reply: "回答中提到了 solder-mask-exposure，但没有结构化结论。",
				},
			],
		});
		expect(parsed[0]?.retrieval?.hits?.[0]?.evidenceId).toBe("ev_alias_solder_mask");
		const report = evaluatePcbResults([fixture], parsed);
		expect(report.cases[0]?.retrieval.passed).toBe(true);
		expect(report.cases[0]?.final.passed).toBe(false);
	});

	it("produces a measured offline baseline without a release threshold", () => {
		const report = evaluatePcbResults(PCB_EVALUATION_CASES, passingResults(), "2026-01-01T00:00:00.000Z");
		expect(report.schemaVersion).toBe(1);
		expect(report.passedCases).toBe(PCB_EVALUATION_CASES.length);
		expect(report.retrieval.meanScore).toBe(1);
		expect(report.final.meanScore).toBe(1);
		expect(report.baseline.measured).toBe(true);
		expect(report.baseline.sample).toBe(false);
		expect(report.baseline.releaseThreshold).toBeNull();
	});

	it("marks missing results unmeasured and synthetic results as sample data", () => {
		const missing = evaluatePcbResults(PCB_EVALUATION_CASES, []);
		expect(missing.baseline.measured).toBe(false);
		expect(missing.baseline.sample).toBe(false);

		const sample = evaluatePcbResults(PCB_EVALUATION_CASES, passingResults(), undefined, { sample: true });
		expect(sample.baseline.measured).toBe(true);
		expect(sample.baseline.sample).toBe(true);
		expect(sample.baseline.note).toContain("not a real model-quality baseline");
	});

	it("rejects a conclusive payload even when refusal is claimed and checks conclusion type independently", () => {
		const base = PCB_EVALUATION_CASES.find((item) => item.category === "no_hit");
		if (!base) throw new Error("no_hit fixture is required");
		const fixture = {
			...base,
			expectation: {
				...base.expectation,
				answer: {
					...base.expectation.answer,
					expectedDefect: "synthetic-defect",
					expectedConclusionType: "ask" as const,
				},
			},
		};
		const result: EvaluationActualResult = {
			caseId: fixture.id,
			retrieval: { status: "no_results", hits: [] },
			answer: {
				predictedDefect: "synthetic-defect",
				refused: true,
				conclusionType: "conclusive",
			},
		};
		const final = scoreFinal(fixture, result);
		expect(final.dimensions.conclusion.passed).toBe(true);
		expect(final.dimensions.conclusionType?.passed).toBe(false);
		expect(final.dimensions.refusal.passed).toBe(false);
		expect(final.passed).toBe(false);
	});
});
