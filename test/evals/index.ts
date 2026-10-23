/** 离线 PCB 评测的统一入口：导出固定夹具、评分器、术语样例及其结构类型。 */
export { getPcbEvaluationCase, PCB_EVALUATION_CASES } from "./fixtures.ts";
export {
	type EvaluationReportOptions,
	evaluatePcbResults,
	parseEvaluationResults,
	scoreFinal,
	scoreRetrieval,
} from "./score.ts";
export { TERMINOLOGY_AMBIGUOUS_CASE, TERMINOLOGY_CHAOS_CASES } from "./terminology.ts";
export type {
	CaseEvaluation,
	EvaluationActualAnswer,
	EvaluationActualResult,
	EvaluationAnswerExpectation,
	EvaluationCategory,
	EvaluationDimension,
	EvaluationReport,
	EvaluationRetrievalExpectation,
	EvaluationRetrievalHit,
	EvaluationTurn,
	FinalEvaluation,
	PcbEvaluationCase,
	RetrievalEvaluation,
	RetrievalStatus,
} from "./types.ts";
