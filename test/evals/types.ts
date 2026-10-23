/** 离线 PCB 评测的数据契约：夹具声明期望，实际结果提供检索与答案，报告按维度汇总。 */
export type EvaluationCategory =
	| "alias"
	| "similar_defect"
	| "contradictory_parameters"
	| "multi_turn"
	| "no_hit"
	| "web_conflict"
	| "compaction";

export type RetrievalStatus = "ok" | "no_results" | "degraded" | "error";

export interface EvaluationTurn {
	role: "user" | "assistant";
	text: string;
}

export interface EvaluationRetrievalHit {
	evidenceId?: string;
	label?: string;
	sourceType?: "knowledge_base" | "local" | "web" | "unknown";
	title?: string;
	score?: number;
}

export interface EvaluationRetrievalExpectation {
	shouldHit: boolean;
	requiredEvidenceIds?: readonly string[];
	acceptedLabels?: readonly string[];
	forbiddenLabels?: readonly string[];
	minHits?: number;
	maxHits?: number;
	expectedStatus?: RetrievalStatus;
}

export interface EvaluationAnswerExpectation {
	expectedDefect?: string;
	allowedCandidates?: readonly string[];
	forbiddenDefects?: readonly string[];
	requiredCriteria?: readonly string[];
	requiredFollowUps?: readonly string[];
	mustAsk?: boolean;
	mustRefuseConclusion?: boolean;
	mustAcknowledgeConflict?: boolean;
	expectedConclusionType?: "conclusive" | "ask" | "refuse" | "conflict";
}

export interface PcbEvaluationCase {
	id: string;
	category: EvaluationCategory;
	description: string;
	turns: readonly EvaluationTurn[];
	redactionNote: string;
	expectation: {
		retrieval: EvaluationRetrievalExpectation;
		answer: EvaluationAnswerExpectation;
	};
}

/** 被评测系统返回的结构化答案；文本字段仅作为兼容输入，不直接替代维度判断。 */
export interface EvaluationActualAnswer {
	predictedDefect?: string;
	candidates?: readonly string[];
	criteria?: readonly string[];
	followUpQuestions?: readonly string[];
	asked?: boolean;
	refused?: boolean;
	conflictAcknowledged?: boolean;
	conclusionType?: "conclusive" | "ask" | "refuse" | "conflict";
	text?: string;
}

export interface EvaluationActualResult {
	caseId: string;
	retrieval?: {
		status?: RetrievalStatus;
		hits?: readonly EvaluationRetrievalHit[];
	};
	answer?: EvaluationActualAnswer;
	/** 对把答案字段命名为 final 的集成，接受它作为 answer 的别名。 */
	final?: EvaluationActualAnswer;
}

export interface EvaluationDimension {
	passed: boolean | null;
	score: number;
	reasons: readonly string[];
}

export interface RetrievalEvaluation {
	score: number;
	passed: boolean;
	dimensions: {
		hit: EvaluationDimension;
		target?: EvaluationDimension;
		status?: EvaluationDimension;
		bounds?: EvaluationDimension;
	};
	reasons: readonly string[];
}

export interface FinalEvaluation {
	score: number;
	passed: boolean;
	dimensions: {
		conclusion: EvaluationDimension;
		conclusionType?: EvaluationDimension;
		criteria: EvaluationDimension;
		followUp: EvaluationDimension;
		refusal: EvaluationDimension;
		conflict?: EvaluationDimension;
	};
	reasons: readonly string[];
}

export interface CaseEvaluation {
	caseId: string;
	category: EvaluationCategory;
	retrieval: RetrievalEvaluation;
	final: FinalEvaluation;
	overallPassed: boolean;
	reasons: readonly string[];
}

export interface EvaluationReport {
	schemaVersion: 1;
	generatedAt: string;
	fixtureCount: number;
	resultCount: number;
	caseCount: number;
	passedCases: number;
	retrieval: {
		passedCases: number;
		meanScore: number;
	};
	final: {
		passedCases: number;
		meanScore: number;
	};
	cases: readonly CaseEvaluation[];
	/** baseline 只描述当前是否有测量结果，不预设发布阈值。 */
	baseline: {
		measured: boolean;
		sample: boolean;
		releaseThreshold: null;
		note: string;
	};
}
