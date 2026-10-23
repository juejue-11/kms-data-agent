import { readFileSync } from "node:fs";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import type { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import type { AppConfig } from "../config.ts";

// 领域压缩提示词作为运行时常量加载，避免依赖调用进程的当前目录。
export const compactionInstructions = readFileSync(
	new URL("../../resources/pcb/compaction.md", import.meta.url),
	"utf8",
);
export async function createPcbResourceLoader(
	config: AppConfig,
	settingsManager: SettingsManager,
	extensions: ExtensionFactory[],
): Promise<DefaultResourceLoader> {
	// 资源加载器只接收 PCB 显式传入的系统提示词和扩展，隔离项目级发现机制。
	const loader = new DefaultResourceLoader({
		cwd: config.workspaceDir,
		agentDir: config.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: readFileSync(new URL("../../resources/pcb/system-prompt.md", import.meta.url), "utf8"),
		appendSystemPrompt: [],
		extensionFactories: extensions,
	});
	await loader.reload();
	// reload 会执行扩展初始化；任何扩展错误都必须在创建 AgentSession 前暴露。
	if (loader.getExtensions().errors.length) throw new Error("PCB extension initialization failed");
	return loader;
}
