// PCB 会话页面控制器：维护会话列表、消息 DOM 与当前请求，并把断流恢复限制在原会话视图内。
const api = new window.PcbApi();
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const userInput = document.getElementById("user-input");
const chatBox = document.getElementById("chat-box");
const newSessionBtn = document.getElementById("new-session-btn");
const refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
const sessionTitle = document.getElementById("session-title");
const runStatus = document.getElementById("run-status");
const connectionDot = document.getElementById("connection-dot");
const connectionTitle = document.getElementById("connection-title");
const connectionDesc = document.getElementById("connection-desc");
const deleteDialog = document.getElementById("session-delete-dialog");
const deleteDialogMessage = document.getElementById("session-delete-message");
const deleteCancelBtn = document.getElementById("session-delete-cancel");
const deleteConfirmBtn = document.getElementById("session-delete-confirm");
const renameDialog = document.getElementById("session-rename-dialog");
const renameForm = document.getElementById("session-rename-form");
const renameInput = document.getElementById("session-rename-input");
const renameError = document.getElementById("session-rename-error");
const renameCancelBtn = document.getElementById("session-rename-cancel");
const renameSaveBtn = document.getElementById("session-rename-save");

const SELECTED_SESSION_KEY = "pcb.selectedSessionId";
const NEW_SESSION_TITLE = "新会话";
const MAX_SESSION_TITLE_LENGTH = 100;

const state = {
	sessionId: null,
	sessions: [],
	viewGeneration: 0,
	activeRequest: null,
	loadingSession: false,
	creatingSession: false,
	deletingSessionId: null,
	renamingSessionId: null,
	pendingRenameSessionId: null,
	pendingDeleteSessionId: null,
	sessionListGeneration: 0,
	sessionListVersion: 0,
};

const RECONCILE_DELAY_MS = 1500;

const workspace = new window.PcbWorkspace({
	onSelect: (sessionId) => void selectSession(sessionId),
	onRename: requestRenameSession,
	onDelete: requestDeleteSession,
	sessionTitle: sessionDisplayTitle,
	onExample: (question) => {
		// 示例与普通输入共用同一发送路径；繁忙时保留用户草稿。
		if (state.activeRequest || state.loadingSession || state.creatingSession || state.deletingSessionId) return;
		userInput.value = question;
		void sendMessage();
	},
});

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value) {
	return isRecord(value) ? value : {};
}

function safeStorageGet(key) {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeStorageSet(key, value) {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// 隐私浏览可能禁用本地存储；服务端会话仍是最终状态来源。
	}
}

function safeStorageRemove(key) {
	try {
		window.localStorage.removeItem(key);
	} catch {
		// 隐私浏览可能禁用本地存储；清除失败不会影响当前页面状态。
	}
}

function normalizeSessionTitle(value) {
	return String(value ?? "").trim();
}

function sessionDisplayTitle(session) {
	const title = normalizeSessionTitle(session?.title);
	return title || NEW_SESSION_TITLE;
}

function makeRequestId() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	const bytes = new Uint8Array(16);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
	else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function setConnection(connected, description = "") {
	connectionDot.dataset.state = connected ? "connected" : "offline";
	connectionTitle.textContent = connected ? "服务已连接" : "服务不可达";
	connectionDesc.textContent = description || (connected ? "会话数据已同步" : "请确认后端已启动");
}

function setRunStatus(text = "", isError = false) {
	runStatus.textContent = text;
	runStatus.classList.toggle("error", isError);
}

function setSending(sending) {
	sendBtn.disabled = sending;
	userInput.disabled = sending;
	stopBtn.hidden = !sending;
	stopBtn.disabled = Boolean(state.activeRequest?.cancelling);
	sendBtn.dataset.sending = String(sending);
	sendBtn.setAttribute("aria-label", sending ? "正在生成回答" : "发送消息");
	chatBox.setAttribute("aria-busy", String(sending));
}

function currentRequest(request) {
	// 会话切换会递增 generation；三重校验会丢弃旧请求迟到的事件、响应和定时器回调。
	return (
		state.activeRequest === request &&
		request.generation === state.viewGeneration &&
		request.sessionId === state.sessionId
	);
}

function clearChat() {
	chatBox.replaceChildren();
}

function addWelcome() {
	workspace.showWelcome();
}

function messageContent(message) {
	if (typeof message === "string") return message;
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part) => isRecord(part) && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

function sourceKind(source) {
	const sourceType = String(source?.sourceType || source?.type || "").toLowerCase();
	if (sourceType.includes("knowledge") || sourceType === "kb" || sourceType === "知识库") return "kb";
	if (sourceType.includes("local") || sourceType === "本地") return "local";
	if (sourceType.includes("web") || sourceType === "网络") return "web";
	return "unknown";
}

function sourceKindLabel(source) {
	const labels = { kb: "知识库", local: "本地降级", web: "网络", unknown: "来源" };
	return labels[sourceKind(source)];
}

function sourceTitle(source) {
	return source?.title || source?.source || source?.url || "未命名来源";
}

function stripMarkdown(text) {
	return String(text || "")
		.replace(/^\s*#+\s*/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^>\s?/gm, "")
		.trim();
}

function appendSources(bubble, sources, citationValidation) {
	bubble.querySelector(".sources")?.remove();
	const validSources = Array.isArray(sources) ? sources : [];
	const validation = asObject(citationValidation);
	if (!validSources.length && validation.status !== "invalid") return;

	const box = document.createElement("div");
	box.className = "sources";
	const head = document.createElement("div");
	head.className = "sources-head";
	head.textContent = validation.status === "invalid" ? "出处（引用校验有问题）" : "出处";
	box.appendChild(head);

	for (const source of validSources) {
		const item = document.createElement("div");
		item.className = "source-item";
		const badge = document.createElement("span");
		const kind = sourceKind(source);
		badge.className = `badge ${kind}`;
		badge.textContent = sourceKindLabel(source);
		item.appendChild(badge);

		const name = document.createElement("span");
		name.className = "src-name";
		name.textContent = sourceTitle(source);
		item.appendChild(name);
		if (source.evidenceId) {
			const evidenceId = document.createElement("span");
			evidenceId.className = "src-id";
			evidenceId.textContent = ` [E:${source.evidenceId}]`;
			item.appendChild(evidenceId);
		}
		if (source.page !== undefined && source.page !== null) {
			const page = document.createElement("span");
			page.className = "src-location";
			page.textContent = ` · 第 ${source.page} 页`;
			item.appendChild(page);
		}
		if (source.url && /^https?:\/\//i.test(String(source.url))) {
			const link = document.createElement("a");
			link.className = "src-link";
			link.href = String(source.url);
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.textContent = "打开来源";
			item.appendChild(link);
		}
		if (source.text) {
			const snippet = document.createElement("div");
			snippet.className = "src-text";
			snippet.textContent = stripMarkdown(String(source.text).slice(0, 160));
			item.appendChild(snippet);
		}
		box.appendChild(item);
	}

	if (validation.status === "invalid") {
		const invalidIds = Array.isArray(validation.invalidIds) ? validation.invalidIds : [];
		const warning = document.createElement("div");
		warning.className = "citation-warning";
		warning.textContent = invalidIds.length ? `无法定位引用：${invalidIds.join(", ")}` : "部分引用无法定位";
		box.appendChild(warning);
	}
	bubble.appendChild(box);
}

function setMessageStatus(message, status) {
	const normalized = String(status || "").toLowerCase();
	const existing = message.bubble.querySelector(".message-status");
	if (!normalized || normalized === "succeeded") {
		existing?.remove();
		return;
	}
	const statusNode = existing || document.createElement("div");
	statusNode.className = "message-status";
	statusNode.textContent = `\u672a\u5b8c\u6210: ${status}`;
	if (!existing) message.bubble.appendChild(statusNode);
}

function addMessage(text, className, sources = [], options = {}) {
	workspace.hideWelcome();
	const wrap = document.createElement("div");
	wrap.className = `message ${className}`;
	if (options.entryId) wrap.dataset.entryId = options.entryId;
	if (options.requestId) wrap.dataset.requestId = options.requestId;
	if (options.status) wrap.dataset.status = options.status;

	const avatar = document.createElement("div");
	avatar.className = `avatar ${className === "ai-message" ? "ai" : "user"}`;
	if (className === "ai-message") {
		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		icon.setAttribute("viewBox", "0 0 32 32");
		icon.setAttribute("aria-hidden", "true");
		const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
		use.setAttribute("href", "#pcb-mark");
		icon.appendChild(use);
		avatar.appendChild(icon);
	} else avatar.textContent = "我";
	wrap.appendChild(avatar);

	const bubble = document.createElement("div");
	bubble.className = "bubble";
	const textNode = document.createElement("div");
	textNode.className = "msg-text";
	if (className === "ai-message") {
		textNode.classList.add("markdown");
		textNode.appendChild(renderMarkdown(text));
	} else {
		textNode.textContent = text;
	}
	bubble.appendChild(textNode);
	if (options.status && options.status !== "succeeded") {
		const status = document.createElement("div");
		status.className = "message-status";
		status.textContent = `\u672a\u5b8c\u6210: ${options.status}`;
		bubble.appendChild(status);
	}
	wrap.appendChild(bubble);
	if (className === "ai-message") appendSources(bubble, sources, options.citationValidation);
	chatBox.appendChild(wrap);
	chatBox.scrollTop = chatBox.scrollHeight;
	return { wrap, bubble, textNode };
}

function updateAssistant(message, text, { sources, citationValidation, status } = {}) {
	message.textNode.replaceChildren(renderMarkdown(text || ""));
	if (status) message.wrap.dataset.status = status;
	setMessageStatus(message, status);
	appendSources(message.bubble, sources, citationValidation);
	chatBox.scrollTop = chatBox.scrollHeight;
}

function renderHistory(messages) {
	clearChat();
	if (!Array.isArray(messages) || !messages.length) {
		addWelcome();
		return;
	}
	for (const message of messages) {
		const role = String(message.role || "").toLowerCase();
		const className = role === "user" ? "user-message" : "ai-message";
		const content = messageContent(message);
		const displayContent = content || (message.status ? `请求状态：${message.status}` : "");
		if (!displayContent) continue;
		addMessage(displayContent, className, message.sources || [], {
			entryId: message.entryId,
			requestId: message.requestId,
			citationValidation: message.citationValidation,
			status: message.status,
		});
	}
	if (!chatBox.children.length) addWelcome();
	chatBox.scrollTop = chatBox.scrollHeight;
}

function terminalResult(value) {
	const object = asObject(value);
	const candidate = isRecord(object.final) ? object.final : isRecord(object.result) ? object.result : object;
	if (isTerminal(candidate)) return candidate;
	return null;
}

function isTerminal(value) {
	const status = String(asObject(value).status || "").toLowerCase();
	return ["succeeded", "failed", "cancelled", "canceled", "interrupted", "timeout"].includes(status);
}

function renderFinal(request, final) {
	const result = terminalResult(final) || asObject(final);
	const reply = typeof result.reply === "string" ? result.reply : typeof result.text === "string" ? result.text : "";
	const status = String(result.status || "");
	const fallback = result.errorCode
		? `请求状态：${status || "failed"}\n错误：${result.errorCode}`
		: status
			? `请求状态：${status}`
			: "服务未返回回答。";
	updateAssistant(request.assistant, reply || fallback, {
		sources: result.sources,
		citationValidation: result.citationValidation,
		status,
	});
	if (status === "succeeded") setRunStatus("已完成");
	else if (status) setRunStatus(`请求状态：${status}`, status !== "cancelled" && status !== "canceled");
	else setRunStatus("");
}

function setActiveRequest(request) {
	state.activeRequest = request;
	setSending(Boolean(request));
}

function clearReconcileTimer(request) {
	if (!request?.reconcileTimer) return;
	clearTimeout(request.reconcileTimer);
	request.reconcileTimer = null;
}

function scheduleReconcile(request) {
	if (!currentRequest(request)) return;
	clearReconcileTimer(request);
	request.reconcileTimer = setTimeout(() => {
		request.reconcileTimer = null;
		void reconcileRequest(request);
	}, RECONCILE_DELAY_MS);
}

function finishRequest(request, final) {
	if (!currentRequest(request)) return;
	clearReconcileTimer(request);
	renderFinal(request, final);
	state.activeRequest = null;
	setSending(false);
	void refreshSessions({ preserveSelection: true });
}

async function reconcileRequest(request) {
	// SSE 中断或切回页面后只查询原 requestId；终态到达前按延迟轮询，避免重复提交。
	if (!currentRequest(request)) return;
	try {
		const stateResponse = await api.getRequest(request.sessionId, request.requestId);
		if (!currentRequest(request)) return;
		const final = terminalResult(stateResponse);
		if (final || isTerminal(stateResponse)) {
			finishRequest(request, final || stateResponse);
			return;
		}
		request.connectionLost = true;
		setRunStatus("请求仍在服务端运行，可停止或稍后刷新状态");
		setSending(true);
		scheduleReconcile(request);
	} catch (error) {
		if (!currentRequest(request)) return;
		request.connectionLost = true;
		setRunStatus(error.message || "无法查询请求状态", true);
		if (error?.status) {
			finishRequest(request, { status: "failed", reply: error.message, errorCode: error.code, sources: [] });
			return;
		}
		setSending(true);
		scheduleReconcile(request);
	}
}

function eventStatus(event) {
	const type = String(event?.type || "");
	const payload = asObject(event?.payload);
	const backend = String(payload.backend || payload.toolName || "").toLowerCase();
	const isLocal = backend.includes("local") || backend.includes("\u672c\u5730");
	const isKnowledge = backend.includes("knowledge") || backend.includes("kb") || backend === "ragflow";
	const isWeb =
		backend.includes("web") || backend.includes("network") || backend === "tavily" || backend === "duckduckgo";
	if (type === "tool_completed") {
		const status = String(payload.status || "").toLowerCase();
		if (payload.isError || status === "failed") return "检索服务失败";
		if (status === "no_results") return "检索正常，未找到结果";
		if (status === "degraded" || payload.warningCode) return isLocal ? "已使用本地降级资料" : "检索服务降级";
		if (isWeb) return "联网检索完成";
		if (isKnowledge) return "知识库检索完成";
		if (isLocal) return "本地检索完成";
		return "资料查询完成";
	}
	if (type === "tool_started") {
		if (isWeb) return "正在联网检索";
		if (isKnowledge) return "正在检索知识库";
		if (isLocal) return "正在检索本地资料";
		return "正在查询资料";
	}
	if (type === "context_compacting") return "正在整理上下文";
	if (type === "context_compacted") {
		const status = String(payload.status || "succeeded").toLowerCase();
		if (status === "failed") return "上下文整理失败，历史已保留";
		if (["cancelled", "canceled", "interrupted"].includes(status)) return "上下文整理已中断";
		return "上下文整理完成";
	}
	if (type === "retrying" || type === "summarization_retrying") {
		if (payload.success === true) return "重试完成";
		if (payload.success === false) return "重试失败";
		return payload.attempt ? `正在重试（第 ${payload.attempt} 次）` : "正在重试模型请求";
	}
	if (type === "request_started") return "请求已开始";
	return "";
}

function refreshSessionTitleAfterAcceptedRequest(request) {
	if (request.sessionTitleRefreshStarted) return;
	request.sessionTitleRefreshStarted = true;
	void refreshSessions({ preserveSelection: true });
}

async function sendMessage() {
	// 一个页面请求从生成 requestId 到终态渲染都绑定同一 generation，保证切换会话后旧流不能污染新页面。
	const text = userInput.value.trim();
	if (
		!text ||
		state.activeRequest ||
		state.loadingSession ||
		state.creatingSession ||
		(state.deletingSessionId && state.deletingSessionId === state.sessionId)
	)
		return;
	let sessionId = state.sessionId;
	if (!sessionId) {
		try {
			await createSession();
			sessionId = state.sessionId;
			if (!sessionId) throw new Error("Session creation returned no session ID");
		} catch (error) {
			setConnection(false, error.message);
			setRunStatus(error.message || "Unable to create a session", true);
			return;
		}
	}

	const generation = state.viewGeneration;
	const requestId = makeRequestId();
	addMessage(text, "user-message", [], { requestId });
	const assistant = addMessage("", "ai-message", [], { requestId });
	const request = {
		sessionId,
		requestId,
		generation,
		assistant,
		streamedText: "",
		completedText: "",
		controller: new AbortController(),
		cancelling: false,
		connectionLost: false,
	};
	setActiveRequest(request);
	userInput.value = "";
	userInput.style.height = "auto";
	setRunStatus("正在请求模型…");
	try {
		const result = await api.sendMessage(sessionId, {
			requestId,
			message: text,
			signal: request.controller.signal,
			onEvent: (event) => {
				if (!currentRequest(request)) return;
				workspace.updateKnowledge(event);
				if (["request_started", "message_delta", "message_completed", "request_finished"].includes(event?.type))
					refreshSessionTitleAfterAcceptedRequest(request);
				const status = eventStatus(event);
				if (status) setRunStatus(status);
				if (event?.type === "message_delta") {
					const delta = typeof asObject(event.payload).delta === "string" ? event.payload.delta : "";
					request.streamedText += delta;
					updateAssistant(request.assistant, request.streamedText);
				} else if (event?.type === "message_completed") {
					const payload = asObject(event.payload);
					const completed = typeof payload.text === "string" ? payload.text : messageContent(payload);
					if (completed) {
						request.completedText = completed;
						updateAssistant(request.assistant, completed);
					}
					request.streamedText = "";
				} else if (event?.type === "request_finished") {
					const final = window.PcbApi.eventFinalResult(event);
					if (final) finishRequest(request, final);
				}
			},
		});
		if (!currentRequest(request)) return;
		if (result.kind === "status") {
			refreshSessionTitleAfterAcceptedRequest(request);
			setRunStatus("请求已在服务端运行，未重复提交");
			await reconcileRequest(request);
			return;
		}
		if (result.final) {
			refreshSessionTitleAfterAcceptedRequest(request);
			finishRequest(request, result.final);
			return;
		}
		refreshSessionTitleAfterAcceptedRequest(request);
		await reconcileRequest(request);
	} catch (error) {
		if (!currentRequest(request)) return;
		if (error?.name === "AbortError") return;
		if (error?.status && error.status < 500) {
			finishRequest(request, { status: "failed", reply: error.message, errorCode: error.code, sources: [] });
			return;
		}
		setRunStatus("连接中断，正在查询请求状态…", true);
		await reconcileRequest(request);
	}
}

deleteCancelBtn.addEventListener("click", cancelDeleteSession);
deleteConfirmBtn.addEventListener("click", () => {
	void confirmDeleteSession();
});
deleteDialog.addEventListener("cancel", (event) => {
	// 删除确认只能通过按钮关闭，点击原生遮罩不会触发关闭。
	event.preventDefault();
});
renameForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void renameSession(state.pendingRenameSessionId, renameInput.value);
});
renameCancelBtn.addEventListener("click", () => {
	state.pendingRenameSessionId = null;
	renameDialog.close();
});
renameDialog.addEventListener("cancel", (event) => {
	// 保存进行中不能退出，以免取消按钮造成“改名已撤回”的误解。
	if (state.renamingSessionId) event.preventDefault();
	else state.pendingRenameSessionId = null;
});

async function stopMessage() {
	const request = state.activeRequest;
	if (!request || request.cancelling) return;
	request.cancelling = true;
	setSending(true);
	setRunStatus("正在停止请求…");
	try {
		const response = await api.cancelRequest(request.sessionId, request.requestId);
		if (!currentRequest(request)) return;
		const final = terminalResult(response);
		if (final || isTerminal(response)) finishRequest(request, final || response);
		else {
			request.cancelling = false;
			setSending(true);
			scheduleReconcile(request);
			setRunStatus("已发送停止请求，等待服务端确认");
		}
	} catch (error) {
		if (!currentRequest(request)) return;
		request.cancelling = false;
		setSending(true);
		setRunStatus(error.message || "停止请求失败", true);
	}
}

function renderSessionList() {
	workspace.renderSessions(
		state.sessions,
		state.sessionId,
		Boolean(state.deletingSessionId || state.renamingSessionId),
	);
}
function invalidateActiveRequest() {
	const previous = state.activeRequest;
	if (previous) {
		clearReconcileTimer(previous);
		previous.controller.abort();
	}
	state.activeRequest = null;
	setSending(false);
}

function showEmptySession() {
	// 删除最后一个会话或首次打开空列表时只准备空白页面，发送消息前再创建后端会话。
	state.viewGeneration += 1;
	invalidateActiveRequest();
	state.sessionId = null;
	safeStorageRemove(SELECTED_SESSION_KEY);
	sessionTitle.textContent = NEW_SESSION_TITLE;
	setRunStatus("");
	clearChat();
	addWelcome();
	renderSessionList();
}

async function refreshSessions({ preserveSelection = false } = {}) {
	const generation = ++state.sessionListGeneration;
	const version = state.sessionListVersion;
	state.loadingSession = true;
	try {
		const response = await api.listSessions({ limit: 100 });
		if (generation !== state.sessionListGeneration || version !== state.sessionListVersion) return false;
		state.sessions = Array.isArray(response.sessions) ? response.sessions : [];
		setConnection(true, `${state.sessions.length} 个会话`);
		renderSessionList();
		const current = state.sessions.find((session) => session.sessionId === state.sessionId);
		if (current) sessionTitle.textContent = sessionDisplayTitle(current);
		if (preserveSelection) return true;
		const stored = safeStorageGet(SELECTED_SESSION_KEY);
		const selected = state.sessions.find((session) => session.sessionId === stored) || state.sessions[0];
		if (selected) await selectSession(selected.sessionId);
		else showEmptySession();
		return true;
	} catch (error) {
		if (generation !== state.sessionListGeneration) return false;
		setConnection(false, error.message || "无法加载会话列表");
		setRunStatus("服务不可达，请确认后端已启动", true);
		return false;
	} finally {
		if (generation === state.sessionListGeneration && !state.creatingSession) state.loadingSession = false;
	}
}

async function createSession() {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.loadingSession = true;
	try {
		state.viewGeneration += 1;
		invalidateActiveRequest();
		const created = await api.createSession();
		if (!created.sessionId) throw new Error("服务未返回会话 ID");
		state.sessionId = created.sessionId;
		safeStorageSet(SELECTED_SESSION_KEY, state.sessionId);
		sessionTitle.textContent = sessionDisplayTitle(created);
		setRunStatus("");
		clearChat();
		addWelcome();
		await refreshSessions({ preserveSelection: true });
	} finally {
		state.creatingSession = false;
		state.loadingSession = false;
	}
}

async function selectSession(sessionId) {
	if (!sessionId) return;
	// 先使旧视图失效并中止其控制器，再加载新会话；旧请求即使随后回调也会被 currentRequest 拦截。
	const generation = state.viewGeneration + 1;
	state.viewGeneration = generation;
	invalidateActiveRequest();
	state.sessionId = sessionId;
	safeStorageSet(SELECTED_SESSION_KEY, sessionId);
	state.loadingSession = true;
	const sessionListVersion = state.sessionListVersion;
	const isCurrentView = () => state.sessionId === sessionId && state.viewGeneration === generation;
	renderSessionList();
	clearChat();
	setRunStatus("正在恢复会话…");
	try {
		const [session, history] = await Promise.all([
			api.getSession(sessionId),
			api.getMessages(sessionId, { limit: 100 }),
		]);
		if (!isCurrentView()) return;
		const latestSession = state.sessions.find((item) => item.sessionId === sessionId);
		sessionTitle.textContent =
			state.sessionListVersion !== sessionListVersion && latestSession
				? sessionDisplayTitle(latestSession)
				: sessionDisplayTitle(session);
		renderHistory(history.messages);
		setConnection(true, "会话已恢复");
		const activeRequestId = session.activeRequestId;
		if (activeRequestId) {
			const request = {
				sessionId,
				requestId: activeRequestId,
				generation,
				assistant: addMessage("", "ai-message", [], { requestId: activeRequestId }),
				streamedText: "",
				completedText: "",
				controller: new AbortController(),
				cancelling: false,
				connectionLost: true,
			};
			state.activeRequest = request;
			setSending(true);
			setRunStatus("会话中有运行中的请求，正在查询状态…");
			await reconcileRequest(request);
		} else setRunStatus("");
		renderSessionList();
	} catch (error) {
		if (!isCurrentView()) return;
		setConnection(false, error.message || "无法恢复会话");
		setRunStatus(error.message || "无法恢复会话", true);
		clearChat();
		addMessage("无法恢复此会话，请刷新列表后重试。", "ai-message");
	} finally {
		if (isCurrentView()) state.loadingSession = false;
	}
}

function requestRenameSession(sessionId) {
	const session = state.sessions.find((item) => item.sessionId === sessionId);
	if (!session || state.renamingSessionId || state.deletingSessionId) return;
	state.pendingRenameSessionId = sessionId;
	renameInput.value = sessionDisplayTitle(session);
	renameError.textContent = "";
	renameDialog.showModal();
}

async function renameSession(sessionId, requestedTitle) {
	const session = state.sessions.find((item) => item.sessionId === sessionId);
	if (!session || state.renamingSessionId || state.deletingSessionId) return false;
	const title = normalizeSessionTitle(requestedTitle);
	if (!title) {
		renameError.textContent = "会话标题不能为空";
		setRunStatus("会话标题不能为空", true);
		return false;
	}
	if (Array.from(title).length > MAX_SESSION_TITLE_LENGTH) {
		renameError.textContent = `会话标题不能超过${MAX_SESSION_TITLE_LENGTH}个字符`;
		setRunStatus(`会话标题不能超过${MAX_SESSION_TITLE_LENGTH}个字符`, true);
		return false;
	}
	state.renamingSessionId = sessionId;
	renameError.textContent = "";
	renameSaveBtn.disabled = true;
	renameCancelBtn.disabled = true;
	state.sessionListVersion += 1;
	renderSessionList();
	try {
		const updated = await api.renameSession(sessionId, title);
		state.sessionListVersion += 1;
		const updatedTitle = normalizeSessionTitle(updated.title) || title;
		state.sessions = state.sessions.map((item) =>
			item.sessionId === sessionId ? { ...item, ...updated, sessionId, title: updatedTitle } : item,
		);
		if (state.sessionId === sessionId) sessionTitle.textContent = updatedTitle;
		if (state.pendingRenameSessionId === sessionId) {
			state.pendingRenameSessionId = null;
			renameDialog.close();
		}
		renderSessionList();
		setRunStatus("");
		return true;
	} catch (error) {
		renameError.textContent = error.message || "会话重命名失败";
		setRunStatus(error.message || "会话重命名失败", true);
		return false;
	} finally {
		if (state.renamingSessionId === sessionId) state.renamingSessionId = null;
		renameSaveBtn.disabled = false;
		renameCancelBtn.disabled = false;
		renderSessionList();
	}
}

function closeDeleteDialog() {
	state.pendingDeleteSessionId = null;
	if (deleteDialog.open) deleteDialog.close();
}

function requestDeleteSession(sessionId) {
	const session = state.sessions.find((item) => item.sessionId === sessionId);
	if (!session || state.deletingSessionId || state.renamingSessionId) return false;
	state.pendingDeleteSessionId = sessionId;
	deleteDialogMessage.textContent = `删除“${sessionDisplayTitle(session)}”及其关联消息后不可恢复。`;
	deleteDialog.showModal();
	return true;
}

function cancelDeleteSession() {
	closeDeleteDialog();
}

async function confirmDeleteSession() {
	const sessionId = state.pendingDeleteSessionId;
	if (!sessionId || state.deletingSessionId) return false;
	closeDeleteDialog();
	return deleteSession(sessionId);
}

async function deleteSession(sessionId) {
	if (!sessionId || state.deletingSessionId) return false;
	const wasCurrent = state.sessionId === sessionId;
	if (wasCurrent) {
		// 删除接口会等待并取消服务端请求；这里先停止本地流，避免删除后的迟到事件写回页面。
		state.viewGeneration += 1;
		invalidateActiveRequest();
		state.loadingSession = false;
	}
	state.deletingSessionId = sessionId;
	state.sessionListVersion += 1;
	renderSessionList();
	setRunStatus("正在删除会话…");
	try {
		await api.deleteSession(sessionId);
		state.sessionListVersion += 1;
		state.sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
		const shouldNavigate = state.sessionId === sessionId;
		if (shouldNavigate) {
			state.sessionId = null;
			safeStorageRemove(SELECTED_SESSION_KEY);
		}
		renderSessionList();
		await refreshSessions({ preserveSelection: true });
		if (shouldNavigate && state.sessionId === null) {
			const next = state.sessions[0];
			if (next) await selectSession(next.sessionId);
			else showEmptySession();
		}
		if (!state.activeRequest) setRunStatus("");
		return true;
	} catch (error) {
		const message = error.message || "会话删除失败，可重试";
		const shouldRestore = wasCurrent && state.sessionId === sessionId;
		if (shouldRestore) {
			await selectSession(sessionId);
			if (state.sessionId === sessionId) setRunStatus(message, true);
		} else setRunStatus(message, true);
		renderSessionList();
		return false;
	} finally {
		if (state.deletingSessionId === sessionId) state.deletingSessionId = null;
		renderSessionList();
	}
}

newSessionBtn.addEventListener("click", () => {
	if (workspace.narrowScreen.matches) workspace.setCollapsed(true);
	void createSession().catch((error) => {
		setConnection(false, error.message);
		setRunStatus(error.message || "创建会话失败", true);
	});
});
refreshSessionsBtn.addEventListener("click", () => {
	void refreshSessions({ preserveSelection: false });
});
sendBtn.addEventListener("click", () => void sendMessage());
stopBtn.addEventListener("click", () => void stopMessage());

userInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		void sendMessage();
	}
});

userInput.addEventListener("input", () => {
	userInput.style.height = "auto";
	userInput.style.height = `${Math.min(userInput.scrollHeight, 160)}px`;
});

window.PcbClientController = Object.freeze({
	state,
	refreshSessions,
	selectSession,
	createSession,
	requestRenameSession,
	renameSession,
	requestDeleteSession,
	cancelDeleteSession,
	confirmDeleteSession,
	sendMessage,
	stopMessage,
	parseSourceKind: sourceKind,
	formatEventStatus: eventStatus,
	makeRequestId,
});

addWelcome();
void refreshSessions();
