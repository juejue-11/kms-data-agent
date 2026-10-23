// 保留原术语检查命令入口，评分逻辑统一放在 test/evals，不依赖外部检索服务。
// 使用 --results <文件> 传入实际结构化结果；没有结果时只输出缺失诊断。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "evals", "run.ts");
const forwarded = process.argv.slice(2).filter((arg) => arg !== "--full" && arg !== "--retrieval");
const result = spawnSync(process.execPath, [scriptPath, "--suite", "terminology", ...forwarded], {
	stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
