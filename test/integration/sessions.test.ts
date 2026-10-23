// 会话端到端验收：复用真实 Pi 持久化和运行时，以假模型验证恢复、并发、取消、压缩及 HTTP。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { AgentService, type Submission } from "../../app/agent/agent-service.ts";
import { PcbHttpClient } from "../../app/cli/http-client.ts";
import { loadConfig } from "../../app/config.ts";
import { createHttpServer } from "../../app/http/app.ts";
import { runtimeFromModel } from "../../app/runtime/pi-runtime.ts";
import { acquireDataLock } from "../../app/sessions/data-lock.ts";
import { type Settings, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.ts";

async function setup(settings: Partial<Settings> = {}, harnessOptions: Parameters<typeof createHarness>[0] = {}) {
	// 每例独占临时数据目录；缩小保留上下文便于受控触发压缩，不依赖真实模型。
	const root = mkdtempSync(join(tmpdir(), "pcb-integration-"));
	const harness = await createHarness(harnessOptions);
	const config = loadConfig({
		PCB_DATA_DIR: root,
		PCB_WORKSPACE_DIR: join(root, "workspace"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PCB_SESSION_IDLE_TTL_MS: "1",
		PCB_REQUEST_TIMEOUT_MS: "5000",
	});
	const create = () =>
		new AgentService({
			config,
			runtime: runtimeFromModel(config, harness.session.modelRuntime, () =>
				SettingsManager.inMemory({
					defaultProvider: harness.getModel().provider,
					defaultModel: harness.getModel().id,
					retry: { enabled: false },
					cacheWarming: "off",
					compaction: { keepRecentTokens: 5, reserveTokens: 256 },
					...settings,
				}),
			),
			tools: () => ({ extensions: [], toolNames: [] }),
			validate: () => ({ sources: [], citationValidation: { status: "not_applicable", invalidIds: [] } }),
		});
	const service = create();
	return {
		root,
		harness,
		config,
		service,
		create,
		async cleanup() {
			await service.close();
			harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
async function finish(submission: Submission) {
	submission.start?.();
	return submission.done ?? submission.result;
}

test("native Pi history carries two turns, survives reaping and service restart, isolates visitors and new sessions", async () => {
	const env = await setup();
	let restarted: AgentService | undefined;
	try {
		const first = env.service.create("visitor-a");
		env.harness.setResponses([
			fauxAssistantMessage("请确认划伤深度。"),
			(context) => {
				assert.ok(context.messages.some((message) => getMessageText(message).includes("板面有划伤")));
				return fauxAssistantMessage("这种板面划伤需要确认深度与露铜情况。");
			},
		]);
		const one = await finish(
			env.service.submit("visitor-a", first.sessionId, { requestId: randomUUID(), message: "板面有划伤" }),
		);
		assert.equal(one.status, "succeeded");
		env.service.reap(Date.now() + 100);
		assert.equal(env.service.registry.instances.size, 0);
		const two = await finish(
			env.service.submit("visitor-a", first.sessionId, { requestId: randomUUID(), message: "这种缺陷怎么处理" }),
		);
		assert.equal(two.status, "succeeded");
		assert.throws(() => env.service.messages("visitor-b", first.sessionId), /SESSION_NOT_FOUND/);
		assert.equal(env.service.list("visitor-b").sessions.length, 0);
		await env.service.close();
		restarted = env.create();
		assert.equal(restarted.messages("visitor-a", first.sessionId).messages.length, 4);
		env.harness.setResponses([
			(context) => {
				assert.equal(context.messages.filter((message) => message.role === "user").length, 3);
				return fauxAssistantMessage("继续确认划伤。");
			},
			(context) => {
				assert.ok(!context.messages.some((message) => getMessageText(message).includes("板面有划伤")));
				return fauxAssistantMessage("新会话。");
			},
		]);
		assert.equal(
			(
				await finish(
					restarted.submit("visitor-a", first.sessionId, { requestId: randomUUID(), message: "还有哪些条件" }),
				)
			).status,
			"succeeded",
		);
		const fresh = restarted.create("visitor-a");
		assert.equal(
			(await finish(restarted.submit("visitor-a", fresh.sessionId, { requestId: randomUUID(), message: "你好" })))
				.status,
			"succeeded",
		);
	} finally {
		await restarted?.close();
		await env.cleanup();
	}
});

test("atomic reservation rejects concurrency; request ids deduplicate before busy checks; cancellation releases the session", async () => {
	const env = await setup();
	try {
		const { sessionId } = env.service.create("a");
		const requestId = randomUUID();
		env.harness.setResponses([
			async (_context, options) => {
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					if (options?.signal?.aborted) resolve();
				});
				return fauxAssistantMessage("部分回答", { stopReason: "aborted" });
			},
		]);
		const submission = env.service.submit("a", sessionId, { requestId, message: "板面划伤" });
		assert.equal(env.service.submit("a", sessionId, { requestId, message: "板面划伤" }).duplicate, true);
		assert.throws(
			() => env.service.submit("a", sessionId, { requestId, message: "不同内容" }),
			/REQUEST_ID_CONFLICT/,
		);
		assert.throws(
			() => env.service.submit("a", sessionId, { requestId: randomUUID(), message: "重复发送" }),
			/SESSION_BUSY/,
		);
		const events: string[] = [];
		submission.subscribe!((event) => events.push(event.type));
		submission.start!();
		const cancelled = await env.service.cancel("a", sessionId, requestId);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(events.filter((type) => type === "request_finished").length, 1);
		env.harness.setResponses([fauxAssistantMessage("恢复后回答")]);
		assert.equal(
			(await finish(env.service.submit("a", sessionId, { requestId: randomUUID(), message: "重新提问" }))).status,
			"succeeded",
		);
		assert.equal((await env.service.cancel("a", sessionId, requestId)).status, "cancelled");
	} finally {
		await env.cleanup();
	}
});

test("empty sessions restore explicitly; damaged nonempty Pi history is rejected", async () => {
	const env = await setup();
	try {
		const { sessionId } = env.service.create("a");
		assert.deepEqual(env.service.messages("a", sessionId).messages, []);
		env.harness.setResponses([fauxAssistantMessage("已记录")]);
		await finish(env.service.submit("a", sessionId, { requestId: randomUUID(), message: "划伤" }));
		const metadata = env.service.store.readSession("a", sessionId);
		const file = join(env.service.store.sessionDir("a", sessionId), "pi", metadata.piSessionFile);
		env.service.reap(Date.now() + 100);
		writeFileSync(file, `${readFileSync(file, "utf8")}invalid-json\n`);
		assert.throws(() => env.service.messages("a", sessionId), /SESSION_RECOVERY_FAILED/);
	} finally {
		await env.cleanup();
	}
});

test("HTTP uses signed persistent visitor credentials, same-origin writes, JSON dedup and session ownership", async () => {
	const env = await setup();
	const server = createHttpServer(env.service, env.root);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	try {
		const created = await fetch(`${base}/api/sessions`, { method: "POST" });
		assert.equal(created.status, 201);
		const cookie = created.headers.get("set-cookie")!.split(";")[0];
		const session = (await created.json()) as { sessionId: string };
		assert.equal((await fetch(`${base}/api/sessions/${session.sessionId}`)).status, 404);
		assert.equal(
			(await fetch(`${base}/api/sessions/${session.sessionId}`, { headers: { Cookie: cookie } })).status,
			200,
		);
		assert.equal(
			(
				await fetch(`${base}/api/sessions`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: "https://attacker.invalid" },
				})
			).status,
			403,
		);
		env.harness.setResponses([fauxAssistantMessage("流式完成")]);
		const input = { requestId: randomUUID(), message: "板面有划伤" };
		const response = await fetch(`${base}/api/sessions/${session.sessionId}/messages`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(input),
		});
		const stream = await response.text();
		assert.match(stream, /message_delta/);
		assert.equal((stream.match(/"type":"request_finished"/g) ?? []).length, 1);
		const replay = await fetch(`${base}/api/sessions/${session.sessionId}/messages`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(input),
		});
		assert.match(replay.headers.get("content-type")!, /application\/json/);
		assert.equal(env.harness.faux.state.callCount, 1);
		const stateFile = join(env.root, "cli-state.json");
		// CLI 使用真实 HTTP 和持久 Cookie；重新创建客户端后仍只能恢复本人会话。
		const cli = await new PcbHttpClient({ baseUrl: base, stateFile }).initialize();
		const cliSession = await cli.createSession();
		assert.ok(typeof cliSession.sessionId === "string");
		env.harness.setResponses([fauxAssistantMessage("CLI 通过同一服务完成")]);
		const cliResult = await cli.sendMessage(cliSession.sessionId, { requestId: randomUUID(), message: "查看划伤" });
		assert.equal(cliResult.kind, "stream");
		assert.ok(cliResult.kind === "stream");
		assert.equal(cliResult.final?.reply, "CLI 通过同一服务完成");
		const restoredCli = await new PcbHttpClient({ baseUrl: base, stateFile }).initialize();
		assert.equal((await restoredCli.getMessages(cliSession.sessionId)).messages?.length, 2);
		assert.equal((await restoredCli.listSessions()).sessions?.length, 1);
		assert.equal(
			(await fetch(`${base}/api/sessions/${cliSession.sessionId}`, { headers: { Cookie: cookie } })).status,
			404,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await env.cleanup();
	}
});

test("data directory admits a single process writer and preserves unknown lock files", () => {
	const root = mkdtempSync(join(tmpdir(), "pcb-lock-"));
	try {
		const release = acquireDataLock(root);
		assert.throws(() => acquireDataLock(root), /already in use/);
		release();
		writeFileSync(join(root, "service.lock"), "broken");
		assert.throws(() => acquireDataLock(root), /lock is invalid/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native compaction retains PCB facts and evidence ids, leaves original entries readable and reports failure", async () => {
	const env = await setup();
	try {
		const { sessionId } = env.service.create("a");
		env.harness.setResponses([
			fauxAssistantMessage("已确认板面划伤，厚度 1.6mm，排除起泡，待确认深度 [E:ev_example]"),
			fauxAssistantMessage("请提供深度与露铜情况。"),
		]);
		await finish(
			env.service.submit("a", sessionId, {
				requestId: randomUUID(),
				message: "板面有划伤，厚度1.6mm，已排除起泡。",
			}),
		);
		await finish(env.service.submit("a", sessionId, { requestId: randomUUID(), message: "这种缺陷怎么处理？" }));
		const live = env.service.registry.instances.get(sessionId)!;
		const originalIds = live.manager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.id);
		assert.ok(originalIds.length >= 4);
		assert.equal(live.session.settingsManager.getCompactionSettings(live.session.model).keepRecentTokens, 5);
		env.harness.setResponses([
			(context) => {
				const content = context.messages.map(getMessageText).join("\n");
				assert.match(content, /已排除候选/);
				assert.match(content, /ev_example/);
				return fauxAssistantMessage("板面划伤；厚度1.6mm；已排除起泡；证据 [E:ev_example]；待确认深度与露铜。");
			},
		]);
		await live.session.compact();
		assert.ok(live.manager.getBranch().some((entry) => entry.type === "compaction"));
		assert.ok(originalIds.every((id) => live.manager.getBranch().some((entry) => entry.id === id)));
		env.harness.setResponses([
			(context) => {
				const content = context.messages.map(getMessageText).join("\n");
				assert.match(content, /板面划伤/);
				assert.match(content, /1.6mm/);
				assert.match(content, /ev_example/);
				return fauxAssistantMessage("继续确认划伤深度。");
			},
		]);
		assert.equal(
			(await finish(env.service.submit("a", sessionId, { requestId: randomUUID(), message: "还缺什么信息？" })))
				.status,
			"succeeded",
		);
		const entriesBefore = live.manager.getEntries().length;
		env.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "controlled summary failure" }),
		]);
		const events: string[] = [];
		const unsubscribe = live.session.subscribe((event) => {
			if (event.type === "compaction_end")
				events.push(event.aborted ? "aborted" : event.errorMessage ? "failed" : "succeeded");
		});
		await assert.rejects(live.session.compact());
		unsubscribe();
		assert.ok(events.some((status) => status === "aborted" || status === "failed"));
		assert.ok(live.manager.getEntries().length >= entriesBefore);
	} finally {
		await env.cleanup();
	}
});

test("Pi terminal snapshot repairs interrupted business-index writes without replaying the model", async () => {
	const env = await setup();
	let restored: AgentService | undefined;
	try {
		const { sessionId } = env.service.create("a");
		const requestId = randomUUID();
		const write = env.service.store.writeRequest.bind(env.service.store);
		env.service.store.writeRequest = (owner, session, metadata) => {
			// 只让业务索引终态落盘失败，检验重启能用 Pi 的终态快照修复而不重放模型。
			if (metadata.status === "succeeded") throw new Error("controlled disk failure");
			write(owner, session, metadata);
		};
		env.harness.setResponses([fauxAssistantMessage("已完成的真实Pi回答")]);
		assert.equal(
			(await finish(env.service.submit("a", sessionId, { requestId, message: "板面划伤" }))).status,
			"interrupted",
		);
		await env.service.close();
		restored = env.create();
		const result = restored.request("a", sessionId, requestId);
		assert.equal(result.status, "succeeded");
		assert.equal(result.reply, "已完成的真实Pi回答");
		assert.equal(env.harness.faux.state.callCount, 1);
	} finally {
		await restored?.close();
		await env.cleanup();
	}
});

test("in-flight cancellation propagates to the native model signal and old cancel cannot stop a new request", async () => {
	const env = await setup();
	try {
		const { sessionId } = env.service.create("a");
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let aborted = false;
		env.harness.setResponses([
			async (_context, options) => {
				entered();
				assert.ok(options?.signal);
				await new Promise<void>((resolve) => {
					options.signal!.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					);
				});
				return fauxAssistantMessage("未完成", { stopReason: "aborted" });
			},
		]);
		const requestId = randomUUID();
		const submission = env.service.submit("a", sessionId, { requestId, message: "等待取消" });
		submission.start!();
		await started;
		assert.equal((await env.service.cancel("a", sessionId, requestId)).status, "cancelled");
		assert.ok(aborted);
		env.harness.setResponses([fauxAssistantMessage("新请求成功")]);
		const next = env.service.submit("a", sessionId, { requestId: randomUUID(), message: "继续" });
		await env.service.cancel("a", sessionId, requestId);
		assert.equal((await finish(next)).status, "succeeded");
	} finally {
		await env.cleanup();
	}
});

test("native retry settles once, final text replaces attempt text and usage matches persisted native messages", async () => {
	const env = await setup({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
	try {
		const { sessionId } = env.service.create("a");
		env.harness.setResponses([
			fauxAssistantMessage("临时错误", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			fauxAssistantMessage("最终可靠回答"),
		]);
		const submission = env.service.submit("a", sessionId, { requestId: randomUUID(), message: "板面划伤" });
		const events: string[] = [];
		submission.subscribe!((event) => events.push(event.type));
		const result = await finish(submission);
		assert.equal(result.status, "succeeded");
		assert.equal(result.reply, "最终可靠回答");
		assert.ok(events.includes("retrying"));
		assert.equal(events.filter((type) => type === "request_finished").length, 1);
		const native = env.service.registry.instances
			.get(sessionId)!
			.manager.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		assert.equal(
			result.usage?.totalTokens,
			native.reduce((sum, message) => sum + message.usage.totalTokens, 0),
		);
		assert.equal(
			env.service.messages("a", sessionId).messages.filter((message) => message.role === "assistant").length,
			1,
		);
	} finally {
		await env.cleanup();
	}
});

test("automatic native compaction completes before the business terminal and preserves the raw turn", async () => {
	// 小上下文模型加长输入触发原生自动压缩，业务终态必须等待压缩结束。
	const env = await setup({}, { models: [{ id: "pcb-small-context", contextWindow: 2048, maxTokens: 256 }] });
	try {
		const { sessionId } = env.service.create("a");
		const summary: Parameters<typeof env.harness.setResponses>[0][number] = () =>
			fauxAssistantMessage("保留：板面划伤，厚度1.6mm，待确认深度。[E:ev_auto]");
		env.harness.setResponses([fauxAssistantMessage("请确认划伤深度。[E:ev_auto]"), summary, summary]);
		const request = env.service.submit("a", sessionId, {
			requestId: randomUUID(),
			message: `板面划伤，厚度1.6mm。${"补充工艺参数。".repeat(1600)}`,
		});
		const events: string[] = [];
		request.subscribe!((event) => events.push(event.type));
		const result = await finish(request);
		assert.equal(result.status, "succeeded");
		assert.ok(events.includes("context_compacting"));
		assert.ok(events.lastIndexOf("request_finished") > events.lastIndexOf("context_compacted"));
		const branch = env.service.registry.instances.get(sessionId)!.manager.getBranch();
		assert.ok(branch.some((entry) => entry.type === "compaction"));
		assert.ok(
			branch.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					getMessageText(entry.message).length > 10000,
			),
		);
	} finally {
		await env.cleanup();
	}
});
