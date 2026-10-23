import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { compact } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import type { AppConfig } from "../config.ts";
import { compactionInstructions, createPcbResourceLoader } from "./resource-loader.ts";

export type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
export type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.ts";
export { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
// PiRuntime 是业务层与原生 Pi AgentSession 之间的窄边界，只开放创建会话能力。
export interface PiRuntime {
	createSession(
		manager: SessionManager,
		extensions: ExtensionFactory[],
		toolNames: string[],
		report?: (type: string, payload: unknown) => void,
	): Promise<AgentSession>;
}
// 初始化 Pi 的模型运行时和受限工作目录；allowModelNetwork:false 只关闭初始化阶段的模型目录联网刷新，不禁止后续模型推理请求。
export async function createPiRuntime(config: AppConfig): Promise<PiRuntime> {
	mkdirSync(config.workspaceDir, { recursive: true });
	mkdirSync(config.agentDir, { recursive: true, mode: 0o700 });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(config.agentDir, "auth.json"),
		modelsPath: join(config.agentDir, "models.json"),
		allowModelNetwork: false,
	});
	return runtimeFromModel(config, modelRuntime);
}
export function runtimeFromModel(
	config: AppConfig,
	modelRuntime: ModelRuntime,
	settingsFactory?: () => SettingsManager,
): PiRuntime {
	// 为每个业务会话创建一次 AgentSession，并核对最终生效的工具白名单。
	return {
		async createSession(manager, extensions, toolNames, report) {
			// 忽略项目设置和项目资源发现，确保 PCB 运行时只使用显式注入的资源。
			const settings =
				settingsFactory?.() ??
				SettingsManager.create(config.workspaceDir, config.agentDir, { projectTrusted: false });
			let liveSession: AgentSession | undefined;
			const pcbCompaction: ExtensionFactory = (pi) => {
				pi.on("session_before_compact", async (event, ctx) => {
					if (!ctx.model) throw new Error("MODEL_UNAVAILABLE");
					// 复用 Pi 原生的准备、分段轮次、摘要、重试和持久化流程，只替换领域提示词。
					try {
						const result = await compact(
							event.preparation,
							ctx.model,
							undefined,
							undefined,
							[compactionInstructions, event.customInstructions].filter(Boolean).join("\n"),
							event.signal,
							ctx.thinkingLevel,
							(model, context, options) =>
								liveSession!.agent.streamFunction(
									model,
									normalizeContext({
										messages: [
											{ role: "system", content: compactionInstructions, timestamp: Date.now() },
											...context.messages,
										],
									}),
									options,
								),
							undefined,
							settings.getRetrySettings(),
							{
								onRetryScheduled: (attempt, maxAttempts, delayMs) =>
									report?.("summarization_retrying", { attempt, maxAttempts, delayMs }),
								onRetryFinished: (success, attempt) => report?.("summarization_retrying", { success, attempt }),
							},
						);
						return { compaction: result };
					} catch {
						if (!event.signal.aborted) report?.("compaction_failed", { errorCode: "COMPACTION_FAILED" });
						// Pi 会吞掉扩展处理器异常，因此显式取消，避免领域摘要失败后又落入通用摘要。
						return { cancel: true };
					}
				});
			};
			const loader = await createPcbResourceLoader(config, settings, [...extensions, pcbCompaction]);
			// 开启压缩，但具体摘要实现仍由上面的 PCB 扩展接管。
			settings.applyOverrides({ compaction: { enabled: true } });
			const { session } = await createAgentSession({
				cwd: config.workspaceDir,
				agentDir: config.agentDir,
				sessionManager: manager,
				modelRuntime,
				settingsManager: settings,
				resourceLoader: loader,
				tools: toolNames,
			});
			liveSession = session;
			try {
				await session.bindExtensions({});
				const active = session.getActiveToolNames().sort();
				// 绑定后再次核对工具集合，防止资源加载或扩展注册改变安全边界。
				if (JSON.stringify(active) !== JSON.stringify([...toolNames].sort()))
					throw new Error("PCB tool allowlist mismatch");
				return session;
			} catch (error) {
				session.dispose();
				throw error;
			}
		},
	};
}
