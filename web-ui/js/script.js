const sendBtn = document.getElementById("send-btn");
const userInput = document.getElementById("user-input");
const chatBox = document.getElementById("chat-box");

async function sendMessage() {
	const text = userInput.value.trim();
	if (!text) return;

	addMessage(text, "user-message");
	userInput.value = "";
	userInput.style.height = "auto";
	userInput.focus();
	setSending(true);

	const typing = addTyping();

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: text }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();

		typing.remove();
		addMessage(data.reply || "抱歉，AI 没有返回内容。", "ai-message", data.sources || []);
	} catch (error) {
		console.error("请求失败:", error);
		typing.remove();
		addMessage(
			"抱歉，连接服务器失败。请确认后端已启动（在项目目录执行 node --env-file=.env server.js）。",
			"ai-message",
		);
	} finally {
		setSending(false);
	}
}

function setSending(sending) {
	sendBtn.disabled = sending;
	sendBtn.textContent = sending ? "思考中…" : "发送";
}

// 去掉出处摘要里的 Markdown 标记（# 标题、**加粗** 等），摘要按纯文本显示
function stripMarkdown(text) {
	return text
		.replace(/^\s*#+\s*/gm, "") // 行首 # 标题
		.replace(/\*\*([^*]+)\*\*/g, "$1") // **加粗**
		.replace(/\*([^*]+)\*/g, "$1") // *斜体*
		.replace(/`([^`]+)`/g, "$1") // `代码`
		.replace(/^>\s?/gm, "") // > 引用
		.trim();
}

function addMessage(text, className, sources = []) {
	const wrap = document.createElement("div");
	wrap.className = `message ${className}`;

	const avatar = document.createElement("div");
	avatar.className = `avatar ${className === "ai-message" ? "ai" : "user"}`;
	avatar.textContent = className === "ai-message" ? "助" : "我";
	wrap.appendChild(avatar);

	const bubble = document.createElement("div");
	bubble.className = "bubble";

	const txt = document.createElement("div");
	txt.className = "msg-text";
	if (className === "ai-message") {
		txt.classList.add("markdown");
		txt.appendChild(renderMarkdown(text));
	} else {
		txt.textContent = text;
	}
	bubble.appendChild(txt);

	if (sources.length) {
		const box = document.createElement("div");
		box.className = "sources";

		const head = document.createElement("div");
		head.className = "sources-head";
		head.textContent = "出处";
		box.appendChild(head);

		for (const s of sources) {
			const item = document.createElement("div");
			item.className = "source-item";

			const badge = document.createElement("span");
			badge.className = `badge ${s.type === "知识库" ? "kb" : "web"}`;
			badge.textContent = s.type === "知识库" ? "知识库" : "网络";

			const name = document.createElement("span");
			name.className = "src-name";
			name.textContent = s.source;

			item.appendChild(badge);
			item.appendChild(name);

			if (s.text) {
				const snippet = document.createElement("div");
				snippet.className = "src-text";
				snippet.textContent = stripMarkdown(s.text.slice(0, 100));
				item.appendChild(snippet);
			}
			box.appendChild(item);
		}
		bubble.appendChild(box);
	}

	wrap.appendChild(bubble);
	chatBox.appendChild(wrap);
	chatBox.scrollTop = chatBox.scrollHeight;
	return wrap;
}

function addTyping() {
	const wrap = document.createElement("div");
	wrap.className = "message ai-message";
	wrap.innerHTML =
		'<div class="avatar ai">助</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
	chatBox.appendChild(wrap);
	chatBox.scrollTop = chatBox.scrollHeight;
	return wrap;
}

// 发送按钮
sendBtn.addEventListener("click", sendMessage);

// 输入框：Enter 发送，Shift+Enter 换行
userInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// 输入框自适应高度
userInput.addEventListener("input", () => {
	userInput.style.height = "auto";
	userInput.style.height = `${Math.min(userInput.scrollHeight, 132)}px`;
});
