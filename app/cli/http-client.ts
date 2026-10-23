import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * PCB 会话协议的 Node HTTP 客户端：统一处理请求、Cookie 状态、SSE 事件和断流后的查询。
 * 发送请求时沿用调用方提供的 requestId，使服务端可以识别重复提交并返回已有请求状态。
 */
const DEFAULT_PORT = "9100";
const DEFAULT_STATE_FILE_NAME = ".pcb-cli-state.json";

export type JsonObject = Record<string, unknown>;

export type CitationValidation = {
	status?: string;
	invalidIds?: string[];
};

export type Source = {
	evidenceId?: string;
	sourceType?: string;
	title?: string;
	text?: string;
	page?: number | string;
	url?: string;
	[key: string]: unknown;
};

export type Session = {
	sessionId: string;
	createdAt?: string;
	updatedAt?: string;
	status?: string;
	activeRequestId?: string;
	[key: string]: unknown;
};

export type SessionList = {
	sessions?: Session[];
	nextCursor?: string;
	[key: string]: unknown;
};

export type Message = {
	entryId?: string;
	requestId?: string;
	role?: string;
	content?: string;
	status?: string;
	sources?: Source[];
	citationValidation?: CitationValidation;
	[key: string]: unknown;
};

export type MessageList = {
	messages?: Message[];
	nextCursor?: string;
	[key: string]: unknown;
};

export type RequestResult = {
	sessionId?: string;
	requestId?: string;
	status?: string;
	reply?: string;
	sources?: Source[];
	citationValidation?: CitationValidation;
	errorCode?: string;
	usage?: JsonObject;
	model?: string;
	[key: string]: unknown;
};

export type PcbEvent = {
	sessionId?: string;
	requestId?: string;
	sequence?: number;
	type?: string;
	payload?: unknown;
	[key: string]: unknown;
};

export type SendMessageOptions = {
	requestId?: string;
	message?: string;
	onEvent?: (event: PcbEvent) => void | Promise<void>;
	signal?: AbortSignal;
};

export type SendMessageResult =
	| { kind: "status"; status: number; state: JsonObject }
	| { kind: "stream"; status: number; final: JsonObject | null; lastEvent: PcbEvent | null }
	| { kind: "json"; status: number; final: JsonObject | null; data: unknown };

type FetchOptions = {
	method?: string;
	headers?: ConstructorParameters<typeof Headers>[0];
	body?: unknown;
	signal?: AbortSignal;
};

type ErrorOptions = {
	cause?: unknown;
	status?: number;
	code?: string;
	details?: unknown;
};

export type SseRecord = {
	event?: string;
	id?: string;
	data: unknown;
	rawData: string;
};

export type PcbHttpClientOptions = {
	baseUrl?: string;
	stateFile?: string;
	cookieJar?: CookieJar;
	fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
	return isRecord(value) ? value : {};
}

function parseJson(text: string): unknown {
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function normalizeBaseUrl(value: string | undefined): string {
	const input = String(value || `http://127.0.0.1:${DEFAULT_PORT}`).trim();
	const url = new URL(input);
	if (!/^https?:$/.test(url.protocol)) throw new TypeError("PCB API URL must use http or https");
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeBaseUrl(env.PCB_API_URL || env.PCB_SERVER_URL || `http://127.0.0.1:${env.PORT || DEFAULT_PORT}`);
}

export function resolveStateFile(env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir()): string {
	const configured = env.PCB_CLI_STATE_FILE?.trim();
	if (configured) return path.resolve(configured);
	return path.join(homeDirectory, DEFAULT_STATE_FILE_NAME);
}

function parseCookiePair(header: string): { name: string; value: string } | null {
	const pair = String(header || "").split(";", 1)[0];
	const separator = pair.indexOf("=");
	if (separator <= 0) return null;
	const name = pair.slice(0, separator).trim();
	const value = pair.slice(separator + 1).trim();
	if (!name) return null;
	return { name, value };
}

function splitSetCookie(header: string): string[] {
	const values: string[] = [];
	let start = 0;
	let quoted = false;
	for (let index = 0; index < header.length; index += 1) {
		const character = header[index];
		if (character === '"') quoted = !quoted;
		if (character === "," && !quoted && /\s*[^;,=]+=[^;,]*/.test(header.slice(index + 1))) {
			values.push(header.slice(start, index));
			start = index + 1;
		}
	}
	values.push(header.slice(start));
	return values;
}

function hasExpiredAttribute(header: string): boolean {
	return (
		/(?:^|;)\s*max-age\s*=\s*0(?:\s*;|$)/i.test(header) || /(?:^|;)\s*expires\s*=\s*Thu, 01 Jan 1970/i.test(header)
	);
}

export class CookieJar {
	readonly stateFile: string;
	readonly cookies = new Map<string, string>();

	constructor(stateFile: string) {
		this.stateFile = stateFile;
	}

	async load(): Promise<this> {
		try {
			const raw = await readFile(this.stateFile, "utf8");
			const parsed = parseJson(raw);
			const cookies = asObject(parsed).cookies;
			if (isRecord(cookies)) {
				for (const [name, value] of Object.entries(cookies)) {
					if (typeof value === "string" && name) this.cookies.set(name, value);
				}
			}
		} catch (error) {
			if (isRecord(error) && error.code !== "ENOENT") throw error;
			if (!isRecord(error) && error instanceof Error && error.message) throw error;
		}
		return this;
	}

	header(): string {
		return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	}

	async capture(headers: Headers): Promise<void> {
		// 优先使用多值接口；旧运行时只有合并后的 set-cookie 时，再按逗号拆分并保留带引号的值。
		const getSetCookie = headers.getSetCookie;
		const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
		const fallback = headers.get("set-cookie");
		const values = setCookies.length ? setCookies : fallback ? splitSetCookie(fallback) : [];
		let changed = false;
		for (const raw of values) {
			const pair = parseCookiePair(raw);
			if (!pair) continue;
			// 空值或过期属性代表服务端撤销 Cookie，更新后立即持久化供下一次客户端复用。
			if (!pair.value || hasExpiredAttribute(raw)) changed = this.cookies.delete(pair.name) || changed;
			else if (this.cookies.get(pair.name) !== pair.value) {
				this.cookies.set(pair.name, pair.value);
				changed = true;
			}
		}
		if (changed) await this.save();
	}

	async save(): Promise<void> {
		await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
		const contents = `${JSON.stringify({ version: 1, cookies: Object.fromEntries(this.cookies) }, null, 2)}\n`;
		await writeFile(this.stateFile, contents, { encoding: "utf8", mode: 0o600 });
	}
}

export class PcbClientError extends Error {
	readonly status: number | undefined;
	readonly code: string | undefined;
	readonly details: unknown;

	constructor(message: string, options: ErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "PcbClientError";
		this.status = options.status;
		this.code = options.code;
		this.details = options.details;
	}
}

export class StreamDisconnectedError extends PcbClientError {
	readonly sessionId: string | undefined;
	readonly requestId: string | undefined;
	readonly lastEvent: PcbEvent | null | undefined;

	constructor(
		message: string,
		options: ErrorOptions & { sessionId?: string; requestId?: string; lastEvent?: PcbEvent | null } = {},
	) {
		super(message, options);
		this.name = "StreamDisconnectedError";
		this.sessionId = options.sessionId;
		this.requestId = options.requestId;
		this.lastEvent = options.lastEvent;
	}
}

function isAbortError(error: unknown): boolean {
	return isRecord(error) && error.name === "AbortError";
}

function responseContentType(response: Response): string {
	return response.headers.get("content-type")?.toLowerCase() || "";
}

function finalFromPayload(payload: unknown, fallback: JsonObject = {}): JsonObject {
	const value = asObject(payload);
	if (isRecord(value.final)) return value.final;
	if (isRecord(value.result)) return value.result;
	if (typeof value.status === "string" && ("reply" in value || "sources" in value || "citationValidation" in value))
		return value;
	return fallback;
}

function responseError(data: unknown, status: number): PcbClientError {
	const body = asObject(data);
	const nested = asObject(body.error);
	const message =
		typeof nested.message === "string"
			? nested.message
			: typeof body.message === "string"
				? body.message
				: typeof body.error === "string"
					? body.error
					: `服务返回 HTTP ${status}`;
	const code =
		typeof nested.code === "string"
			? nested.code
			: typeof body.code === "string"
				? body.code
				: typeof body.errorCode === "string"
					? body.errorCode
					: undefined;
	return new PcbClientError(message, { status, code, details: body });
}

export function eventFinalResult(event: PcbEvent | unknown): JsonObject | null {
	if (!isRecord(event) || event.type !== "request_finished") return null;
	const result = finalFromPayload(event.payload);
	return Object.keys(result).length ? result : null;
}

function eventFromRecord(record: SseRecord): PcbEvent {
	if (isRecord(record.data))
		return record.data.type ? record.data : { ...record.data, type: record.event || "message" };
	return { type: record.event || "message", payload: record.data };
}

function parseSseData(rawData: string): unknown {
	return parseJson(rawData) ?? rawData;
}

function finishSseRecord(fields: { event: string; id: string; data: string[] }): SseRecord | null {
	if (!fields.data.length) return null;
	return {
		event: fields.event || undefined,
		id: fields.id || undefined,
		data: parseSseData(fields.data.join("\n")),
		rawData: fields.data.join("\n"),
	};
}

/** 解析完整的 SSE 帧；末尾没有空行结束的帧也会被接纳，便于测试和日志工具复用。 */
export function parseSseRecords(source: string): SseRecord[] {
	const fields = { event: "", id: "", data: [] as string[] };
	const records: SseRecord[] = [];
	for (const rawLine of String(source || "").split(/\r\n|\n|\r/)) {
		if (rawLine === "") {
			const record = finishSseRecord(fields);
			if (record) records.push(record);
			fields.event = "";
			fields.id = "";
			fields.data = [];
			continue;
		}
		if (rawLine.startsWith(":")) continue;
		const separator = rawLine.indexOf(":");
		const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
		const value = separator === -1 ? "" : rawLine.slice(separator + 1).replace(/^ /, "");
		if (field === "event") fields.event = value;
		else if (field === "id") fields.id = value;
		else if (field === "data") fields.data.push(value);
	}
	const record = finishSseRecord(fields);
	if (record) records.push(record);
	return records;
}

async function consumeSseBody(
	body: ReadableStream<Uint8Array> | null,
	onEvent: (event: PcbEvent) => void | Promise<void>,
): Promise<PcbEvent | null> {
	// 流式读取按行组装事件，只有遇到空行才提交一条记录；因此分块边界不会影响事件边界。
	if (!body || typeof body.getReader !== "function") throw new Error("SSE response has no readable body");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let fields = { event: "", id: "", data: [] as string[] };
	let lastEvent: PcbEvent | null = null;

	const emitRecord = async (): Promise<void> => {
		const record = finishSseRecord(fields);
		fields = { event: "", id: "", data: [] };
		if (!record) return;
		lastEvent = eventFromRecord(record);
		await onEvent(lastEvent);
	};

	const consumeLine = async (line: string): Promise<void> => {
		if (line === "") {
			await emitRecord();
			return;
		}
		if (line.startsWith(":")) return;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "event") fields.event = value;
		else if (field === "id") fields.id = value;
		else if (field === "data") fields.data.push(value);
	};

	while (true) {
		const result = await reader.read();
		if (result.done) break;
		if (result.value) buffer += decoder.decode(result.value, { stream: true });
		let newline = buffer.search(/\r\n|\n|\r/);
		while (newline !== -1) {
			const match = /\r\n|\n|\r/.exec(buffer.slice(newline));
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + (match?.[0].length || 1));
			await consumeLine(line);
			newline = buffer.search(/\r\n|\n|\r/);
		}
	}
	buffer += decoder.decode();
	if (buffer) await consumeLine(buffer);
	await emitRecord();
	return lastEvent;
}

function pathPart(value: string): string {
	return encodeURIComponent(String(value));
}

export class PcbHttpClient {
	readonly baseUrl: string;
	readonly cookieJar: CookieJar;
	readonly fetchImpl: typeof fetch;

	constructor({
		baseUrl = resolveApiBaseUrl(),
		stateFile = resolveStateFile(),
		cookieJar,
		fetchImpl = globalThis.fetch,
	}: PcbHttpClientOptions = {}) {
		if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
		this.baseUrl = normalizeBaseUrl(baseUrl);
		this.cookieJar = cookieJar || new CookieJar(stateFile);
		this.fetchImpl = fetchImpl;
	}

	async initialize(): Promise<this> {
		await this.cookieJar.load();
		return this;
	}

	url(pathname: string, query?: Record<string, string | number | undefined>): URL {
		const url = new URL(pathname, this.baseUrl);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
			}
		}
		return url;
	}

	async fetchResponse(pathname: string, options: FetchOptions = {}): Promise<Response> {
		const headers = new Headers(options.headers || {});
		if (!headers.has("Accept")) headers.set("Accept", "application/json");
		if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
		const cookie = this.cookieJar.header();
		if (cookie) headers.set("Cookie", cookie);
		let response: Response;
		try {
			response = await this.fetchImpl(this.url(pathname), {
				method: options.method || "GET",
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: options.signal,
				credentials: "include",
			});
		} catch (error) {
			if (isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : "网络错误";
			throw new PcbClientError(`无法连接服务：${message}`, { code: "SERVICE_UNAVAILABLE", cause: error });
		}
		await this.cookieJar.capture(response.headers);
		return response;
	}

	async readResponse(response: Response): Promise<{ text: string; data: unknown; contentType: string }> {
		const text = await response.text();
		return { text, data: parseJson(text), contentType: responseContentType(response) };
	}

	async requestJson(
		pathname: string,
		options: FetchOptions = {},
	): Promise<{ status: number; text: string; data: unknown; contentType: string }> {
		const response = await this.fetchResponse(pathname, options);
		const parsed = await this.readResponse(response);
		if (!response.ok) throw responseError(parsed.data, response.status);
		return { status: response.status, ...parsed };
	}

	async createSession(): Promise<JsonObject> {
		const result = await this.requestJson("/api/sessions", { method: "POST" });
		return asObject(result.data);
	}

	async listSessions({ cursor, limit }: { cursor?: string; limit?: number } = {}): Promise<SessionList> {
		const response = await this.requestJson(`/api/sessions${this.query({ before: cursor, limit })}`);
		return asObject(response.data) as SessionList;
	}

	async getSession(sessionId: string): Promise<JsonObject> {
		const response = await this.requestJson(`/api/sessions/${pathPart(sessionId)}`);
		return asObject(response.data);
	}

	async getMessages(
		sessionId: string,
		{ before, limit }: { before?: string; limit?: number } = {},
	): Promise<MessageList> {
		const response = await this.requestJson(
			`/api/sessions/${pathPart(sessionId)}/messages${this.query({ before, limit })}`,
		);
		return asObject(response.data) as MessageList;
	}

	async getRequest(sessionId: string, requestId: string): Promise<JsonObject> {
		const response = await this.requestJson(`/api/sessions/${pathPart(sessionId)}/requests/${pathPart(requestId)}`);
		return asObject(response.data);
	}

	async cancelRequest(sessionId: string, requestId: string): Promise<JsonObject> {
		const response = await this.requestJson(
			`/api/sessions/${pathPart(sessionId)}/requests/${pathPart(requestId)}/cancel`,
			{ method: "POST" },
		);
		return asObject(response.data);
	}

	query(queryValues: Record<string, string | number | undefined>): string {
		const values = Object.entries(queryValues).filter(
			([, value]) => value !== undefined && value !== null && value !== "",
		);
		if (!values.length) return "";
		const search = new URLSearchParams(values.map(([key, value]): [string, string] => [key, String(value)]));
		return `?${search.toString()}`;
	}

	async sendMessage(
		sessionId: string,
		{ requestId, message, onEvent, signal }: SendMessageOptions = {},
	): Promise<SendMessageResult> {
		// requestId 由 CLI 或页面生成并随 POST 发送；202 表示服务端已接收，调用方应查询同一请求而不是重发。
		const response = await this.fetchResponse(`/api/sessions/${pathPart(sessionId)}/messages`, {
			method: "POST",
			headers: { Accept: "text/event-stream" },
			body: { requestId, message },
			signal,
		});
		const contentType = responseContentType(response);
		if (response.status === 202) {
			const parsed = await this.readResponse(response);
			return { kind: "status", status: response.status, state: asObject(parsed.data) };
		}
		if (!response.ok) {
			const parsed = await this.readResponse(response);
			throw responseError(parsed.data, response.status);
		}

		if (contentType.includes("text/event-stream")) {
			// SSE 事件可能重复或乱序到达，按正数 sequence 去重；断流则携带请求身份交给上层恢复。
			let lastEvent: PcbEvent | null = null;
			let final: JsonObject | null = null;
			let lastSequence = 0;
			try {
				await consumeSseBody(response.body, async (event) => {
					const sequence = Number(event.sequence);
					if (Number.isFinite(sequence) && sequence > 0) {
						if (sequence <= lastSequence) return;
						lastSequence = sequence;
					}
					lastEvent = event;
					final = eventFinalResult(event) || final;
					if (onEvent) await onEvent(event);
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
				throw new StreamDisconnectedError("流式连接中断，正在查询请求状态", {
					code: "STREAM_DISCONNECTED",
					cause: error,
					sessionId,
					requestId,
					lastEvent,
				});
			}
			return { kind: "stream", status: response.status, final, lastEvent };
		}

		const parsed = await this.readResponse(response);
		if (!contentType.includes("application/json")) {
			throw new PcbClientError("服务返回了无法识别的响应格式", {
				status: response.status,
				code: "INVALID_RESPONSE",
			});
		}
		return { kind: "json", status: response.status, final: finalFromPayload(parsed.data), data: parsed.data };
	}
}

export async function createPcbHttpClient(options: PcbHttpClientOptions = {}): Promise<PcbHttpClient> {
	const client = new PcbHttpClient(options);
	await client.initialize();
	return client;
}
