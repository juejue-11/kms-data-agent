// 服务入口仅负责启动与退出信号，业务装配集中在 app/bootstrap.ts。
import { bootstrap } from "./app/bootstrap.ts";

try {
	const application = await bootstrap();
	const address = application.server.address();
	console.log(`PCB 服务已启动：http://${address.address}:${address.port}`);
	const stop = () => {
		// 取消活动请求并释放数据目录锁；失败通过进程退出码反馈。
		void application.close().catch(() => {
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
} catch (error) {
	console.error(`PCB 启动失败：${error instanceof Error ? error.message : "未知错误"}`);
	process.exitCode = 1;
}
