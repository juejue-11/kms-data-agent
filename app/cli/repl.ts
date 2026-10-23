import crypto from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import {
	createPcbHttpClient,
	type JsonObject,
	type Message,
	PcbClientError,
	type PcbEvent,
	type PcbHttpClientOptions,
	type RequestResult,
	type SendMessageOptions,
	type SendMessageResult,
	type SessionList,
	type Source,
	StreamDisconnectedError,
} from "./http-client.ts";

/**
 * 交互式 CLI 的会话层：负责启动 readline、维护当前会话和活动请求，并把服务端事件转换为终端输出。
 * 请求流中断或服务端返回 202 时只轮询原 requestId，保证恢复过程不会再次提交用户消息。
 */
type CliInput = NodeJS.ReadableStream & { isTTY?: boolean };
type CliOutput = { write(chunk: string): unknown; isTTY?: boolean };

export type CliClient = {
	createSession(): Promise<JsonObject>;
	listSessions(options?: { cursor?: string; limit?: number }): Promise<SessionList>;
	getSession(sessionId: string): Promise<JsonObject>;
	getMessages(
		sessionId: string,
		options?: { before?: string; limit?: number },
	): Promise<{ messages?: Message[]; nextCursor?: string }>;
	getRequest(sessionId: string, requestId: string): Promise<RequestResult>;
	cancelRequest(sessionId: string, requestId: string): Promise<RequestResult>;
	sendMessage(sessionId: string, options?: SendMessageOptions): Promise<SendMessageResult>;
};

export type CliAppOptions = {
	client: CliClient;
	input?: CliInput;
	output?: CliOutput;
	errorOutput?: CliOutput;
	randomUuid?: () => string;
};

export type RunCliOptions = Omit<CliAppOptions, "client"> & {
	client?: CliClient;
	clientOptions?: PcbHttpClientOptions;
};

type ActiveRequest = { sessionId: string; requestId: string };

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const useColor = Boolean(process.stdout.isTTY);
const paint = (code: string, value: string): string => (useColor ? `\u001b[${code}m${value}\u001b[0m` : value);
const green = (value: string): string => paint("32", value);
const cyan = (value: string): string => paint("36", value);
const yellow = (value: string): string => paint("33", value);
const red = (value: string): string => paint("31", value);
const gray = (value: string): string => paint("90", value);
const bold = (value: string): string => paint("1", value);

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
	return isRecord(value) ? value : {};
}

function terminalResult(value: unknown): JsonObject | null {
	const object = asObject(value);
	const candidate = isRecord(object.final) ? object.final : isRecord(object.result) ? object.result : object;
	return isTerminal(candidate) ? candidate : null;
}

function messageText(message: unknown): string {
	if (typeof message === "string") return message;
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part): part is JsonObject => isRecord(part) && typeof part.text === "string")
			.map((part) => String(part.text))
			.join("");
	}
	return "";
}

function sourceLabel(source: Source): string {
	const sourceType = String(source?.sourceType || source?.type || "").toLowerCase();
	if (sourceType.includes("knowledge") || sourceType === "kb" || sourceType === "知识库") return "知识库";
	if (sourceType.includes("local") || sourceType === "本地") return "本地降级";
	if (sourceType.includes("web") || sourceType === "网络") return "网络";
	return String(source?.title || source?.source || "source");
}

function sourceTitle(source: Source): string {
	return String(source?.title || source?.source || source?.url || "source");
}

function sourceLocation(source: Source): string {
	const location = [];
	if (source?.page !== undefined && source.page !== null) location.push(`第 ${source.page} 页`);
	if (source?.url) location.push(String(source.url));
	return location.length ? ` · ${location.join(" · ")}` : "";
}

function requestStatus(value: unknown): string {
	const object = asObject(value);
	return String(object.status || object.state || "").toLowerCase();
}

function isTerminal(value: unknown): boolean {
	return ["succeeded", "failed", "cancelled", "canceled", "interrupted", "timeout"].includes(requestStatus(value));
}

function hasServiceError(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	if (!isRecord(error)) return false;
	return error.code === "SERVICE_UNAVAILABLE" || error.code === "STREAM_DISCONNECTED";
}

export class CliApp {
	readonly client: CliClient;
	readonly input: CliInput;
	readonly output: CliOutput;
	readonly errorOutput: CliOutput;
	readonly randomUuid: () => string;
	currentSessionId: string | null;
	activeRequest: ActiveRequest | null;
	readline: readline.Interface | null;
	busy: boolean;
	closed: boolean;
	resolveClosed: (() => void) | null;

	constructor({
		client,
		input = process.stdin,
		output = process.stdout,
		errorOutput = process.stderr,
		randomUuid = crypto.randomUUID,
	}: CliAppOptions) {
		if (!client) throw new TypeError("client is required");
		this.client = client;
		this.input = input;
		this.output = output;
		this.errorOutput = errorOutput;
		this.randomUuid = randomUuid;
		this.currentSessionId = null;
		this.activeRequest = null;
		this.readline = null;
		this.busy = false;
		this.closed = false;
		this.resolveClosed = null;
	}

	write(value: unknown): void {
		this.output.write(String(value));
	}

	writeLine(value = ""): void {
		this.write(`${value}\n`);
	}

	writeError(value: unknown): void {
		this.errorOutput.write(`${value}\n`);
	}

	printBanner() {
		this.writeLine(bold("PCB 缺陷分析助手") + gray(" —— 会话服务客户端"));
		this.writeLine(gray("输入缺陷现象发送。命令：new / list / open / history / stop / clear / help / exit。"));
		this.writeLine("");
	}

	printHelp() {
		this.writeLine("");
		this.writeLine("可用命令：");
		this.writeLine("  new              新建会话");
		this.writeLine("  list             列出本人会话");
		this.writeLine("  open <sessionId> 打开并恢复会话");
		this.writeLine("  history          查看当前会话历史");
		this.writeLine("  stop [requestId] 停止当前或指定请求");
		this.writeLine("  clear            只清屏，不删除历史");
		this.writeLine("  help             显示本帮助");
		this.writeLine("  exit             退出程序");
		this.writeLine("");
	}

	printPrompt() {
		if (!this.readline || this.closed) return;
		const suffix = this.currentSessionId ? ` [${this.currentSessionId}]` : "";
		this.readline.setPrompt(`${green("❯")}${gray(suffix)} `);
		this.readline.prompt();
	}

	clearScreen() {
		this.write("\u001b[2J\u001b[H");
		this.printBanner();
	}

	async start(): Promise<void> {
		// 先做一次轻量连通性检查，再挂载 line/SIGINT/close 生命周期，最后把控制权交给 readline。
		this.printBanner();
		if (typeof this.client.listSessions === "function") {
			try {
				await this.client.listSessions({ limit: 1 });
			} catch (error) {
				this.printError(error);
			}
		}
		this.readline = readline.createInterface({
			input: this.input,
			output: this.output as NodeJS.WritableStream,
			prompt: `${green("❯")} `,
			terminal: Boolean(this.input.isTTY && this.output.isTTY),
		});
		this.readline.on("line", (line) => {
			void this.handleLine(line);
		});
		this.readline.on("SIGINT", () => this.close());
		this.readline.on("close", () => {
			this.closed = true;
			if (this.resolveClosed) this.resolveClosed();
		});
		this.printPrompt();
		return new Promise((resolve) => {
			this.resolveClosed = resolve;
			if (this.closed) resolve();
		});
	}

	close(): void {
		if (this.closed) return;
		this.readline?.close();
	}

	async handleLine(line: string): Promise<void> {
		const input = String(line || "").trim();
		if (!input) {
			this.printPrompt();
			return;
		}
		const [command, ...arguments_] = input.split(/\s+/);
		const normalized = command.toLowerCase();
		// 一次只允许一个活动请求；stop 是唯一可在忙碌期间继续处理的命令。
		if (this.busy && normalized !== "stop") {
			this.writeError(gray("当前请求仍在运行，请使用 stop。"));
			return;
		}
		if (this.busy && normalized === "stop") {
			try {
				await this.stopRequest(arguments_[0]);
			} catch (error) {
				this.printError(error);
			}
			this.printPrompt();
			return;
		}
		if (normalized === "exit" || normalized === "quit") {
			this.close();
			return;
		}
		if (normalized === "help" || normalized === "?" || normalized === "？") {
			this.printHelp();
			this.printPrompt();
			return;
		}
		if (normalized === "clear" || normalized === "cls") {
			this.clearScreen();
			this.printPrompt();
			return;
		}

		this.busy = true;
		try {
			switch (normalized) {
				case "new":
					await this.newSession();
					break;
				case "list":
					await this.listSessions(arguments_[0]);
					break;
				case "open":
					await this.openSession(arguments_[0]);
					break;
				case "history":
					await this.printHistory(arguments_[0] || this.currentSessionId);
					break;
				case "stop":
					await this.stopRequest(arguments_[0]);
					break;
				default:
					await this.sendMessage(input);
			}
		} catch (error) {
			this.printError(error);
		} finally {
			this.busy = false;
			this.printPrompt();
		}
	}

	async newSession(): Promise<void> {
		const created = await this.client.createSession();
		const sessionId = stringValue(created.sessionId);
		if (!sessionId) throw new PcbClientError("服务未返回 sessionId", { code: "INVALID_RESPONSE" });
		this.currentSessionId = sessionId;
		this.activeRequest = null;
		this.writeLine(cyan(`已打开新会话：${sessionId}`));
	}

	async listSessions(cursor?: string): Promise<void> {
		const result = await this.client.listSessions({ cursor });
		const sessions = Array.isArray(result.sessions) ? result.sessions : [];
		if (!sessions.length) {
			this.writeLine(gray("暂无会话。输入 new 创建会话。"));
			return;
		}
		this.writeLine("会话列表：");
		for (const session of sessions) {
			const marker = session.sessionId === this.currentSessionId ? "*" : " ";
			const status = session.status || (session.activeRequestId ? "running" : "idle");
			this.writeLine(` ${marker} ${session.sessionId}  ${status}  ${session.updatedAt || session.createdAt || ""}`);
		}
		if (result.nextCursor) this.writeLine(gray(`下一页游标：${result.nextCursor}`));
	}

	async openSession(sessionId?: string): Promise<void> {
		if (!sessionId) throw new PcbClientError("用法：open <sessionId>", { code: "INVALID_INPUT" });
		const session = await this.client.getSession(sessionId);
		const selectedSessionId = stringValue(session.sessionId) || sessionId;
		this.currentSessionId = selectedSessionId;
		const activeRequestId = stringValue(session.activeRequestId);
		this.activeRequest = activeRequestId ? { sessionId: selectedSessionId, requestId: activeRequestId } : null;
		this.writeLine(cyan(`已打开会话：${this.currentSessionId}`));
		await this.printHistory(this.currentSessionId);
		if (activeRequestId) await this.reconcileRequest(selectedSessionId, activeRequestId);
	}

	async printHistory(sessionId: string | null | undefined): Promise<void> {
		if (!sessionId)
			throw new PcbClientError("当前没有会话。输入 new 或 open <sessionId>。", { code: "INVALID_INPUT" });
		const result = await this.client.getMessages(sessionId, { limit: 100 });
		const messages = Array.isArray(result.messages) ? result.messages : [];
		if (!messages.length) {
			this.writeLine(gray("会话历史为空。"));
			return;
		}
		for (const message of messages) {
			const role = String(message.role || "").toLowerCase();
			const label = role === "user" ? "我" : role === "assistant" ? "助" : role || "消息";
			const content = messageText(message);
			const status = message.status && message.status !== "succeeded" ? ` (${message.status})` : "";
			const displayContent = content || (status ? `请求状态：${message.status}` : "");
			if (!displayContent) continue;
			this.writeLine(`${bold(label)}${status}：`);
			this.writeLine(displayContent);
			if (role === "assistant") {
				this.printSources(message.sources);
				const validation = asObject(message.citationValidation);
				if (validation.status === "invalid") {
					const invalid = Array.isArray(validation.invalidIds) ? validation.invalidIds.join(", ") : "未知引用";
					this.writeLine(yellow(`引用校验：存在无法定位的引用（${invalid}）`));
				}
			}
		}
	}

	async ensureSession(): Promise<string> {
		if (this.currentSessionId) return this.currentSessionId;
		const created = await this.client.createSession();
		if (!created.sessionId) throw new PcbClientError("服务未返回 sessionId", { code: "INVALID_RESPONSE" });
		const sessionId = stringValue(created.sessionId);
		if (!sessionId) throw new PcbClientError("invalid session response", { code: "INVALID_RESPONSE" });
		this.currentSessionId = sessionId;
		this.writeLine(cyan(`已自动创建会话：${this.currentSessionId}`));
		return sessionId;
	}

	printEventStatus(event: PcbEvent): void {
		const payload = asObject(event.payload);
		const backend = String(payload.backend || payload.toolName || "").toLowerCase();
		const isLocal = backend.includes("local") || backend.includes("\u672c\u5730");
		const isKnowledge = backend.includes("knowledge") || backend.includes("kb") || backend.includes("\u77e5\u8bc6");
		const isWeb = backend.includes("web") || backend.includes("network") || backend.includes("\u8054\u7f51");
		let label = "";
		if (event.type === "tool_completed") {
			const status = String(payload.status || "").toLowerCase();
			if (payload.isError || status === "failed") label = "Retrieval service failed";
			else if (status === "no_results") label = "Retrieval: no results";
			else if (status === "degraded" || payload.warningCode)
				label = isLocal ? "Local retrieval degraded" : "Retrieval service degraded";
			else if (isWeb) label = "Web retrieval complete";
			else if (isKnowledge) label = "Knowledge-base retrieval complete";
			else if (isLocal) label = "Local retrieval complete";
			else label = "Retrieval complete";
		} else if (event.type === "tool_started") {
			label = isWeb
				? "Searching the web"
				: isKnowledge
					? "Searching the knowledge base"
					: isLocal
						? "Searching local sources"
						: "Searching sources";
		} else if (event.type === "context_compacting") label = "Compacting context";
		else if (event.type === "context_compacted") {
			const status = String(payload.status || "succeeded").toLowerCase();
			label =
				status === "failed"
					? "Context compaction failed"
					: ["cancelled", "canceled", "interrupted"].includes(status)
						? "Context compaction interrupted"
						: "Context compaction complete";
		} else if (event.type === "retrying" || event.type === "summarization_retrying") {
			label =
				payload.success === true
					? "Retry complete"
					: payload.success === false
						? "Retry failed"
						: payload.attempt
							? `Retrying (attempt ${String(payload.attempt)})`
							: "Retrying model request";
		} else if (event.type === "request_started") label = "Request started";
		if (label) this.writeError(gray(`[${label}]`));
	}
	printSources(sources: unknown): void {
		if (!Array.isArray(sources) || !sources.length) return;
		this.writeLine(gray("\n依据："));
		const typedSources = sources.filter((source): source is Source => isRecord(source));
		for (const [index, source] of typedSources.entries()) {
			const evidence = source?.evidenceId ? ` [E:${source.evidenceId}]` : "";
			this.writeLine(
				`  ${index + 1}. ${sourceLabel(source)} · ${sourceTitle(source)}${evidence}${sourceLocation(source)}`,
			);
			if (source?.text) {
				const flat = String(source.text).replace(/\s+/g, " ").trim();
				this.writeLine(gray(`     ${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`));
			}
		}
	}

	printFinal(
		result: unknown,
		{ streamed = false, streamedText = "" }: { streamed?: boolean; streamedText?: string } = {},
	): void {
		const final = terminalResult(result) || asObject(result);
		const reply = typeof final.reply === "string" ? final.reply : typeof final.text === "string" ? final.text : "";
		if (!streamed && reply) this.write(reply);
		else if (streamed && reply && streamedText !== reply) this.write(`\n${reply}`);
		if (reply || streamed) this.write("\n");
		const status = requestStatus(final);
		if (status && status !== "succeeded") this.writeLine(yellow(`请求状态：${status}`));
		if (final.errorCode) this.writeLine(red(`错误：${final.errorCode}`));
		this.printSources(final.sources);
		const validation = asObject(final.citationValidation);
		if (validation.status === "invalid") {
			const invalid = Array.isArray(validation.invalidIds) ? validation.invalidIds.join(", ") : "未知引用";
			this.writeLine(yellow(`引用校验：存在无法定位的引用（${invalid}）`));
		}
	}

	async reconcileRequest(
		sessionId: string,
		requestId: string,
		{ streamed = false, streamedText = "" }: { streamed?: boolean; streamedText?: string } = {},
	): Promise<JsonObject> {
		// 查询同一请求直到终态；切换会话或退出后 activeRequest 改变，轮询会自然停止。
		let announced = false;
		while (!this.closed) {
			const state = await this.client.getRequest(sessionId, requestId);
			if (this.activeRequest?.requestId !== requestId) return state;
			const final = terminalResult(state);
			if (final) {
				this.printFinal(final, { streamed, streamedText });
				this.activeRequest = null;
				return final;
			}
			if (!announced) {
				this.writeLine(yellow(`请求仍在运行：${requestId}`));
				announced = true;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 800));
		}
		return { sessionId, requestId, status: "running" };
	}

	async sendMessage(message: string): Promise<void> {
		const sessionId = await this.ensureSession();
		const requestId = this.randomUuid();
		this.activeRequest = { sessionId, requestId };
		let streamedText = "";
		this.write(cyan("助："));
		try {
			// SSE、202 和断流都沿用已登记的 requestId；恢复只读取状态，绝不重新发送正文。
			const result = await this.client.sendMessage(sessionId, {
				requestId,
				message,
				onEvent: (event) => {
					this.printEventStatus(event);
					if (event?.type !== "message_delta") return;
					const payload = asObject(event.payload);
					const delta = typeof payload.delta === "string" ? payload.delta : "";
					if (delta) {
						streamedText += delta;
						this.write(delta);
					}
				},
			});
			if (result.kind === "status") {
				this.writeLine(yellow("请求已在服务端运行，未重复提交。"));
				await this.reconcileRequest(sessionId, requestId, { streamedText });
				return;
			}
			if (result.final) {
				if (this.activeRequest?.requestId !== requestId) return;
				this.printFinal(result.final, { streamed: Boolean(streamedText), streamedText });
				this.activeRequest = null;
				return;
			}
			await this.reconcileRequest(sessionId, requestId, { streamed: Boolean(streamedText), streamedText });
		} catch (error) {
			if (error instanceof StreamDisconnectedError || (isRecord(error) && error.code === "SERVICE_UNAVAILABLE")) {
				this.writeLine(yellow("流式连接中断，查询服务端请求状态；不会重发消息。"));
				try {
					await this.reconcileRequest(sessionId, requestId, { streamed: Boolean(streamedText), streamedText });
				} catch (reconcileError) {
					this.printError(reconcileError);
				}
				return;
			}
			throw error;
		}
	}

	async stopRequest(requestId?: string): Promise<void> {
		const target = requestId || this.activeRequest?.requestId;
		const sessionId = this.activeRequest?.sessionId || this.currentSessionId;
		if (!target || !sessionId) {
			this.writeLine(gray("当前没有可停止的请求。"));
			return;
		}
		const state = await this.client.cancelRequest(sessionId, target);
		const final = terminalResult(state);
		if (final || isTerminal(state)) {
			this.printFinal(final || state);
			if (this.activeRequest?.requestId === target) this.activeRequest = null;
		} else {
			this.writeLine(yellow(`已发送停止请求：${target}`));
		}
	}

	printError(error: unknown): void {
		if (hasServiceError(error)) {
			this.writeError(red("服务不可达，请确认后端已启动并检查 PCB_API_URL。"));
			return;
		}
		const details = isRecord(error) ? error : {};
		const code = details.code ? ` [${String(details.code)}]` : "";
		const message = details.message
			? String(details.message)
			: error instanceof Error
				? error.message
				: "unknown error";
		this.writeError(red(`error${code}: ${message}`));
	}
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
	const client = options.client || (await createPcbHttpClient(options.clientOptions));
	const app = new CliApp({ ...options, client });
	await app.start();
}
