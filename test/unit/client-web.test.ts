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

	contains(name: string): boolean {
		return this.values.has(name);
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
	type = "";
	disabled = false;
	hidden = false;
	open = false;
	matches = false;
	content?: { firstElementChild: FakeElement };
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	offsetHeight = 0;
	lineHeight = "20px";
	minHeight = "26px";
	maxHeight = "160px";
	lastScrollTo: { top: number; behavior?: string } | null = null;
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly classList = new FakeClassList();
	readonly children: FakeElement[] = [];
	private parent: FakeElement | null = null;
	private readonly listeners = new Map<string, (...args: unknown[]) => void>();
	private readonly ownerDocument?: FakeDocument;

	constructor(ownerDocument?: FakeDocument) {
		this.ownerDocument = ownerDocument;
	}

	focus(): void {
		if (this.ownerDocument) this.ownerDocument.activeElement = this;
	}

	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}

	cloneNode(deep: boolean): FakeElement {
		const clone = new FakeElement(this.ownerDocument);
		clone.id = this.id;
		clone.className = this.className;
		clone.textContent = this.textContent;
		Object.assign(clone.dataset, this.dataset);
		if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
		return clone;
	}

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
		return this.querySelectorAll(selector)[0] || null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const result: FakeElement[] = [];
		for (const child of this.children) {
			if (
				(selector.startsWith(".") && child.className.split(/\s+/).includes(selector.slice(1))) ||
				(selector.startsWith("#") && child.id === selector.slice(1)) ||
				(selector === "[data-question]" && child.dataset.question)
			)
				result.push(child);
			result.push(...child.querySelectorAll(selector));
		}
		return result;
	}

	setAttribute(name: string, value: string): void {
		if (name === "open") this.open = true;
		this.dataset[name] = value;
	}

	showModal(): void {
		this.open = true;
	}

	close(): void {
		this.open = false;
	}

	// 原生弹出层只影响绘制层级，行为测试保留其开启/关闭状态即可。
	showPopover(): void {
		this.open = true;
	}

	hidePopover(): void {
		this.open = false;
	}

	getBoundingClientRect(): { top: number; bottom: number; right: number; width: number; height: number } {
		return { top: 100, bottom: 130, right: 240, width: 116, height: 80 };
	}

	trigger(type: string, event: Record<string, unknown> = {}): void {
		this.listeners.get(type)?.(event);
	}

	scrollTo(options: { top: number; behavior?: string }): void {
		this.scrollTop = options.top;
		this.lastScrollTo = options;
	}

	addEventListener(type: string, callback: (...args: unknown[]) => void): void {
		this.listeners.set(type, callback);
	}
}

class FakeDocument extends FakeElement {
	private readonly elements = new Map<string, FakeElement>();
	activeElement: FakeElement | null = null;

	register(id: string): FakeElement {
		const element = new FakeElement(this);
		element.id = id;
		this.elements.set(id, element);
		return element;
	}

	getElementById(id: string): FakeElement | null {
		return this.elements.get(id) || this.elements.get("chat-box")?.querySelector(`#${id}`) || null;
	}

	createElement(_tagName: string): FakeElement {
		return new FakeElement(this);
	}

	createElementNS(_namespace: string, tagName: string): FakeElement {
		return this.createElement(tagName);
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

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

class FakeResizeObserver {
	static latest: FakeResizeObserver | undefined;
	private readonly callback: () => void;

	constructor(callback: () => void) {
		this.callback = callback;
		FakeResizeObserver.latest = this;
	}

	observe(): void {}

	trigger(): void {
		this.callback();
	}
}

class StubApi {
	listSessions = async (_options?: UnknownRecord): Promise<UnknownRecord> => ({ sessions: [] });
	createSession = async (): Promise<UnknownRecord> => ({ sessionId: "seed" });
	getSession = async (sessionId: string): Promise<UnknownRecord> => ({ sessionId });
	getMessages = async (_sessionId?: string, _options?: UnknownRecord): Promise<UnknownRecord> => ({ messages: [] });
	getRequest = async (_sessionId?: string, _requestId?: string): Promise<UnknownRecord> => ({ status: "running" });
	renameSession = async (sessionId: string, title: string): Promise<UnknownRecord> => ({ sessionId, title });
	deleteSession = async (sessionId: string): Promise<UnknownRecord> => ({ sessionId, deleted: true });
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
	document: FakeDocument;
	api: StubApi;
	controller: UnknownRecord;
	state: UnknownRecord;
	chatBox: FakeElement;
	composerRegion: FakeElement;
	jumpButton: FakeElement;
	input: FakeElement;
	sessionList: FakeElement;
	sessionTitle: FakeElement;
	runStatus: FakeElement;
	deleteDialog: FakeElement;
	deleteMessage: FakeElement;
	deleteCancel: FakeElement;
	renameDialog: FakeElement;
	renameForm: FakeElement;
	renameInput: FakeElement;
	renameError: FakeElement;
	renameCancel: FakeElement;
	runTimers: () => void;
	triggerComposerResize: () => void;
};

async function loadWebHarness(): Promise<WebHarness> {
	const document = new FakeDocument();
	for (const id of [
		"app-shell",
		"sidebar",
		"workspace-main",
		"sidebar-collapse-btn",
		"sidebar-expand-btn",
		"sidebar-backdrop",
		"welcome-template",
		"knowledge-status",
		"knowledge-status-text",
		"send-btn",
		"stop-btn",
		"user-input",
		"chat-box",
		"composer-region",
		"jump-to-latest",
		"session-list",
		"new-session-btn",
		"refresh-sessions-btn",
		"session-title",
		"run-status",
		"connection-dot",
		"connection-title",
		"connection-desc",
		"session-delete-dialog",
		"session-delete-heading",
		"session-delete-message",
		"session-delete-cancel",
		"session-delete-confirm",
		"session-rename-dialog",
		"session-rename-form",
		"session-rename-input",
		"session-rename-error",
		"session-rename-cancel",
		"session-rename-save",
	])
		document.register(id);
	// 测试替身复用真实模板中的问题文本，确保入口发送的内容与页面一致。
	const html = await readFile(new URL("../../web-ui/index.html", import.meta.url), "utf8");
	const welcome = document.createElement("section");
	welcome.id = "welcome-message";
	welcome.className = "welcome";
	for (const match of html.matchAll(/data-question="([^"]+)"/g)) {
		const button = document.createElement("button");
		button.dataset.question = match[1];
		welcome.appendChild(button);
	}
	document.getElementById("welcome-template")!.content = { firstElementChild: welcome };
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
		ResizeObserver: FakeResizeObserver,
		matchMedia: () => new FakeElement(document),
		getComputedStyle: (element: FakeElement) => ({ lineHeight: element.lineHeight }),
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

		renameSession(sessionId: string, title: string): Promise<UnknownRecord> {
			return api.renameSession(sessionId, title);
		}

		deleteSession(sessionId: string): Promise<UnknownRecord> {
			return api.deleteSession(sessionId);
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
	vm.runInNewContext(await readFile(new URL("../../web-ui/js/workspace.js", import.meta.url), "utf8"), context);
	const source = await readFile(new URL("../../web-ui/js/script.js", import.meta.url), "utf8");
	vm.runInNewContext(source, context, { filename: "web-ui/js/script.js" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const controller = context.window as UnknownRecord;
	return {
		document,
		api,
		controller: controller.PcbClientController as UnknownRecord,
		state: (controller.PcbClientController as UnknownRecord).state as UnknownRecord,
		chatBox: document.getElementById("chat-box") as FakeElement,
		composerRegion: document.getElementById("composer-region") as FakeElement,
		jumpButton: document.getElementById("jump-to-latest") as FakeElement,
		input: document.getElementById("user-input") as FakeElement,
		sessionList: document.getElementById("session-list") as FakeElement,
		sessionTitle: document.getElementById("session-title") as FakeElement,
		runStatus: document.getElementById("run-status") as FakeElement,
		deleteDialog: document.getElementById("session-delete-dialog") as FakeElement,
		deleteMessage: document.getElementById("session-delete-message") as FakeElement,
		deleteCancel: document.getElementById("session-delete-cancel") as FakeElement,
		renameDialog: document.getElementById("session-rename-dialog") as FakeElement,
		renameForm: document.getElementById("session-rename-form") as FakeElement,
		renameInput: document.getElementById("session-rename-input") as FakeElement,
		renameError: document.getElementById("session-rename-error") as FakeElement,
		renameCancel: document.getElementById("session-rename-cancel") as FakeElement,
		runTimers: () => {
			const callbacks = timerCallbacks.splice(0);
			for (const callback of callbacks) callback();
		},
		triggerComposerResize: () => FakeResizeObserver.latest?.trigger(),
	};
}

test("browser follows streaming output only while the viewport is at the bottom", async () => {
	const harness = await loadWebHarness();
	harness.chatBox.clientHeight = 100;
	harness.chatBox.scrollHeight = 400;
	harness.chatBox.scrollTop = 300;
	harness.chatBox.trigger("scroll");
	harness.input.value = "测试流式输出";
	let streamEvent!: EventHandler;
	harness.api.sendMessage = async (_sessionId, options) => {
		streamEvent = options.onEvent!;
		return new Promise<SendResult>(() => undefined);
	};
	const sending = (harness.controller.sendMessage as () => Promise<void>)();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.chatBox.lastScrollTo?.top, 400);
	harness.chatBox.scrollTop = 200;
	harness.chatBox.trigger("scroll");
	harness.chatBox.lastScrollTo = null;
	streamEvent({ type: "message_delta", payload: { delta: "继续生成内容" } });
	assert.equal(harness.chatBox.lastScrollTo, null);
	assert.equal(harness.jumpButton.hidden, false);
	assert.equal(harness.state.isFollowing, false);
	void sending;
});

test("browser restores streaming follow mode after returning to the bottom or clicking jump button", async () => {
	const harness = await loadWebHarness();
	harness.chatBox.clientHeight = 100;
	harness.chatBox.scrollHeight = 500;
	harness.chatBox.scrollTop = 250;
	harness.chatBox.trigger("scroll");
	assert.equal(harness.state.isFollowing, false);
	harness.chatBox.scrollTop = 400;
	harness.chatBox.trigger("scroll");
	assert.equal(harness.state.isFollowing, true);
	harness.chatBox.scrollTop = 200;
	harness.chatBox.trigger("scroll");
	harness.jumpButton.trigger("click");
	assert.equal(harness.state.isFollowing, true);
	assert.equal(harness.chatBox.lastScrollTo?.top, 500);
	assert.equal(harness.jumpButton.hidden, true);
});

test("browser grows the message input to its content and caps it with an internal scrollbar", async () => {
	const harness = await loadWebHarness();
	harness.input.scrollHeight = 28;
	harness.input.trigger("input");
	assert.equal(harness.input.style.height, "28px");
	assert.equal(harness.input.style.overflowY, "hidden");

	harness.input.scrollHeight = 240;
	harness.input.trigger("input");
	assert.equal(harness.input.style.height, "160px");
	assert.equal(harness.input.style.overflowY, "auto");

	harness.input.scrollHeight = 54;
	harness.input.trigger("input");
	assert.equal(harness.input.style.height, "54px");
	assert.equal(harness.input.style.overflowY, "hidden");
});

test("browser keeps the jump button in the composer flow above the input area", async () => {
	const html = await readFile(new URL("../../web-ui/index.html", import.meta.url), "utf8");
	const composerStart = html.indexOf('<div id="composer-region" class="composer-region">');
	const jumpIndex = html.indexOf('id="jump-to-latest"', composerStart);
	const inputIndex = html.indexOf('class="input-area"', composerStart);
	assert.ok(composerStart >= 0);
	assert.ok(jumpIndex > composerStart && jumpIndex < inputIndex);
	const css = await readFile(new URL("../../web-ui/css/style.css", import.meta.url), "utf8");
	assert.match(css, /\.composer-region\s*\{[^}]*display:\s*flex/s);
	assert.match(css, /\.jump-to-latest\s*\{[^}]*align-self:\s*center/s);
});

test("browser makes only the jump button opaque while the composer overlay stays transparent", async () => {
	const css = await readFile(new URL("../../web-ui/css/style.css", import.meta.url), "utf8");
	const composerRule = css.match(/\.composer-region\s*\{[^}]*\}/s)?.[0] || "";
	assert.match(composerRule, /position:\s*absolute/);
	assert.match(composerRule, /background:\s*transparent/);
	assert.match(composerRule, /pointer-events:\s*none/);
	assert.match(
		css,
		/\.composer-region\s*>\s*\.jump-to-latest\s*,\s*\.composer-region\s*>\s*\.input-area\s*\{[^}]*pointer-events:\s*auto/s,
	);
	const jumpRule = css.match(/\.jump-to-latest\s*\{[^}]*\}/s)?.[0] || "";
	assert.match(jumpRule, /background:\s*var\(--surface\)/);
});

test("browser reserves the composer overlay height so the last message stays visible at the bottom", async () => {
	const harness = await loadWebHarness();
	harness.chatBox.scrollHeight = 800;
	harness.chatBox.clientHeight = 200;
	harness.chatBox.scrollTop = 600;
	harness.chatBox.lastScrollTo = null;
	harness.composerRegion.offsetHeight = 180;
	harness.triggerComposerResize();
	assert.equal(harness.chatBox.style.paddingBottom, "192px");
	const scrollToLatest = harness.chatBox.lastScrollTo as { top: number } | null;
	assert.notEqual(scrollToLatest, null);
	assert.equal(scrollToLatest?.top, 800);

	harness.chatBox.lastScrollTo = null;
	harness.state.isFollowing = false;
	harness.composerRegion.offsetHeight = 320;
	harness.triggerComposerResize();
	assert.equal(harness.chatBox.style.paddingBottom, "332px");
	assert.equal(harness.chatBox.lastScrollTo, null);
});

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

// 传输层使用会话 ID 的 URL 编码，并把标题写入 PATCH、删除请求使用 DELETE。
test("browser transport sends rename and delete session requests", async () => {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const context = vm.createContext({
		window: {
			fetch: async (url: string, options: RequestInit = {}) => {
				calls.push({ url, method: options.method || "GET", body: options.body as string | undefined });
				const body =
					options.method === "PATCH" ? { sessionId: "s/1", title: "新标题" } : { sessionId: "s/1", deleted: true };
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		},
		URL,
		Headers,
		TextDecoder,
		Response,
	});
	vm.runInContext(await readFile(new URL("../../web-ui/js/client.js", import.meta.url), "utf8"), context);
	const api = vm.runInContext("new window.PcbApi({ baseUrl: 'https://example.test' })", context) as {
		renameSession: (sessionId: string, title: string) => Promise<UnknownRecord>;
		deleteSession: (sessionId: string) => Promise<UnknownRecord>;
	};
	assert.deepEqual(JSON.parse(JSON.stringify(await api.renameSession("s/1", "新标题"))), {
		sessionId: "s/1",
		title: "新标题",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await api.deleteSession("s/1"))), { sessionId: "s/1", deleted: true });
	assert.deepEqual(calls, [
		{ url: "https://example.test/api/sessions/s%2F1", method: "PATCH", body: JSON.stringify({ title: "新标题" }) },
		{ url: "https://example.test/api/sessions/s%2F1", method: "DELETE", body: undefined },
	]);
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

// 标题缺失时显示固定的新会话文案，不能把内部会话 ID 暴露到列表或顶部标题。
test("browser keeps UUIDs out of session titles when the server has no title", async () => {
	const harness = await loadWebHarness();
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "uuid-session-123" }] });
	harness.api.getSession = async (sessionId) => ({ sessionId });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)({
		preserveSelection: true,
	});
	assert.match(elementText(harness.sessionList), /新会话/);
	assert.doesNotMatch(elementText(harness.sessionList), /uuid-session-123/);
	assert.equal(harness.sessionTitle.textContent, "新会话");
});

// 重命名会把 trim 后的标题传给 PATCH，并在列表和当前标题同时更新；超长标题被明确拒绝。
test("browser renames a session and synchronizes the current title", async () => {
	const harness = await loadWebHarness();
	const renameCalls: Array<{ sessionId: string; title: string }> = [];
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title: "旧标题" }] });
	harness.api.getSession = async () => ({ sessionId: "s1", title: "旧标题" });
	harness.api.renameSession = async (sessionId, title) => {
		renameCalls.push({ sessionId, title });
		return { sessionId, title };
	};
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	assert.equal(
		await (harness.controller.renameSession as (sessionId: string, title: string) => Promise<boolean>)(
			"s1",
			"  新标题  ",
		),
		true,
	);
	assert.deepEqual(renameCalls, [{ sessionId: "s1", title: "新标题" }]);
	assert.equal(harness.sessionTitle.textContent, "新标题");
	assert.match(elementText(harness.sessionList), /新标题/);
	assert.equal(
		await (harness.controller.renameSession as (sessionId: string, title: string) => Promise<boolean>)(
			"s1",
			"x".repeat(101),
		),
		false,
	);
	assert.equal(renameCalls.length, 1);
});

// 重命名弹窗在校验或保存失败时保留输入，取消不发请求，成功后关闭并更新名称。
test("browser rename modal validates input, allows cancellation and retries a failed save", async () => {
	const harness = await loadWebHarness();
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title: "原标题" }] });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	const openRename = harness.controller.requestRenameSession as (sessionId: string) => void;
	let saves = 0;
	harness.api.renameSession = async (sessionId, title) => {
		saves++;
		if (saves === 1) throw new Error("保存失败，请重试");
		return { sessionId, title };
	};
	openRename("s1");
	assert.equal(harness.renameDialog.open, true);
	harness.renameCancel.trigger("click");
	assert.equal(harness.renameDialog.open, false);
	assert.equal(saves, 0);
	openRename("s1");
	harness.renameInput.value = "   ";
	harness.renameForm.trigger("submit", { preventDefault() {} });
	assert.match(harness.renameError.textContent, /不能为空/);
	assert.equal(saves, 0);
	harness.renameInput.value = "修改后的标题";
	harness.renameForm.trigger("submit", { preventDefault() {} });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.renameDialog.open, true);
	assert.equal(harness.renameInput.value, "修改后的标题");
	assert.match(harness.renameError.textContent, /保存失败/);
	harness.renameForm.trigger("submit", { preventDefault() {} });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.renameDialog.open, false);
	assert.equal(harness.sessionTitle.textContent, "修改后的标题");
});

// 取消只关闭确认框；原生 cancel 事件也被拦截，点击遮罩不会绕过确认流程。
test("browser requires explicit delete confirmation and keeps the modal open on backdrop interaction", async () => {
	const harness = await loadWebHarness();
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title: "待删会话" }] });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	let deletes = 0;
	harness.api.deleteSession = async () => {
		deletes += 1;
		return { sessionId: "s1", deleted: true };
	};
	assert.equal((harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1"), true);
	assert.equal(harness.deleteDialog.open, true);
	assert.match(harness.deleteMessage.textContent, /关联消息后不可恢复/);
	harness.deleteDialog.trigger("click");
	assert.equal(harness.deleteDialog.open, true);
	let prevented = false;
	harness.deleteDialog.trigger("cancel", {
		preventDefault: () => {
			prevented = true;
		},
	});
	assert.equal(prevented, true);
	assert.equal(harness.deleteDialog.open, true);
	harness.deleteCancel.trigger("click");
	assert.equal(harness.deleteDialog.open, false);
	assert.equal(deletes, 0);
});

// 当前、非当前和最后一个会话的删除都由服务端确认后更新列表；最后一个回到空白新会话页。
test("browser deletes current, non-current, and last sessions with the expected navigation", async () => {
	const harness = await loadWebHarness();
	let sessions = [
		{ sessionId: "s1", title: "当前会话" },
		{ sessionId: "s2", title: "其他会话" },
	];
	const deleted: string[] = [];
	harness.api.listSessions = async () => ({ sessions });
	harness.api.getSession = async (sessionId) =>
		sessions.find((session) => session.sessionId === sessionId) || { sessionId };
	harness.api.deleteSession = async (sessionId) => {
		deleted.push(sessionId);
		sessions = sessions.filter((session) => session.sessionId !== sessionId);
		return { sessionId, deleted: true };
	};
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	assert.equal(harness.state.sessionId, "s1");
	(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s2");
	await (harness.controller.confirmDeleteSession as () => Promise<boolean>)();
	assert.deepEqual(deleted, ["s2"]);
	assert.equal(harness.state.sessionId, "s1");
	assert.doesNotMatch(elementText(harness.sessionList), /其他会话/);
	assert.equal(harness.runStatus.textContent, "");

	(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1");
	await (harness.controller.confirmDeleteSession as () => Promise<boolean>)();
	assert.deepEqual(deleted, ["s2", "s1"]);
	assert.equal(harness.state.sessionId, null);
	assert.equal(harness.sessionTitle.textContent, "新会话");
});

// 删除失败时保留会话并重新加载当前视图，用户可以再次打开确认框重试。
test("browser keeps a session after a failed delete and restores the current view", async () => {
	const harness = await loadWebHarness();
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title: "保留会话" }] });
	harness.api.getSession = async () => ({ sessionId: "s1", title: "保留会话", activeRequestId: "running-request" });
	harness.api.deleteSession = async () => {
		throw new Error("删除失败");
	};
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1");
	assert.equal(await (harness.controller.confirmDeleteSession as () => Promise<boolean>)(), false);
	assert.equal(harness.state.sessionId, "s1");
	assert.match(elementText(harness.sessionList), /保留会话/);
	assert.equal(harness.state.loadingSession, false);
	assert.equal((harness.state.activeRequest as UnknownRecord).requestId, "running-request");
	assert.equal(harness.input.disabled, true);
});

// 重命名完成后，迟到的会话 GET 不能用旧标题覆盖顶部标题。
test("browser prefers the renamed list title over a late stale session load", async () => {
	const harness = await loadWebHarness();
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title: "旧标题" }] });
	let resolveSession: ((session: UnknownRecord) => void) | undefined;
	harness.api.getSession = async () =>
		new Promise<UnknownRecord>((resolve) => {
			resolveSession = resolve;
		});
	harness.api.getMessages = async () => ({ messages: [] });
	harness.api.renameSession = async (sessionId, title) => ({ sessionId, title });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)({
		preserveSelection: true,
	});
	const selectPromise = (harness.controller.selectSession as (sessionId: string) => Promise<void>)("s1");
	await new Promise<void>((resolve) => setImmediate(resolve));
	await (harness.controller.renameSession as (sessionId: string, title: string) => Promise<boolean>)("s1", "新标题");
	resolveSession?.({ sessionId: "s1", title: "旧标题" });
	await selectPromise;
	assert.equal(harness.sessionTitle.textContent, "新标题");
});

// 服务端受理首问后即刷新标题，无需等到模型生成结束。
test("browser refreshes the generated title while the first request is still streaming", async () => {
	const harness = await loadWebHarness();
	let title = "新会话";
	harness.api.listSessions = async () => ({ sessions: [{ sessionId: "s1", title }] });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	let finishStream!: (result: SendResult) => void;
	harness.api.sendMessage = async (_sessionId, options) => {
		title = "板面有划伤";
		options.onEvent?.({ type: "request_started" });
		return new Promise<SendResult>((resolve) => {
			finishStream = resolve;
		});
	};
	harness.input.value = "板面有划伤。还有露铜";
	const sending = (harness.controller.sendMessage as () => Promise<void>)();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.sessionTitle.textContent, "板面有划伤");
	assert.ok(harness.state.activeRequest);
	finishStream({ kind: "stream", status: 200, final: { status: "succeeded", reply: "完成" }, lastEvent: null });
	await sending;
});

// 删除当前会话后跳到另一会话；旧流即使随后完成也不能污染新页面。
test("browser switches away from a deleted current session and ignores its late stream", async () => {
	const harness = await loadWebHarness();
	let sessions = [
		{ sessionId: "s1", title: "待删会话" },
		{ sessionId: "s2", title: "保留会话" },
	];
	harness.api.listSessions = async () => ({ sessions });
	harness.api.getSession = async (sessionId) =>
		sessions.find((session) => session.sessionId === sessionId) || { sessionId };
	harness.api.deleteSession = async (sessionId) => {
		sessions = sessions.filter((session) => session.sessionId !== sessionId);
		return { sessionId, deleted: true };
	};
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	let streamOptions!: SendOptions;
	let finishStream!: (result: SendResult) => void;
	harness.api.sendMessage = async (_sessionId, options) => {
		streamOptions = options;
		return new Promise<SendResult>((resolve) => {
			finishStream = resolve;
		});
	};
	harness.input.value = "待删除的提问";
	const sending = (harness.controller.sendMessage as () => Promise<void>)();
	(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1");
	await (harness.controller.confirmDeleteSession as () => Promise<boolean>)();
	assert.equal(harness.state.sessionId, "s2");
	assert.equal(harness.sessionTitle.textContent, "保留会话");
	assert.equal(streamOptions.signal?.aborted, true);
	streamOptions.onEvent?.({ type: "message_delta", payload: { delta: "旧会话迟到内容" } });
	finishStream({
		kind: "stream",
		status: 200,
		final: { status: "succeeded", reply: "旧会话最终回答" },
		lastEvent: null,
	});
	await sending;
	assert.equal(harness.state.activeRequest, null);
	assert.doesNotMatch(elementText(harness.chatBox), /旧会话/);
});

// 操作前发出的列表查询即使最后返回，也不能恢复旧名称或把已删除会话重新放回列表。
test("browser ignores list responses captured before a rename or delete", async () => {
	for (const operation of ["rename", "delete"]) {
		const harness = await loadWebHarness();
		let sessions = [{ sessionId: "s1", title: "旧标题" }];
		harness.api.listSessions = async () => ({ sessions });
		await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
		let releaseList!: (result: UnknownRecord) => void;
		harness.api.listSessions = async () =>
			new Promise<UnknownRecord>((resolve) => {
				releaseList = resolve;
			});
		const staleList = (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)({
			preserveSelection: true,
		});
		harness.api.listSessions = async () => ({ sessions });
		if (operation === "rename") {
			harness.api.renameSession = async (sessionId, title) => {
				sessions = [{ sessionId, title }];
				return { sessionId, title };
			};
			await (harness.controller.renameSession as (sessionId: string, title: string) => Promise<boolean>)(
				"s1",
				"新标题",
			);
		} else {
			harness.api.deleteSession = async (sessionId) => {
				sessions = [];
				return { sessionId, deleted: true };
			};
			(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1");
			await (harness.controller.confirmDeleteSession as () => Promise<boolean>)();
		}
		releaseList({ sessions: [{ sessionId: "s1", title: "旧标题" }] });
		await staleList;
		assert.doesNotMatch(elementText(harness.sessionList), /旧标题/);
		assert.equal(harness.sessionTitle.textContent, operation === "rename" ? "新标题" : "新会话");
	}
});

// 等待删除响应时不向正在删除的会话发送消息，保留用户尚未发送的草稿。
test("browser preserves the draft instead of sending into a session being deleted", async () => {
	const harness = await loadWebHarness();
	let sessions = [{ sessionId: "s1", title: "待删会话" }];
	harness.api.listSessions = async () => ({ sessions });
	await (harness.controller.refreshSessions as (options?: UnknownRecord) => Promise<boolean>)();
	let completeDelete!: (result: UnknownRecord) => void;
	harness.api.deleteSession = async () =>
		new Promise<UnknownRecord>((resolve) => {
			completeDelete = resolve;
		});
	let sends = 0;
	harness.api.sendMessage = async () => {
		sends++;
		return { kind: "stream", status: 200, final: null, lastEvent: null };
	};
	(harness.controller.requestDeleteSession as (sessionId: string) => boolean)("s1");
	const deletion = (harness.controller.confirmDeleteSession as () => Promise<boolean>)();
	harness.input.value = "尚未发送的草稿";
	await (harness.controller.sendMessage as () => Promise<void>)();
	assert.equal(sends, 0);
	assert.equal(harness.input.value, "尚未发送的草稿");
	sessions = [];
	completeDelete({ sessionId: "s1", deleted: true });
	await deletion;
});

// 四个欢迎入口都直接走既有请求接口；首问后整个欢迎区域消失，新会话再恢复。
test("browser sends each welcome question and restores welcome only for an empty session", async () => {
	for (let index = 0; index < 4; index++) {
		const harness = await loadWebHarness();
		const welcome = harness.chatBox.querySelector(".welcome")!;
		const examples = welcome.querySelectorAll("[data-question]");
		assert.equal(examples.length, 4);
		let sent = "";
		harness.api.sendMessage = async (_sessionId, options) => {
			sent = options.message || "";
			return { kind: "stream", status: 200, final: { status: "succeeded", reply: "分析完成" }, lastEvent: null };
		};
		examples[index].trigger("click");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(sent, examples[index].dataset.question);
		assert.equal(harness.chatBox.querySelector(".welcome"), null);
		assert.equal(harness.chatBox.querySelectorAll(".user-message").length, 1);
		assert.match(elementText(harness.chatBox), /分析完成/);
		await (harness.controller.createSession as () => Promise<void>)();
		assert.ok(harness.chatBox.querySelector(".welcome"));
		assert.equal(harness.chatBox.querySelectorAll(".message").length, 0);
	}
});

// 日期采用本地自然日；菜单通过鼠标或键盘打开，重命名只打开原有弹窗。
test("browser groups sessions by calendar day and operates the keyboard accessible menu", async () => {
	const harness = await loadWebHarness();
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const earlier = new Date(today);
	earlier.setDate(today.getDate() - 3);
	harness.api.listSessions = async () => ({
		sessions: [
			{ sessionId: "old", title: "早期排查", updatedAt: earlier.toISOString() },
			{ sessionId: "today", title: "今日排查", updatedAt: today.toISOString() },
			{ sessionId: "yesterday", title: "昨日排查", createdAt: yesterday.toISOString() },
		],
	});
	await (harness.controller.refreshSessions as (options: UnknownRecord) => Promise<boolean>)({
		preserveSelection: true,
	});
	const groups = harness.sessionList.querySelectorAll(".session-group");
	assert.deepEqual(
		groups.map((group) => group.querySelector(".session-group-heading")!.textContent),
		["今天", "昨天", "更早"],
	);
	assert.match(elementText(groups[0]), /今日排查/);
	assert.match(elementText(groups[1]), /昨日排查/);
	assert.match(elementText(groups[2]), /早期排查/);
	assert.doesNotMatch(elementText(harness.sessionList), /待机|运行中/);
	const toggle = groups[0].querySelector(".session-menu-toggle")!;
	const menu = groups[0].querySelector(".session-menu")!;
	assert.equal(menu.hidden, true);
	toggle.trigger("click");
	assert.equal(menu.hidden, false);
	assert.equal(harness.document.activeElement, menu.children[0]);
	menu.trigger("keydown", { key: "ArrowDown", preventDefault() {} });
	assert.equal(harness.document.activeElement, menu.children[1]);
	harness.document.trigger("keydown", { key: "Escape" });
	assert.equal(menu.hidden, true);
	assert.equal(harness.document.activeElement, toggle);
	toggle.trigger("click");
	menu.children[0].trigger("click");
	assert.equal(harness.renameDialog.open, true);
	assert.equal(harness.renameInput.value, "今日排查");
	assert.equal(menu.hidden, true);
});

// 折叠/展开可逆；知识库状态只由检索事件更新，不根据会话连接伪报在线。
test("browser toggles the sidebar and reports knowledge retrieval state from actual events", async () => {
	const harness = await loadWebHarness();
	const shell = harness.document.getElementById("app-shell")!;
	harness.document.getElementById("sidebar-collapse-btn")!.trigger("click");
	assert.equal(shell.classList.contains("sidebar-collapsed"), true);
	assert.equal(harness.document.getElementById("sidebar-expand-btn")!.hidden, false);
	harness.document.getElementById("sidebar-expand-btn")!.trigger("click");
	assert.equal(shell.classList.contains("sidebar-collapsed"), false);
	assert.equal(harness.document.getElementById("sidebar-expand-btn")!.hidden, true);
	await (harness.controller.selectSession as (sessionId: string) => Promise<void>)("s1");
	harness.api.sendMessage = async (_sessionId, options) => {
		options.onEvent?.({ type: "tool_started", payload: { backend: "ragflow" } });
		assert.equal(harness.document.getElementById("knowledge-status")!.dataset.state, "checking");
		options.onEvent?.({
			type: "tool_completed",
			payload: { toolName: "search_knowledge_base", backend: "local", status: "degraded" },
		});
		assert.equal(harness.document.getElementById("knowledge-status")!.dataset.state, "degraded");
		options.onEvent?.({ type: "tool_completed", payload: { backend: "ragflow", status: "failed" } });
		assert.equal(harness.document.getElementById("knowledge-status")!.dataset.state, "offline");
		options.onEvent?.({ type: "tool_completed", payload: { backend: "ragflow", status: "ok" } });
		return { kind: "stream", status: 200, final: { status: "succeeded", reply: "完成" }, lastEvent: null };
	};
	harness.input.value = "排查孔铜异常";
	await (harness.controller.sendMessage as () => Promise<void>)();
	assert.equal(harness.document.getElementById("knowledge-status")!.dataset.state, "connected");
});

// 输入法确认候选词和 Shift+Enter 不发送，普通 Enter 只发送一次。
test("browser preserves IME composition and multiline input before sending with Enter", async () => {
	const harness = await loadWebHarness();
	await (harness.controller.selectSession as (sessionId: string) => Promise<void>)("s1");
	let sends = 0;
	harness.api.sendMessage = async () => {
		sends++;
		return { kind: "stream", status: 200, final: { status: "succeeded", reply: "完成" }, lastEvent: null };
	};
	harness.input.value = "线路异常";
	harness.input.trigger("keydown", { key: "Enter", isComposing: true });
	harness.input.trigger("keydown", { key: "Enter", shiftKey: true });
	assert.equal(sends, 0);
	assert.equal(harness.input.value, "线路异常");
	harness.input.trigger("keydown", { key: "Enter", preventDefault() {} });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sends, 1);
});
