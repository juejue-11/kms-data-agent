// 工作台视图只负责导航、欢迎区域和侧栏交互；请求与会话状态仍由原控制器维护。
(function installWorkspace(global) {
	class PcbWorkspace {
		constructor(handlers) {
			this.handlers = handlers;
			this.shell = document.getElementById("app-shell");
			this.sidebar = document.getElementById("sidebar");
			this.main = document.getElementById("workspace-main");
			this.chat = document.getElementById("chat-box");
			this.list = document.getElementById("session-list");
			this.collapseButton = document.getElementById("sidebar-collapse-btn");
			this.expandButton = document.getElementById("sidebar-expand-btn");
			this.backdrop = document.getElementById("sidebar-backdrop");
			this.narrowScreen = global.matchMedia("(max-width: 760px)");
			this.openMenu = null;
			this.list.addEventListener("scroll", () => this.closeMenu());
			this.collapsed = this.narrowScreen.matches;
			this.collapseButton.addEventListener("click", () => this.setCollapsed(!this.collapsed));
			this.expandButton.addEventListener("click", () => this.setCollapsed(false));
			this.backdrop.addEventListener("click", () => this.setCollapsed(true));
			this.narrowScreen.addEventListener("change", (event) => this.setCollapsed(event.matches));
			document.addEventListener("pointerdown", (event) => {
				if (this.openMenu && !this.openMenu.container.contains(event.target)) this.closeMenu();
			});
			document.addEventListener("keydown", (event) => {
				if (event.key !== "Escape") return;
				if (this.openMenu) this.closeMenu(true);
				else if (this.narrowScreen.matches && !this.collapsed) this.setCollapsed(true);
			});
			this.setCollapsed(this.collapsed, false);
		}

		setCollapsed(collapsed, moveFocus = true) {
			const sidebarHadFocus = this.sidebar.contains(document.activeElement);
			this.collapsed = collapsed;
			this.closeMenu();
			this.shell.classList.toggle("sidebar-collapsed", collapsed);
			this.shell.classList.toggle("sidebar-open", this.narrowScreen.matches && !collapsed);
			this.expandButton.hidden = !collapsed;
			this.backdrop.hidden = !this.narrowScreen.matches || collapsed;
			// 小屏关闭时隐藏导航焦点，打开时让背景工作区退出键盘导航。
			this.sidebar.inert = this.narrowScreen.matches && collapsed;
			this.main.inert = this.narrowScreen.matches && !collapsed;
			this.collapseButton.setAttribute("aria-expanded", String(!collapsed));
			this.collapseButton.setAttribute("aria-label", collapsed ? "展开会话导航" : "折叠会话导航");
			this.collapseButton.title = collapsed ? "展开会话导航" : "折叠会话导航";
			this.expandButton.setAttribute("aria-expanded", String(!collapsed));
			if (moveFocus && collapsed && sidebarHadFocus) this.expandButton.focus();
			else if (moveFocus && !collapsed) this.collapseButton.focus();
		}

		closeMenu(restoreFocus = false) {
			if (!this.openMenu) return;
			const { menu, toggle } = this.openMenu;
			menu.hidePopover();
			menu.hidden = true;
			toggle.setAttribute("aria-expanded", "false");
			this.openMenu = null;
			if (restoreFocus) toggle.focus();
		}

		showWelcome() {
			const welcome = document.getElementById("welcome-template").content.firstElementChild.cloneNode(true);
			for (const button of welcome.querySelectorAll("[data-question]")) {
				button.addEventListener("click", () => this.handlers.onExample(button.dataset.question));
			}
			this.chat.appendChild(welcome);
		}

		hideWelcome() {
			this.chat.querySelector(".welcome")?.remove();
		}

		renderSessions(sessions, selectedId, busy) {
			this.closeMenu();
			this.list.replaceChildren();
			if (!sessions.length) {
				const empty = document.createElement("p");
				empty.className = "session-empty";
				empty.textContent = "还没有对话记录\n开始一次新的质量排查吧";
				this.list.appendChild(empty);
				return;
			}
			// 按用户本地自然日分组，避免用固定 24 小时误判跨日和夏令时。
			const today = new Date();
			const yesterday = new Date(today);
			yesterday.setDate(today.getDate() - 1);
			const groups = new Map([
				["今天", []],
				["昨天", []],
				["更早", []],
			]);
			const ordered = [...sessions].sort(
				(a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0),
			);
			for (const session of ordered) {
				const day = new Date(session.updatedAt || session.createdAt).toDateString();
				const group = day === today.toDateString() ? "今天" : day === yesterday.toDateString() ? "昨天" : "更早";
				groups.get(group).push(session);
			}
			for (const [label, entries] of groups) {
				if (!entries.length) continue;
				const group = document.createElement("div");
				group.className = "session-group";
				group.setAttribute("role", "listitem");
				const heading = document.createElement("h3");
				heading.className = "session-group-heading";
				heading.textContent = label;
				group.appendChild(heading);
				for (const session of entries) group.appendChild(this.sessionItem(session, selectedId, busy, label));
				this.list.appendChild(group);
			}
		}

		sessionItem(session, selectedId, busy, group) {
			const titleText = this.handlers.sessionTitle(session);
			const item = document.createElement("div");
			item.className = `session-item${session.sessionId === selectedId ? " active" : ""}`;
			const select = document.createElement("button");
			select.type = "button";
			select.className = "session-item-main";
			select.title = titleText;
			select.setAttribute("aria-current", session.sessionId === selectedId ? "page" : "false");
			const title = document.createElement("span");
			title.className = "session-item-title";
			title.textContent = titleText;
			const meta = document.createElement("span");
			meta.className = "session-item-meta";
			const date = new Date(session.updatedAt || session.createdAt);
			meta.textContent = Number.isNaN(date.getTime())
				? "时间未知"
				: date.toLocaleString("zh-CN", {
						...(group === "更早" ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
						hour: "2-digit",
						minute: "2-digit",
						hour12: false,
					});
			select.appendChild(title);
			select.appendChild(meta);
			select.addEventListener("click", () => {
				this.closeMenu();
				if (this.narrowScreen.matches) this.setCollapsed(true);
				this.handlers.onSelect(session.sessionId);
			});
			item.appendChild(select);

			const actions = document.createElement("div");
			actions.className = "session-item-actions";
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "session-menu-toggle";
			toggle.textContent = "···";
			toggle.setAttribute("aria-label", `操作会话：${titleText}`);
			toggle.setAttribute("aria-haspopup", "menu");
			toggle.setAttribute("aria-expanded", "false");
			toggle.disabled = busy;
			const menu = document.createElement("div");
			menu.className = "session-menu";
			menu.setAttribute("popover", "manual");
			menu.setAttribute("role", "menu");
			menu.setAttribute("aria-label", `会话操作：${titleText}`);
			menu.hidden = true;
			const buttons = [];
			for (const [label, action] of [
				["重命名", this.handlers.onRename],
				["删除", this.handlers.onDelete],
			]) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = `session-action${label === "删除" ? " session-delete-action" : ""}`;
				button.textContent = label;
				button.setAttribute("role", "menuitem");
				button.disabled = busy;
				button.addEventListener("click", () => {
					this.closeMenu();
					action(session.sessionId);
				});
				buttons.push(button);
				menu.appendChild(button);
			}
			toggle.addEventListener("click", () => {
				const wasOpen = this.openMenu?.toggle === toggle;
				this.closeMenu();
				if (wasOpen) return;
				menu.hidden = false;
				// 使用浏览器顶层弹出层，避免菜单被可滚动会话列表裁切。
				menu.showPopover();
				const anchor = toggle.getBoundingClientRect();
				const menuHeight = menu.getBoundingClientRect().height;
				menu.style.left = `${anchor.right - menu.getBoundingClientRect().width}px`;
				menu.style.top = `${anchor.top > menuHeight + 12 ? anchor.top - menuHeight - 4 : anchor.bottom + 4}px`;
				toggle.setAttribute("aria-expanded", "true");
				this.openMenu = { menu, toggle, container: actions };
				buttons[0].focus();
			});
			menu.addEventListener("keydown", (event) => {
				if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return;
				if (event.key === "Tab") {
					this.closeMenu(true);
					return;
				}
				event.preventDefault();
				const index = buttons.indexOf(document.activeElement);
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? 1
							: (index + (event.key === "ArrowDown" ? 1 : -1) + 2) % 2;
				buttons[next].focus();
			});
			actions.appendChild(toggle);
			actions.appendChild(menu);
			item.appendChild(actions);
			return item;
		}

		updateKnowledge(event) {
			const payload = event?.payload || {};
			const backend = String(payload.backend || "").toLowerCase();
			if (payload.toolName !== "search_knowledge_base" && !/knowledge|kb|ragflow/.test(backend)) return;
			const node = document.getElementById("knowledge-status");
			const label = document.getElementById("knowledge-status-text");
			// 当前没有独立健康接口，只根据真实知识库检索事件报告状态。
			if (event.type === "tool_started") {
				node.dataset.state = "checking";
				label.textContent = "知识库 · 检索中";
			} else if (event.type === "tool_completed") {
				const failed = payload.isError || payload.status === "failed";
				const degraded = payload.status === "degraded" || payload.warningCode;
				node.dataset.state = failed ? "offline" : degraded ? "degraded" : "connected";
				label.textContent = failed ? "知识库 · 检索失败" : degraded ? "知识库 · 服务降级" : "知识库 · 检索正常";
			}
		}
	}
	global.PcbWorkspace = PcbWorkspace;
})(window);
