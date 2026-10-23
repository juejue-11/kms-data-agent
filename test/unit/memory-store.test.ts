// 记忆存储验收：身份/有效期过滤、更正失效、删除持久化，以及损坏快照和写入失败时的保护。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, MemoryStoreError } from "../../app/memory/store.ts";

const draft = {
	kind: "process-parameter",
	value: { lineWidthMm: 0.15 },
	confirmationStatus: "confirmed" as const,
	sourceSessionId: "session-1",
	sourceEntryId: "entry-1",
};

describe("MemoryStore", () => {
	it("isolates owners and returns only effective records in the requested scope", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const store = new MemoryStore({
			now: () => now,
			idFactory: (() => {
				let index = 0;
				return () => `mem_${++index}`;
			})(),
		});

		const privateRecord = await store.save("alice", draft);
		await store.save("bob", { ...draft, value: { lineWidthMm: 0.2 } });
		await store.save("alice", {
			...draft,
			kind: "expired",
			validFrom: "2025-01-01T00:00:00.000Z",
			validTo: "2025-12-31T00:00:00.000Z",
		});

		expect((await store.search("alice", "lineWidthMm")).map((record) => record.memoryId)).toEqual([
			privateRecord.memoryId,
		]);
		expect(await store.search("bob", "lineWidthMm")).toHaveLength(1);
		expect(await store.search("mallory", "lineWidthMm")).toEqual([]);

		now = new Date("2025-06-01T00:00:00.000Z");
		expect(await store.search("alice", "expired")).toHaveLength(1);
		now = new Date("2026-01-01T00:00:00.000Z");
		expect(await store.search("alice", "expired")).toEqual([]);
	});

	it("creates a correcting version and makes the old version unavailable", async () => {
		const store = new MemoryStore({
			idFactory: (() => {
				let index = 0;
				return () => `mem_${++index}`;
			})(),
		});
		const original = await store.save("alice", draft);
		const corrected = await store.update("alice", original.memoryId, { value: { lineWidthMm: 0.2 } });

		expect(corrected.memoryId).not.toBe(original.memoryId);
		expect(corrected.supersedes).toBe(original.memoryId);
		expect(await store.get("alice", original.memoryId)).toBeUndefined();
		expect((await store.search("alice", "lineWidthMm")).map((record) => record.memoryId)).toEqual([
			corrected.memoryId,
		]);
		await expect(store.update("bob", corrected.memoryId, { value: { lineWidthMm: 0.3 } })).rejects.toMatchObject({
			code: "MEMORY_NOT_FOUND",
		});
	});

	it("removes deleted records from retrieval and the persisted snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pcb-memory-"));
		const storagePath = join(directory, "memories.json");
		try {
			const store = new MemoryStore({ storagePath });
			const record = await store.save("alice", draft);
			expect(await store.delete("alice", record.memoryId)).toBe(true);
			expect(await store.get("alice", record.memoryId)).toBeUndefined();
			expect(await store.search("alice", "process")).toEqual([]);

			const restored = new MemoryStore({ storagePath });
			expect(await restored.search("alice", "process")).toEqual([]);
			expect(JSON.parse(await readFile(storagePath, "utf8")).records).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects invalid ranges and unauthorised non-owner scopes", async () => {
		const store = new MemoryStore();
		await expect(
			store.save("alice", {
				...draft,
				validFrom: "2026-01-02T00:00:00.000Z",
				validTo: "2026-01-01T00:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(MemoryStoreError);
		await expect(
			store.save("alice", {
				...draft,
				scope: "project:restricted",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORISED" });
		const record = await store.save(
			{ ownerId: "alice", scopes: ["project:restricted"] },
			{ ...draft, scope: "project:restricted" },
		);
		expect(record.scope).toBe("project:restricted");
	});

	it("fails closed on an invalid snapshot instead of filtering or overwriting it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pcb-memory-invalid-"));
		const storagePath = join(directory, "memories.json");
		try {
			const snapshots = [
				{ schemaVersion: 2, records: [] },
				{ schemaVersion: 1 },
				{ schemaVersion: 1, records: {} },
				{ schemaVersion: 1, records: [{ memoryId: "broken" }] },
				{ schemaVersion: 1, records: [], unknown: true },
			];
			for (const snapshot of snapshots) {
				const original = JSON.stringify(snapshot);
				await writeFile(storagePath, original, "utf8");
				const store = new MemoryStore({ storagePath });
				await expect(store.search("alice", "broken")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
				expect(await readFile(storagePath, "utf8")).toBe(original);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rolls back save, correction and deletion when persistence fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pcb-memory-rollback-"));
		const storagePath = join(directory, "memories.json");
		try {
			const store = new MemoryStore({ storagePath });
			const original = await store.save("alice", draft);
			await rm(storagePath, { force: true });
			// 用目录占据快照路径制造可重复的写入失败，验证内存变更也会回滚。
			await mkdir(storagePath);

			await expect(store.save("alice", { ...draft, kind: "failed-save" })).rejects.toMatchObject({
				code: "STORAGE_ERROR",
			});
			expect(await store.search("alice", "failed-save")).toEqual([]);

			await expect(store.update("alice", original.memoryId, { value: { lineWidthMm: 0.2 } })).rejects.toMatchObject({
				code: "STORAGE_ERROR",
			});
			expect(await store.get("alice", original.memoryId)).toEqual(original);

			await expect(store.delete("alice", original.memoryId)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
			expect(await store.get("alice", original.memoryId)).toEqual(original);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

it("lets the owner delete a future-effective memory before it can be retrieved", async () => {
	const store = new MemoryStore();
	const record = await store.save("alice", { ...draft, validFrom: "2100-01-01T00:00:00Z" });
	expect(await store.get("alice", record.memoryId)).toBeUndefined();
	expect(await store.delete("bob", record.memoryId)).toBe(false);
	expect(await store.delete("alice", record.memoryId)).toBe(true);
	expect(await store.list("alice", { at: "2101-01-01T00:00:00Z" })).toEqual([]);
});
