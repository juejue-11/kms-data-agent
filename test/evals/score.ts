import type {
	CaseEvaluation,
	EvaluationActualAnswer,
	EvaluationActualResult,
	EvaluationDimension,
	EvaluationReport,
	EvaluationRetrievalHit,
	FinalEvaluation,
	PcbEvaluationCase,
	RetrievalEvaluation,
	RetrievalStatus,
} from "./types.ts";

/**
 * 离线评分器把每个用例拆成“检索”和“最终答案”两组维度，再汇总为可解释的报告。
 * 输入只包含结构化结果；评测器不会发起网络请求，也不会读取环境变量。
 */
export interface EvaluationReportOptions {
	/** 评分器自检用的合成数据不能被当作业务质量基线。 */
	sample?: boolean;
}

function normalizePhrase(value: string | undefined): string {
	return (value ?? "")
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\u2010-\u2015_]+/g, "-")
		.replace(/[^\p{L}\p{N}-]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function includesPhrase(values: readonly string[], expected: string): boolean {
	const wanted = normalizePhrase(expected);
	return values.some((value) => {
		const actual = normalizePhrase(value);
		return actual === wanted || actual.includes(wanted);
	});
}

function dimension(passed: boolean | null, ...reasons: string[]): EvaluationDimension {
	return { passed, score: passed === null ? 1 : passed ? 1 : 0, reasons };
}

function hitLabel(hit: EvaluationRetrievalHit): string {
	return hit.label ?? hit.title ?? "";
}

function activeDimensions(dimensions: Record<string, EvaluationDimension | undefined>): EvaluationDimension[] {
	return Object.values(dimensions).filter(
		(item): item is EvaluationDimension => item !== undefined && item.passed !== null,
	);
}

function aggregate(dimensions: Record<string, EvaluationDimension | undefined>): {
	score: number;
	passed: boolean;
	reasons: string[];
} {
	// 未启用的维度不参与平均分；没有可评分维度时按满分返回，避免无要求用例被误判失败。
	const active = activeDimensions(dimensions);
	const reasons = active.flatMap((item) => item.reasons);
	return {
		score: active.length === 0 ? 1 : active.reduce((sum, item) => sum + item.score, 0) / active.length,
		passed: active.every((item) => item.passed === true),
		reasons,
	};
}

export function scoreRetrieval(
	fixture: PcbEvaluationCase,
	actual: EvaluationActualResult | undefined,
): RetrievalEvaluation {
	// 检索同时检查命中与证据目标、状态和数量边界；缺失实际结果会明确记录原因。
	const expectation = fixture.expectation.retrieval;
	const retrieval = actual?.retrieval;
	const hits = retrieval?.hits ?? [];
	const labels = hits.map(hitLabel).filter(Boolean);
	const hit = dimension(
		retrieval === undefined ? false : hits.length > 0 === expectation.shouldHit,
		retrieval === undefined
			? "Retrieval result is missing."
			: expectation.shouldHit
				? hits.length > 0
					? `Received ${hits.length} retrieval hit(s).`
					: "Expected a hit but retrieval returned no evidence."
				: hits.length === 0
					? "No retrieval hit was returned as expected."
					: `Expected no hit but received ${hits.length} hit(s).`,
	);

	let target: EvaluationDimension | undefined;
	const targetReasons: string[] = [];
	if (expectation.requiredEvidenceIds?.length) {
		const ids = new Set(hits.map((item) => item.evidenceId).filter((id): id is string => Boolean(id)));
		const missing = expectation.requiredEvidenceIds.filter((id) => !ids.has(id));
		if (missing.length) targetReasons.push(`Missing required evidence id(s): ${missing.join(", ")}.`);
		else targetReasons.push("All required evidence ids are present.");
		target = dimension(missing.length === 0, ...targetReasons);
	} else if (expectation.acceptedLabels?.length) {
		const accepted = expectation.acceptedLabels.some((label) => includesPhrase(labels, label));
		target = dimension(
			accepted,
			accepted
				? "At least one accepted retrieval label is present."
				: `No accepted retrieval label was found; received ${labels.length ? labels.join(", ") : "none"}.`,
		);
	}

	if (expectation.forbiddenLabels?.length) {
		const forbidden = expectation.forbiddenLabels.filter((label) => includesPhrase(labels, label));
		const forbiddenDimension = dimension(
			forbidden.length === 0,
			forbidden.length === 0
				? "No forbidden retrieval label is present."
				: `Forbidden retrieval label(s) present: ${forbidden.join(", ")}.`,
		);
		target = target
			? dimension(
					target.passed === true && forbiddenDimension.passed === true,
					...target.reasons,
					...forbiddenDimension.reasons,
				)
			: forbiddenDimension;
	}

	const status = expectation.expectedStatus
		? dimension(
				retrieval?.status === expectation.expectedStatus,
				retrieval === undefined
					? "Retrieval status is missing."
					: retrieval.status === expectation.expectedStatus
						? `Retrieval status is ${expectation.expectedStatus}.`
						: `Expected retrieval status ${expectation.expectedStatus}, received ${retrieval.status ?? "unset"}.`,
			)
		: undefined;
	const bounds =
		expectation.minHits !== undefined || expectation.maxHits !== undefined
			? dimension(
					(expectation.minHits === undefined || hits.length >= expectation.minHits) &&
						(expectation.maxHits === undefined || hits.length <= expectation.maxHits),
					`Received ${hits.length} hit(s); expected bounds ${expectation.minHits ?? 0}..${expectation.maxHits ?? "unbounded"}.`,
				)
			: undefined;

	const dimensions = { hit, target, status, bounds };
	const summary = aggregate(dimensions);
	return { ...summary, dimensions, reasons: summary.reasons };
}

function answerOf(actual: EvaluationActualResult | undefined): EvaluationActualAnswer | undefined {
	return actual?.answer ?? actual?.final;
}

export function scoreFinal(fixture: PcbEvaluationCase, actual: EvaluationActualResult | undefined): FinalEvaluation {
	// 答案评分覆盖结论、标准、追问、拒绝结论和冲突确认，未声明的维度保持不参与状态。
	const expectation = fixture.expectation.answer;
	const answer = answerOf(actual);
	const predicted = answer?.predictedDefect;
	const candidates = answer?.candidates ?? [];

	let conclusion: EvaluationDimension;
	const conclusionReasons: string[] = [];
	if (expectation.expectedDefect !== undefined) {
		const passed = normalizePhrase(predicted) === normalizePhrase(expectation.expectedDefect);
		conclusionReasons.push(
			passed
				? `Predicted defect exactly matches ${expectation.expectedDefect}.`
				: `Expected predicted defect ${expectation.expectedDefect}, received ${predicted ?? "unset"}.`,
		);
		conclusion = dimension(passed, ...conclusionReasons);
	} else if (expectation.allowedCandidates?.length) {
		const observed = [predicted, ...candidates].filter((value): value is string => Boolean(value));
		const passed = observed.some((value) =>
			expectation.allowedCandidates?.some((item) => normalizePhrase(item) === normalizePhrase(value)),
		);
		conclusionReasons.push(
			passed
				? "The result uses an allowed candidate."
				: `No allowed candidate was reported; received ${observed.length ? observed.join(", ") : "none"}.`,
		);
		conclusion = dimension(passed, ...conclusionReasons);
	} else {
		conclusion = dimension(null);
	}

	const conclusionType = expectation.expectedConclusionType
		? dimension(
				answer?.conclusionType === expectation.expectedConclusionType,
				answer?.conclusionType === expectation.expectedConclusionType
					? `Conclusion type is ${expectation.expectedConclusionType}.`
					: `Expected conclusion type ${expectation.expectedConclusionType}, received ${answer?.conclusionType ?? "unset"}.`,
			)
		: undefined;

	if (expectation.forbiddenDefects?.length) {
		const forbidden =
			predicted && expectation.forbiddenDefects.some((item) => normalizePhrase(item) === normalizePhrase(predicted));
		conclusion = dimension(
			conclusion.passed !== false && !forbidden,
			...conclusion.reasons,
			...(forbidden
				? [`Forbidden conclusion ${predicted} was reported.`]
				: ["No forbidden conclusion was reported."]),
		);
	}

	const requiredCriteria = expectation.requiredCriteria ?? [];
	const criteria = requiredCriteria.length
		? dimension(
				Boolean(answer) && requiredCriteria.every((item) => includesPhrase(answer?.criteria ?? [], item)),
				...(answer
					? requiredCriteria.map((item) =>
							includesPhrase(answer.criteria ?? [], item)
								? `Required criterion present: ${item}.`
								: `Required criterion missing: ${item}.`,
						)
					: ["Final answer is missing, so no criteria can be verified."]),
			)
		: dimension(null);

	const requiredFollowUps = expectation.requiredFollowUps ?? [];
	const followUpRequired = expectation.mustAsk === true || requiredFollowUps.length > 0;
	const followUp = followUpRequired
		? dimension(
				Boolean(answer) &&
					(answer?.asked === true || (answer?.followUpQuestions?.length ?? 0) > 0) &&
					requiredFollowUps.every((item) => includesPhrase(answer?.followUpQuestions ?? [], item)),
				...(answer
					? [
							answer.asked === true || (answer.followUpQuestions?.length ?? 0) > 0
								? "The result asks for more information."
								: "The result does not ask a follow-up question.",
							...requiredFollowUps
								.filter((item) => !includesPhrase(answer.followUpQuestions ?? [], item))
								.map((item) => `Required follow-up missing: ${item}.`),
						]
					: ["Final answer is missing, so no follow-up can be verified."]),
			)
		: dimension(null);

	const refusal =
		expectation.mustRefuseConclusion === true
			? dimension(
					Boolean(answer) &&
						(answer?.refused === true || ["ask", "refuse", "conflict"].includes(answer?.conclusionType ?? "")) &&
						!answer?.predictedDefect &&
						(answer?.candidates?.length ?? 0) === 0 &&
						answer?.conclusionType !== "conclusive",
					!answer
						? "Final answer is missing, so refusal cannot be verified."
						: answer.predictedDefect ||
								(answer.candidates?.length ?? 0) > 0 ||
								answer.conclusionType === "conclusive"
							? "The refusal is contradicted by a predicted defect, candidate, or conclusive type."
							: answer.refused === true || ["ask", "refuse", "conflict"].includes(answer.conclusionType ?? "")
								? "The result explicitly withholds a final conclusion."
								: "The result makes or leaves room for a conclusion where refusal was required.",
				)
			: dimension(null);

	const conflict =
		expectation.mustAcknowledgeConflict === true
			? dimension(
					answer?.conflictAcknowledged === true,
					answer?.conflictAcknowledged === true
						? "The evidence conflict is acknowledged."
						: "The evidence conflict is not acknowledged.",
				)
			: undefined;

	const dimensions = { conclusion, conclusionType, criteria, followUp, refusal, conflict };
	const summary = aggregate(dimensions);
	return { ...summary, dimensions, reasons: summary.reasons };
}

export function evaluatePcbResults(
	fixtures: readonly PcbEvaluationCase[],
	results: readonly EvaluationActualResult[],
	generatedAt = new Date().toISOString(),
	options: EvaluationReportOptions = {},
): EvaluationReport {
	// 报告按 caseId 对齐夹具与实际结果，并分别汇总检索和最终答案；baseline 仅描述测量状态。
	const byCase = new Map(results.map((result) => [result.caseId, result]));
	const cases: CaseEvaluation[] = fixtures.map((fixture) => {
		const actual = byCase.get(fixture.id);
		const retrieval = scoreRetrieval(fixture, actual);
		const final = scoreFinal(fixture, actual);
		const reasons = [...retrieval.reasons, ...final.reasons];
		return {
			caseId: fixture.id,
			category: fixture.category,
			retrieval,
			final,
			overallPassed: retrieval.passed && final.passed,
			reasons,
		};
	});
	const retrievalPassedCases = cases.filter((item) => item.retrieval.passed).length;
	const finalPassedCases = cases.filter((item) => item.final.passed).length;
	const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
	const measured = results.some((result) => fixtureIds.has(result.caseId));
	const sample = options.sample === true;
	return {
		schemaVersion: 1,
		generatedAt,
		fixtureCount: fixtures.length,
		resultCount: results.length,
		caseCount: cases.length,
		passedCases: cases.filter((item) => item.overallPassed).length,
		retrieval: {
			passedCases: retrievalPassedCases,
			meanScore: cases.length ? cases.reduce((sum, item) => sum + item.retrieval.score, 0) / cases.length : 1,
		},
		final: {
			passedCases: finalPassedCases,
			meanScore: cases.length ? cases.reduce((sum, item) => sum + item.final.score, 0) / cases.length : 1,
		},
		cases,
		baseline: {
			measured,
			sample,
			releaseThreshold: null,
			note: sample
				? "Synthetic sample only; this report checks the evaluator and is not a real model-quality baseline."
				: measured
					? "Observed structured run; establish a release threshold only after representative human-labelled runs."
					: "No corresponding actual results were supplied; this is a missing-result diagnostic, not a measured baseline.",
		},
	};
}

function normalizeHit(value: unknown): EvaluationRetrievalHit {
	if (typeof value === "string") return { label: value };
	if (!value || typeof value !== "object") return {};
	const item = value as Record<string, unknown>;
	return {
		evidenceId:
			typeof item.evidenceId === "string" ? item.evidenceId : typeof item.id === "string" ? item.id : undefined,
		label:
			typeof item.label === "string"
				? item.label
				: typeof item.source === "string"
					? item.source
					: typeof item.defect === "string"
						? item.defect
						: undefined,
		sourceType:
			typeof item.sourceType === "string" && ["knowledge_base", "local", "web", "unknown"].includes(item.sourceType)
				? (item.sourceType as EvaluationRetrievalHit["sourceType"])
				: undefined,
		title: typeof item.title === "string" ? item.title : undefined,
		score: typeof item.score === "number" ? item.score : undefined,
	};
}

function normalizeRetrievalStatus(value: unknown): RetrievalStatus | undefined {
	return typeof value === "string" && ["ok", "no_results", "degraded", "error"].includes(value)
		? (value as RetrievalStatus)
		: undefined;
}

function normalizeAnswer(value: unknown): EvaluationActualAnswer | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return { text: value };
	if (typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	const candidates = Array.isArray(item.candidates)
		? item.candidates.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const criteria = Array.isArray(item.criteria)
		? item.criteria.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const followUpQuestions = Array.isArray(item.followUpQuestions)
		? item.followUpQuestions.filter((entry): entry is string => typeof entry === "string")
		: Array.isArray(item.followUps)
			? item.followUps.filter((entry): entry is string => typeof entry === "string")
			: undefined;
	return {
		predictedDefect:
			typeof item.predictedDefect === "string"
				? item.predictedDefect
				: typeof item.defect === "string"
					? item.defect
					: undefined,
		candidates,
		criteria,
		followUpQuestions,
		asked: typeof item.asked === "boolean" ? item.asked : undefined,
		refused:
			typeof item.refused === "boolean"
				? item.refused
				: typeof item.shouldRefuseConclusion === "boolean"
					? item.shouldRefuseConclusion
					: undefined,
		conflictAcknowledged:
			typeof item.conflictAcknowledged === "boolean"
				? item.conflictAcknowledged
				: typeof item.conflict === "boolean"
					? item.conflict
					: undefined,
		conclusionType:
			typeof item.conclusionType === "string" &&
			["conclusive", "ask", "refuse", "conflict"].includes(item.conclusionType)
				? (item.conclusionType as EvaluationActualAnswer["conclusionType"])
				: undefined,
		text: typeof item.text === "string" ? item.text : typeof item.reply === "string" ? item.reply : undefined,
	};
}

/** 解析实际运行 JSON；不发起网络请求，也不读取环境变量。 */
export function parseEvaluationResults(input: unknown): EvaluationActualResult[] {
	let entries: unknown[];
	if (Array.isArray(input)) {
		entries = input;
	} else if (input && typeof input === "object" && Array.isArray((input as { results?: unknown }).results)) {
		entries = (input as { results: unknown[] }).results;
	} else if (input && typeof input === "object") {
		entries = Object.entries(input as Record<string, unknown>).map(([caseId, value]) => ({
			caseId,
			...(value as object),
		}));
	} else {
		entries = [];
	}
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		if (typeof item.caseId !== "string") return [];
		const retrievalValue = item.retrieval ?? item.search;
		const retrievalRecord =
			retrievalValue && typeof retrievalValue === "object" ? (retrievalValue as Record<string, unknown>) : undefined;
		const retrieval = retrievalRecord
			? {
					status: normalizeRetrievalStatus(retrievalRecord.status),
					hits: Array.isArray(retrievalRecord.hits)
						? retrievalRecord.hits.map(normalizeHit)
						: Array.isArray(retrievalRecord.evidence)
							? retrievalRecord.evidence.map(normalizeHit)
							: Array.isArray(retrievalRecord.sources)
								? retrievalRecord.sources.map(normalizeHit)
								: [],
				}
			: undefined;
		const answer = normalizeAnswer(item.answer ?? item.final ?? item.reply);
		return [{ caseId: item.caseId, retrieval, answer }];
	});
}
