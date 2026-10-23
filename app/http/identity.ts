// 独立访客模式：随机身份加服务器签名，知道会话 ID 并不能取得会话权限。
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { AppError, uuidPattern } from "../contracts/protocol.ts";

export function createIdentity(dataDir: string): (request: IncomingMessage, response: ServerResponse) => string {
	const secretPath = join(dataDir, "identity-secret");
	// 密钥随数据目录持久保存，使服务重启后已签发的访客凭据仍可验证。
	if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32), { flag: "wx", mode: 0o600 });
	const secret = readFileSync(secretPath);
	if (secret.length !== 32) throw new Error("Invalid identity signing secret");
	const sign = (id: string) => createHmac("sha256", secret).update(id).digest("base64url");
	return (request, response) => {
		const cookie = request.headers.cookie
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("pcb_identity="))
			?.slice(13);
		if (cookie) {
			const [id, signature] = cookie.split(".");
			const expected = Buffer.from(sign(id ?? ""));
			const actual = Buffer.from(signature ?? "");
			// 先检查长度再作恒定时间比较；伪造凭据报错，不静默切换为新访客。
			if (!uuidPattern.test(id ?? "") || actual.length !== expected.length || !timingSafeEqual(actual, expected))
				throw new AppError("UNAUTHENTICATED", 401);
			return id;
		}
		const id = randomUUID();
		response.setHeader(
			"Set-Cookie",
			`pcb_identity=${id}.${sign(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${"encrypted" in request.socket && request.socket.encrypted ? "; Secure" : ""}`,
		);
		return id;
	};
}
export function checkOrigin(request: IncomingMessage): void {
	const origin = request.headers.origin;
	if (!origin) {
		// CLI 通常没有 Origin；浏览器带跨站元数据时仍拒绝写入。
		if (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")
			throw new AppError("ORIGIN_FORBIDDEN", 403);
		return;
	}
	try {
		const parsed = new URL(origin);
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.host !== request.headers.host)
			throw new Error("Origin mismatch");
	} catch {
		throw new AppError("ORIGIN_FORBIDDEN", 403);
	}
}
