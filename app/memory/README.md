# Optional business memory

`MemoryStore` is separate from Pi session history. Construct it with no options for an isolated in-memory store, or pass `storagePath` for an atomic JSON snapshot. Every operation takes a `MemoryPrincipal` (or an owner id shorthand); records are filtered by owner, authorised scope and `[validFrom, validTo)` at query time.

```ts
const store = new MemoryStore({ storagePath: ".pcb-data/memories.json" });
const principal = { ownerId: "user-123", scopes: ["project:pcb"] };

const saved = await store.save(principal, {
  kind: "confirmed-process-parameter",
  value: { lineWidthMm: 0.15 },
  confirmationStatus: "confirmed",
  sourceSessionId: "session-id",
  sourceEntryId: "entry-id",
  scope: "project:pcb"
});
const corrected = await store.update(principal, saved.memoryId, { value: { lineWidthMm: 0.16 } });
await store.search(principal, "lineWidthMm");
await store.delete(principal, corrected.memoryId);
```

`update` creates a new `memoryId` and sets `supersedes`; the old version is excluded from `get`, `list` and `search`. `delete` removes the record from the active index and snapshot. `sourceSessionId` and `sourceEntryId` are required so the caller can explain where a memory came from.

`createMemoryExtension` is opt-in:

```ts
const extension = createMemoryExtension({
  store,
  enabled: true,
  getPrincipal: (ctx) => authForSession(ctx),
  getDefaultSource: (ctx) => currentBusinessSource(ctx),
  beforeExecute: (signal, ctx) => budgetForMemoryTool(signal, ctx),
  validateSource: (sessionId, entryId, ctx) => verifyEntryOwner(sessionId, entryId, ctx),
});
```

When `enabled` is omitted or false, the factory registers no tools. When enabled it registers `memory_list`, `memory_save`, `memory_update` and `memory_delete`. Listing requires a non-empty query; use the explicit query `"*"` to view all effective memories available to the current user within the authorized scope and result limit. The factory has no chat event listener, so it never extracts whole conversations automatically.

The host hooks run before each tool. Save source ids are optional for the model: when omitted, `getDefaultSource` supplies the current business session and user-entry ids. The final pair must be non-empty and `validateSource` receives it for saves and corrections; an update without source fields reuses and validates the previous pair. `beforeExecute` is followed by an abort check. Tool queries are limited to 1,000 characters, JSON values to 8 KiB, and result limits to 20 records. A cancelled save, correction or deletion is rejected before the store mutation.

