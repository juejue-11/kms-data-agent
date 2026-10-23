// 统一装配入口：网页和 CLI 共用此服务，模型执行与历史管理始终交给 Pi。
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./agent/agent-service.ts";
import { type AppConfig, loadConfig, repositoryRoot } from "./config.ts";
import { AppError } from "./contracts/protocol.ts";
import { validate } from "./evidence/evidence-service.ts";
import { createHttpServer } from "./http/app.ts";
import { createMemoryExtension, MEMORY_EXTENSION_TOOL_NAMES } from "./memory/extension.ts";
import { MemoryStore } from "./memory/store.ts";
import { createPiRuntime, type PiRuntime } from "./runtime/pi-runtime.ts";
import { acquireDataLock } from "./sessions/data-lock.ts";
import { type PcbExtensionDeps, tools } from "./tools/pcb-extension.ts";

export function assertSourceRuntime(): void {
	// 包名必须解析到当前仓库源码，避免误用 node_modules 中残留的构建产物。
	for (const [name, path] of [
		["pi-coding-agent", "coding-agent"],
		["pi-agent-core", "agent"],
		["pi-ai", "ai"],
	]) {
		const resolved = fileURLToPath(import.meta.resolve(`@earendil-works/${name}`));
		if (resolved.toLowerCase() !== resolve(repositoryRoot, "packages", path, "src/index.ts").toLowerCase())
			throw new Error("PCB requires the repository source resolver; use npm run start:pcb");
	}
}
/** 允许测试注入原生运行时和检索替身，生产入口则使用服务器配置。 */
export function createService(
	config: AppConfig,
	runtime: PiRuntime,
	adapters: Partial<PcbExtensionDeps> = {},
): AgentService {
	mkdirSync(config.workspaceDir, { recursive: true });
	const memory = new MemoryStore({ storagePath: join(config.dataDir, "memory.json") });
	const service = new AgentService({
		config,
		runtime,
		validate,
		log: (record) => console.log(JSON.stringify(record)),
		tools: (input) => {
			// 每个会话创建独立扩展；策略再按当前请求重置，避免串用检索状态。
			const pcb = tools({
				...input,
				policyConfig: {
					maxToolCalls: config.maxToolCalls,
					allowWebSearch: config.allowWebSearch,
					allowWebOnKbError: config.allowWebOnKbError,
				},
				deps: {
					retrievalTimeoutMs: config.retrievalTimeoutMs,
					maxResults: config.kbTopK,
					retrievalOptions: {
						minSimilarity: config.kbMinSimilarity,
						topK: config.kbTopK,
						allowLocalFallback: config.allowLocalFallback,
						ragflowBaseUrl: config.ragflowBaseUrl,
						ragflowApiKey: config.ragflowApiKey,
						datasetIds: config.datasetIds,
						localKbDir: config.localKbDir,
						searchProvider: config.searchProvider,
						tavilyApiKey: config.tavilyApiKey,
						env: {},
					},
					...adapters,
				},
			});
			const extensions = [...pcb.extensions];
			const toolNames: string[] = [...pcb.toolNames];
			if (config.memoryEnabled) {
				// 记忆属于可选业务事实，不自动注入全部聊天，也不替代 Pi 的会话历史。
				extensions.push(
					createMemoryExtension({
						store: memory,
						enabled: true,
						getPrincipal: () => (input.getRun() ? { ownerId: input.ownerId } : undefined),
						getDefaultSource: () => {
							// 未指定来源时关联本轮真实用户条目，不能凭空生成来源标识。
							const entry = input.manager
								.getBranch()
								.findLast((item) => item.type === "message" && item.message.role === "user");
							if (!entry) throw new AppError("INVALID_MEMORY_SOURCE", 400);
							return { sourceSessionId: input.sessionId, sourceEntryId: entry.id };
						},
						beforeExecute: (signal) => {
							// 记忆工具与检索工具共享本轮预算及取消状态。
							signal?.throwIfAborted();
							const run = input.getRun();
							if (!run) throw new AppError("REQUEST_NOT_RUNNING", 409);
							run.signal.throwIfAborted();
							const decision = pcb.getPolicy().before("memory");
							if (!decision.allowed) {
								if (decision.terminate) run.stop(decision.code!);
								throw new AppError(decision.code!, 409);
							}
						},
						validateSource: (sessionId, entryId) => {
							// 先验证来源会话归属，再检查条目；会话 ID 本身不构成访问授权。
							const metadata = service.store.readSession(input.ownerId, sessionId);
							const manager =
								sessionId === input.sessionId
									? input.manager
									: (service.registry.peekManager(sessionId) ?? service.registry.openManager(metadata));
							if (!manager.getBranch().some((entry) => entry.id === entryId))
								throw new AppError("INVALID_MEMORY_SOURCE", 400);
						},
					}),
				);
				toolNames.push(...MEMORY_EXTENSION_TOOL_NAMES);
			}
			return { extensions, toolNames };
		},
	});
	return service;
}
export async function bootstrap(config: AppConfig = loadConfig()) {
	assertSourceRuntime();
	// 必须在创建存储和服务前取得独占锁，保证一个数据目录只有一个写入进程。
	const release = acquireDataLock(config.dataDir);
	let service: AgentService | undefined;
	try {
		service = createService(config, await createPiRuntime(config));
		const server = createHttpServer(service, config.dataDir);
		await new Promise<void>((ready, reject) => {
			server.once("error", reject);
			server.listen(config.port, config.host, ready);
		});
		let closing: Promise<void> | undefined;
		const close = (): Promise<void> => {
			// 多个退出信号共用同一次关闭：停止接入、取消任务、断开连接后才释放锁。
			closing ??= (async () => {
				const stopped = new Promise<void>((done) => server.close(() => done()));
				await service!.close();
				server.closeAllConnections();
				await stopped;
				release();
			})();
			return closing;
		};
		return { service, server, close };
	} catch (error) {
		// 启动中途失败也释放已创建资源，避免留下本进程的有效锁。
		await service?.close();
		release();
		throw error;
	}
}
