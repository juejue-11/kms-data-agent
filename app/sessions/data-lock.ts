import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 以独占文件锁保证同一数据目录只有一个服务进程；返回值负责释放本进程持有的锁。
export function acquireDataLock(dataDir: string): () => void {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, "service.lock");
	const token = randomUUID();
	const content = JSON.stringify({ pid: process.pid, token });
	// 最多重试一次：第一次用于发现陈旧锁，第二次用于抢占清理后的路径。
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, content, { flag: "wx", mode: 0o600 });
			return () => {
				// 锁内容包含 PID 和随机 token，避免误删后来进程重新创建的锁。
				if (existsSync(path) && readFileSync(path, "utf8") === content) unlinkSync(path);
			};
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			let lock: { pid?: number };
			try {
				// 锁文件损坏时不能猜测占用者，交给运维检查后再启动。
				lock = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				throw new Error("Data directory lock is invalid; inspect service.lock before restarting");
			}
			if (!Number.isSafeInteger(lock.pid) || lock.pid! <= 0) throw new Error("Invalid lock PID");
			try {
				process.kill(lock.pid!, 0);
			} catch (probeError) {
				if (probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH") {
					// recovery 文件让多个并发启动者串行处理同一个已退出进程的锁。
					const recoveryPath = join(dataDir, "service.lock-recovery");
					try {
						writeFileSync(recoveryPath, content, { flag: "wx", mode: 0o600 });
					} catch {
						throw new Error(
							"PCB lock recovery is already in progress; inspect service.lock-recovery if its process has exited",
						);
					}
					try {
						// 竞争中的启动者可能已经替换了死进程的锁，只有 PID 仍匹配时才删除。
						const current = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
						if (current.pid === lock.pid) {
							try {
								process.kill(current.pid!, 0);
							} catch (currentError) {
								if (currentError instanceof Error && "code" in currentError && currentError.code === "ESRCH")
									unlinkSync(path);
							}
						}
					} finally {
						unlinkSync(recoveryPath);
					}
					continue;
				}
			}
			throw new Error("PCB data directory is already in use");
		}
	}
	throw new Error("Unable to acquire PCB data lock");
}
