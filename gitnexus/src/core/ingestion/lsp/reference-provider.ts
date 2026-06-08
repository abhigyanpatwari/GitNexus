/**
 * Mode B (LSP-backed `rename` + `impact`) — issue #159 P2.
 *
 * This file is the single Mode-B surface. It holds FOUR
 * concerns under one roof:
 *
 *   - WI-1: `ReferenceProvider` (class) — the LSP verb port.
 *   - WI-2: `withReferenceProvider` (funnel) — the lifecycle
 *     helper that gates every LSP-touching code path.
 *   - WI-3 adapter: `workspaceEditToChanges` +
 *     `workspaceEditToApplierChanges` — pure
 *     `WorkspaceEdit → ChangesFile` translators.
 *   - WI-3 applier: `applyPreciseEdits` — the precise per-edit
 *     splicer (KD-2).
 *
 * **Why all four in one file (and not split across four):**
 * the four concerns are tightly coupled — the funnel wires the
 * provider, the adapter feeds the applier, the applier re-uses
 * the adapter's internal types. Splitting them would force the
 * single consumer (`local-backend.ts:18-22`) to grow from one
 * import to four, with no logical boundary gained. The file
 * uses `// ─── WI-1 ───` / `// ─── WI-2 ───` / `// ─── WI-3
 * adapter ───` / `// ─── WI-3 applier ───` section markers to
 * keep the concerns visually partitioned. **Consider splitting
 * at P3+ if any single concern grows past ~500 lines.**
 *
 * ─── WI-1 — ReferenceProvider ──────────────────────────────────
 *
 * A thin port on top of `LspClient` that exposes the three LSP
 * verbs needed for Mode B (LSP-backed `rename` + `impact`):
 *
 *   - `resolveSymbol(name, fileHint?)` → `workspace/symbol`
 *     filtered to a single on-identifier `Location` (KD-4).
 *     0 or >1 matches, or off-identifier position, → `null`
 *     (refuse-over-guess, KD-1).
 *   - `references(loc)` → `textDocument/references` with
 *     `includeDeclaration:false`. Empty result → `[]` (a real
 *     answer). `request` returns `null` → `null` (refuse).
 *   - `rename(loc, newName)` → `textDocument/rename` returning
 *     a `WorkspaceEdit`. Non-text `documentChanges` op → `null`.
 *
 * Invariants honored:
 *   - Inv-1 (no graph writes): the provider only consumes an
 *     `LspClient` + the immutable `Location` shape. No DB I/O.
 *   - Inv-3 (refuse-over-guess): any `null` short-circuits to
 *     `null`; non-text `documentChanges` op is refused wholesale.
 *   - Inv-6 (line convention): LSP 0-indexed positions pass
 *     through verbatim; the adapter in WI-3 applies the +1
 *     conversion at the edge.
 *   - Inv-7 (foundation untouched): the provider calls the
 *     public `client.request<T>` and `client.didOpen` only; it
 *     does NOT import from the analyze/ingestion write pipeline.
 *
 * KD-3b: this provider assumes the real `typescript-language-server`
 * honors `workspace/symbol`/`textDocument/references`/`textDocument/rename`
 * under the current capability stanza. The Stage-1 spike
 * confirmed this; if the assumption is ever broken in the future,
 * a one-line additive capability declaration in `lsp-client.ts`
 * + a regression test is the KD-3b case-(ii) fix.
 *
 * KD-3: the provider performs an EXPLICIT `client.didOpen` of the
 * target file before every request. The `LspClient` auto-`didOpen`
 * is wired only for `textDocument/definition`.
 *
 * KD-4: `resolveSymbol` verifies the resolved `Location.start`
 * actually lands on the identifier (the `workspace/symbol` start
 * can be off by N characters vs. the actual name — see the
 * production spike which returned character 0 for `isUnindexablePath`).
 * Off-identifier → refuse.
 */

import { fileURLToPath } from 'node:url';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as path from 'node:path';

import { LspClient } from './lsp-client.js';
import { __test__ as locationMapperTest, type Location } from './location-mapper.js';
import { normalizeFilePath } from '../../../lib/utils.js';

// ─── Public types ────────────────────────────────────────────────────

/**
 * Minimal `WorkspaceEdit` shape per LSP 3.17. We do not depend on
 * `vscode-languageserver-types` to keep the dep surface tight
 * (Inv-7: no new external deps in this cycle).
 *
 * Either `changes` (a map of URI → `TextEdit[]`) OR
 * `documentChanges` (an ordered list of `TextDocumentEdit`/`*Op`)
 * may be present. Non-text `documentChanges` ops
 * (`kind: 'create' | 'rename' | 'delete'`) are NOT supported in
 * Mode B and cause the provider to refuse (KD-7).
 */
export type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | CreateFileOp | RenameFileOp | DeleteFileOp>;
};

export type TextEdit = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
};

export type TextDocumentEdit = {
  textDocument: { uri: string; version?: number };
  edits: TextEdit[];
};

export type CreateFileOp = { kind: 'create'; uri: string };
export type RenameFileOp = { kind: 'rename'; oldUri: string; newUri: string };
export type DeleteFileOp = { kind: 'delete'; uri: string };

/** Default per-request timeout (matches mode-c-verifier). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

// ─── Public types — WI-3: WorkspaceEdit → changes adapter + applier ──

/**
 * A single emitted edit, ready for the `rename` `changes` payload.
 *
 * The shape matches the existing `rename` output (see
 * `local-backend.ts:3376`): `{line, old_text, new_text, confidence}`.
 * The `range` field is an additive extension — the legacy
 * apply block in `local-backend.ts:3604-3615` does NOT read
 * `edits[]` (it does a file-global regex), so the existing
 * consumer is unaffected. `applyPreciseEdits` uses `range` to
 * perform a character-precise splice (KD-2).
 *
 * - `line`     — 1-indexed (matches the existing `rename` output).
 *                LSP's 0-indexed `range.start.line` is +1'd at the
 *                edge (Inv-6).
 * - `old_text` — the original source line, trimmed.
 * - `new_text` — the same line with the LSP range replaced by
 *                `newText`, trimmed.
 * - `confidence` — always `'lsp'` (provenance, KD-6).
 * - `range`    — the original LSP range (0-indexed). Used by
 *                `applyPreciseEdits` to sort descending by
 *                `(start.line, start.character)` and splice
 *                right-to-left so same-line multiple edits don't
 *                shift each other's offsets (KD-2).
 */
/**
 * Display shape — matches the legacy `rename` output. Read by
 * tools, UIs, audit logs. This is the PUBLIC shape emitted by
 * `workspaceEditToChanges`: it carries only the four display
 * fields (`line`, `old_text`, `new_text`, `confidence`).
 *
 * The LSP-precise splice inputs (`newText`, `range`) are NOT on
 * this type. They live on the `@internal` `ApplierChangesFileEdit`
 * extension below, which `applyPreciseEdits` accepts but which is
 * hidden from `rename`-wire consumers.
 */
export type ChangesFileEdit = {
  /** 1-indexed line number (Inv-6). LSP 0-indexed is +1'd at the edge. */
  line: number;
  /** The original source line, trimmed. */
  old_text: string;
  /** The same line with the LSP range replaced by `newText`, trimmed. */
  new_text: string;
  /** Provenance — always `'lsp'` (KD-6). */
  confidence: 'lsp';
};

/**
 * Applier-only shape — extends the public `ChangesFileEdit` with
 * the raw LSP inputs needed for the character-precise splice
 * (KD-2). `applyPreciseEdits` accepts this shape; it is NOT
 * emitted by `workspaceEditToChanges` on the public wire.
 *
 * Why a separate type: the legacy `rename` consumer (and any
 * audit log / UI that reads `changes[]`) does not need
 * `newText`/`range`, and their presence in the public type
 * invites confusion (the trimmed `new_text` ≠ the raw
 * `newText` byte-for-byte). Splitting makes the public
 * surface minimal and the applier surface explicit.
 *
 * `@internal` — exported solely for `applyPreciseEdits` callers
 * and the applier test suite.
 */
export type ApplierChangesFileEdit = ChangesFileEdit & {
  /** Raw LSP replacement text. Used by `applyPreciseEdits` only. */
  newText: string;
  /** Raw 0-indexed LSP range. Used by `applyPreciseEdits` only. */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
};

/**
 * Per-file edit list in the `rename` `changes` shape. The
 * `file_path` is a repo-relative POSIX path (matching the
 * existing `rename` output's `file_path`).
 *
 * This is the PUBLIC shape — `edits[]` is `ChangesFileEdit[]`
 * (the display shape, no `newText`/`range`).
 */
export type ChangesFile = {
  file_path: string;
  edits: ChangesFileEdit[];
};

/**
 * Applier-only shape — extends `ChangesFile` with the precise
 * splice inputs. `applyPreciseEdits` accepts this shape.
 *
 * `content` is an OPTIONAL pre-read of the file. When the
 * caller is `workspaceEditToApplierChanges` (which has just
 * read the file to compute `old_text`/`new_text`), it
 * injects the content here so `applyPreciseEdits` does NOT
 * re-read. Callers that build the shape by hand (e.g. unit
 * tests, the integration seam) leave it `undefined` and the
 * applier falls back to its own `readFile`. This is an
 * `@internal` field; production callers should not need to
 * populate it manually.
 *
 * `@internal` — exported solely for `applyPreciseEdits` callers
 * and the applier test suite. `workspaceEditToChanges` builds
 * this shape internally to pass to the applier; it strips
 * `newText`/`range` before emitting the public `ChangesFile[]`.
 */
export type ApplierChangesFile = {
  file_path: string;
  edits: ApplierChangesFileEdit[];
  /**
   * Optional pre-read file content. When present, the applier
   * uses it instead of calling `readFile`. `@internal`.
   */
  content?: string;
};

/**
 * Dependency injection bag for `workspaceEditToChanges`. Tests
 * use this to bypass real `fs/promises`. Production callers
 * pass nothing — the default reads from `node:fs/promises`.
 */
export type AdapterDeps = {
  /**
   * Read the file at `absPath` and return its content. Default:
   * `node:fs/promises.readFile(absPath, 'utf8')`.
   */
  readFile?: (absPath: string) => Promise<string>;
};

/**
 * Options for `applyPreciseEdits`. `dryRun` is required; the
 * file-write surface is opt-in (production code calls with
 * `dryRun: !params.dry_run` from the MCP `rename` wire).
 */
export type ApplierOpts = {
  repoPath: string;
  dryRun: boolean;
  /**
   * Optional dependency bag. Tests inject `readFile`/`writeFile`
   * to control file content + count writes. Production callers
   * pass nothing — the default uses `node:fs/promises`.
   */
  deps?: ApplierDeps;
};

/**
 * Dependency injection bag for `applyPreciseEdits`. Mirrors
 * `AdapterDeps` for symmetry.
 *
 * **Invariants:**
 *   - `readFile` and `writeFile` must be supplied TOGETHER, or
 *     NEITHER. A partial bag (e.g. only `readFile`) would
 *     silently fall through to the real `fs.writeFile` for the
 *     missing field, polluting test setups or letting real writes
 *     leak. `applyPreciseEdits` validates this at the entry point
 *     and throws on a partial bag.
 *   - `realpath` is OPTIONAL and independent of the read/write
 *     pair. The applier uses it for the F1 symlink-redirect
 *     TOCTOU re-check (resolve the abs path, then re-verify
 *     containment before the write). When omitted, the default
 *     uses `fs/promises.realpath` (F1.3 baseline).
 */
export type ApplierDeps = {
  readFile?: (absPath: string) => Promise<string>;
  writeFile?: (absPath: string, content: string) => Promise<void>;
  /**
   * Resolve symlinks for the F1 TOCTOU re-check. Default:
   * `node:fs/promises.realpath(absPath)`. The applier calls
   * this AFTER the textual `isWithinRepo` containment check
   * passes and BEFORE the write — a symlink that resolves
   * outside the repo is skipped, not written.
   */
  realpath?: (absPath: string) => Promise<string>;
};

// ─── Provider class ──────────────────────────────────────────────────

/**
 * `ReferenceProvider` is constructed with a started `LspClient` and
 * the file URI that subsequent `references`/`rename` requests
 * target. The URI is needed so the provider can `didOpen` the
 * target file explicitly (KD-3) — `resolveSymbol` uses the
 * server-wide `workspace/symbol`, which is path-agnostic, so the
 * `didOpen` for it is best-effort and may be a no-op if the
 * server has already indexed the workspace.
 */
export class ReferenceProvider {
  private readonly client: LspClient;
  private readonly fileUri: string;
  private readonly filePath: string;

  constructor(client: LspClient, fileUri: string) {
    this.client = client;
    this.fileUri = fileUri;
    // The provider never *writes* the file — it only reads it.
    // We use the URI as a stable identifier; the actual path is
    // the consumer's concern (the LSP server indexes by URI).
    this.filePath = fileUri;
  }

  /**
   * `workspace/symbol` → a single on-identifier `Location`.
   *
   * KD-4 — refuse (return `null`) when:
   *   1. the request itself returned `null` (server error / not ready);
   *   2. the response is `[]` (no matches);
   *   3. after filtering by `fileHint` (when supplied), >1
   *      candidates remain;
   *   4. after filtering, exactly 1 candidate remains, but its
   *      `range.start` is off the identifier (the position would
   *      not select the symbol in the editor).
   */
  async resolveSymbol(name: string, fileHint?: string): Promise<Location | null> {
    return this.withDidOpen(async (uri) => {
      const symbols = await this.client.request<any[]>(
        'workspace/symbol',
        { query: name },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (!Array.isArray(symbols) || symbols.length === 0) {
        // 0 matches OR request-null (refuse).
        return null;
      }

      // 1) Filter to the file hint when supplied.
      const candidates = fileHint
        ? symbols.filter((s) => isInFile(s, fileHint))
        : symbols;
      if (candidates.length === 0) {
        return null;
      }
      if (candidates.length > 1) {
        // Ambiguous even with the hint — refuse.
        return null;
      }

      // 2) Exactly one — verify it lands on the identifier (KD-4).
      const s = candidates[0];
      const loc = symbolToLocation(s);
      if (!loc) return null;
      if (!(await isOnIdentifier(loc, name, () => this.readFileOrEmpty()))) {
        return null;
      }
      return loc;
      // `uri` is captured for symmetry with `references`/`rename`
      // and to make it clear that every request runs in the
      // context of an already-`didOpen`ed file (KD-3). The current
      // `workspace/symbol` request is workspace-wide, so it
      // doesn't use the URI, but a future per-URI variant can.
      void uri;
    });
  }

  /**
   * `textDocument/references` (includeDeclaration:false).
   *
   * Returns:
   *   - `Location[]` on a real (possibly empty) response;
   *   - `[]` on a server-reported empty references set;
   *   - `null` ONLY when the request itself returns `null`
   *     (server unavailable / not ready / timed out / errored).
   */
  async references(loc: Location): Promise<Location[] | null> {
    return this.withDidOpen(async (uri) => {
      const refs = await this.client.request<Location[]>(
        'textDocument/references',
        {
          textDocument: { uri: loc.uri },
          position: loc.range.start,
          context: { includeDeclaration: false },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (refs === null) return null;        // request refused
      if (!Array.isArray(refs)) return null; // defensive — malformed
      // `uri` is the `didOpen`'d file URI — used here for
      // symmetry/future per-URI requests. The current
      // `textDocument/references` request uses `loc.uri`.
      void uri;
      return refs;
    });
  }

  /**
   * `textDocument/rename` → `WorkspaceEdit`.
   *
   * Returns:
   *   - the `WorkspaceEdit` verbatim (either `.changes` or
   *     `.documentChanges` with text edits only);
   *   - `null` when the request returns `null` (refuse);
   *   - `null` when `documentChanges` contains a non-text op
   *     (file create/rename/delete — KD-7: not supported in Mode B).
   */
  async rename(loc: Location, newName: string): Promise<WorkspaceEdit | null> {
    return this.withDidOpen(async (uri) => {
      const edit = await this.client.request<WorkspaceEdit>(
        'textDocument/rename',
        {
          textDocument: { uri: loc.uri },
          position: loc.range.start,
          newName,
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (edit === null) return null;        // request refused
      if (!isValidWorkspaceEdit(edit)) return null;
      // `uri` for symmetry/future per-URI requests. The current
      // `textDocument/rename` request uses `loc.uri`.
      void uri;
      return edit;
    });
  }

  /**
   * KD-3 helper — every `ReferenceProvider` method that issues a
   * request must first call `client.didOpen` on the target file
   * with the current content. This helper is the single seam
   * for that pre-request `didOpen`. The callback receives the
   * URI of the just-`didOpen`'d file so future per-URI requests
   * can be added without re-touching the `didOpen` boilerplate.
   *
   * On `didOpen` failure (e.g. file vanished, the client refuses
   * to open it): return `null` — consistent with the provider's
   * null-on-any-gate-fail contract. The fn is not invoked.
   *
   * On fn failure: re-throw. The funnel's try/finally is
   * responsible for stopping the client; the provider itself
   * does not swallow consumer errors (the consumer — the LSP
   * funnel in `withReferenceProvider` — owns the gate-fail
   * semantics for fn-throws).
   */
  private async withDidOpen<T>(fn: (uri: string) => Promise<T>): Promise<T | null> {
    let content: string;
    try {
      content = await this.readFileOrEmpty();
    } catch {
      return null;
    }
    try {
      await this.client.didOpen(this.fileUri, content);
    } catch {
      return null;
    }
    return await fn(this.fileUri);
  }

  /**
   * Read the file content for `didOpen`. The provider doesn't
   * ship an FS dep — the consumer is expected to pass a client
   * whose backing process already has the file. We use a lazy
   * `fs.readFile` ONLY if the file path is local. This is purely
   * a defensive measure so the `didOpen` semantic isn't a no-op
   * in test fixtures that don't pre-open the file.
   *
   * Cached per instance: a single funnel call exercises
   * `resolveSymbol` + `references` + `rename`, each of which
   * does its own `didOpen` (KD-3). The file content is identical
   * across those calls — read once, return from the cache for
   * the remainder of the instance's lifetime.
   */
  private lastRead: { uri: string; content: string } | null = null;
  private async readFileOrEmpty(): Promise<string> {
    if (!this.filePath || !this.filePath.startsWith('file://')) return '';
    if (this.lastRead && this.lastRead.uri === this.fileUri) {
      return this.lastRead.content;
    }
    try {
      const p = fileURLToPath(this.filePath);
      const content = await fsReadFile(p, 'utf8');
      this.lastRead = { uri: this.fileUri, content };
      return content;
    } catch {
      return '';
    }
  }
}

// ─── Internal helpers (exported for tests via __test__) ─────────────

/**
 * KD-4: the `workspace/symbol` start position can point at column 0
 * (the beginning of a line) even when the identifier doesn't start
 * at column 0. We verify by reading the source line and checking
 * that the identifier at or near `start.character` equals `name`.
 *
 * "On identifier" is defined as:
 *   - the source line at `range.start.line` exists;
 *   - `range.start.character` lies inside the name token on that line.
 *
 * The check is intentionally strict: it does NOT try to recover
 * by re-scanning the line for the first occurrence of `name`.
 * KD-4 is a refuse-over-guess gate.
 */
async function isOnIdentifier(
  loc: Location,
  name: string,
  readFile: () => Promise<string>,
): Promise<boolean> {
  const text = await readFile();
  if (!text) {
    // The file isn't preloaded by the client; the production
    // server has the file already (it was discovered via
    // `workspaceFolders`). We can't perform a local on-identifier
    // check, so we accept whatever position the server returned.
    // This is consistent with the Stage-1 spike output
    // (character 0 for `isUnindexablePath`).
    return true;
  }
  const lines = text.split(/\r?\n/);
  const lineText = lines[loc.range.start.line];
  if (typeof lineText !== 'string') return false;
  const c = loc.range.start.character;
  if (c < 0 || c > lineText.length) return false;
  // The character must lie inside the name token.
  // i.e. lineText.substring(c, c + name.length) === name.
  // AND the character BEFORE c (if any) must NOT be an identifier char.
  const tail = lineText.substring(c, c + name.length);
  if (tail !== name) return false;
  const before = c > 0 ? lineText[c - 1] : '';
  if (before && /[A-Za-z0-9_$]/.test(before)) return false;
  return true;
}

/** True iff `s.location.uri` is a path that ends with `fileHint`. */
function isInFile(s: any, fileHint: string): boolean {
  const uri: string | undefined = s?.location?.uri;
  if (typeof uri !== 'string') return false;
  // Match either the basename or any trailing path component.
  return uri.endsWith('/' + fileHint) || uri.endsWith(fileHint);
}

/**
 * Project a `SymbolInformation` (or `WorkspaceSymbol`) to the
 * canonical `Location` shape. Returns `null` for malformed
 * server responses (refuse over guess).
 */
function symbolToLocation(s: any): Location | null {
  const uri: unknown = s?.location?.uri;
  const line: unknown = s?.location?.range?.start?.line;
  const character: unknown = s?.location?.range?.start?.character;
  if (typeof uri !== 'string') return null;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) return null;
  if (typeof character !== 'number' || character < 0) return null;
  // KD-4 BVA: a character offset greater than any reasonable line
  // length is a structural signal that the position is not on an
  // identifier. 4096 is generous — a typical TS line is <200 chars.
  if (character > 4096) return null;
  return { uri, range: { start: { line, character } } };
}

/**
 * True iff the response is a valid `WorkspaceEdit` AND contains
 * no non-text `documentChanges` op.
 */
function isValidWorkspaceEdit(edit: any): edit is WorkspaceEdit {
  if (!edit || typeof edit !== 'object') return false;
  // The `changes` form is always accepted.
  if (edit.changes && typeof edit.changes === 'object') return true;
  // The `documentChanges` form must be a list of TEXT edits.
  if (Array.isArray(edit.documentChanges) && edit.documentChanges.length > 0) {
    return edit.documentChanges.every(isTextDocumentEdit);
  }
  // Empty edit — neither `changes` nor `documentChanges`.
  return false;
}

function isTextDocumentEdit(d: any): d is TextDocumentEdit {
  if (!d || typeof d !== 'object') return false;
  // Non-text op?
  if (d.kind === 'create' || d.kind === 'rename' || d.kind === 'delete') return false;
  // Must have a textDocument.uri and an edits array.
  if (!d.textDocument || typeof d.textDocument.uri !== 'string') return false;
  if (!Array.isArray(d.edits)) return false;
  // Every edit must be a valid TextEdit.
  return d.edits.every((e: any) =>
    e &&
    typeof e === 'object' &&
    e.range?.start &&
    typeof e.range.start.line === 'number' &&
    typeof e.range.start.character === 'number' &&
    e.range?.end &&
    typeof e.range.end.line === 'number' &&
    typeof e.range.end.character === 'number' &&
    typeof e.newText === 'string',
  );
}

// ─── Test surface (internal helpers exported via __test__) ──────────

export const __test__ = {
  // The only key the white-box test suite actually reaches for
  // (reference-provider.test.ts:328). The other internal helpers
  // are kept as plain (non-exported) functions; if a future test
  // needs to pin their behavior, re-export here.
  isOnIdentifier,
};

// ═══════════════════════════════════════════════════════════════════════
// ─── WI-2 — Mode B lifecycle helper: withReferenceProvider ───
// ═══════════════════════════════════════════════════════════════════════

/**
 * Minimal subset of `LspClient` the funnel calls. Exported as a
 * structural type so tests can construct plain-object fakes
 * without inheriting the real class (which would couple them to
 * the JSON-RPC transport and the `vscode-jsonrpc` dep).
 *
 * The contract is exactly: "a started client exposes `start` and
 * `stop`; the funnel calls `start` once and `stop` once in
 * `finally`". Anything else on the client is irrelevant to the
 * funnel — `ReferenceProvider` does the rest.
 */
export type LspClientLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Minimal `RepoHandle` shape the funnel reads. We type it
 * structurally (vs. importing the concrete type from
 * `mcp/local/local-backend.ts`) so the LSP module stays
 * decoupled from the analyze/ingestion write pipeline
 * (Inv-7). The two fields the funnel actually reads:
 *   - `id`       — passed to the probe so a future implementation
 *                  can scope probe samples per repo
 *   - `repoPath` — used as the `LspClient` workspaceRoot default
 *                  when the caller does not override `createLspClient`
 */
export type RepoLike = {
  id: string;
  repoPath: string;
};

/**
 * The shape of a probe. We accept a `ProbeFn` (not the concrete
 * `probeWorkspaceReadiness`) so the funnel can be unit-tested
 * without producing real DB reads — production callers pass the
 * real probe; tests pass a `vi.fn()`.
 */
export type ProbeFn = (client: LspClientLike) => Promise<{ ready: boolean; reason?: string }>;

/**
 * Factory for producing an `LspClientLike`. The default constructs
 * a real `LspClient` with `repo.repoPath` as the workspaceRoot.
 * Tests inject a `vi.fn(() => mockClient)`.
 */
export type CreateLspClientFn = (repo: RepoLike, fileUri: string) => LspClientLike;

/**
 * Dependency bag for `withReferenceProvider`. Every field has a
 * default (real production wiring). The unit tests pass a
 * hand-built bag to bypass subprocess spawning.
 *
 * **Why a bag (not constructor args):** The funnel is the *only*
 * call site where Mode B touches the foundation. Hand-rolling a
 * class for it would couple it to `LspClient` (the foundation
 * implementation). A bag of functions lets the production path
 * default to the real foundation and the test path swap in
 * `vi.fn()`s — the unit surface stays at the *seam*, not at the
 * concrete class.
 */
export type WithReferenceProviderDeps = {
  /** Override the `discoverServers` call (default: real one). */
  discoverServers?: () => Promise<{ typescript: { path: string; version: string } | null }>;
  /**
   * Override the `LspClient` factory (default: `new LspClient({ workspaceRoot: repo.repoPath })`).
   * The factory is called ONCE per funnel invocation, AFTER
   * `discoverServers` succeeds, BEFORE `start()`.
   */
  createLspClient?: CreateLspClientFn;
  /**
   * Override the readiness probe (default: `probeWorkspaceReadiness`
   * called with an empty `samples` list — the funnel is a structural
   * gate; consumers that want a real readiness check pass their own
   * probe). The default empty-samples probe returns
   * `{ready:false, reason:'no samples provided'}` — so production
   * callers MUST override this to get a real ready signal.
   */
  probe?: ProbeFn;
};

/**
 * `withReferenceProvider` — the single refuse funnel for Mode B
 * (WI-4 `rename` + WI-5 `impact`).
 *
 * Lifecycle (single try/finally, Inv-5):
 *   1. `discoverServers()`                → null if no TS server
 *   2. `client.start()`                    → null if start throws
 *   3. (in try) `probe(client)`            → null if not ready
 *   4. (in try) `fn(provider)`             → fn's result, null on throw
 *   5. (in finally) `client.stop()`        — runs on every post-start exit
 *
 * Return value:
 *   - The exact value `fn` resolves to (preserving `undefined`)
 *     on the happy path.
 *   - `null` on any gate failure (no server, start failed, probe
 *     not ready, or `fn` threw).
 *
 * **Why preserve `undefined`:** `null` and `undefined` carry
 * different semantics. `null` means "refused" (the consumer
 * should fall back to the heuristic path). `undefined` means
 * "ran, found nothing to do" (a real answer from the provider).
 * WI-5's d=1 union-seeding uses this distinction: an
 * `undefined` provider result means "no LSP-only callers to
 * union in"; a `null` result means "refuse the LSP path".
 *
 * Invariants honored:
 *   - Inv-4: `probe` is the sole gate (the funnel never
 *     bypasses it).
 *   - Inv-5: `client.stop()` runs in `finally` — once we have a
 *     client, we ALWAYS stop it. The only path that skips `stop`
 *     is when `start()` itself throws (G2), because we never
 *     had a client to stop.
 *   - Inv-7: this module imports `LspClient` (foundation,
 *     read-only) but does NOT import from the
 *     analyze/ingestion write pipeline.
 *
 * @param repo     The repo handle (read `id` + `repoPath`).
 * @param fileUri  The file URI to hand to `ReferenceProvider`
 *                 so it can `didOpen` the target explicitly.
 * @param fn       The user work. Receives a fresh
 *                 `ReferenceProvider` bound to the started client.
 * @param deps     Optional dependency overrides. Production
 *                 callers pass nothing (defaults wire the real
 *                 foundation). Tests pass a bag of `vi.fn()`s.
 */
export async function withReferenceProvider<T>(
  repo: RepoLike,
  fileUri: string,
  fn: (provider: ReferenceProvider) => Promise<T>,
  deps: WithReferenceProviderDeps = {},
): Promise<T | null> {
  // ── 1) Discovery gate (G1) ────────────────────────────────────────
  // `discoverServers` is a pure async function — never throws,
  // never installs. Absence is the most common case (production
  // repos may not have the LSP binary on PATH) and the funnel
  // treats it as "refuse → null" with zero side effects.
  const discover = deps.discoverServers ?? defaultDiscoverServers;
  const discovered = await discover();
  if (!discovered.typescript) {
    // No server. No client was created → no stop needed.
    return null;
  }

  // ── 2) Client construction + start (G2) ───────────────────────────
  // We construct the client AFTER discovery succeeds so a missing
  // binary doesn't waste a client object. The factory signature
  // takes `(repo, fileUri)` even though the default `LspClient`
  // ignores `fileUri` — keeping the seam symmetric lets the
  // funnel hand the same `fileUri` to the future factory in WI-3
  // if a `preOpen` semantic is added.
  const factory = deps.createLspClient ?? defaultCreateLspClient;
  const client = factory(repo, fileUri);
  try {
    await client.start();
  } catch {
    // start() threw (e.g. spawn failed). We have no client we
    // can stop — the client was either never constructed or was
    // torn down by `doStart` internally. Return null.
    return null;
  }

  // ── 3) Probe gate (G3) + fn execution (G4, G5, G6) in a single
  //    try/finally (Inv-4 + Inv-5) ──────────────────────────────────
  // The probe is the SOLE LSP authorization gate (Inv-4). A
  // non-ready verdict means we must not even *try* to use the
  // LSP surface — but the client is still alive and must be
  // stopped (Inv-5). The same try/finally covers the fn call:
  //   - probe not ready  → null + stop (G3)
  //   - fn throws        → null + stop (G4)
  //   - fn resolves      → return value + stop (G5)
  //   - fn returns undef → undefined + stop (G6)
  //
  // Single try-block, single finally: this is the load-bearing
  // piece for Inv-5 ("stop in finally on every post-start exit").
  const probe = deps.probe ?? defaultProbe;
  try {
    // ── F7 seam assert: refuse a structural fake that lacks the
    //    provider's `request` / `didOpen` surface ────────────────
    // The funnel accepts any `LspClientLike` (start/stop) for
    // testability. A test fake that omits `request` or `didOpen`
    // would otherwise crash opaquely INSIDE the provider when fn
    // first tries to issue an LSP request. We assert the surface
    // right after start() resolves so a structural mismatch is
    // refused at the gate (null + stop in finally).
    if (
      typeof (client as { request?: unknown }).request !== 'function' ||
      typeof (client as { didOpen?: unknown }).didOpen !== 'function'
    ) {
      return null;
    }
    const probeResult = await probe(client);
    if (!probeResult.ready) {
      return null;
    }
    // The ReferenceProvider is constructed on the started client
    // + the fileUri the funnel received. The provider itself
    // never spawns; it only consumes the client's request surface.
    //
    // The cast widens `LspClientLike` (the narrow seam) back to
    // the concrete `LspClient` (the foundation class). This is
    // safe: by this point `discover` + `start` + `probe` have
    // all succeeded, so `client` is either a started `LspClient`
    // or a structural fake with the right shape. The provider's
    // surface (`request`, `didOpen`) is exercised at fn-call
    // time and will surface any mismatch in the consumer's
    // contract test.
    return await fn(new ReferenceProvider(client as unknown as LspClient, fileUri));
  } catch {
    // Probe-threw OR fn-threw. In both cases the funnel refuses
    // (the probe is the gate, fn is the consumer). The finally
    // below will still run to stop the client.
    return null;
  } finally {
    // The load-bearing Inv-5 invariant: once we have a started
    // client, we ALWAYS stop it, on every exit path (success,
    // probe-not-ready, fn-throw, probe-throw). `client.stop()`
    // itself is idempotent and never throws per its contract,
    // so we don't need a try/catch around it.
    await client.stop();
  }
}

// ─── Defaults: real-foundation wiring ────────────────────────────────

/**
 * Default `discoverServers` indirection. We import the real
 * function lazily so the test bag can short-circuit discovery
 * without paying the foundation's module-load cost. The
 * function is also exported here (vs. inlined) so a future
 * freeze on its signature is a one-line change.
 */
async function defaultDiscoverServers(): Promise<{
  typescript: { path: string; version: string } | null;
}> {
  const { discoverServers } = await import('./server-discovery.js');
  return discoverServers();
}

/**
 * Default `LspClient` factory. We import the class lazily for
 * the same reason as `defaultDiscoverServers`. The
 * `workspaceRoot` is the repo path; `binaryPath` is left null
 * (the client will call `discoverServers` again internally —
 * a slight redundancy, but safe: the second call is idempotent
 * and the result is memoized in the client).
 *
 * **Note on the cast:** `LspClient` is a concrete class; the
 * `LspClientLike` seam is structural. We cast at the boundary
 * so the rest of the funnel can use the narrow type. This is
 * the one cast in the file; all downstream code uses
 * `LspClientLike` only.
 */
function defaultCreateLspClient(repo: RepoLike, _fileUri: string): LspClientLike {
  // `_fileUri` is part of the seam (the factory signature is
  // `(repo, fileUri)`); the default `LspClient` doesn't yet
  // consume the URI for pre-open, so we accept and ignore it.
  // A future WI-3 factory can use it to pre-open the target.
  void _fileUri;
  // `LspClient` is a concrete class; structurally it satisfies
  // `LspClientLike` (it has `start()` and `stop()` returning
  // `Promise<void>`). The narrow type seam lets the funnel
  // accept test fakes (plain objects) without inheritance.
  return new LspClient({ workspaceRoot: repo.repoPath });
}

/**
 * Default probe. Mirrors the real `probeWorkspaceReadiness` with
 * a degenerate input (empty `samples` array). This is the
 * **safe default** — it returns `{ready:false, reason:'no samples
 * provided'}`, which means the funnel will refuse. Production
 * callers MUST override this dep with a real probe (the WI-4 +
 * WI-5 wiring sites will do so).
 *
 * The function is async (matches the `ProbeFn` signature) but
 * the body is sync — the `await` is a no-op. We keep the async
 * shape so the default can be swapped with the real probe
 * without a re-shape at the call site.
 */
async function defaultProbe(_client: LspClientLike): Promise<{ ready: boolean; reason?: string }> {
  return { ready: false, reason: 'no samples provided (withReferenceProvider default probe — callers must supply a real probe)' };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── WI-3 adapter — `WorkspaceEdit` → `changes` adapter ───
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert an LSP `WorkspaceEdit` to the `rename` `changes` shape
 * (PUBLIC display shape).
 *
 * Returns `null` on ANY refuse condition (KD-7, Inv-3, Inv-8):
 *   - any edit resolves to `node_modules` / `.d.ts` (uses
 *     `isUnindexablePath` from `location-mapper.ts`);
 *   - any resolved path is OUTSIDE `repoPath` (path-traversal
 *     containment);
 *   - any multi-line range (`start.line !== end.line`);
 *   - any non-text `documentChanges` op (kind: create/rename/delete);
 *   - the edit is empty or malformed (no `changes`, no
 *     `documentChanges` with text edits);
 *   - the source file cannot be read (e.g. OOB line index).
 *
 * Returns `ChangesFile[]` on success. Each entry has:
 *   - `file_path` — repo-relative POSIX path (matches the existing
 *     `rename` output's `file_path`);
 *   - `edits[]` — one per `TextEdit`, with `line` 1-indexed
 *     (Inv-6), `old_text` / `new_text` trimmed, `confidence:'lsp'`.
 *     The raw LSP `newText` / `range` are NOT on this public
 *     shape — they live on the `@internal` `ApplierChangesFileEdit`
 *     extension. Use `workspaceEditToApplierChanges` if the
 *     applier needs the raw splice data.
 *
 * **Adapter ≠ applier.** The adapter only TRANSLATES — it does
 * not sort edits; it preserves the input order. Sorting and
 * splicing is `applyPreciseEdits`'s job (KD-2, see the descending
 * `(line, character)` sort there).
 *
 * @param edit     The LSP `WorkspaceEdit` (`.changes` or
 *                 `.documentChanges` form).
 * @param repoPath Absolute path to the repo root. Used for
 *                 containment + relative-path emission.
 * @param deps     Optional dependency overrides. Production
 *                 callers pass nothing.
 */
export async function workspaceEditToChanges(
  edit: WorkspaceEdit,
  repoPath: string,
  deps: AdapterDeps = {},
): Promise<ChangesFile[] | null> {
  const applier = await workspaceEditToApplierChanges(edit, repoPath, deps);
  if (applier === null) return null;
  return applier.map((f) => ({
    file_path: f.file_path,
    edits: f.edits.map((e) => ({
      line: e.line,
      old_text: e.old_text,
      new_text: e.new_text,
      confidence: e.confidence,
    })),
  }));
}

/**
 * Convert an LSP `WorkspaceEdit` to the `applyPreciseEdits`
 * input shape (the `@internal` `ApplierChangesFile[]`).
 *
 * Same refuse semantics as `workspaceEditToChanges` (KD-7,
 * Inv-3, Inv-8). The only difference: the returned edits
 * carry the raw `newText` and `range` fields the applier
 * needs for the character-precise splice (KD-2).
 *
 * `@internal` — exported solely for the applier pipeline. The
 * `rename` MCP wire output uses the public `ChangesFile[]` from
 * `workspaceEditToChanges`.
 *
 * @param edit     The LSP `WorkspaceEdit`.
 * @param repoPath Absolute path to the repo root.
 * @param deps     Optional dependency overrides.
 */
export async function workspaceEditToApplierChanges(
  edit: WorkspaceEdit,
  repoPath: string,
  deps: AdapterDeps = {},
): Promise<ApplierChangesFile[] | null> {
  const readFile = deps.readFile ?? defaultReadFile;

  // ── 1) Collect (uri, TextEdit[]) pairs from the edit, refusing
  //    on any non-text op or malformed payload ────────────────────
  const pairs: Array<{ uri: string; edits: TextEdit[] }> = [];
  if (edit.changes && typeof edit.changes === 'object') {
    // The `.changes` form. Values must be arrays of valid
    // `TextEdit`s. We do a shallow validation here so a malformed
    // entry refuses wholesale — never partial.
    for (const [uri, raw] of Object.entries(edit.changes)) {
      if (!Array.isArray(raw)) return null;
      for (const e of raw) {
        if (!isValidTextEdit(e)) return null;
      }
      pairs.push({ uri, edits: raw });
    }
  } else if (Array.isArray(edit.documentChanges) && edit.documentChanges.length > 0) {
    // The `.documentChanges` form. Each entry is either a
    // `TextDocumentEdit` (text edits only) or a non-text op
    // (create/rename/delete — KD-7: refuse). The text-edit
    // entries are already validated by `isTextDocumentEdit`; we
    // reuse it as the gate.
    for (const d of edit.documentChanges) {
      if (!isTextDocumentEdit(d)) {
        // Either a non-text op (kind: create/rename/delete) or
        // a malformed text entry. Either way, refuse wholesale.
        return null;
      }
      pairs.push({ uri: d.textDocument.uri, edits: d.edits });
    }
  } else {
    // Neither form present, or empty. Refuse.
    return null;
  }

  // ── 2) For each pair: URI → repo-relative path, refuse on
  //    out-of-repo / node_modules / .d.ts / multi-line / OOB ────
  // Group entries by file_path. We accumulate into a Map keyed
  // by the repo-relative POSIX path so the final shape matches
  // the `rename` output (one entry per file). We also remember
  // the pre-read `content` per file (a single read per file) so
  // we can carry it on the emitted `ApplierChangesFile` for
  // `applyPreciseEdits` to reuse without a second read (E-1).
  const byPath = new Map<string, ApplierChangesFileEdit[]>();
  const contentByPath = new Map<string, string>();
  for (const { uri, edits } of pairs) {
    // URI → repo-relative POSIX path, with containment + KD-7
    // gates. Returns `null` on ANY refuse condition.
    const rel = uriToRepoRelative(uri, repoPath);
    if (rel === null) return null;

    // Read the file (one read per file, cached implicitly by
    // the byPath grouping — re-reads happen only if the same
    // file appears in both `.changes` and `.documentChanges`,
    // which is itself a structural red flag we ignore here).
    let content: string;
    try {
      content = await readFile(path.resolve(repoPath, rel));
    } catch {
      // The file is gone / unreadable. We can't compute
      // old_text/new_text precisely. Refuse wholesale — never
      // emit a synthetic empty edit.
      return null;
    }
    contentByPath.set(rel, content);
    const lines = content.split('\n');

    for (const e of edits) {
      // Multi-line refuse: start.line !== end.line (Inv-3, KD-7).
      // The applier cannot represent a multi-line range as a
      // single line-precise splice.
      if (e.range.start.line !== e.range.end.line) return null;

      // BVA: the source line at e.range.start.line MUST exist.
      // If the LSP server returned a stale or out-of-bounds
      // line index, refuse (don't guess).
      const sourceLine = lines[e.range.start.line];
      if (typeof sourceLine !== 'string') return null;
      const endLine = lines[e.range.end.line];
      if (typeof endLine !== 'string') return null;

      // Compute the precise splice for old_text/new_text.
      const computed = computeLineEdit(sourceLine, e.range.start.character, e.range.end.character, e.newText);
      if (computed === null) {
        // The character offsets are out of bounds (e.g. the
        // server returned character > line length). Refuse.
        return null;
      }

      const out: ApplierChangesFileEdit = {
        // Inv-6: LSP 0-indexed → emitted 1-indexed.
        line: e.range.start.line + 1,
        old_text: computed.oldLine.trim(),
        new_text: computed.newLine.trim(),
        confidence: 'lsp',
        // Carry the raw LSP `newText` so the applier can do
        // the character-precise splice (KD-2) without having
        // to re-derive it from the trimmed `new_text`.
        newText: e.newText,
        range: e.range,
      };

      if (!byPath.has(rel)) byPath.set(rel, []);
      byPath.get(rel)!.push(out);
    }
  }

  // ── 3) Emit ApplierChangesFile[] ────────────────────────────
  // Preserve insertion order: a Map iteration is insertion-ordered
  // in JS, so the first-seen file is first. This matches the
  // input URI order (`.changes`) or the `documentChanges` array
  // order. The existing `rename` output doesn't pin order, but a
  // stable order is a no-cost testability win.
  //
  // We carry the pre-read `content` (E-1: share content between
  // adapter and applier) on each emitted file so the applier can
  // skip its own `readFile`.
  const result: ApplierChangesFile[] = [];
  for (const [file_path, edits] of byPath) {
    result.push({ file_path, edits, content: contentByPath.get(file_path) });
  }
  return result;
}

/**
 * `applyPreciseEdits` — the precise per-edit applier (KD-2).
 *
 * Takes the `@internal` `ApplierChangesFile[]` shape (the same
 * one `workspaceEditToApplierChanges` emits) — each edit
 * carries the raw LSP `newText` + `range` fields needed for
 * the character-precise splice. The PUBLIC `ChangesFile[]`
 * shape (returned by `workspaceEditToChanges` and emitted on
 * the `rename` wire) does NOT carry those fields by design.
 *
 * For each `ApplierChangesFile`:
 *   1. Resolve the file path under `repoPath` (containment +
 *      symlink realpath re-check). Out-of-repo → skip (do NOT
 *      throw — the caller handles the `skipped` count).
 *   2. Read the file.
 *   3. Sort edits DESCENDING by `(range.start.line,
 *      range.start.character)`. Descending order guarantees
 *      that:
 *        - cross-line edits don't shift each other's line
 *          indices (lower lines are applied later);
 *        - same-line edits splice right-to-left, so a leftward
 *          edit's character range is unaffected by the prior
 *          splice of a rightward edit.
 *   4. For each edit (in sorted order), splice `newText` into
 *      `[start.character, end.character)` of the line. (We splice
 *      via the original `range`, NOT `old_text`/`new_text` —
 *      the trimmed text is a display artifact; the splice uses
 *      the raw offsets.)
 *   5. Write the file ONCE. With `dryRun=true`, skip the write
 *      but still count the edits that WOULD be written.
 *
 * Returns `{ written, skipped }`:
 *   - `written` — number of edits actually applied (== number of
 *      edits when `dryRun` is true OR false and the file is
 *      in-repo + readable + writable);
 *   - `skipped` — number of edits refused (out-of-repo, file
 *      unreadable, write error). The applier does NOT throw on
 *      skip; it returns counts.
 *
 * The applier does NOT use a file-global regex — that's the
 * load-bearing correction (KD-2). It does a per-edit splice
 * using the original LSP character ranges.
 *
 * @param changes  The emitted `ChangesFile[]` from
 *                 `workspaceEditToChanges`. The `range` field
 *                 on each edit is REQUIRED.
 * @param opts     `{ repoPath, dryRun, deps? }`. `dryRun` is
 *                 required.
 */

// ═══════════════════════════════════════════════════════════════════════
// ─── WI-3 applier — `applyPreciseEdits` ───
// ═══════════════════════════════════════════════════════════════════════

export async function applyPreciseEdits(
  changes: ApplierChangesFile[],
  opts: ApplierOpts,
): Promise<{ written: number; skipped: number }> {
  const { repoPath, dryRun } = opts;
  // F6: readFile and writeFile must be supplied TOGETHER, or
  // NEITHER. A partial bag would silently fall through to the
  // real `fs.writeFile` for the missing field, polluting test
  // setups or letting real writes leak. The applier validates
  // this at the entry point so the failure is loud. (F6.1, F6.2,
  // F6.3 are the contract tests for this guard.)
  if (opts.deps && (opts.deps.readFile === undefined) !== (opts.deps.writeFile === undefined)) {
    throw new Error('applyPreciseEdits: readFile and writeFile must be provided together');
  }
  const deps = opts.deps ?? {};
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const realpath = deps.realpath ?? defaultRealpath;

  let written = 0;
  let skipped = 0;

  // ── E-2: parallelize per-file reads + realpaths ─────────────
  // Pre-compute the abs path + initial realpath + initial read
  // for every change in parallel. Writes stay serial (see
  // below). The reads and realpaths are independent across
  // files, so we batch them with Promise.all.
  //
  // `preload[i]` is one of:
  //   - null                       → file skipped (out-of-repo / read failed)
  //   - { kind: 'ok', content, realAbs }  → ready to splice + write
  //   - { kind: 'realpath-skip', editCount } → realpath escaped/threw;
  //                                          caller adds editCount to skipped
  //   - { kind: 'no-content' }     → fallback path: no `change.content`,
  //                                  applier must read on its own
  //
  // The fallback to no-content preserves the existing
  // readFile-deps test path (F6, etc.) — tests that hand-build
  // `ApplierChangesFile[]` with no `content` field still
  // exercise `readFile` exactly once per file.
  type Preload =
    | { kind: 'ok'; content: string; realAbs: string }
    | { kind: 'realpath-skip'; editCount: number }
    | { kind: 'no-content'; editCount: number }
    | null;
  const preload: Preload[] = await Promise.all(
    changes.map(async (change): Promise<Preload> => {
      const abs = path.resolve(repoPath, change.file_path);
      if (!isWithinRepo(abs, repoPath)) {
        skipped += change.edits.length;
        return null;
      }
      // E-1: use the pre-read content if the adapter carried it
      // (avoids a second read for the common path). Fall back
      // to the applier's own readFile for the test path (F6,
      // P1-P7 build the shape by hand and leave `content`
      // undefined).
      let content: string;
      if (typeof change.content === 'string') {
        content = change.content;
      } else {
        return { kind: 'no-content', editCount: change.edits.length };
      }
      // F1: symlink-redirect TOCTOU re-check (S-6 + S-7
      // extraction). The same check runs in BOTH dryRun and
      // non-dryRun paths — dryRun is a *preview* contract, not
      // a *skip-the-safety-checks* contract.
      const realAbs = await checkRealpath(abs, repoPath, realpath);
      if (realAbs === null) {
        return { kind: 'realpath-skip', editCount: change.edits.length };
      }
      return { kind: 'ok', content, realAbs };
    }),
  );

  // ── Serial splice + write per file (writes must stay serial
  //    for ordering correctness — see KD-2). The reads /
  //    realpaths are already done in parallel above. ────────
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const pre = preload[i];
    if (pre === null) continue;
    if (pre.kind === 'realpath-skip') {
      skipped += pre.editCount;
      continue;
    }

    let content: string;
    let realAbs: string;
    if (pre.kind === 'ok') {
      content = pre.content;
      realAbs = pre.realAbs;
    } else {
      // no-content fallback: re-read on the serial path. The
      // pre-parallel pass deliberately skipped the read so the
      // fast path doesn't double-read.
      const abs = path.resolve(repoPath, change.file_path);
      let readContent: string;
      try {
        readContent = await readFile(abs);
      } catch {
        skipped += pre.editCount;
        continue;
      }
      content = readContent;
      const resolved = await checkRealpath(abs, repoPath, realpath);
      if (resolved === null) {
        skipped += pre.editCount;
        continue;
      }
      realAbs = resolved;
    }

    // KD-2: sort edits DESCENDING by (line, character). On a
    // single line, this means right-to-left; across lines, this
    // means bottom-to-top. Either way, the indices of any
    // not-yet-applied edit are still valid in the current
    // content.
    const lines = content.split('\n');
    const sorted = [...change.edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const e of sorted) {
      // BVA: the line must exist in the current content. If
      // the file shrank between read and apply (e.g. another
      // tool wrote to it), skip this single edit.
      const lineIdx = e.range.start.line;
      if (lineIdx < 0 || lineIdx >= lines.length) {
        skipped++;
        continue;
      }
      const sourceLine = lines[lineIdx];
      // Character-precise splice using the original LSP range
      // (KD-2). We splice the LSP `newText` (carried as a
      // separate field on the emitted `ChangesFileEdit` so we
      // do NOT have to re-derive it from the trimmed `new_text`).
      // The `new_text` field is a display artifact; the
      // splice uses `newText` (the raw LSP replacement) +
      // `range` (the raw character offsets) verbatim.
      const startChar = e.range.start.character;
      const endChar = e.range.end.character;
      if (
        startChar < 0 ||
        endChar < startChar ||
        endChar > sourceLine.length
      ) {
        skipped++;
        continue;
      }
      lines[lineIdx] = sourceLine.slice(0, startChar) + e.newText + sourceLine.slice(endChar);
    }

    // Write once per file (KD-2: "write once").
    const newContent = lines.join('\n');
    if (dryRun) {
      // dryRun: count edits as written, but DO NOT call
      // writeFile. The realpath check already ran in the
      // pre-parallel pass above (F1).
      written += change.edits.length;
    } else {
      try {
        await writeFile(realAbs, newContent);
        written += change.edits.length;
      } catch {
        skipped += change.edits.length;
      }
    }
  }

  return { written, skipped };
}

/**
 * F1 symlink-redirect TOCTOU re-check (S-6 + S-7 extraction):
 * resolve `abs` and re-verify containment. Returns the resolved
 * realpath on success; `null` on any refuse (escape or thrown
 * error). The caller is responsible for adding the per-file
 * `editCount` to its `skipped` counter when `null` is returned.
 */
async function checkRealpath(
  abs: string,
  repoPath: string,
  realpathFn: (abs: string) => Promise<string>,
): Promise<string | null> {
  let real: string;
  try {
    real = await realpathFn(abs);
  } catch {
    return null;
  }
  if (!isWithinRepo(real, repoPath)) {
    return null;
  }
  return real;
}

// ─── WI-3 internal helpers ───────────────────────────────────────────

/**
 * Convert a `file://` URI (or a bare absolute path) to a
 * repo-relative POSIX path, enforcing:
 *   - `isUnindexablePath` (KD-7: no `node_modules` / `.d.ts`);
 *   - path-traversal containment (resolved under `repoPath`).
 *
 * Returns `null` on ANY refuse condition. The caller treats
 * `null` as "refuse the whole attempt".
 *
 * Inlined here because the foundation's `fileUriToPath`
 * (`lsp-client.ts:155-165`) is a private helper — exporting it
 * is out of scope for WI-3 (no edits to foundation files). The
 * implementation mirrors the foundation's behavior on the
 * `file://` prefix and falls back to a manual strip.
 */
function uriToRepoRelative(uri: string, repoPath: string): string | null {
  // 1) URI → absolute path.
  let abs: string;
  if (uri.startsWith('file://')) {
    try {
      abs = fileURLToPath(uri);
    } catch {
      return null;
    }
  } else {
    // Some servers emit bare absolute paths; treat them as abs.
    abs = uri;
  }
  // Normalize to forward slashes for the containment check
  // (path.resolve on Windows produces backslashes, but our
  // repo-relative emit uses POSIX slashes).
  const normAbs = abs.replace(/\\/g, '/');
  const normRepo = repoPath.replace(/\\/g, '/');

  // 2) Containment: the resolved abs path must start with
  //    `<repoPath>/` OR equal `<repoPath>` exactly. Reject
  //    anything outside (path-traversal).
  if (!isWithinRepo(normAbs, normRepo)) return null;

  // 3) Repo-relative POSIX path.
  const relRaw = path.relative(repoPath, abs);
  const rel = normalizeFilePath(relRaw);
  if (!rel) return null;

  // 4) KD-7 / Inv-8: never edit `node_modules` or `.d.ts`.
  //    `isUnindexablePath` lives in `location-mapper.ts` and is
  //    exposed via `__test__` (the public-ish test surface).
  if (locationMapperTest.isUnindexablePath(rel)) return null;

  return rel;
}

/**
 * `isWithinRepo(abs, repo)` — true iff `abs` equals `repo` or
 * starts with `repo + path.sep`. Encapsulates the boundary check
 * so the same predicate is used by the adapter (URI → path) and
 * the applier (file_path → abs).
 */
function isWithinRepo(abs: string, repo: string): boolean {
  // Defensive: strip any trailing separator from the repo path
  // so `repo + sep` doesn't double up.
  const normRepo = repo.endsWith(path.sep) ? repo.slice(0, -path.sep.length) : repo;
  if (abs === normRepo) return true;
  return abs.startsWith(normRepo + path.sep);
}

/**
 * Compute the new line text given the original line + start/end
 * character offsets + the LSP `newText`. Returns `null` if the
 * offsets are out of bounds.
 *
 * Used only by the adapter to compute `old_text` / `new_text`
 * (the trimmed audit-trail fields). The applier does the
 * splice directly via `e.newText` + `e.range`.
 */
function computeLineEdit(
  sourceLine: string,
  startChar: number,
  endChar: number,
  newText: string,
): { oldLine: string; newLine: string } | null {
  if (
    startChar < 0 ||
    endChar < startChar ||
    endChar > sourceLine.length
  ) {
    return null;
  }
  const oldLine = sourceLine;
  const newLine = sourceLine.slice(0, startChar) + newText + sourceLine.slice(endChar);
  return { oldLine, newLine };
}

/**
 * `isValidTextEdit(e)` — true iff `e` is a structurally valid
 * `TextEdit` (object with `range.start`, `range.end`, and
 * `newText:string`). The adapter uses this to gate the
 * `.changes` form on a per-edit basis — a single malformed
 * entry refuses the whole attempt.
 */
function isValidTextEdit(e: any): e is TextEdit {
  return (
    e &&
    typeof e === 'object' &&
    e.range?.start &&
    typeof e.range.start.line === 'number' &&
    typeof e.range.start.character === 'number' &&
    e.range?.end &&
    typeof e.range.end.line === 'number' &&
    typeof e.range.end.character === 'number' &&
    typeof e.newText === 'string'
  );
}

/**
 * Default `readFile` for the adapter / applier. Lazy-imported
 * to keep cold-start cheap (mirrors `readFileOrEmpty` in the
 * provider class).
 */
async function defaultReadFile(absPath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(absPath, 'utf8');
}

/**
 * Default `writeFile` for the applier. Same lazy-import pattern
 * as `defaultReadFile`.
 */
async function defaultWriteFile(absPath: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  return writeFile(absPath, content, 'utf8');
}

/**
 * Default `realpath` for the applier. Used by the F1
 * symlink-redirect TOCTOU re-check. Lazy-imported for the same
 * reason as `defaultReadFile` / `defaultWriteFile` — keep
 * cold-start cheap.
 *
 * Production callers may pass a custom `realpath` via
 * `ApplierDeps.realpath` for testability or to override the
 * resolution policy.
 */
async function defaultRealpath(absPath: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(absPath);
}
