// 启动时校验并整理业务配置快照；凭据只留在服务端，不进入客户端协议。
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 使用模块位置定位仓库，避免从其他目录启动时改变资源和数据路径。
export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export interface AppConfig {
	// 运行数据、领域工作目录与 Pi 配置目录分别管理。
	dataDir: string;
	workspaceDir: string;
	agentDir: string;
	port: number;
	host: string;
	idleTtlMs: number;
	// 服务并发、整轮时限和工具预算属于监督限制，模型重试仍由 Pi 负责。
	maxActiveRequests: number;
	requestTimeoutMs: number;
	maxToolCalls: number;
	retrievalTimeoutMs: number;
	allowWebSearch: boolean;
	// 知识库故障与正常无命中是不同状态，故障后联网必须单独授权配置。
	allowWebOnKbError: boolean;
	allowLocalFallback: boolean;
	kbMinSimilarity: number;
	kbTopK: number;
	memoryEnabled: boolean;
	configVersion: string;
	ragflowBaseUrl: string;
	ragflowApiKey: string;
	datasetIds: string[];
	localKbDir: string;
	searchProvider: "tavily" | "duckduckgo";
	tavilyApiKey: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	// 显式接收环境变量便于离线测试，非法值在启动阶段直接报错。
	const integer = (key: string, fallback: number, min = 1, max = 2147483647): number => {
		const value = env[key] === undefined ? fallback : Number(env[key]);
		if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
		return value;
	};
	const boolean = (key: string, fallback = false): boolean => {
		if (env[key] === undefined) return fallback;
		if (!["true", "false", "1", "0"].includes(env[key]!)) throw new Error(`Invalid ${key}`);
		return env[key] === "true" || env[key] === "1";
	};
	const kbMinSimilarity = Number(env.PCB_KB_MIN_SIMILARITY ?? "0.35");
	if (!Number.isFinite(kbMinSimilarity) || kbMinSimilarity < 0 || kbMinSimilarity > 1)
		throw new Error("Invalid PCB_KB_MIN_SIMILARITY");
	const dataDir = resolve(repositoryRoot, env.PCB_DATA_DIR ?? ".pcb-data");
	const agentDir = resolve(repositoryRoot, env.PI_CODING_AGENT_DIR ?? ".pi-agent");
	const staticDir = resolve(repositoryRoot, "web-ui").toLowerCase();
	// 数据和认证文件不能落在公开静态目录中。
	for (const directory of [dataDir, agentDir]) {
		if (directory.toLowerCase() === staticDir || directory.toLowerCase().startsWith(`${staticDir}${sep}`))
			throw new Error("PCB data and credentials must be outside web-ui");
	}
	const ragflowBaseUrl = env.RAGFLOW_BASE_URL ?? "http://localhost:80";
	if (!["http:", "https:"].includes(new URL(ragflowBaseUrl).protocol)) throw new Error("Invalid RAGFLOW_BASE_URL");
	const searchProvider = env.SEARCH_PROVIDER?.toLowerCase() ?? "duckduckgo";
	if (searchProvider !== "tavily" && searchProvider !== "duckduckgo") throw new Error("Invalid SEARCH_PROVIDER");
	return {
		dataDir,
		workspaceDir: resolve(repositoryRoot, env.PCB_WORKSPACE_DIR ?? `${dataDir}/workspace`),
		agentDir,
		port: integer("PORT", 9100, 0, 65535),
		host: env.PCB_HOST ?? "127.0.0.1",
		idleTtlMs: integer("PCB_SESSION_IDLE_TTL_MS", 600000),
		maxActiveRequests: integer("PCB_MAX_ACTIVE_REQUESTS", 4),
		requestTimeoutMs: integer("PCB_REQUEST_TIMEOUT_MS", 180000),
		maxToolCalls: integer("PCB_MAX_TOOL_CALLS", 8),
		retrievalTimeoutMs: integer("PCB_RETRIEVAL_TIMEOUT_MS", 15000),
		allowWebSearch: boolean("PCB_ALLOW_WEB_SEARCH"),
		allowWebOnKbError: boolean("PCB_ALLOW_WEB_ON_KB_ERROR"),
		allowLocalFallback: boolean("PCB_ALLOW_LOCAL_FALLBACK"),
		kbMinSimilarity,
		kbTopK: integer("PCB_KB_TOP_K", 2, 1, 20),
		memoryEnabled: boolean("PCB_MEMORY_ENABLED"),
		configVersion: env.PCB_CONFIG_VERSION ?? "1",
		ragflowBaseUrl,
		ragflowApiKey: env.RAGFLOW_API_KEY ?? "",
		datasetIds: (env.RAGFLOW_DATASET_IDS ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
		localKbDir: resolve(repositoryRoot, env.LOCAL_KB_DIR ?? "../分析资料"),
		searchProvider,
		tavilyApiKey: env.TAVILY_API_KEY ?? "",
	};
}
