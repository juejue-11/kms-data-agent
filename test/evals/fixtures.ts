import type { PcbEvaluationCase } from "./types.ts";

/**
 * 脱敏后的 PCB 评测用例；其中的标签是稳定的夹具标识，不是生产文档名称。
 * 运行时适配器可在评分前把实际证据元数据映射到这些标签。
 */
export const PCB_EVALUATION_CASES: readonly PcbEvaluationCase[] = [
	{
		id: "alias-solder-mask-pad-exposure",
		category: "alias",
		description: "The colloquial 绿油 wording should resolve to solder-mask exposure.",
		turns: [{ role: "user", text: "绿油没有盖住焊盘，露铜了" }],
		redactionNote: "Part number, customer and document identifiers were removed.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_alias_solder_mask"],
				acceptedLabels: ["solder-mask-exposure"],
				expectedStatus: "ok",
			},
			answer: {
				expectedDefect: "solder-mask-exposure",
				requiredCriteria: ["pad copper is exposed", "solder-mask coverage is missing"],
			},
		},
	},
	{
		id: "similar-line-whitening-vs-open",
		category: "similar_defect",
		description: "The appearance is similar to an open circuit, but continuity is intact.",
		turns: [{ role: "user", text: "走线边缘发白，看着像断线，但万用表导通" }],
		redactionNote: "Measurement instrument and board identifiers were anonymised.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_similar_line_whitening"],
				acceptedLabels: ["line-whitening"],
				forbiddenLabels: ["open-circuit"],
				expectedStatus: "ok",
			},
			answer: {
				expectedDefect: "line-whitening",
				allowedCandidates: ["line-whitening", "open-circuit"],
				forbiddenDefects: ["open-circuit"],
				requiredCriteria: ["continuity remains intact"],
			},
		},
	},
	{
		id: "contradictory-line-width-parameters",
		category: "contradictory_parameters",
		description: "Reported and drawing line widths conflict, so the answer must request the drawing revision.",
		turns: [{ role: "user", text: "线宽标称 0.15 mm，实测 0.30 mm，但检验单写的是 0.20 mm" }],
		redactionNote: "Numeric values are synthetic and do not identify a customer design.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_contradictory_line_width"],
				acceptedLabels: ["line-width-out-of-tolerance"],
				expectedStatus: "ok",
			},
			answer: {
				expectedDefect: "line-width-out-of-tolerance",
				requiredCriteria: ["compare measured width with the controlled drawing"],
				requiredFollowUps: ["confirm the controlled drawing revision"],
				mustAsk: true,
			},
		},
	},
	{
		id: "multi-turn-board-scratch",
		category: "multi_turn",
		description: "A follow-up question must retain the defect from the previous turn.",
		turns: [
			{ role: "user", text: "板面有划伤" },
			{ role: "user", text: "这种缺陷怎么处理？" },
		],
		redactionNote: "Process names and board identifiers were removed.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_multi_turn_board_scratch"],
				acceptedLabels: ["board-scratch"],
				expectedStatus: "ok",
			},
			answer: {
				expectedDefect: "board-scratch",
				requiredCriteria: ["scratch depth", "whether copper is exposed"],
				requiredFollowUps: ["whether copper is exposed"],
				mustAsk: true,
			},
		},
	},
	{
		id: "no-hit-insufficient-description",
		category: "no_hit",
		description: "An unrecognised description must not be turned into a confident defect conclusion.",
		turns: [{ role: "user", text: "板子看起来不太对" }],
		redactionNote: "The description is intentionally generic and contains no customer data.",
		expectation: {
			retrieval: {
				shouldHit: false,
				expectedStatus: "no_results",
			},
			answer: {
				mustAsk: true,
				mustRefuseConclusion: true,
				expectedConclusionType: "ask",
			},
		},
	},
	{
		id: "web-conflict-with-internal-record",
		category: "web_conflict",
		description:
			"Internal and web evidence disagree; the answer must surface the conflict and defer a final conclusion.",
		turns: [{ role: "user", text: "化金面发红，内部资料和网上资料给了不同原因" }],
		redactionNote: "URLs, supplier names and document numbers were replaced with fixture identifiers.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_conflict_internal", "ev_conflict_web"],
				acceptedLabels: ["immersion-gold-discoloration", "web-oxidation-note"],
				expectedStatus: "ok",
			},
			answer: {
				mustRefuseConclusion: true,
				mustAcknowledgeConflict: true,
				expectedConclusionType: "conflict",
				requiredFollowUps: ["confirm the applicable process specification"],
				mustAsk: true,
			},
		},
	},
	{
		id: "compaction-retains-defect-context",
		category: "compaction",
		description: "After context compaction, the follow-up still needs the original board-scratch evidence.",
		turns: [
			{ role: "user", text: "记录一下：板面划伤但目前没有看到露铜" },
			{ role: "assistant", text: "已记录现象，需结合深度和检验标准判断。" },
			{ role: "user", text: "压缩上下文后，这个缺陷的判定依据是什么？" },
		],
		redactionNote: "The compaction marker and evidence text are synthetic.",
		expectation: {
			retrieval: {
				shouldHit: true,
				requiredEvidenceIds: ["ev_compaction_board_scratch"],
				acceptedLabels: ["board-scratch"],
				expectedStatus: "ok",
			},
			answer: {
				expectedDefect: "board-scratch",
				requiredCriteria: ["scratch depth", "whether copper is exposed"],
			},
		},
	},
] as const;

export function getPcbEvaluationCase(caseId: string): PcbEvaluationCase | undefined {
	return PCB_EVALUATION_CASES.find((item) => item.id === caseId);
}
