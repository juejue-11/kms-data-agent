// HTTP、SSE 与业务服务共用的协议；仅投影 Pi 结果，不维护第二份消息历史。
export type RequestStatus = "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
/** 仅返回工具实际取得的定位信息，缺失的页码和链接不补造。 */
export interface Source {
	evidenceId: string;
	sourceType: "knowledge_base" | "local" | "web";
	title: string;
	text?: string;
	page?: number;
	url?: string;
}
/** 请求查询和最终事件使用相同结构；取消或中断时 reply 可能只是部分文本。 */
export interface RequestResult {
	sessionId: string;
	requestId: string;
	status: RequestStatus;
	reply: string;
	sources: Source[];
	citationValidation: { status: "valid" | "invalid" | "not_applicable"; invalidIds: string[] };
	errorCode?: string;
	model?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
}
/** sequence 在单次请求内递增，客户端据此过滤重复或过期增量。 */
export interface BusinessEvent {
	sessionId: string;
	requestId: string;
	sequence: number;
	type: string;
	payload: unknown;
}
/** 稳定业务错误码与 HTTP 状态分开保存，客户端无需解析错误文案。 */
export class AppError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status: number, message = code) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireId(value: unknown): string {
	// 对外只接受业务 UUID，不把客户端参数作为任意历史文件路径。
	if (typeof value !== "string" || !uuidPattern.test(value)) throw new AppError("INVALID_INPUT", 400);
	return value;
}
export function isTerminal(status: RequestStatus): boolean {
	// 受理和运行均非终态；不能仅凭一次模型 agent_end 判定业务请求完成。
	return status !== "accepted" && status !== "running";
}
