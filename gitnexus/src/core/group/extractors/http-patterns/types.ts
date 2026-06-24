import type Parser from 'tree-sitter';

/**
 * Shared types for the http-route-extractor language plugins.
 *
 * Each plugin lives in its own file (java.ts, node.ts, ...) and owns
 * the tree-sitter grammar import + queries. The top-level
 * `http-route-extractor.ts` orchestrator only knows about this type
 * module and the plugin registry (`./index.ts`). It MUST NOT import
 * any grammar or query text directly — language-specific knowledge
 * belongs in the plugins.
 */

export type HttpRole = 'provider' | 'consumer';

/**
 * One raw HTTP detection produced by a plugin's `scan()` function. The
 * orchestrator converts this into a full `ExtractedContract` by running
 * path normalization and building the contract id.
 *
 * `path` is the raw literal string as it appeared in source (with
 * `${...}` template placeholders still in place); the orchestrator
 * runs the appropriate normalizer for provider vs. consumer paths.
 */
export interface HttpDetection {
  role: HttpRole;
  /** Short framework label, e.g. `'spring'`, `'nest'`, `'express'`. */
  framework: string;
  /** HTTP method in upper case (`'GET'`, `'POST'`, ...). */
  method: string;
  /** Raw path literal as seen in source (template placeholders intact). */
  path: string;
  /**
   * Symbol name of the handler (for providers) or calling function
   * (for consumers) when the plugin can determine it structurally.
   * Null when no good candidate is available.
   */
  name: string | null;
  /**
   * 1-based source line of the call/registration site (the `fetch(...)` for
   * consumers, the `router.get(...)` / decorator for providers). Lets the
   * extractor resolve the contract to the *containing* symbol (the function
   * the call lives in) via line-span containment, so HTTP contracts carry a
   * real `symbolUid` instead of an empty one. Optional — a plugin that does
   * not set it falls back to file-level boundary resolution downstream.
   */
  line?: number;
  /**
   * When the handler is an IMPORTED symbol, the import resolved to its declared
   * (exported) `name` and the `module` specifier it came from. The extractor
   * pins resolution to the import's target file, so an aliased import
   * (`import { listUsers as handleUsers }`) or a name that collides with a local
   * symbol resolves to the right handler instead of a same-named decoy. `name`
   * here is the DECLARED export name (not the local alias); `module` is the raw
   * specifier (e.g. `./handlers/users`). Set only for named imports; omitted for
   * locally-defined or anonymous handlers.
   */
  handlerImport?: { name: string; module: string };
  /** Confidence in (0, 1]. Source-scan plugins typically use 0.7–0.8. */
  confidence: number;
}

export interface HttpScanInput {
  filePath: string;
  tree: Parser.Tree;
}

export interface HttpFileDetections {
  filePath: string;
  detections: HttpDetection[];
}

/**
 * One language-scoped HTTP plugin. The plugin owns the tree-sitter
 * grammar and the `scan` function that translates a parsed tree into
 * zero or more `HttpDetection`s. Plugins are free to run multiple
 * compiled pattern bundles internally (see the shared scanner's
 * `runCompiledPatterns` helper).
 *
 * `language` is typed as `unknown` for the same reason as
 * `LanguagePatterns.language` in `tree-sitter-scanner.ts` — the
 * grammar modules export different shapes.
 */
/**
 * Per-repo state a plugin can build during a `prepareRepo` pass before
 * any per-file `scan` is invoked. The orchestrator threads this opaque
 * value back into each `scan` call so plugins can resolve cross-file
 * facts (e.g. FastAPI `app.include_router(prefix=...)` mappings live
 * in `main.py` but apply to handlers declared in `api/*.py`).
 *
 * Plugins that have no cross-file state can omit `prepareRepo` and
 * receive `undefined`.
 */
export type RepoContext = unknown;

export interface HttpLanguagePlugin {
  /** Human-readable plugin name for diagnostics. */
  name: string;
  /** tree-sitter grammar object (passed to the shared parser). */
  language: unknown;
  /**
   * Whether ingestion is known to emit a `Route` graph node for EVERY
   * provider route in this language (Spring/FastAPI/Laravel annotations are
   * extracted into Route nodes during parse). When `'complete'`, the
   * orchestrator may skip the source-scan + tree-sitter parse for a file whose
   * graph provider routes all resolved a handler symbol (#2138 Part 2) — the
   * graph is authoritative, the scan would only re-discover the same routes.
   *
   * Defaults to `'partial'` (the safe assumption): the source scan always runs,
   * so a language whose ingestion coverage is incomplete never loses routes.
   * This is a deliberate, per-language trust assertion — set it only for
   * languages whose route ingestion is provably complete.
   */
  routeCoverage?: 'complete' | 'partial';
  /**
   * Cheap, parse-free pre-check used by the parse-skip optimization (#2138
   * Part 2). Given a file's raw source text, return `false` ONLY when the file
   * provably contains no outbound-HTTP (consumer) call that this plugin's
   * `scan()` would detect; return `true` on any doubt.
   *
   * Why it exists: `routeCoverage: 'complete'` asserts *provider* Route-node
   * completeness only. A provider-covered file may ALSO be a consumer (e.g. a
   * Spring `@RestController` that calls `restTemplate`/`webClient`, a Laravel
   * controller using Guzzle, a FastAPI handler calling `requests`/`httpx`).
   * Ingestion's `FETCHES` edges are JS/TS-only, so the graph cannot back up
   * those server-side consumers — they come solely from the source scan. The
   * orchestrator may therefore skip a provider-covered file's parse only when
   * this returns `false`; otherwise the file is still scanned so its consumer
   * contracts are not dropped.
   *
   * MUST be implemented by any plugin whose `scan()` can emit `'consumer'`
   * detections AND that declares `routeCoverage: 'complete'`; otherwise that
   * language's provider-covered files are never parse-skipped (safe, no win).
   * The check is intentionally conservative — over-matching only costs a parse
   * that could have been skipped; it never drops data.
   */
  hasConsumerSignals?(content: string): boolean;
  /**
   * Optional pre-pass: walk the relevant files in the repo and produce
   * an opaque context that `scan` can use to resolve cross-file facts.
   * Implementations must not throw — return undefined on any error so
   * the orchestrator falls back to context-less scanning.
   */
  prepareRepo?(args: {
    repoPath: string;
    files: string[];
    parser: Parser;
    readFile: (rel: string) => string | null;
    parseSource: (parser: Parser, src: string) => Parser.Tree | null;
  }): RepoContext | undefined;
  /**
   * Scan a parsed tree and return zero or more HTTP detections. Plugins
   * must not throw — they should swallow per-match errors so a single
   * malformed construct does not abort the whole file.
   *
   * `repoContext` is whatever the plugin's `prepareRepo` produced (or
   * `undefined` if there is no `prepareRepo`).
   *
   * `fileRel` is the repo-relative path of the file being scanned;
   * plugins that resolve cross-file facts (e.g. FastAPI router prefix
   * joining) need it to key into `repoContext`. Optional so existing
   * single-file plugins can keep their unary `scan(tree)` shape.
   */
  scan(tree: Parser.Tree, repoContext?: RepoContext, fileRel?: string): HttpDetection[];
  /**
   * Optional project-level scan hook for language rules that require
   * multiple files, such as Java controllers inheriting Spring mappings
   * from annotated interfaces.
   */
  scanProject?(files: readonly HttpScanInput[]): HttpFileDetections[];
}
