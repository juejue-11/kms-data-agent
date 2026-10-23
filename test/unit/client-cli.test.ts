/**
 * CLI 交互生命周期测试：覆盖自动建会话、SSE 正常结束、断流恢复和 202 状态轮询。
 * 断流场景重点验证沿用原 requestId 查询终态，不能再次提交用户消息。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamDisconnectedError } from "../../app/cli/http-client.ts";
import { CliApp, type CliClient } from "../../app/cli/repl.ts";

type TestSink = {
	isTTY: false;
	value: string;
	write(chunk: string): boolean;
};

function sink(): TestSink {
	return {
		isTTY: false,
		value: "",
		write(chunk: string) {
			this.value += chunk;
			return true;
		},
	};
}

// 正常输入应创建一次会话并输出最终回答，同时不引入旧的 owner 标识。
test("CLI creates a service session and sends one request without owner input", async () => {
	const output = sink();
	const errors = sink();
	const calls: unknown[] = [];
	const client: CliClient = {
		createSession: async () => ({ sessionId: "s1" }),
		listSessions: async () => ({ sessions: [] }),
		getSession: async () => ({ sessionId: "s1" }),
		getMessages: async () => ({ messages: [] }),
		getRequest: async () => ({ status: "running" }),
		cancelRequest: async () => ({ status: "cancelled" }),
		sendMessage: async (_sessionId: string, options = {}) => {
			const { message = "", onEvent } = options;
			calls.push(message);
			if (onEvent) onEvent({ type: "message_delta", payload: { delta: "delta" } });
			return {
				kind: "stream",
				status: 200,
				final: { status: "succeeded", reply: "answer", sources: [] },
				lastEvent: null,
			};
		},
	};
	const app = new CliApp({ client, output, errorOutput: errors, randomUuid: () => "r1" });

	await app.handleLine("板面有划伤");

	assert.deepEqual(calls, ["板面有划伤"]);
	assert.match(output.value, /answer/);
	assert.doesNotMatch(output.value, /ownerId/);
});

// 流断开后只查询同一请求；服务端已完成的回答仍应被打印出来。
test("CLI queries a disconnected request once and does not resubmit", async () => {
	const output = sink();
	const errors = sink();
	let sends = 0;
	let queries = 0;
	const client: CliClient = {
		createSession: async () => ({ sessionId: "s1" }),
		listSessions: async () => ({ sessions: [] }),
		getSession: async () => ({ sessionId: "s1" }),
		getMessages: async () => ({ messages: [] }),
		cancelRequest: async () => ({ status: "cancelled" }),
		sendMessage: async () => {
			sends += 1;
			throw new StreamDisconnectedError("断流", { sessionId: "s1", requestId: "r1" });
		},
		getRequest: async () => {
			queries += 1;
			return { sessionId: "s1", requestId: "r1", status: "succeeded", reply: "服务端答案", sources: [] };
		},
	};
	const app = new CliApp({ client, output, errorOutput: errors, randomUuid: () => "r1" });

	await app.handleLine("继续处理");

	assert.equal(sends, 1);
	assert.equal(queries, 1);
	assert.match(output.value, /服务端答案/);
});

// 202 表示请求已在服务端运行，CLI 轮询到终态后才结束交互生命周期。
test("CLI keeps polling a running JSON result and prints only the terminal answer", async () => {
	const output = sink();
	let queries = 0;
	let sends = 0;
	const client: CliClient = {
		createSession: async () => ({ sessionId: "s1" }),
		listSessions: async () => ({ sessions: [] }),
		getSession: async () => ({ sessionId: "s1" }),
		getMessages: async () => ({ messages: [] }),
		cancelRequest: async () => ({ status: "cancelled" }),
		sendMessage: async () => {
			sends++;
			return { kind: "status", status: 202, state: { status: "running", reply: "" } };
		},
		getRequest: async () => {
			queries++;
			return queries === 1
				? { status: "running", reply: "", sources: [] }
				: { status: "succeeded", reply: "最终答案", sources: [] };
		},
	};
	const app = new CliApp({ client, output, errorOutput: sink(), randomUuid: () => "r1" });
	await app.handleLine("继续");
	assert.equal(sends, 1);
	assert.equal(queries, 2);
	assert.equal(app.activeRequest, null);
	assert.match(output.value, /最终答案/);
});
