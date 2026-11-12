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

	closest(selector: string): FakeElement | null {
		return selector === "[data-preview-evidence]" && this.dataset.previewEvidence ? this : null;
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
	getEvidence = async (_sessionId?: string, evidenceId?: string): Promise<UnknownRecord> => ({ evidenceId });
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
	usageSummary: FakeElement;
	usageDetails: FakeElement;
	usageStatus: FakeElement;
	deleteDialog: FakeElement;
	deleteMessage: FakeElement;
	deleteCancel: FakeElement;
	renameDialog: FakeElement;
	evidenceDialog: FakeElement;
	evidenceTitle: FakeElement;
	evidenceLocation: FakeElement;
	evidenceText: FakeElement;
	evidenceClose: FakeElement;
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
		"usage-summary",
		"usage-details",
		"usage-status",
		"usage-input",
		"usage-output",
		"usage-cache-read",
		"usage-cache-write",
		"usage-cache-rate",
		"usage-total",
		"usage-cost",
		"usage-elapsed",
		"usage-model",
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
		"evidence-dialog",
		"evidence-preview-title",
		"evidence-preview-kind",
		"evidence-preview-location",
		"evidence-preview-text",
		"evidence-preview-error",
		"evidence-preview-close",
		"evidence-preview-link",
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
		setInterval: (callback: () => void) => {
			timerCallbacks.push(callback);
			return timerCallbacks.length;
		},
		clearInterval: () => undefined,
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
			for (const match of String(text).matchAll(/\[E:([A-Za-z0-9_-]+)\]/g)) {
				const reference = document.createElement("button");
				reference.className = "citation-link";
				reference.dataset.evidenceId = match[1] || "";
				reference.dataset.previewEvidence = "true";
				reference.textContent = match[0];
				node.appendChild(reference);
			}
			return node;
		},
		renderEvidenceMarkdown: (text: string) => {
			const node = new FakeElement();
			node.className = "md-body";
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

		getEvidence(sessionId: string, evidenceId: string): Promise<UnknownRecord> {
			return api.getEvidence(sessionId, evidenceId);
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
		usageSummary: document.getElementById("usage-summary") as FakeElement,
		usageDetails: document.getElementById("usage-details") as FakeElement,
		usageStatus: document.getElementById("usage-status") as FakeElement,
		deleteDialog: document.getElementById("session-delete-dialog") as FakeElement,
		deleteMessage: document.getElementById("session-delete-message") as FakeElement,
		deleteCancel: document.getElementById("session-delete-cancel") as FakeElement,
		renameDialog: document.getElementById("session-rename-dialog") as FakeElement,
		evidenceDialog: document.getElementById("evidence-dialog") as FakeElement,
		evidenceTitle: document.getElementById("evidence-preview-title") as FakeElement,
		evidenceLocation: document.getElementById("evidence-preview-location") as FakeElement,
		evidenceText: document.getElementById("evidence-preview-text") as FakeElement,
		evidenceClose: document.getElementById("evidence-preview-close") as FakeElement,
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

test("browser opens the full evidence preview from an inline citation without a source list", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-preview";
	harness.input.value = "检查证据";
	const previewCalls: Array<{ sessionId: string; evidenceId: string }> = [];
	harness.api.sendMessage = async () => ({
		kind: "stream",
		status: 200,
		final: {
			status: "succeeded",
			reply: "依据 [E:ev_preview1]，请确认板厚。",
			sources: [{ evidenceId: "ev_preview1", sourceType: "knowledge_base", title: "规范", text: "片段" }],
		},
		lastEvent: null,
	});
	harness.api.getEvidence = async (sessionId, evidenceId) => {
		previewCalls.push({ sessionId: sessionId || "", evidenceId: evidenceId || "" });
		return {
			evidenceId,
			sourceType: "knowledge_base",
			title: "线路缺陷判定规范",
			text: "## 诊断增强\n<table><thead><tr><th>观察特征</th></tr></thead><tbody></tbody></table>",
			documentId: "doc-1",
			chunkId: "chunk-9",
			page: 4,
		};
	};
	await (harness.controller.sendMessage as () => Promise<void>)();
	assert.equal(harness.chatBox.querySelector(".sources-disclosure"), null);
	assert.equal(harness.chatBox.querySelector(".source-preview-trigger"), null);
	const citation = harness.chatBox.querySelector(".citation-link");
	assert.ok(citation);
	harness.chatBox.trigger("click", { target: citation });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(previewCalls, [{ sessionId: "session-preview", evidenceId: "ev_preview1" }]);
	assert.equal(harness.evidenceDialog.open, true);
	assert.equal(harness.evidenceTitle.textContent, "线路缺陷判定规范");
	assert.match(harness.evidenceLocation.textContent, /第 4 页/);
	assert.equal(harness.evidenceText.children[0]?.className, "md-body");
	assert.match(harness.evidenceText.children[0]?.textContent || "", /<table>/);
	harness.evidenceClose.trigger("click");
	assert.equal(harness.evidenceDialog.open, false);
});

test("browser does not render a separate evidence list when the answer omits inline citations", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-uncited-preview";
	harness.input.value = "检查证据";
	harness.api.sendMessage = async () => ({
		kind: "stream",
		status: 200,
		final: {
			status: "succeeded",
			reply: "先确认是否露铜和划伤深度。",
			citationValidation: { status: "not_applicable", invalidIds: [] },
			sources: [{ evidenceId: "ev_preview1", sourceType: "knowledge_base", title: "规范", text: "片段" }],
		},
		lastEvent: null,
	});
	harness.api.getEvidence = async (_sessionId, evidenceId) => ({
		evidenceId,
		sourceType: "knowledge_base",
		title: "线路缺陷判定规范",
		text: "完整的内部知识库证据内容。",
	});
	await (harness.controller.sendMessage as () => Promise<void>)();
	assert.equal(harness.chatBox.querySelector(".sources"), null);
	assert.equal(harness.chatBox.querySelector(".citation-link"), null);
});

for (const history of [false, true]) {
	for (const status of ["valid", "not_applicable", "invalid"]) {
		test(`browser omits source lists for ${status} ${history ? "restored answers" : "new answers"}`, async () => {
			const harness = await loadWebHarness();
			const answer = {
				status: "succeeded",
				reply: "判定依据见 [E:ev_preview1]。",
				sources: [{ evidenceId: "ev_preview1", sourceType: "knowledge_base", title: "工艺规范", text: "证据片段" }],
				citationValidation: { status, invalidIds: status === "invalid" ? ["ev_missing"] : [] },
			};
			if (history) {
				harness.api.getMessages = async () => ({
					messages: [{ ...answer, entryId: "saved-answer", role: "assistant", content: answer.reply }],
				});
				await (harness.controller.selectSession as (sessionId: string) => Promise<void>)("history-sources");
			} else {
				harness.state.sessionId = "new-sources";
				harness.input.value = "检查缺陷";
				harness.api.sendMessage = async () => ({ kind: "stream", status: 200, final: answer, lastEvent: null });
				await (harness.controller.sendMessage as () => Promise<void>)();
			}
			assert.equal(harness.chatBox.querySelector(".sources"), null);
			assert.equal(harness.chatBox.querySelector(".source-preview-trigger"), null);
			if (status === "invalid") {
				assert.match(harness.chatBox.querySelector(".citation-warning")?.textContent || "", /ev_missing/);
			} else assert.equal(harness.chatBox.querySelector(".citation-warning"), null);
		});
	}
}

test("browser streams estimated usage in the composer and replaces it with confirmed usage", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-usage";
	harness.input.value = "统计用量";
	let onEvent!: EventHandler;
	let resolveSend!: (result: SendResult) => void;
	harness.api.sendMessage = async (_sessionId, options) => {
		onEvent = options.onEvent!;
		return new Promise<SendResult>((resolve) => {
			resolveSend = resolve;
		});
	};
	const sending = (harness.controller.sendMessage as () => Promise<void>)();
	await new Promise<void>((resolve) => setImmediate(resolve));
	onEvent({ type: "message_delta", payload: { delta: "一个PCB异常分析响应" } });
	assert.match(harness.usageSummary.textContent, /^生成中 · .* 秒$/);
	assert.doesNotMatch(harness.usageSummary.textContent, /token|输出约/);
	assert.match(harness.document.getElementById("usage-output")?.textContent || "", /^约 /);
	assert.equal(harness.usageStatus.dataset.state, "running");
	onEvent({
		type: "usage_snapshot",
		payload: { usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 20, totalTokens: 250, cost: 0.000135 } },
	});
	assert.match(harness.usageSummary.textContent, /^生成中 · .* 秒$/);
	assert.equal(harness.document.getElementById("usage-cache-rate")?.textContent, "36.4%");
	resolveSend({
		kind: "stream",
		status: 200,
		final: {
			status: "succeeded",
			reply: "分析完成。",
			model: "provider/model",
			elapsedMs: 2431,
			usage: { input: 120, output: 34, cacheRead: 80, cacheWrite: 20, totalTokens: 254, cost: 0.000145 },
		},
		lastEvent: null,
	});
	await sending;
	assert.equal(harness.usageStatus.dataset.state, "complete");
	assert.match(harness.usageSummary.textContent, /上轮 · 254 token · ￥0\.00104 · 2\.4 秒/);
	assert.doesNotMatch(harness.usageSummary.textContent, /输入|输出|缓存/);
	assert.match(harness.usageSummary.textContent, /2\.4 秒/);
	assert.equal(harness.document.getElementById("usage-cost")?.textContent, "￥0.00104");
	assert.equal(harness.chatBox.querySelector(".usage-details"), null);
});

test("browser shows usage in the composer without inventing a cache rate", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-no-cache-stats";
	harness.input.value = "统计缓存";
	harness.api.sendMessage = async () => ({
		kind: "stream",
		status: 200,
		final: {
			status: "succeeded",
			reply: "分析完成。",
			usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0 },
		},
		lastEvent: null,
	});
	await (harness.controller.sendMessage as () => Promise<void>)();

	assert.match(harness.usageSummary.textContent, /上轮 · 150 token · ￥0 ·/);
	assert.equal(harness.document.getElementById("usage-cache-rate")?.textContent, "0.0%");
	assert.equal(harness.document.getElementById("usage-cache-read")?.textContent, "0");
	assert.equal(harness.chatBox.querySelector(".usage-details"), null);
});

test("browser labels missing cache counters as unavailable", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-cache-unavailable";
	harness.input.value = "统计缓存";
	harness.api.sendMessage = async () => ({
		kind: "stream",
		status: 200,
		final: {
			status: "succeeded",
			reply: "分析完成。",
			usage: { input: 120, output: 30, totalTokens: 150, cost: 0 },
		},
		lastEvent: null,
	});
	await (harness.controller.sendMessage as () => Promise<void>)();

	assert.equal(harness.document.getElementById("usage-cache-rate")?.textContent, "不可用");
	assert.equal(harness.document.getElementById("usage-cache-read")?.textContent, "不可用");
});

test("browser explains model connection failures without exposing only an internal code", async () => {
	const harness = await loadWebHarness();
	harness.state.sessionId = "session-model-connection-error";
	harness.input.value = "测试模型连接";
	harness.api.sendMessage = async () => ({
		kind: "stream",
		status: 200,
		final: { status: "failed", errorCode: "MODEL_CONNECTION_ERROR" },
		lastEvent: null,
	});
	await (harness.controller.sendMessage as () => Promise<void>)();

	const assistant = harness.chatBox.children.at(-1);
	assert.equal(
		assistant?.querySelector(".msg-text")?.children[0]?.textContent,
		"模型服务连接失败，请检查本机网络或代理设置后重试。",
	);
});

test("browser opens usage details on hover and closes them on pointer leave or Escape", async () => {
	const harness = await loadWebHarness();
	let prevented = false;
	harness.usageDetails.trigger("pointerenter", { pointerType: "mouse" });
	assert.equal(harness.usageDetails.open, true);
	harness.document.getElementById("usage-summary")?.trigger("click", {
		preventDefault: () => {
			prevented = true;
		},
	});
	assert.equal(prevented, true);
	assert.equal(harness.usageDetails.open, true);
	harness.usageDetails.trigger("pointerleave", { pointerType: "mouse" });
	assert.equal(harness.usageDetails.open, false);
	harness.usageDetails.trigger("focusin");
	assert.equal(harness.usageDetails.open, true);
	harness.usageDetails.trigger("keydown", { key: "Escape" });
	assert.equal(harness.usageDetails.open, false);
});

test("browser restores the latest historical usage in the composer instead of the answer", async () => {
	const harness = await loadWebHarness();
	harness.api.getSession = async (sessionId) => ({ sessionId });
	harness.api.getMessages = async () => ({
		messages: [
			{ entryId: "user-entry", role: "user", content: "之前的问题" },
			{
				entryId: "assistant-entry",
				role: "assistant",
				content: "之前的回答。",
				status: "succeeded",
				model: "provider/model",
				elapsedMs: 1500,
				usage: { input: 10, output: 5, cacheRead: 5, cacheWrite: 1, totalTokens: 21, cost: 0.00001 },
			},
		],
	});
	await (harness.controller.selectSession as (sessionId: string) => Promise<void>)("session-history-usage");

	assert.match(harness.usageSummary.textContent, /上轮 · 21 token · ￥0\.000072 · 1\.5 秒/);
	assert.equal(harness.document.getElementById("usage-cache-rate")?.textContent, "31.3%");
	assert.match(harness.usageSummary.textContent, /1\.5 秒/);
	assert.equal(harness.usageStatus.dataset.state, "complete");
	assert.equal(harness.chatBox.querySelector(".usage-details"), null);
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

test("browser transport requests an evidence preview within its session scope", async () => {
	const calls: Array<{ url: string; method: string }> = [];
	const context = vm.createContext({
		window: {
			fetch: async (url: string, options: RequestInit = {}) => {
				calls.push({ url, method: options.method || "GET" });
				return new Response(JSON.stringify({ evidenceId: "ev_preview1", title: "工艺规范", text: "完整证据" }), {
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
		getEvidence: (sessionId: string, evidenceId: string) => Promise<UnknownRecord>;
	};
	assert.deepEqual(JSON.parse(JSON.stringify(await api.getEvidence("s/1", "ev_preview1"))), {
		evidenceId: "ev_preview1",
		title: "工艺规范",
		text: "完整证据",
	});
	assert.deepEqual(calls, [{ url: "https://example.test/api/sessions/s%2F1/evidence/ev_preview1", method: "GET" }]);
});

test("markdown renders evidence references as buttons while leaving code references inert", async () => {
	const document = new FakeDocument();
	const context = vm.createContext({
		window: {
			marked: {
				use: () => undefined,
				lexer: () => [
					{
						type: "paragraph",
						tokens: [
							{ type: "text", text: "依据 [E:ev_ref123]，另见 [E:ev_other456]。" },
							{ type: "codespan", text: "[E:ev_code123]" },
						],
					},
				],
			},
		},
		document,
	});
	vm.runInContext(await readFile(new URL("../../web-ui/js/markdown.js", import.meta.url), "utf8"), context);
	const output = (context.window as UnknownRecord).renderMarkdown as (value: string) => FakeElement;
	const rendered = output("ignored");
	const references = rendered.querySelectorAll(".citation-link");
	assert.equal(references.length, 2);
	assert.deepEqual(
		references.map((reference) => reference.dataset.evidenceId),
		["ev_ref123", "ev_other456"],
	);
	assert.deepEqual(
		references.map((reference) => reference.textContent),
		["1", "2"],
	);
	assert.equal(references[0]?.dataset["aria-label"], "预览引用材料 1（ev_ref123）");
	assert.equal(references[1]?.dataset["aria-label"], "预览引用材料 2（ev_other456）");
});

test("evidence markdown converts structured HTML tables to readable markdown rows", async () => {
	let parsedMarkdown = "";
	const rows = [
		[
			{ tagName: "TH", textContent: "观察特征" },
			{ tagName: "TH", textContent: "可能原因" },
		],
		[
			{ tagName: "TD", textContent: "坐标桥重复" },
			{ tagName: "TD", textContent: "底片或曝光数据错误" },
		],
	];
	class TableDOMParser {
		parseFromString(_source: string, _type: string) {
			return {
				querySelector: () => ({
					querySelectorAll: () => rows.map((cells) => ({ querySelectorAll: () => cells })),
				}),
			};
		}
	}
	const context = vm.createContext({
		window: {
			marked: {
				use: () => undefined,
				lexer: (source: string) => {
					parsedMarkdown = source;
					return [];
				},
			},
		},
		document: new FakeDocument(),
		DOMParser: TableDOMParser,
	});
	vm.runInContext(await readFile(new URL("../../web-ui/js/markdown.js", import.meta.url), "utf8"), context);
	const renderEvidenceMarkdown = (context.window as UnknownRecord).renderEvidenceMarkdown as (
		value: string,
	) => FakeElement;
	const rendered = renderEvidenceMarkdown(
		"## 诊断增强\n<table><thead><tr><th>观察特征</th></tr></thead><tbody></tbody></table>",
	);
	assert.equal(rendered.className, "md-body");
	assert.match(parsedMarkdown, /## 诊断增强/);
	assert.match(parsedMarkdown, /\| 观察特征 \| 可能原因 \|/);
	assert.match(parsedMarkdown, /\| 坐标桥重复 \| 底片或曝光数据错误 \|/);
	assert.doesNotMatch(parsedMarkdown, /<\/?(?:table|thead|tbody|tr|th|td)\b/i);
});

test("CSV evidence renders Data records and quoted CSV rows as readable tables", async () => {
	const parsedMarkdown: string[] = [];
	const context = vm.createContext({
		window: {
			marked: {
				use: () => undefined,
				lexer: (source: string) => {
					parsedMarkdown.push(source);
					return [];
				},
			},
		},
		document: new FakeDocument(),
	});
	vm.runInContext(await readFile(new URL("../../web-ui/js/markdown.js", import.meta.url), "utf8"), context);
	const renderEvidenceMarkdown = (context.window as UnknownRecord).renderEvidenceMarkdown as (
		value: string,
		title: string,
	) => FakeElement;
	renderEvidenceMarkdown(
		"编号: DEF-001; 缺陷: 线路开路; 类别: 线路; 工序: 曝光、蚀刻; 文件: DEF-001.md ——Data 编号: DEF-002; 缺陷: 线路短路; 类别: 线路; 工序: 压合; 文件: DEF-002.md",
		"缺陷索引.csv",
	);
	renderEvidenceMarkdown('编号,缺陷,说明\nDEF-003,缺陷,"线间距,桥连"', "缺陷列表.csv");
	assert.match(parsedMarkdown[0] || "", /\| 编号 \| 缺陷 \| 类别 \| 工序 \| 文件 \|/);
	assert.match(parsedMarkdown[0] || "", /\| DEF-001 \| 线路开路 \| 线路 \| 曝光、蚀刻 \| DEF-001\.md \|/);
	assert.match(parsedMarkdown[0] || "", /\| DEF-002 \| 线路短路 \| 线路 \| 压合 \| DEF-002\.md \|/);
	assert.match(parsedMarkdown[1] || "", /\| DEF-003 \| 缺陷 \| 线间距,桥连 \|/);
	assert.equal(parsedMarkdown[2], undefined);
});

test("evidence preview formats structured text, pretty-prints JSON, and preserves code-like files", async () => {
	const parsedMarkdown: string[] = [];
	const context = vm.createContext({
		window: {
			marked: {
				use: () => undefined,
				lexer: (source: string) => {
					parsedMarkdown.push(source);
					return [];
				},
			},
		},
		document: new FakeDocument(),
	});
	vm.runInContext(await readFile(new URL("../../web-ui/js/markdown.js", import.meta.url), "utf8"), context);
	const renderEvidenceMarkdown = (context.window as UnknownRecord).renderEvidenceMarkdown as (
		value: string,
		title: string,
	) => FakeElement;
	renderEvidenceMarkdown(
		"## 缺陷类别：阻焊\n阻焊 | 非BGA区域不允许 | 1. 离BGA和SMD区域5mm内不允许 2. 缺点大小1.25mm以内 | 目视/十倍镜 | ★ | 阻焊 | 绿油上PAD | 1. 绿油不允许入插件孔 2. 上金手指或感光点表面不允许",
		"缺陷说明.txt",
	);
	assert.match(parsedMarkdown[0] || "", /## 缺陷类别：阻焊/);
	assert.match(parsedMarkdown[0] || "", /### 阻焊/);
	assert.match(parsedMarkdown[0] || "", /适用条件：.*非BGA区域不允许/);
	assert.match(parsedMarkdown[0] || "", /1\. 离BGA和SMD区域5mm内不允许\n2\. 缺点大小1\.25mm以内/);
	assert.match(parsedMarkdown[0] || "", /检查方法：.*目视\/十倍镜/);
	assert.match(parsedMarkdown[0] || "", /### ★ 阻焊 · 绿油上PAD/);
	assert.match(parsedMarkdown[0] || "", /1\. 绿油不允许入插件孔\n2\. 上金手指或感光点表面不允许/);
	renderEvidenceMarkdown("普通说明 | 仅有两个字段", "说明.txt");
	assert.equal(parsedMarkdown[1], "普通说明 | 仅有两个字段");

	const formattedJson = renderEvidenceMarkdown('{"name":"DEF-001","rules":[1,2]}', "defect.json");
	assert.equal(formattedJson.className, "md-code");
	assert.match(formattedJson.children[1]?.children[0]?.textContent || "", /\n {2}"rules": \[/);
	const invalidJson = renderEvidenceMarkdown("{not valid json", "broken.json");
	assert.equal(invalidJson.className, "md-body");
	assert.equal(parsedMarkdown[2], "{not valid json");

	for (const title of ["rule.xml", "process.yaml", "process.yml", "service.log"]) {
		const rendered = renderEvidenceMarkdown("line one\nline two", title);
		assert.equal(rendered.className, "md-code");
		assert.equal(rendered.children[1]?.children[0]?.textContent, "line one\nline two");
	}
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
