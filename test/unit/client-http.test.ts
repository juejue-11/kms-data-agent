/**
 * HTTP 客户端协议测试：验证 SSE 帧与终态、requestId 去重、Cookie 持久化、错误映射和断流身份保留。
 * 所有网络交互都由本地 fetch stub 模拟，测试不依赖真实服务。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	PcbClientError,
	type PcbEvent,
	PcbHttpClient,
	parseSseRecords,
	StreamDisconnectedError,
} from "../../app/cli/http-client.ts";

type FetchStub = typeof fetch;

// SSE 解析应保留事件元数据，并把多行 data 还原为一个 JSON 负载。
test("parseSseRecords keeps event fields and multiline JSON data", () => {
	const records = parseSseRecords(
		": heartbeat\n" +
			"event: pcb\n" +
			"id: 7\n" +
			'data: {"sessionId":"s1",\n' +
			'data: "type":"message_delta","payload":{"delta":"板"}}\n\n',
	);

	assert.equal(records.length, 1);
	assert.equal(records[0].event, "pcb");
	assert.equal(records[0].id, "7");
	assert.deepEqual(records[0].data, {
		sessionId: "s1",
		type: "message_delta",
		payload: { delta: "板" },
	});
});

// 正常流应按事件顺序交付，并从 request_finished 事件提取最终结果。
test("sendMessage consumes SSE and returns request_finished final result", async () => {
	const events: PcbEvent[] = [];
	const fetchImpl: FetchStub = async (_url, init = {}) => {
		assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("Accept"), "text/event-stream");
		assert.deepEqual(JSON.parse(String(init.body)), { requestId: "r1", message: "问题" });
		return new Response(
			[
				`data: ${JSON.stringify({ sessionId: "s1", requestId: "r1", sequence: 1, type: "message_delta", payload: { delta: "答" } })}`,
				"",
				`data: ${JSON.stringify({ sessionId: "s1", requestId: "r1", sequence: 2, type: "request_finished", payload: { final: { sessionId: "s1", requestId: "r1", status: "succeeded", reply: "答案", sources: [] } } })}`,
				"",
			].join("\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	};
	const client = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile: path.join(os.tmpdir(), "pcb-client-http-test.json"),
		fetchImpl,
	});
	const result = await client.sendMessage("s1", {
		requestId: "r1",
		message: "问题",
		onEvent: (event: PcbEvent) => {
			events.push(event);
		},
	});

	assert.equal(result.kind, "stream");
	assert.equal(result.final?.reply, "答案");
	assert.deepEqual(
		events.map((event) => event.type),
		["message_delta", "request_finished"],
	);
});

// 服务端返回 202 表示已有请求在运行，客户端只返回状态，不开启第二条流。
test("a duplicate submission returns status without starting another stream", async () => {
	let calls = 0;
	const client = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile: path.join(os.tmpdir(), "pcb-client-http-duplicate.json"),
		fetchImpl: async () => {
			calls += 1;
			return new Response(
				JSON.stringify({ requestId: "r1", status: "running", statusUrl: "/api/sessions/s1/requests/r1" }),
				{
					status: 202,
					headers: { "content-type": "application/json" },
				},
			);
		},
	});

	const result = await client.sendMessage("s1", { requestId: "r1", message: "问题" });
	assert.equal(calls, 1);
	assert.equal(result.kind, "status");
	assert.equal(result.state.status, "running");
});

// 嵌套错误对象中的稳定 code/message 应转换为可供上层判断的客户端错误。
test("nested HTTP errors expose the stable server code and message", async () => {
	const client = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile: path.join(os.tmpdir(), "pcb-client-http-error.json"),
		fetchImpl: async () =>
			new Response(JSON.stringify({ error: { code: "SESSION_BUSY", message: "会话正在运行" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			}),
	});

	await assert.rejects(client.getSession("s1"), (error: unknown) => {
		if (!(error instanceof PcbClientError)) return false;
		assert.equal(error.code, "SESSION_BUSY");
		assert.equal(error.message, "会话正在运行");
		assert.equal(error.status, 409);
		return true;
	});
});

// Cookie 从响应保存到状态文件，并在新的客户端实例初始化后随请求发出。
test("service cookie is persisted and sent on the next client request", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pcb-client-cookie-"));
	const stateFile = path.join(directory, "state.json");
	const requests: Array<string | null> = [];
	const first = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile,
		fetchImpl: async (_url, init = {}) => {
			requests.push(new Headers(init.headers).get("Cookie"));
			return new Response(JSON.stringify({ sessionId: "s1" }), {
				status: 201,
				headers: { "content-type": "application/json", "set-cookie": "pcb_visitor=signed; Path=/; HttpOnly" },
			});
		},
	});
	await first.createSession();
	const second = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile,
		fetchImpl: async (_url, init = {}) => {
			requests.push(new Headers(init.headers).get("Cookie"));
			return new Response(JSON.stringify({ sessions: [] }), { headers: { "content-type": "application/json" } });
		},
	});
	await second.initialize();
	await second.listSessions();

	assert.equal(requests[0], null);
	assert.equal(requests[1], "pcb_visitor=signed");
	const saved = JSON.parse(await readFile(stateFile, "utf8"));
	assert.equal(saved.cookies.pcb_visitor, "signed");
});

// 可读流异常应标记为断流，并保留 sessionId/requestId 供恢复逻辑使用。
test("a broken stream is reported as disconnected with request identity", async () => {
	const client = new PcbHttpClient({
		baseUrl: "http://127.0.0.1:9100",
		stateFile: path.join(os.tmpdir(), "pcb-client-http-stream.json"),
		fetchImpl: async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new Error("socket closed"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});

	await assert.rejects(client.sendMessage("s1", { requestId: "r1", message: "问题" }), (error: unknown) => {
		if (!(error instanceof StreamDisconnectedError)) return false;
		assert.equal(error.sessionId, "s1");
		assert.equal(error.requestId, "r1");
		return true;
	});
});
