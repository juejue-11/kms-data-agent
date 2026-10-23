// SSE 仅负责临时展示；断流不取消后台生成，客户端可用请求 ID 查询最终结果。
import type { ServerResponse } from "node:http";
import type { BusinessEvent } from "../contracts/protocol.ts";

export function eventStream(response: ServerResponse): { send: (event: BusinessEvent) => void; close: () => void } {
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	response.flushHeaders();
	const heartbeat = setInterval(() => {
		// 心跳不占业务事件序列，连接缓冲较多时跳过，避免继续积压。
		if (!response.destroyed && response.writableLength < 65536) response.write(": keepalive\n\n");
	}, 15000);
	heartbeat.unref();
	response.once("close", () => clearInterval(heartbeat));
	return {
		send(event) {
			if (response.destroyed || response.writableEnded) return;
			const frame = `data: ${JSON.stringify(event)}\n\n`;
			if (response.writableLength + Buffer.byteLength(frame) > 262144) {
				// 原生事件回调不能被慢客户端阻塞，超过缓冲上限时断开该订阅连接。
				response.destroy();
				return;
			}
			response.write(frame);
		},
		close() {
			clearInterval(heartbeat);
			if (!response.destroyed) response.end();
		},
	};
}
