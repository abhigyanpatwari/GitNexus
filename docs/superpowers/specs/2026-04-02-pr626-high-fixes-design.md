# PR #626 HIGH-Priority Fixes Design

**Date:** 2026-04-02
**PR:** abhigyanpatwari/GitNexus#626 — Intra-repo service communication tracking
**Scope:** 4 HIGH-priority issues identified by abhigyanpatwari and xkonjin
**Approach:** Minimal targeted fixes (option A) — no refactoring, no scope creep

---

## Fix 1: Path Traversal via Group Name

**File:** `gitnexus/src/core/group/storage.ts`
**Risk:** A group name like `../../etc` creates directories outside the intended path.

### Solution

Add `validateGroupName(name: string): void` that enforces `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`.

- Call in `createGroupDir` (primary entry point)
- Call in `getGroupDir` (defense in depth)
- Throw descriptive error on invalid names

**Legacy:** Groups already on disk with names outside this pattern are not auto-renamed; only new `create` / resolved paths are validated.

### Why regex over path.resolve + startsWith

- abhigyanpatwari explicitly requested `[a-zA-Z0-9_-]`
- Stricter: disallows spaces, dots, Unicode edge cases
- Simpler to reason about

### Tests

- `../../evil` throws
- `foo/bar` throws
- Empty string throws
- `my-group_01` passes
- `A` (single char) passes
- CLI smoke: one integration test that hits `getGroupDir` / `createGroupDir` (e.g. `group create` or `group add`) with an invalid name proves wiring for every subcommand that resolves a group through storage

### CLI/API entry points accepting groupName

All paths flow through `getGroupDir` (which validates), so coverage is implicit. For reference:

| Command | Entry | Calls |
|---------|-------|-------|
| `group create` | `cli/group.ts` action | `createGroupDir` -> `getGroupDir` |
| `group add` | `cli/group.ts` action | `getGroupDir` |
| `group remove` | `cli/group.ts` action | `getGroupDir` |
| `group list` | `cli/group.ts` action | reads `groups/` dir directly — no traversal risk (reads, not writes) |
| `group status` | `cli/group.ts` action | `getGroupDir` |
| `group sync` | `cli/group.ts` action | `getGroupDir` |

**`listGroups`:** Reads directory names from disk without validation. Not a write path, so no traversal risk. May surface manually-created directories with non-conforming names — accepted as-is, not in scope.

---

## Fix 2: gRPC Proto Regex -> Brace-Depth Counter

**File:** `gitnexus/src/core/group/extractors/grpc-extractor.ts`
**Risk:** `serviceRe = /service\s+(\w+)\s*\{([^}]*)}/gs` stops at first `}`. Proto services with `google.api.http` annotations inside RPCs contain nested `{ }` blocks.

### Solution

Replace `serviceRe` regex with `extractServiceBlocks(content: string): Array<{ name: string; body: string }>`:

1. Use regex only to find `service <Name> {` start positions (regex consumes the opening `{`)
2. Initialise depth to 1 immediately after the opening `{`
3. Scan forward char by char: `{` -> depth++, `}` -> depth--; collect into body
4. Stop when depth reaches 0 (the matching closing `}`)
5. Return name + body pairs

Inner `rpcRe` regex remains unchanged — it operates on the already-extracted body.

**Malformed input:** If EOF is reached before `depth` returns to 0, skip the incomplete service (do not add to results). Lock this in the test.

**Scope limitation (v1):** Brace-depth only — no lexer for string literals or comments containing `{`/`}`. Sufficient for `google.api.http` annotations. Known false positive: braces inside `//` comments or quoted strings within proto options. Accepted for v1; a proper proto lexer is out of scope.

### Tests

- Proto with single service, no nesting (regression)
- Proto with `google.api.http` nested braces inside RPC options
- Proto with multiple services
- Proto with nested `option` blocks inside RPC (e.g. `google.api.http`)
- Malformed proto with unclosed brace (graceful handling)

---

## Fix 3: Directory Exclusions in Service Boundary Detector

**File:** `gitnexus/src/core/group/service-boundary-detector.ts`
**Risk:** Walks entire repo tree, only skipping dotfiles and `node_modules`. Extremely slow on repos with `vendor/`, `target/`, `__pycache__/`, `.venv/`.

### Solution

Create `EXCLUDED_DIRS` as a `Set<string>` (alongside existing `SERVICE_MARKERS`, `SOURCE_EXTENSIONS`), for example:

```text
node_modules, vendor, target, build, dist,
__pycache__, .venv, venv, .tox, .mypy_cache,
.gradle, .mvn, out, bin
```

(Implement as `new Set([...])` — the list above is the membership, not a string literal.)

Apply in both:
- `walkForBoundaries` (line 77-78) — replace current inline `=== 'node_modules'` check with `EXCLUDED_DIRS.has(entry.name)`
- `hasSourceFilesInSubdirs` (line 130) — replace `entry.name !== 'node_modules'` with `!EXCLUDED_DIRS.has(entry.name)`

Note: remove the old `=== 'node_modules'` literal from both locations — it is covered by `EXCLUDED_DIRS`.
Dotfile exclusion (`.` prefix) remains as a separate check since it's a pattern, not a name.
Exclusions apply only to `isDirectory()` entries — file names are never checked against `EXCLUDED_DIRS`.

**Tradeoff:** Rare layouts that keep source under names like `out/` or `bin/` will be skipped; accepted for performance on typical monorepos.

**Case sensitivity:** `Set.has` is case-sensitive (matches current `=== 'node_modules'` behavior). Windows case-insensitive FS not handled — accepted as-is, consistent with existing code.

### Tests

- Directory named `vendor/` is skipped
- Directory named `target/` is skipped
- Directory named `__pycache__/` is skipped
- Regular source directories are NOT skipped
- Dotfile directories still skipped (regression)

---

## Fix 4: Double-Close of LadybugDB Pools

**Files:**
- `gitnexus/src/core/group/sync.ts` (lines 155-157) — per-id cleanup (KEEP)
- `gitnexus/src/cli/group.ts` (line 188) — blanket `closeLbug()` (REMOVE)

**Risk:** In MCP server context, `closeLbug()` without arguments tears down ALL active pools, including ones from unrelated operations.

### Solution

Remove the `closeLbug()` call (no arguments) from `cli/group.ts` finally block. The per-id cleanup in `sync.ts` is sufficient:

```typescript
// sync.ts — KEEP: cleans up only pools opened by this sync
finally {
  for (const id of [...new Set(openPoolIds)]) {
    await closeLbug(id).catch(() => {});
  }
}
```

```typescript
// cli/group.ts — REMOVE: blanket close that kills all pools
finally {
  await closeLbug().catch(() => {});  // DELETE THIS
}
```

Remove the `closeLbug` import from `cli/group.ts` — after removing the `finally` call it has no remaining usages.

### Tests (unit level — mock pool adapter)

- `syncGroup` closes only the pools it opened (mock `closeLbug`, assert called with specific ids)
- Two-pool scenario: sync opens pools A and B, both closed in finally; pool C (opened elsewhere) not touched
- CLI `sync` command does not call blanket `closeLbug()` (verify no zero-arg call in source — static check or grep-based test)

---

## Out of Scope

- JSON -> LadybugDB migration (tracked in #606)
- MEDIUM/LOW issues (items 5-10 from review summary)
- Test gap coverage beyond what's needed for these 4 fixes
- Any refactoring or architectural changes

## Execution Order

Fixes are independent — can be implemented in parallel or any order.
Recommended order for review clarity: 1 -> 3 -> 4 -> 2 (simplest to most complex).
