import type { PcbEvaluationCase } from "./types.ts";

/** 术语混乱套件使用脱敏、合成的历史叫法，验证别名归一化及含糊输入的追问边界。 */
interface TerminologySeed {
	id: string;
	query: string;
	label: string;
	defect: string;
	acceptedLabels?: readonly string[];
}

const seeds: readonly TerminologySeed[] = [
	{ id: "line-open", query: "板子上有根线断了", label: "线路", defect: "开路" },
	{ id: "line-short", query: "两条线路碰在一起了", label: "线路", defect: "短路" },
	{ id: "line-peel", query: "铜箔从基材上翘起来了", label: "线路", defect: "剥离" },
	{ id: "line-width", query: "走线变细了，跟原稿对不上", label: "线路", defect: "线宽" },
	{ id: "solder-mask-pad", query: "绿油没有盖住焊盘", label: "阻焊", defect: "阻焊" },
	{ id: "solder-mask-residue", query: "绿漆有残留没清干净", label: "阻焊", defect: "阻焊" },
	{ id: "solder-mask-bubble", query: "防焊层起泡了", label: "阻焊", defect: "阻焊" },
	{ id: "hole-blocked", query: "过孔被堵住了", label: "孔", defect: "孔" },
	{ id: "hole-burr", query: "钻孔边缘有毛刺", label: "孔", defect: "毛刺" },
	{ id: "hole-misaligned", query: "孔打偏了没对齐", label: "孔", defect: "孔" },
	{ id: "tin-uneven", query: "喷锡厚薄不均匀", label: "喷锡", defect: "喷锡" },
	{ id: "tin-oxidised", query: "锡面发黑氧化了", label: "喷锡", defect: "喷锡" },
	{ id: "silkscreen-blur", query: "丝印文字印糊了", label: "字符", defect: "字符" },
	{ id: "silkscreen-skew", query: "字印歪了", label: "字符", defect: "字符" },
	{ id: "carbon-peel", query: "碳油脱落了", label: "碳油", defect: "碳油" },
	{ id: "gold-finger-scratch", query: "金手指有划伤", label: "金手指", defect: "金手指" },
	{ id: "gold-red", query: "化金面发红", label: "金手指", defect: "化金", acceptedLabels: ["金手指", "化金"] },
	{ id: "blue-glue", query: "蓝胶残留没撕干净", label: "蓝胶", defect: "蓝胶" },
	{ id: "v-cut", query: "V割太深伤到线路了", label: "V-CUT", defect: "V-CUT", acceptedLabels: ["V-CUT", "成型"] },
	{
		id: "routing-burr",
		query: "锣板后板边有毛刺",
		label: "机械加工",
		defect: "毛刺",
		acceptedLabels: ["机械加工", "成型"],
	},
	{ id: "silver-black", query: "沉银表面发黑", label: "沉银", defect: "沉银" },
	{ id: "board-scratch", query: "板面有划伤", label: "板面及基材", defect: "板面" },
];

export const TERMINOLOGY_CHAOS_CASES: readonly PcbEvaluationCase[] = seeds.map((seed) => ({
	id: `terminology-${seed.id}`,
	category: "alias",
	description: `Legacy terminology case: ${seed.query}`,
	turns: [{ role: "user", text: seed.query }],
	redactionNote: "Legacy terminology input contains no customer identifier.",
	expectation: {
		retrieval: {
			shouldHit: true,
			acceptedLabels: seed.acceptedLabels ?? [seed.label],
			expectedStatus: "ok",
		},
		answer: { expectedDefect: seed.defect },
	},
}));

export const TERMINOLOGY_AMBIGUOUS_CASE: PcbEvaluationCase = {
	id: "terminology-ambiguous-appearance",
	category: "no_hit",
	description: "Legacy ambiguous terminology case.",
	turns: [{ role: "user", text: "这块板子外观看起来有问题" }],
	redactionNote: "The ambiguous input is intentionally generic.",
	expectation: {
		retrieval: { shouldHit: false, expectedStatus: "no_results" },
		answer: { mustAsk: true, mustRefuseConclusion: true, expectedConclusionType: "ask" },
	},
};
