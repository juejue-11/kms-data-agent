// 仅运行 PCB 离线单元测试，避免意外启用仓库中依赖真实认证的端到端测试。
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: [
				"test/unit/memory-store.test.ts",
				"test/unit/memory-extension.test.ts",
				"test/unit/evaluation.test.ts",
			],
			environment: "node",
			env: { PI_OFFLINE: "1" },
		},
	}),
);
