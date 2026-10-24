// HTTP 层只处理身份、协议和传输，问答生命周期由 AgentService 统一管理。
import { createReadStream, type Stats, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { AgentService } from "../agent/agent-service.ts";
import { repositoryRoot } from "../config.ts";
import { AppError, isTerminal } from "../contracts/protocol.ts";
import { checkOrigin, createIdentity } from "./identity.ts";
import { eventStream } from "./stream.ts";

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	// 接收正文时累加大小，防止无界缓存；最终仍由业务服务校验字段。
	if (!request.headers["content-type"]?.startsWith("application/json")) throw new AppError("INVALID_INPUT", 400);
	const parts: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 70000) throw new AppError("INVALID_INPUT", 400);
		parts.push(Buffer.from(chunk));
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
		return value as Record<string, unknown>;
	} catch {
		throw new AppError("INVALID_INPUT", 400);
	}
}
export function createHttpServer(service: AgentService, dataDir: string) {
	const identity = createIdentity(dataDir);
	const staticRoot = resolve(repositoryRoot, "web-ui");
	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "same-origin");
		if (request.method !== "GET" && request.method !== "HEAD") checkOrigin(request);
		const url = new URL(request.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith("/api/")) {
			// 仅公开 web-ui 下的文件，解析后的绝对路径必须仍位于静态根目录内。
			if (request.method !== "GET" && request.method !== "HEAD") throw new AppError("NOT_FOUND", 404);
			const path = resolve(
				staticRoot,
				`.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
			);
			if (!path.startsWith(`${staticRoot}${sep}`)) throw new AppError("NOT_FOUND", 404);
			let stat: Stats;
			try {
				stat = statSync(path);
			} catch {
				throw new AppError("NOT_FOUND", 404);
			}
			if (!stat.isFile()) throw new AppError("NOT_FOUND", 404);
			const types: Record<string, string> = {
				".html": "text/html; charset=utf-8",
				".js": "text/javascript; charset=utf-8",
				".css": "text/css; charset=utf-8",
				".svg": "image/svg+xml",
				".png": "image/png",
			};
			response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
			if (request.method === "HEAD") response.end();
			else
				createReadStream(path)
					.on("error", () => response.destroy())
					.pipe(response);
			return;
		}
		const ownerId = identity(request, response);
		// ownerId 只能取自服务器验证的 Cookie，忽略请求正文中的身份声明。
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[1] !== "sessions") throw new AppError("NOT_FOUND", 404);
		const limit = Number(url.searchParams.get("limit") ?? 50);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("INVALID_INPUT", 400);
		if (parts.length === 2) {
			if (request.method === "POST") {
				json(response, 201, service.create(ownerId));
				return;
			}
			if (request.method === "GET") {
				json(response, 200, service.list(ownerId, url.searchParams.get("before") ?? undefined, limit));
				return;
			}
		}
		const sessionId = parts[2];
		if (parts.length === 3) {
			if (request.method === "GET") {
				json(response, 200, service.get(ownerId, sessionId));
				return;
			}
			if (request.method === "PATCH") {
				const input = await body(request);
				json(response, 200, service.rename(ownerId, sessionId, input.title));
				return;
			}
			if (request.method === "DELETE") {
				json(response, 200, await service.delete(ownerId, sessionId));
				return;
			}
		}
		if (parts.length === 4 && parts[3] === "messages") {
			if (request.method === "GET") {
				json(
					response,
					200,
					service.messages(ownerId, sessionId, url.searchParams.get("before") ?? undefined, limit),
				);
				return;
			}
			if (request.method === "POST") {
				const input = await body(request);
				const submission = service.submit(ownerId, sessionId, {
					requestId: input.requestId,
					message: input.message,
				});
				if (submission.duplicate) {
					// 相同请求只返回已有状态，即使客户端期望 SSE 也不重复启动生成。
					json(response, isTerminal(submission.result.status) ? 200 : 202, {
						...submission.result,
						statusUrl: `/api/sessions/${sessionId}/requests/${submission.result.requestId}`,
					});
					return;
				}
				if (request.headers.accept?.includes("text/event-stream")) {
					// 先订阅再启动，避免漏掉同步产生的首个事件；断开流仅移除订阅。
					const stream = eventStream(response);
					const unsubscribe = submission.subscribe!((event) => {
						stream.send(event);
						if (event.type === "request_finished") stream.close();
					});
					response.once("close", unsubscribe);
					submission.start!();
				} else {
					// 普通 JSON 调用也等待同一个执行结果，不创建另一套模型执行流程。
					submission.start!();
					const result = await submission.done!;
					json(response, result.errorCode === "MODEL_UNAVAILABLE" ? 503 : 200, result);
				}
				return;
			}
		}
		if (parts[3] === "requests" && parts.length === 5 && request.method === "GET") {
			json(response, 200, service.request(ownerId, sessionId, parts[4]));
			return;
		}
		if (parts[3] === "requests" && parts[5] === "cancel" && parts.length === 6 && request.method === "POST") {
			json(response, 200, await service.cancel(ownerId, sessionId, parts[4]));
			return;
		}
		throw new AppError("NOT_FOUND", 404);
	};
	const server = createServer((request, response) => {
		void handler(request, response).catch((error: unknown) => {
			// 已开始 SSE 后不能再写 JSON 错误头，关闭连接让客户端查询请求状态。
			if (response.headersSent) {
				response.destroy();
				return;
			}
			json(response, error instanceof AppError ? error.status : 500, {
				error: {
					code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
					message: error instanceof AppError ? error.message : "服务处理失败",
				},
			});
		});
	});
	server.requestTimeout = 30000;
	return server;
}
