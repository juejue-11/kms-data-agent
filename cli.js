// CLI 只保存服务端签发的 Cookie 并展示响应；会话归属、历史和模型执行均由 HTTP 服务管理。
import process from "node:process";
import { runCli } from "./app/cli/repl.ts";

try {
	await runCli();
} catch (error) {
	console.error(`无法启动客户端：${error?.message || "未知错误"}`);
	process.exitCode = 1;
}
