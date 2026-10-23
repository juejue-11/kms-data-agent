/**
 * 离线评测命令行入口：读取夹具和实际运行 JSON，输出检索、答案及基线报告；整个流程不访问网络。
 * --sample 仅用于验证评分器的合成样例，不能把结果当作模型质量或发布门槛。
 */
import { readFile } from "node:fs/promises";
import { PCB_EVALUATION_CASES } from "./fixtures.ts";
import { evaluatePcbResults, parseEvaluationResults } from "./score.ts";
import { TERMINOLOGY_AMBIGUOUS_CASE, TERMINOLOGY_CHAOS_CASES } from "./terminology.ts";
import type { PcbEvaluationCase } from "./types.ts";

function usage(): string {
	return [
		"Offline PCB evaluation runner",
		"",
		"  node test/evals/run.ts [--results <actual.json>] [--cases <cases.json>] [--suite terminology] [--sample] [--pretty]",
		"",
		"No environment variables or network calls are used. Without --results, the output is a missing-result baseline.",
	].join("\n");
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

function isCase(value: unknown): value is PcbEvaluationCase {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.id === "string" && typeof item.category === "string" && Boolean(item.expectation);
}

function argument(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function isSampleInput(input: unknown): boolean {
	return Boolean(
		input && typeof input === "object" && !Array.isArray(input) && (input as { sample?: unknown }).sample === true,
	);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(usage());
} else {
	const casesPath = argument(args, "--cases");
	const resultsPath = argument(args, "--results");
	const suite = argument(args, "--suite");
	const loadedCases = casesPath ? await readJson(casesPath) : undefined;
	const allCases = Array.isArray(loadedCases)
		? loadedCases.filter(isCase)
		: suite === "terminology"
			? [...TERMINOLOGY_CHAOS_CASES, TERMINOLOGY_AMBIGUOUS_CASE]
			: [...PCB_EVALUATION_CASES];
	const filters = args
		.filter((_arg, index) => index === 0 || !args[index - 1]?.startsWith("--"))
		.filter((arg) => !arg.startsWith("--") && arg !== casesPath && arg !== resultsPath && arg !== suite);
	const cases = filters.length
		? allCases.filter((item) =>
				filters.some((filter) =>
					`${item.id} ${item.description} ${item.turns.map((turn) => turn.text).join(" ")}`.includes(filter),
				),
			)
		: allCases;
	const rawResults = resultsPath ? await readJson(resultsPath) : [];
	// 没有实际结果时保留缺失结果诊断；sample 只标记合成自检，不改变评分维度。
	const sample = args.includes("--sample") || isSampleInput(rawResults);
	const caseIds = new Set(cases.map((item) => item.id));
	const results = parseEvaluationResults(rawResults).filter((result) => caseIds.has(result.caseId));
	const report = evaluatePcbResults(cases, results, undefined, { sample });
	console.log(JSON.stringify(report, null, args.includes("--pretty") || !args.includes("--compact") ? 2 : 0));
}
