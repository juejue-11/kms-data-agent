// PCB 会话协议的浏览器传输层，与页面 DOM 状态分离。
// 流断开后可通过 GET /requests/:requestId 对账，避免再次提交同一条消息。
(function installPcbApi(global) {
	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function asObject(value) {
		return isRecord(value) ? value : {};
	}

	function parseJson(text) {
		if (!text.trim()) return null;
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	function pathPart(value) {
		return encodeURIComponent(String(value));
	}

	function finalFromPayload(payload) {
		const value = asObject(payload);
		if (isRecord(value.final)) return value.final;
		if (isRecord(value.result)) return value.result;
		if (typeof value.status === "string" && ("reply" in value || "sources" in value || "citationValidation" in value))
			return value;
		return null;
	}

	function responseError(data, status) {
		const body = asObject(data);
		const nested = asObject(body.error);
		const message =
			nested.message || body.message || (typeof body.error === "string" ? body.error : `服务返回 HTTP ${status}`);
		return new PcbApiError(message, {
			status,
			code: nested.code || body.code || body.errorCode,
			details: body,
		});
	}

	function eventFinalResult(event) {
		if (!isRecord(event) || event.type !== "request_finished") return null;
		return finalFromPayload(event.payload);
	}

	function parseSseData(rawData) {
		return parseJson(rawData) ?? rawData;
	}

	function finishSseRecord(fields) {
		if (!fields.data.length) return null;
		return {
			event: fields.event || undefined,
			id: fields.id || undefined,
			data: parseSseData(fields.data.join("\n")),
			rawData: fields.data.join("\n"),
		};
	}

	function parseSseRecords(source) {
		// 先按空行划分 SSE 帧，再把多行 data 合并；末尾未闭合的帧也交给调用方处理。
		const fields = { event: "", id: "", data: [] };
		const records = [];
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

	class PcbApiError extends Error {
		constructor(message, options = {}) {
			super(message, options.cause ? { cause: options.cause } : undefined);
			this.name = "PcbApiError";
			this.status = options.status;
			this.code = options.code;
			this.details = options.details;
		}
	}

	class StreamDisconnectedError extends PcbApiError {
		constructor(message, options = {}) {
			super(message, options);
			this.name = "StreamDisconnectedError";
			this.sessionId = options.sessionId;
			this.requestId = options.requestId;
			this.lastEvent = options.lastEvent;
		}
	}

	function isAbortError(error) {
		return error?.name === "AbortError";
	}

	async function consumeSseBody(body, onEvent) {
		// ReadableStream 的分块可能截断任意一行，因此先缓存在 buffer，再按换行消费完整行。
		if (!body || typeof body.getReader !== "function") throw new Error("SSE response has no readable body");
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let fields = { event: "", id: "", data: [] };
		let lastEvent = null;

		const emitRecord = async () => {
			const record = finishSseRecord(fields);
			fields = { event: "", id: "", data: [] };
			if (!record) return;
			lastEvent = isRecord(record.data)
				? record.data.type
					? record.data
					: { ...record.data, type: record.event || "message" }
				: { type: record.event || "message", payload: record.data };
			await onEvent(lastEvent);
		};

		const consumeLine = async (line) => {
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
			buffer += decoder.decode(result.value, { stream: true });
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

	class PcbApi {
		constructor({ baseUrl = "", fetchImpl = global.fetch.bind(global) } = {}) {
			this.baseUrl = String(baseUrl).replace(/\/+$/, "");
			this.fetchImpl = fetchImpl;
		}

		url(pathname) {
			return new URL(pathname, `${this.baseUrl || global.location.origin}/`).toString();
		}

		async fetchResponse(pathname, options = {}) {
			const headers = new Headers(options.headers || {});
			if (!headers.has("Accept")) headers.set("Accept", "application/json");
			if (options.body !== undefined && !headers.has("Content-Type"))
				headers.set("Content-Type", "application/json");
			try {
				return await this.fetchImpl(this.url(pathname), {
					method: options.method || "GET",
					headers,
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
					signal: options.signal,
					credentials: "same-origin",
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
				throw new PcbApiError(`无法连接服务：${error.message || "网络错误"}`, {
					code: "SERVICE_UNAVAILABLE",
					cause: error,
				});
			}
		}

		async readResponse(response) {
			const text = await response.text();
			return { text, data: parseJson(text), contentType: response.headers.get("content-type")?.toLowerCase() || "" };
		}

		async requestJson(pathname, options = {}) {
			const response = await this.fetchResponse(pathname, options);
			const parsed = await this.readResponse(response);
			if (!response.ok) {
				throw responseError(parsed.data, response.status);
			}
			return { status: response.status, ...parsed };
		}

		query(values) {
			const entries = Object.entries(values).filter(
				([, value]) => value !== undefined && value !== null && value !== "",
			);
			if (!entries.length) return "";
			return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
		}

		async createSession() {
			const response = await this.requestJson("/api/sessions", { method: "POST" });
			return asObject(response.data);
		}

		async listSessions({ cursor, limit } = {}) {
			const response = await this.requestJson(`/api/sessions${this.query({ before: cursor, limit })}`);
			return asObject(response.data);
		}

		async getSession(sessionId) {
			const response = await this.requestJson(`/api/sessions/${pathPart(sessionId)}`);
			return asObject(response.data);
		}

		async renameSession(sessionId, title) {
			const response = await this.requestJson(`/api/sessions/${pathPart(sessionId)}`, {
				method: "PATCH",
				body: { title },
			});
			return asObject(response.data);
		}

		async deleteSession(sessionId) {
			const response = await this.requestJson(`/api/sessions/${pathPart(sessionId)}`, {
				method: "DELETE",
			});
			return asObject(response.data);
		}

		async getMessages(sessionId, { before, limit } = {}) {
			const response = await this.requestJson(
				`/api/sessions/${pathPart(sessionId)}/messages${this.query({ before, limit })}`,
			);
			return asObject(response.data);
		}

		async getRequest(sessionId, requestId) {
			const response = await this.requestJson(
				`/api/sessions/${pathPart(sessionId)}/requests/${pathPart(requestId)}`,
			);
			return asObject(response.data);
		}

		async cancelRequest(sessionId, requestId) {
			const response = await this.requestJson(
				`/api/sessions/${pathPart(sessionId)}/requests/${pathPart(requestId)}/cancel`,
				{
					method: "POST",
				},
			);
			return asObject(response.data);
		}

		async sendMessage(sessionId, { requestId, message, onEvent, signal } = {}) {
			// requestId 是服务端去重和断流恢复的关联键；202 或异常都由上层查询同一请求。
			const response = await this.fetchResponse(`/api/sessions/${pathPart(sessionId)}/messages`, {
				method: "POST",
				headers: { Accept: "text/event-stream" },
				body: { requestId, message },
				signal,
			});
			const contentType = response.headers.get("content-type")?.toLowerCase() || "";
			if (response.status === 202) {
				const parsed = await this.readResponse(response);
				return { kind: "status", status: response.status, state: asObject(parsed.data) };
			}
			if (!response.ok) {
				const parsed = await this.readResponse(response);
				throw responseError(parsed.data, response.status);
			}

			if (contentType.includes("text/event-stream")) {
				// 只接受递增的正数 sequence，防止重连或代理重放事件导致页面重复渲染。
				let final = null;
				let lastEvent = null;
				let lastSequence = 0;
				try {
					await consumeSseBody(response.body, async (event) => {
						const sequence = Number(event?.sequence);
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
						// 保留 sessionId、requestId 和最后事件，页面据此轮询而不是重新提交正文。
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
				throw new PcbApiError("服务返回了无法识别的响应格式", {
					status: response.status,
					code: "INVALID_RESPONSE",
				});
			}
			return { kind: "json", status: response.status, final: finalFromPayload(parsed.data), data: parsed.data };
		}
	}

	global.PcbApi = Object.freeze(
		Object.assign(PcbApi, {
			PcbApiError,
			StreamDisconnectedError,
			parseSseRecords,
			eventFinalResult,
		}),
	);
})(window);
