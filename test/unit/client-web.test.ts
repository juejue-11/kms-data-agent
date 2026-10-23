/**
 * 浏览器会话控制器测试：用最小 DOM、存储和计时器替身验证恢复轮询、会话切换过期事件防护及传输导出。
 * 测试通过 VM 加载页面脚本，避免依赖真实浏览器或后端服务。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

type UnknownRecord = Record<string, unknown>;
type EventHandler = (event: UnknownRecord) => void;
type SendOptions = { onEvent?: EventHandler; requestId?: string; message?: string; signal?: AbortSignal };
type SendResult = { kind: "stream"; status: number; final: UnknownRecord | null; lastEvent: UnknownRecord | null };

class FakeClassList {
	private readonly values = new Set<string>();

	add(...names: string[]): void {
		for (const name of names) this.values.add(name);
	}

	toggle(name: string, force?: boolean): boolean {
		const enabled = force === undefined ? !this.values.has(name) : force;
		if (enabled) this.values.add(name);
		else this.values.delete(name);
		return enabled;
	}
}

class FakeElement {
	id = "";
	className = "";
	textContent = "";
	value = "";
	disabled = false;
	hidden = false;
	scrollTop = 0;
	scrollHeight = 0;
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly classList = new FakeClassList();
	readonly children: FakeElement[] = [];
	private parent: FakeElement | null = null;
	private readonly listeners = new Map<string, (...args: unknown[]) => void>();

	appendChild(child: FakeElement): FakeElement {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	remove(): void {
		if (!this.parent) return;
		const index = this.parent.children.indexOf(this);
		if (index >= 0) this.parent.children.splice(index, 1);
		this.parent = null;
	}

	replaceChildren(...children: FakeElement[]): void {
		for (const child of this.children) child.parent = null;
		this.children.length = 0;
		for (const child of children) this.appendChild(child);
	}

	querySelector(selector: string): FakeElement | null {
		const className = selector.startsWith(".") ? selector.slice(1) : "";
		for (const child of this.children) {
			if (className && child.className.split(/\s+/).includes(className)) return child;
			const nested = child.querySelector(selector);
			if (nested) return nested;
		}
		return null;
	}

	setAttribute(_name: string, _value: string): void {}

	addEventListener(type: string, callback: (...args: unknown[]) => void): void {
		this.listeners.set(type, callback);
	}
}

class FakeDocument {
	private readonly elements = new Map<string, FakeElement>();

	register(id: string): FakeElement {
		const element = new FakeElement();
		element.id = id;
		this.elements.set(id, element);
		return element;
	}

	getElementById(id: string): FakeElement | null {
		return this.elements.get(id) || null;
	}

	createElement(_tagName: string): FakeElement {
		return new FakeElement();
	}

	createTextNode(text: string): FakeElement {
		const node = new FakeElement();
		node.textContent = text;
		return node;
	}
}

class FakeStorage {
	private readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) || null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

class StubApi {
	listSessions = async (_options?: UnknownRecord): Promise<UnknownRecord> => ({ sessions: [] });
	createSession = async (): Promise<UnknownRecord> => ({ sessionId: "seed" });
	getSession = async (sessionId: string): Promise<UnknownRecord> => ({ sessionId });
	getMessages = async (_sessionId?: string, _options?: UnknownRecord): Promise<UnknownRecord> => ({ messages: [] });
	getRequest = async (_sessionId?: string, _requestId?: string): Promise<UnknownRecord> => ({ status: "running" });
	cancelRequest = async (_sessionId?: string, _requestId?: string): Promise<UnknownRecord> => ({
		status: "cancelled",
		reply: "",
	});
	sendMessage = async (_sessionId: string, _options: SendOptions): Promise<SendResult> => ({
		kind: "stream",
		status: 200,
		final: null,
		lastEvent: null,
	});
}

type WebHarness = {
	api: StubApi;
	controller: UnknownRecord;
	state: UnknownRecord;
	chatBox: FakeElement;
	input: FakeElement;
	runTimers: () => void;
};

async function loadWebHarness(): Promise<WebHarness> {
	const document = new FakeDocument();
	for (const id of [
		"send-btn",
		"stop-btn",
		"user-input",
		"chat-box",
		"session-list",
		"new-session-btn",
		"refresh-sessions-btn",
		"session-title",
		"run-status",
		"connection-dot",
		"connection-title",
		"connection-desc",
	])
		document.register(id);
	const api = new StubApi();
	const timerCallbacks: Array<() => void> = [];
	const context: Record<string, unknown> = {
		document,
		localStorage: new FakeStorage(),
		setTimeout: (callback: () => void) => {
			timerCallbacks.push(callback);
			return timerCallbacks.length;
		},
		clearTimeout: () => undefined,
		crypto: {
			getRandomValues: (bytes: Uint8Array) => {
				for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 17 + 3) & 0xff;
				return bytes;
			},
		},
		AbortController,
		renderMarkdown: (text: string) => {
			const node = new FakeElement();
			node.textContent = String(text);
			return node;
		},
		console,
	};
	context.window = context;
	class PcbApi {
		static eventFinalResult(_event: unknown): UnknownRecord | null {
			return null;
		}

		listSessions(options?: UnknownRecord): Promise<UnknownRecord> {
			return api.listSessions(options);
		}

		createSession(): Promise<UnknownRecord> {
			return api.createSession();
		}

		getSession(sessionId: string): Promise<UnknownRecord> {
			return api.getSession(sessionId);
		}

		getMessages(sessionId: string, options?: UnknownRecord): Promise<UnknownRecord> {
			return api.getMessages(sessionId, options);
		}

		getRequest(sessionId: string, requestId: string): Promise<UnknownRecord> {
			return api.getRequest(sessionId, requestId);
		}

		cancelRequest(sessionId: string, requestId: string): Promise<UnknownRecord> {
			return api.cancelRequest(sessionId, requestId);
		}

		sendMessage(sessionId: string, options: SendOptions): Promise<SendResult> {
			return api.sendMessage(sessionId, options);
		}
	}
	context.PcbApi = PcbApi;
	const source = await readFile(new URL("../../web-ui/js/script.js", import.meta.url), "utf8");
	vm.runInNewContext(source, context, { filename: "web-ui/js/script.js" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const controller = context.window as UnknownRecord;
	return {
		api,
		controller: controller.PcbClientController as UnknownRecord,
		state: (controller.PcbClientController as UnknownRecord).state as UnknownRecord,
		chatBox: document.getElementById("chat-box") as FakeElement,
		input: document.getElementById("user-input") as FakeElement,
		runTimers: () => {
			const callbacks = timerCallbacks.splice(0);
			for (const callback of callbacks) callback();
		},
	};
}

function elementText(element: FakeElement): string {
	return element.textContent + element.children.map((child) => elementText(child)).join("");
}

// 页面恢复服务端活动请求时只轮询原请求，不重复发送消息，并最终渲染终态。
test("browser reconciles a running request until terminal without resubmitting", async () => {
	const harness = await loadWebHarness();
	const formatEventStatus = harness.controller.formatEventStatus as (event: UnknownRecord) => string;
	assert.equal(
		formatEventStatus({ type: "tool_completed", payload: { backend: "web", status: "ok" } }),
		"联网检索完成",
	);
	assert.equal(
		formatEventStatus({ type: "tool_completed", payload: { backend: "local", status: "degraded" } }),
		"已使用本地降级资料",
	);
	assert.equal(
		formatEventStatus({ type: "context_compacted", payload: { status: "failed" } }),
		"上下文整理失败，历史已保留",
	);
	assert.equal(formatEventStatus({ type: "retrying", payload: { success: true } }), "重试完成");
	let requestQueries = 0;
	harness.api.getSession = async (sessionId) => ({ sessionId, activeRequestId: "r1" });
	harness.api.getMessages = async () => ({ messages: [] });
	harness.api.getRequest = async () => {
		requestQueries += 1;
		return requestQueries === 1
			? { sessionId: "s1", requestId: "r1", status: "running" }
			: { sessionId: "s1", requestId: "r1", status: "succeeded", reply: "done", sources: [] };
	};
	let submissions = 0;
	harness.api.sendMessage = async () => {
		submissions += 1;
		return { kind: "stream", status: 200, final: null, lastEvent: null };
	};
	const selectSession = harness.controller.selectSession as (sessionId: string) => Promise<void>;
	await selectSession("s1");
	assert.equal(requestQueries, 1);
	assert.equal(submissions, 0);
	assert.ok(harness.state.activeRequest);
	harness.runTimers();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(requestQueries, 2);
	assert.equal(harness.state.activeRequest, null);
	assert.match(elementText(harness.chatBox), /done/);
});

// 切换会话后，旧流迟到的 message_delta 不能写入新会话的 DOM。
test("browser ignores a late stream event after switching sessions", async () => {
	const harness = await loadWebHarness();
	const selectSession = harness.controller.selectSession as (sessionId: string) => Promise<void>;
	await selectSession("old");
	harness.input.value = "hello";
	let lateEvent: EventHandler | undefined;
	let resolveSend: ((result: SendResult) => void) | undefined;
	harness.api.sendMessage = async (_sessionId, options) => {
		lateEvent = options.onEvent;
		return new Promise<SendResult>((resolve) => {
			resolveSend = resolve;
		});
	};
	assert.equal(harness.state.sessionId, "old");
	const sendMessage = harness.controller.sendMessage as () => Promise<void>;
	const sendPromise = sendMessage();
	await selectSession("new");
	lateEvent?.({ type: "message_delta", payload: { delta: "OLD" } });
	resolveSend?.({ kind: "stream", status: 200, final: null, lastEvent: null });
	await sendPromise;
	assert.doesNotMatch(elementText(harness.chatBox), /OLD/);
});

// 页面脚本依赖的传输构造器和静态助手必须在浏览器全局可用。
test("browser transport exposes the constructor and static helpers consumed by the page", async () => {
	const source = await readFile(new URL("../../web-ui/js/client.js", import.meta.url), "utf8");
	const context = vm.createContext({ window: { fetch: async () => new Response("{}") }, URL, Headers, TextDecoder });
	vm.runInContext(source, context);
	assert.equal(vm.runInContext("typeof window.PcbApi", context), "function");
	assert.equal(vm.runInContext("typeof window.PcbApi.eventFinalResult", context), "function");
	assert.ok(vm.runInContext("new window.PcbApi()", context));
});

// 请求被服务端以 4xx 拒绝时应释放活动状态，不为未接收的 requestId 继续轮询。
test("browser releases a rejected request instead of polling a request that was never accepted", async () => {
	const harness = await loadWebHarness();
	const select = harness.controller.selectSession as (sessionId: string) => Promise<void>;
	await select("busy-session");
	harness.input.value = "板面划伤";
	harness.api.sendMessage = async () => {
		throw Object.assign(new Error("会话繁忙"), { status: 409, code: "SESSION_BUSY" });
	};
	let queries = 0;
	harness.api.getRequest = async () => {
		queries++;
		return { status: "running", reply: "" };
	};
	await (harness.controller.sendMessage as () => Promise<void>)();
	harness.runTimers();
	assert.equal(harness.state.activeRequest, null);
	assert.equal(queries, 0);
	assert.match(elementText(harness.chatBox), /会话繁忙/);
});
