import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";

// 将 Pi 的细粒度事件转换为业务层事件；无法安全对外表达的事件保持未映射。
export function adaptPiEvent(event: AgentSessionEvent): { type: string; payload: unknown } | undefined {
	switch (event.type) {
		case "message_update":
			// 仅转发文本增量，思考或其他中间片段不进入业务流。
			if (event.assistantMessageEvent.type === "text_delta")
				return { type: "message_delta", payload: { delta: event.assistantMessageEvent.delta } };
			return undefined;
		case "message_end":
			// 用户消息结束不构成对外回答，助手消息才生成完整文本事件。
			if (event.message.role !== "assistant") return undefined;
			return {
				type: "message_completed",
				payload: {
					text: event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				},
			};
		case "tool_execution_start":
			return { type: "tool_started", payload: { toolName: event.toolName, toolCallId: event.toolCallId } };
		case "tool_execution_end": {
			// 工具细节来自扩展返回值，按可选字段读取以兼容不同工具实现。
			const details: unknown =
				event.result && typeof event.result === "object" && "details" in event.result
					? event.result.details
					: undefined;
			const record = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
			return {
				type: "tool_completed",
				payload: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
					status: record.status,
					backend: record.backend,
					warningCode: record.warningCode,
				},
			};
		}
		case "compaction_start":
			// 压缩开始和结束分别表达进行中与最终状态，供客户端展示上下文变化。
			return { type: "context_compacting", payload: { reason: event.reason } };
		case "compaction_end":
			return {
				type: "context_compacted",
				payload: {
					reason: event.reason,
					status: event.aborted ? "cancelled" : event.errorMessage ? "failed" : "succeeded",
					usage: event.result?.usage,
				},
			};
		case "auto_retry_start":
			// 普通模型重试和摘要重试使用不同事件名，避免客户端混淆进度。
			return {
				type: "retrying",
				payload: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
			};
		case "auto_retry_end":
			return { type: "retrying", payload: { success: event.success, attempt: event.attempt } };
		case "summarization_retry_scheduled":
			return {
				type: "summarization_retrying",
				payload: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
			};
		default:
			return undefined;
	}
}
