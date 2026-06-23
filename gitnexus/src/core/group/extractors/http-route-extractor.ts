import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { logger } from '../../logger.js';
import {
  getPluginForFile,
  HTTP_SCAN_GLOB,
  type HttpDetection,
  type HttpLanguagePlugin,
  type HttpScanInput,
} from './http-patterns/index.js';

/**
 * Language-agnostic orchestrator for HTTP route (provider + consumer)
 * contract extraction. Two strategies, in order of preference per role:
 *
 * 1. **Graph-assisted (Strategy A)** — if a per-repo LadybugDB executor
 *    is available, read `HANDLES_ROUTE` / `FETCHES` Cypher edges that
 *    the ingestion pipeline already produced via tree-sitter. This is
 *    the preferred path because the graph has richer symbol metadata
 *    (real uids, class/method structure, etc.).
 *
 * 2. **Source-scan supplement (Strategy B)** — parse files directly with
 *    the per-language plugin registry in `./http-patterns/`. Used to
 *    fill gaps when graph extraction only covers part of a polyglot repo
 *    (e.g. Java graph routes plus Go source-scan routes). Graph entries
 *    remain authoritative for duplicate contract IDs because they carry
 *    richer symbol metadata. Each plugin owns its tree-sitter grammar
 *    and query sources — this orchestrator imports NO grammars or query
 *    strings.
 *
 * Adding a new language for Strategy B is a one-file edit in
 * `http-patterns/index.ts`: register a new `HttpLanguagePlugin` and
 * widen `HTTP_SCAN_GLOB` if needed.
 */

// ─── Graph-assisted queries ──────────────────────────────────────────

// Exported so integration tests can run the exact production query against a
// real LadybugDB (guards the Route.method column contract — see
// route-method-roundtrip.test.ts).
export const HANDLES_ROUTE_QUERY = `
MATCH (handlerFile:File)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
RETURN handlerFile.id AS fileId, handlerFile.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       route.method AS routeMethod,
       route.handlerSymbolId AS handlerSymbolId,
       route.responseKeys AS responseKeys,
       r.reason AS routeSource`;
const FETCHES_QUERY = `
MATCH (callerFile:File)-[r:CodeRelation {type: 'FETCHES'}]->(route:Route)
RETURN callerFile.id AS fileId, callerFile.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       r.reason AS fetchReason`;

// Function/Method/CodeElement symbols (with line spans) in a file, addressed by
// repo-relative path so the source-scan paths — which have a path but no graph
// `fileId` — can resolve the symbol CONTAINING an HTTP call by line-span
// containment. Matched by `filePath` rather than a File-[DEFINES]->sym edge so
// it also reaches methods nested in classes (Java/Kotlin), where the File
// defines the class and the class defines the method.
const CONTAINING_QUERY = `
MATCH (sym:Function)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels
UNION ALL
MATCH (sym:Method)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels
UNION ALL
MATCH (sym:CodeElement)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels`;

// Repo-wide lookup of a symbol by exact name (label-union, as in
// manifest-extractor.ts). Used to resolve a provider's named handler when it is
// defined in a file OTHER than its route registration — and only honored when
// the result is unique (see resolveSymbolByNameUnique).
//
// `n.filePath <> ''` excludes synthetic non-source `CodeElement` nodes that
// carry no real file — ORM model/table nodes (orm.ts emits `filePath: ''`) and
// similar — so a handler name colliding with an ORM model neither resolves to a
// degenerate edge-less node NOR inflates the uniqueness count and masks the real
// handler. `LIMIT 2` bounds materialization: distinguishing unique (1) from
// ambiguous (>=2) never needs more than two rows (the count guard stays exact).
const RESOLVE_BY_NAME_QUERY = `
MATCH (n:Function|Method|CodeElement)
WHERE n.name = $name AND n.filePath <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

// Resolve an IMPORTED handler by pinning it to the import's target module: the
// declared export `$name` whose file is the module the handler was imported from
// (`$fileDot` matches `mod.ext`, `$fileSlash` matches `mod/index.ext`). This is
// the precise rung — it survives aliases and local same-name collisions that a
// repo-wide name lookup cannot, and only resolves on a unique match within that
// module. `LIMIT 2` keeps the uniqueness count exact (see RESOLVE_BY_NAME_QUERY).
const RESOLVE_IN_MODULE_QUERY = `
MATCH (n:Function|Method|CodeElement)
WHERE n.name = $name AND (n.filePath STARTS WITH $fileDot OR n.filePath STARTS WITH $fileSlash)
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

// Source-file extensions an import specifier may resolve to (stripped before
// building the module file-prefix so `./h/users` and `./h/users.ts` agree).
const SOURCE_EXT_RE = /\.(?:m|c)?[jt]sx?$/;

/**
 * Resolve an import specifier to a repo-relative FILE BASE (path without
 * extension) so the target module can be matched by `filePath STARTS WITH`.
 * Handles two relative-import dialects and returns null for bare/absolute
 * imports (which fall back to a repo-wide name lookup):
 *   - path-style (JS/TS): `./handlers/users`, `../x` → joined against the
 *     importing file's directory.
 *   - dotted-relative (Python): `.users`, `..pkg.users` → leading dots are
 *     package levels (one dot = the file's own package), the rest dot→slash.
 */
function resolveModuleBase(fromFile: string, module: string): string | null {
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  if (module.includes('/')) {
    // path-style relative import
    if (!module.startsWith('.')) return null;
    return path.posix.normalize(path.posix.join(dir, module)).replace(SOURCE_EXT_RE, '');
  }
  if (module.startsWith('.')) {
    // Python dotted-relative import
    const dots = module.length - module.replace(/^\.+/, '').length;
    const rest = module.slice(dots).replace(/\./g, '/');
    let base = dir;
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    return rest ? path.posix.normalize(path.posix.join(base, rest)) : base;
  }
  return null; // bare / absolute import — repo-wide fallback
}

interface ResolvedSymbol {
  uid: string;
  name: string;
  filePath: string;
}

/**
 * The innermost Function/Method whose `[startLine, endLine]` span contains
 * `line` — i.e. the symbol the HTTP call lives inside. For a consumer this is
 * the function making the `fetch`; for an inline-arrow provider it is the
 * handler arrow itself. Returns null when nothing encloses the line (e.g. a
 * route registered at module scope referencing a named handler defined
 * elsewhere — that case resolves by name instead).
 */
function resolveContainingSymbol(
  rows: Record<string, unknown>[],
  line: number,
): ResolvedSymbol | null {
  const norm = (x: unknown): string => String(x ?? '');
  // Detection lines are 1-based; symbol spans are stored 0-based for the
  // languages indexed today (parse-worker records `startPosition.row`). So the
  // base-correct probe is `line - 1`. Pick the INNERMOST (smallest-span) symbol
  // whose span contains the probe. Only if nothing contains `line - 1` do we
  // retry with the raw `line` — a defensive fallback for any future language
  // that stores 1-based spans. Probing `line - 1` first (rather than OR-ing both)
  // avoids the +1 slack mis-picking a one-line sibling that sits on `line`.
  const pick = (probe: number): ResolvedSymbol | null => {
    let best: ResolvedSymbol | null = null;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const labels = JSON.stringify(r.labels ?? r[5] ?? '');
      if (!['Function', 'Method', 'CodeElement'].some((l) => labels.includes(l))) continue;
      const start = Number(r.startLine ?? r[3]);
      const end = Number(r.endLine ?? r[4]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (probe < start || probe > end) continue;
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        best = {
          uid: norm(r.uid ?? r[0]),
          name: norm(r.name ?? r[1]),
          filePath: norm(r.filePath ?? r[2]),
        };
      }
    }
    return best && best.uid ? best : null;
  };
  return pick(line - 1) ?? pick(line);
}

/** A Function/Method in the file matching `name` exactly (for named handlers). */
function resolveSymbolByName(rows: Record<string, unknown>[], name: string): ResolvedSymbol | null {
  const norm = (x: unknown): string => String(x ?? '');
  for (const r of rows) {
    const labels = JSON.stringify(r.labels ?? r[5] ?? '');
    if (!['Function', 'Method', 'CodeElement'].some((l) => labels.includes(l))) continue;
    if (norm(r.name ?? r[1]) !== name) continue;
    const uid = norm(r.uid ?? r[0]);
    if (uid) return { uid, name, filePath: norm(r.filePath ?? r[2]) };
  }
  return null;
}

// ─── Path normalization (shared between provider / consumer paths) ──

/**
 * Canonicalize a provider-side HTTP path for contract-id generation:
 *   - strip query string
 *   - lower-case
 *   - drop trailing slash
 *   - collapse `:id`, `{id}`, `[id]` path params into a single `{param}`
 */
export function normalizeHttpPath(p: string): string {
  let s = p.trim().split('?')[0].toLowerCase().replace(/\/+$/, '');
  s = s.replace(/:\w+/g, '{param}');
  s = s.replace(/\{[^}]+\}/g, '{param}');
  s = s.replace(/\[[^\]]+\]/g, '{param}');
  // Preserve root: after stripping trailing slashes, the root "/"
  // collapses to "" which would produce malformed contract ids like
  // `http::GET::`. Restore a single slash for the root case.
  return s === '' ? '/' : s;
}

/**
 * Consumer-side normalization is more aggressive:
 *   - template literals (`${x}`) → `{param}`
 *   - strip protocol + host if the URL is absolute
 *   - numeric segments → `{param}` (so `/api/orders/42` → `/api/orders/{param}`)
 */
function normalizeConsumerPath(url: string): string {
  const templated = url.replace(/\$\{[^}]+\}/g, '{param}').trim();
  let pathOnly = templated;
  if (/^https?:\/\//i.test(templated)) {
    try {
      pathOnly = new URL(templated).pathname;
    } catch {
      pathOnly = templated.replace(/^https?:\/\/[^/]+/i, '');
    }
  }
  const normalized = normalizeHttpPath(pathOnly || '/');
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? '{param}' : segment));
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/';
}

function contractIdFor(method: string, pathNorm: string): string {
  return `http::${method.toUpperCase()}::${pathNorm}`;
}

// ─── Graph row helpers ───────────────────────────────────────────────

function methodFromRouteReason(reason: string): string | null {
  const r = reason || '';
  if (/GetMapping|decorator-Get/i.test(r)) return 'GET';
  if (/PostMapping|decorator-Post/i.test(r)) return 'POST';
  if (/PutMapping|decorator-Put/i.test(r)) return 'PUT';
  if (/DeleteMapping|decorator-Delete/i.test(r)) return 'DELETE';
  if (/PatchMapping|decorator-Patch/i.test(r)) return 'PATCH';
  return null;
}

// ─── Orchestrator ────────────────────────────────────────────────────

export class HttpRouteExtractor implements ContractExtractor {
  type = 'http' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // Parse each file at most once and reuse the plugin results across
    // both graph-assisted enrichment and source-scan emission.
    const parser = new Parser();
    const cachedDetections = new Map<string, HttpDetection[]>();
    const cachedInputs = new Map<
      string,
      { plugin: HttpLanguagePlugin; input: HttpScanInput; repoContext: unknown } | null
    >();
    const projectDetections = new Map<string, HttpDetection[]>();
    let projectScanComplete = false;

    // Per-plugin cross-file context (e.g. Python's FastAPI router →
    // include_router(prefix=...) map). Built lazily on first
    // `getDetections` call for a file the plugin handles, scoped to the
    // file list returned by `getScannedFiles`. Stored by plugin name so
    // a repo with multiple languages keeps each plugin's context
    // independent.
    const repoContextByPlugin = new Map<string, unknown>();
    const ensureRepoContext = async (
      plugin: ReturnType<typeof getPluginForFile>,
    ): Promise<unknown> => {
      if (!plugin || typeof plugin.prepareRepo !== 'function') return undefined;
      if (repoContextByPlugin.has(plugin.name)) return repoContextByPlugin.get(plugin.name);
      try {
        const ctx = plugin.prepareRepo({
          repoPath,
          files: await getScannedFiles(),
          parser,
          readFile: (rel) => readSafe(repoPath, rel),
          parseSource: (p, src) => parseSourceSafe(p, src),
        });
        repoContextByPlugin.set(plugin.name, ctx);
        return ctx;
      } catch {
        repoContextByPlugin.set(plugin.name, undefined);
        return undefined;
      }
    };

    const getScanInput = async (
      rel: string,
    ): Promise<{
      plugin: HttpLanguagePlugin;
      input: HttpScanInput;
      repoContext: unknown;
    } | null> => {
      if (cachedInputs.has(rel)) return cachedInputs.get(rel) ?? null;
      const plugin = getPluginForFile(rel);
      if (!plugin) {
        cachedInputs.set(rel, null);
        return null;
      }
      const repoContext = await ensureRepoContext(plugin);
      const content = readSafe(repoPath, rel);
      if (!content) {
        cachedInputs.set(rel, null);
        return null;
      }
      try {
        parser.setLanguage(plugin.language);
        const tree = parseSourceSafe(parser, content);
        const input = { filePath: rel, tree };
        const item = { plugin, input, repoContext };
        cachedInputs.set(rel, item);
        return item;
      } catch {
        cachedInputs.set(rel, null);
        return null;
      }
    };

    const getDetections = async (rel: string): Promise<HttpDetection[]> => {
      const cached = cachedDetections.get(rel);
      if (cached) return cached;
      const scanInput = await getScanInput(rel);
      const ownDetections = scanInput
        ? scanInput.plugin.scan(scanInput.input.tree, scanInput.repoContext, rel)
        : [];
      const detections = [...ownDetections, ...(projectDetections.get(rel) ?? [])];
      cachedDetections.set(rel, detections);
      return detections;
    };

    // Glob the source-scan file list at most once per extract() —
    // both provider and consumer fallback paths share the same list.
    let scannedFiles: string[] | null = null;
    const getScannedFiles = async (): Promise<string[]> => {
      if (scannedFiles) return scannedFiles;
      scannedFiles = await this.scanFiles(repoPath);
      return scannedFiles;
    };

    const collectProjectDetections = async (files: string[]): Promise<void> => {
      if (projectScanComplete) return;
      projectScanComplete = true;
      const byPlugin = new Map<HttpLanguagePlugin, HttpScanInput[]>();
      for (const rel of files) {
        const scanInput = await getScanInput(rel);
        if (!scanInput?.plugin.scanProject) continue;
        const items = byPlugin.get(scanInput.plugin) ?? [];
        items.push(scanInput.input);
        byPlugin.set(scanInput.plugin, items);
      }

      for (const [plugin, inputs] of byPlugin) {
        const results = plugin.scanProject?.(inputs) ?? [];
        for (const result of results) {
          const existing = projectDetections.get(result.filePath) ?? [];
          projectDetections.set(result.filePath, [...existing, ...result.detections]);
        }
      }

      cachedDetections.clear();
    };

    const files = await getScannedFiles();

    // Resolve an HTTP detection to the symbol it lives in — the containing
    // function for a consumer / inline-arrow provider, or a named handler for
    // a provider — addressed by repo-relative file path so the source-scan
    // paths (which have no graph `fileId`) can resolve too. Per-file symbol
    // lists are cached. Returns null without a DB or when nothing resolves (a
    // named provider resolves by name even with no `line`; containment needs
    // one); the contract then keeps an empty symbolUid and downstream falls
    // back to file-level boundary matching.
    const fileSymbolCache = new Map<string, Record<string, unknown>[]>();
    const loadFileSymbols = async (filePath: string): Promise<Record<string, unknown>[]> => {
      if (!dbExecutor) return [];
      const cached = fileSymbolCache.get(filePath);
      if (cached) return cached;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await dbExecutor(CONTAINING_QUERY, { filePath });
      } catch {
        rows = [];
      }
      fileSymbolCache.set(filePath, rows);
      return rows;
    };
    // Repo-wide UNAMBIGUOUS resolution for a provider handler defined in a file
    // other than its route registration (e.g. `router.get('/x', listUsers)` with
    // `listUsers` imported from another module). Returns the symbol ONLY when
    // exactly one Function/Method/CodeElement carries that name across the repo.
    // The strict uniqueness guard is intentionally conservative: when a name is
    // shared across files (homonyms like `handler`/`index`), we prefer a
    // false-negative (no attribution → file-level fallback) over a false-positive
    // (wrong symbol).
    //
    // An IMPORTED handler (the common cross-file case) is pinned to its source
    // module first by resolveImportedSymbol, so an alias or a name colliding with
    // a local symbol resolves correctly; this repo-wide-by-name rung is the
    // fallback for non-relative/bare imports and for plugins that supply only a
    // name. Cached by name for the lifetime of this extract().
    const globalNameCache = new Map<string, ResolvedSymbol | null>();
    const toResolvedSymbol = (rows: Record<string, unknown>[]): ResolvedSymbol | null => {
      const norm = (x: unknown): string => String(x ?? '');
      const uid = rows.length === 1 ? norm(rows[0]!.uid ?? rows[0]![0]) : '';
      const filePath = uid ? norm(rows[0]!.filePath ?? rows[0]![2]) : '';
      // Reject a unique match that carries no real file (a synthetic ORM /
      // non-source node) so it can never anchor a cross-trace on an edge-less
      // node — defence in depth alongside the queries' filePath predicates.
      return uid && filePath ? { uid, name: norm(rows[0]!.name ?? rows[0]![1]), filePath } : null;
    };
    const resolveSymbolByNameUnique = async (name: string): Promise<ResolvedSymbol | null> => {
      if (!dbExecutor) return null;
      const cached = globalNameCache.get(name);
      if (cached !== undefined) return cached;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await dbExecutor(RESOLVE_BY_NAME_QUERY, { name });
      } catch {
        rows = [];
      }
      const result = toResolvedSymbol(rows);
      globalNameCache.set(name, result);
      return result;
    };
    // Resolve a handler imported from a RELATIVE module to the unique declared
    // symbol of that name inside the import's target file. Returns null for
    // non-relative (bare/aliased-path) imports — those fall back to the repo-wide
    // name lookup. Cached by (target-file-prefix, declared name).
    const importedSymbolCache = new Map<string, ResolvedSymbol | null>();
    const resolveImportedSymbol = async (
      fromFile: string,
      imp: { name: string; module: string },
    ): Promise<ResolvedSymbol | null> => {
      if (!dbExecutor) return null;
      const base = resolveModuleBase(fromFile, imp.module);
      if (base === null) return null; // bare/absolute import → repo-wide fallback
      const cacheKey = JSON.stringify([base, imp.name]);
      const cached = importedSymbolCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await dbExecutor(RESOLVE_IN_MODULE_QUERY, {
          name: imp.name,
          fileDot: `${base}.`,
          fileSlash: `${base}/`,
        });
      } catch {
        rows = [];
      }
      const result = toResolvedSymbol(rows);
      importedSymbolCache.set(cacheKey, result);
      return result;
    };
    const resolveDetectionSymbol = async (
      filePath: string,
      d: HttpDetection,
    ): Promise<ResolvedSymbol | null> => {
      if (!dbExecutor) return null;
      const syms = await loadFileSymbols(filePath);
      // Name resolution does NOT need a detection line — a named provider
      // handler (Spring/Go/etc. method name) resolves by name even when the
      // plugin didn't set `line`. Try the registration file FIRST; then, for a
      // handler defined in another file, the unique repo-wide match. Only the
      // containment fallback requires a line.
      if (d.role === 'provider' && d.name) {
        // IMPORTED handler: pin to the import's target module first. This is the
        // precise rung — it survives aliases and names that collide with a local
        // symbol. The handler is defined ELSEWHERE, so a file-scoped lookup of
        // its (declared) name would be wrong; on a miss go straight to a unique
        // repo-wide match on the declared name, never file-scoped.
        if (d.handlerImport) {
          const byImport = await resolveImportedSymbol(filePath, d.handlerImport);
          if (byImport) return byImport;
          const byGlobal = await resolveSymbolByNameUnique(d.handlerImport.name);
          if (byGlobal) return byGlobal;
          return null;
        }
        const byName = resolveSymbolByName(syms, d.name);
        if (byName) return byName;
        const byGlobal = await resolveSymbolByNameUnique(d.name);
        if (byGlobal) return byGlobal;
        // A NAMED handler we could not resolve by name (neither file-scoped nor
        // the unique repo-wide match) must NOT fall through to line-span
        // containment: `d.line` is the route REGISTRATION site, so containment
        // would attach the route to the enclosing registrar (e.g. a
        // `setupRoutes()` wrapper) rather than the handler. Leave it empty →
        // file-level boundary fallback, upholding the invariant that a
        // zero/ambiguous name match never yields a wrong-symbol attribution.
        return null;
      }
      // Consumers (the function making the fetch) and inline-arrow providers
      // (d.name === null) DO resolve by containment — there the enclosing symbol
      // is the right one.
      if (syms.length === 0 || d.line == null) return null;
      return resolveContainingSymbol(syms, d.line);
    };

    // Run the graph provider pass FIRST. After #2138 Part 2 it reads handler
    // symbols from the graph (no source parse for resolved routes), so it can
    // report which files are fully graph-covered BEFORE we decide what to
    // parse. Files fully covered by a `routeCoverage: 'complete'` language are
    // candidates to skip the source scan + tree-sitter parse — but only their
    // *providers* are graph-authoritative; the consumer-safety gate below
    // removes any candidate that still needs scanning for outbound calls.
    const coveredFiles = new Set<string>();
    const graphProviders =
      dbExecutor != null
        ? await this.extractProvidersGraph(
            dbExecutor,
            getDetections,
            resolveDetectionSymbol,
            coveredFiles,
          )
        : [];

    // Consumer-safety gate (#2138 Part 2): `extractProvidersGraph` marks a file
    // covered on *provider* grounds (all HANDLES_ROUTE rows resolved + a
    // `routeCoverage: 'complete'` language). But a provider-covered file may also
    // be a *consumer* (a controller that calls RestTemplate/WebClient/Guzzle/
    // requests/...), and ingestion emits no FETCHES edges for those server-side
    // languages — the graph can't back them up. So a covered file is only truly
    // safe to skip (parse) when its plugin can PROVE, from a cheap parse-free
    // text scan, that it holds no such consumer call. Anything else (a positive
    // signal, no `hasConsumerSignals` hook, or an unreadable file) stays in the
    // scan set so its consumer contracts are preserved.
    for (const f of [...coveredFiles]) {
      const plugin = getPluginForFile(f);
      const content = readSafe(repoPath, f);
      const provenNoConsumer =
        content != null && typeof plugin?.hasConsumerSignals === 'function'
          ? plugin.hasConsumerSignals(content) === false
          : false;
      if (!provenNoConsumer) coveredFiles.delete(f);
    }

    // Everything the graph did not fully cover still gets a full source scan
    // (fail-open: partial-coverage languages, unresolved routes, and graph-less
    // runs all land here).
    const scanFiles = files.filter((f) => !coveredFiles.has(f));

    await collectProjectDetections(scanFiles);

    const providers = this.mergeGraphAndSourceContracts(
      graphProviders,
      await this.extractProvidersSourceScan(scanFiles, getDetections, resolveDetectionSymbol),
    );

    const graphConsumers =
      dbExecutor != null
        ? await this.extractConsumersGraph(dbExecutor, getDetections, resolveDetectionSymbol)
        : [];
    const consumers = this.mergeGraphAndSourceContracts(
      graphConsumers,
      await this.extractConsumersSourceScan(scanFiles, getDetections, resolveDetectionSymbol),
    );

    return [...providers, ...consumers];
  }

  private async scanFiles(repoPath: string): Promise<string[]> {
    // Honour `.gitnexusignore` and `.gitignore` via the shared IgnoreService
    // so contract extraction respects the same exclusion rules as the rest of
    // the ingestion pipeline. Mirrors `filesystem-walker.ts` which uses the
    // same shape. Replaces a hardcoded `[node_modules, .git, dist, build,
    // vendor]` array — those names are still in `DEFAULT_IGNORE_LIST`, so
    // default behaviour is preserved (#1185).
    const ignoreFilter = await createIgnoreFilter(repoPath);
    return glob(HTTP_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ignoreFilter,
      nodir: true,
    });
  }

  // ─── Graph-assisted providers ──────────────────────────────────────

  private async extractProvidersGraph(
    db: CypherExecutor,
    getDetections: (rel: string) => Promise<HttpDetection[]>,
    resolveSymbol: (filePath: string, d: HttpDetection) => Promise<ResolvedSymbol | null>,
    coveredFiles?: Set<string>,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    // Per-file coverage tracking (#2138 Part 2): a file is "fully graph-covered"
    // when every one of its HANDLES_ROUTE rows resolved a handlerSymbolId AND its
    // language plugin declares `routeCoverage: 'complete'`. Such files can skip
    // the source scan + parse entirely — the graph is authoritative for them.
    const fileAllResolved = new Map<string, boolean>();
    let rows: Record<string, unknown>[];
    try {
      rows = await db(HANDLES_ROUTE_QUERY);
    } catch (err) {
      // A failure here silently disables the entire graph-assisted HTTP
      // provider path (the source-scan fallback still runs and masks most
      // of the damage), so surface it at debug level to make a total
      // outage observable instead of invisible.
      logger.debug(
        `[http-route-extractor] HANDLES_ROUTE query failed; graph providers skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const routeSource = String(row.routeSource ?? row.routeReason ?? '');
      // Prefer the HTTP verb persisted on the Route node by the ingestion
      // routes phase (Spring/Laravel framework routes and decorator routes
      // carry it). Fall back to parsing it out of the edge reason for
      // older indexes or filesystem routes that never stored a method.
      const graphMethod = String(row.routeMethod ?? '')
        .trim()
        .toUpperCase();
      let method = (graphMethod || null) ?? methodFromRouteReason(routeSource);

      const handlerSymbolId = String(row.handlerSymbolId ?? '').trim();
      const fileId = row.fileId ?? row[0];
      // Track per-file resolution for the parse-skip coverage set: a file stays
      // "all resolved" only while every one of its rows carries a handlerSymbolId.
      if (filePath) {
        const prev = fileAllResolved.get(filePath);
        fileAllResolved.set(filePath, (prev ?? true) && handlerSymbolId.length > 0);
      }
      const pathNormEarly = normalizeHttpPath(routePath);

      let symbolUid = '';
      let symbolName = path.basename(filePath) || 'handler';
      let symPath = filePath;
      if (handlerSymbolId) {
        // Fast path (Part 2, #2138): the handler symbol was resolved during
        // ingestion and persisted on the Route node, so the uid is authoritative
        // and we SKIP the source-scan/parse the legacy path needed. Recover the
        // display name from the file's symbols via CONTAINING_QUERY (the correct
        // File-[DEFINES]->symbol edge — NOT CONTAINS, which is File->Folder).
        if (!method) method = 'GET';
        symbolUid = handlerSymbolId;
        if (filePath) {
          try {
            const syms = await db(CONTAINING_QUERY, { filePath });
            const hit = syms.find((s) => String(s.uid ?? s[0]) === handlerSymbolId);
            if (hit) {
              symbolName = String(hit.name ?? hit[1]) || symbolName;
              symPath = String(hit.filePath ?? hit[2]) || filePath;
            }
          } catch {
            /* keep the authoritative uid + basename fallback */
          }
        }
      } else {
        // Legacy fallback (old index / unresolved handler): recover the handler
        // from the plugin's scan and resolve it to a real symbol by name (the
        // handler/method name) or, for an inline handler, by line-span containment
        // — both over File-[DEFINES]->symbol via resolveSymbol. No CONTAINS /
        // pickSymbolUid: CONTAINS is File->Folder and the old first-symbol guess
        // could win the contractId merge with a wrong uid.
        const detections = filePath ? await getDetections(filePath) : [];
        const providerDetections = detections.filter((d) => d.role === 'provider');
        // Candidates share the same normalized path. When multiple detections at
        // the same path exist (GET + POST /api/orders in one router), a blind
        // `.find()` silently returned the first verb — attaching the wrong
        // handler/method. Disambiguate by method when known; refuse to guess.
        const candidates = providerDetections.filter(
          (d) => normalizeHttpPath(d.path) === pathNormEarly,
        );
        let match: (typeof candidates)[number] | undefined;
        const ambiguousCandidates = !method && candidates.length > 1;
        if (method) {
          match = candidates.find((d) => d.method === method);
        } else if (candidates.length === 1) {
          match = candidates[0];
        }
        // else: multiple candidates + unknown method → leave match undefined and
        // skip symbol enrichment, keeping the file-basename fallback rather than
        // guessing the wrong handler.
        if (match && !method) method = match.method;
        if (!method) method = 'GET';
        const resolved =
          match && !ambiguousCandidates ? await resolveSymbol(filePath, match) : null;
        if (resolved) {
          symbolUid = resolved.uid;
          symbolName = resolved.name;
          symPath = resolved.filePath || filePath;
        }
      }

      const pathNorm = pathNormEarly;
      const cid = contractIdFor(method, pathNorm);

      out.push({
        contractId: cid,
        type: 'http',
        role: 'provider',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: 0.9,
        meta: {
          method,
          path: pathNorm,
          pathSegments: pathNorm.split('/').filter(Boolean),
          extractionStrategy: 'graph_assisted',
          routeSource,
        },
      });
    }

    // Populate the parse-skip coverage set: files whose every provider route
    // resolved a handler symbol AND whose language declares complete ingestion
    // route coverage. Fail-open — any unresolved row or a 'partial' language
    // leaves the file out, so it still gets a full source scan.
    if (coveredFiles) {
      for (const [fp, allResolved] of fileAllResolved) {
        if (allResolved && getPluginForFile(fp)?.routeCoverage === 'complete') {
          coveredFiles.add(fp);
        }
      }
    }
    return out;
  }

  // ─── Source-scan providers ─────────────────────────────────────────

  private async extractProvidersSourceScan(
    files: string[],
    getDetections: (rel: string) => Promise<HttpDetection[]>,
    resolveSymbol: (filePath: string, d: HttpDetection) => Promise<ResolvedSymbol | null>,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const detections = await getDetections(rel);
      for (const d of detections) {
        if (d.role !== 'provider') continue;
        const pathNorm = normalizeHttpPath(d.path);
        // Resolve the handler to a real symbol (named handler, or the inline
        // arrow that encloses the registration line) so the contract carries a
        // real symbolUid; fall back to the file + detection name otherwise.
        const resolved = await resolveSymbol(rel, d);
        out.push({
          contractId: contractIdFor(d.method, pathNorm),
          type: 'http',
          role: 'provider',
          symbolUid: resolved?.uid ?? '',
          symbolRef: {
            filePath: resolved?.filePath || rel,
            name: resolved?.name ?? d.name ?? 'handler',
          },
          symbolName: resolved?.name ?? d.name ?? 'handler',
          confidence: d.confidence,
          meta: {
            method: d.method,
            path: pathNorm,
            pathSegments: pathNorm.split('/').filter(Boolean),
            extractionStrategy: resolved ? 'source_scan_resolved' : 'source_scan',
            framework: d.framework,
          },
        });
      }
    }
    return this.dedupeContracts(out);
  }

  // ─── Graph-assisted consumers ──────────────────────────────────────

  private async extractConsumersGraph(
    db: CypherExecutor,
    getDetections: (rel: string) => Promise<HttpDetection[]>,
    resolveSymbol: (filePath: string, d: HttpDetection) => Promise<ResolvedSymbol | null>,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await db(FETCHES_QUERY);
    } catch (err) {
      logger.debug(
        `[http-route-extractor] FETCHES query failed; graph consumers skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const pathNorm = normalizeHttpPath(routePath);
      let method = 'GET';
      // Prefer the plugin's detected method if we can find a matching
      // fetch/axios call in the same file.
      const detections = filePath ? await getDetections(filePath) : [];
      // Symmetric to the provider path: if multiple consumer calls in
      // the same file share the same normalized path (e.g. a GET
      // fetch AND a POST fetch to `/api/orders`), `.find()` silently
      // picked the first verb and keyed the contract id on the wrong
      // method. With no upstream method signal here, refuse to guess
      // when candidates are ambiguous — leave `method` at its
      // conservative 'GET' default.
      const consumerCandidates = detections.filter(
        (d) => d.role === 'consumer' && normalizeConsumerPath(d.path) === pathNorm,
      );
      if (consumerCandidates.length === 1) {
        method = consumerCandidates[0].method;
      }

      const cid = contractIdFor(method, pathNorm);
      let symbolUid = '';
      let symbolName = 'fetch';
      let symPath = filePath;
      // Resolve the function CONTAINING the fetch by line-span. Do NOT fall back
      // to the old `pickSymbolUid(syms, null)` first-symbol-in-file guess: an
      // arbitrary wrong uid is worse than an empty one because it would win the
      // contractId merge over a correctly-resolved source-scan contract (and the
      // empty case degrades to the file-level boundary fallback downstream).
      const resolved =
        consumerCandidates.length === 1
          ? await resolveSymbol(filePath, consumerCandidates[0])
          : null;
      if (resolved) {
        symbolUid = resolved.uid;
        symbolName = resolved.name;
        symPath = resolved.filePath || filePath;
      }
      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: 0.9,
        meta: {
          method,
          path: pathNorm,
          extractionStrategy: 'graph_assisted',
          fetchReason: String(row.fetchReason ?? ''),
        },
      });
    }
    return out;
  }

  // ─── Source-scan consumers ─────────────────────────────────────────

  private async extractConsumersSourceScan(
    files: string[],
    getDetections: (rel: string) => Promise<HttpDetection[]>,
    resolveSymbol: (filePath: string, d: HttpDetection) => Promise<ResolvedSymbol | null>,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const detections = await getDetections(rel);
      for (const d of detections) {
        if (d.role !== 'consumer') continue;
        const pathNorm = normalizeConsumerPath(d.path);
        // Resolve the function CONTAINING the fetch/axios call so the consumer
        // contract carries a real symbolUid (was always '' — the gap that left
        // cross-repo trace/impact unable to traverse HTTP links).
        const resolved = await resolveSymbol(rel, d);
        out.push({
          contractId: contractIdFor(d.method, pathNorm),
          type: 'http',
          role: 'consumer',
          symbolUid: resolved?.uid ?? '',
          symbolRef: { filePath: resolved?.filePath || rel, name: resolved?.name ?? 'fetch' },
          symbolName: resolved?.name ?? 'fetch',
          confidence: d.confidence,
          meta: {
            method: d.method,
            path: pathNorm,
            extractionStrategy: resolved ? 'source_scan_resolved' : 'source_scan',
            framework: d.framework,
          },
        });
      }
    }
    return this.dedupeContracts(out);
  }

  private dedupeContracts(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.symbolRef.filePath}|${c.symbolRef.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }

  private mergeGraphAndSourceContracts(
    graphContracts: ExtractedContract[],
    sourceContracts: ExtractedContract[],
  ): ExtractedContract[] {
    const seenContractIds = new Set(graphContracts.map((c) => c.contractId));
    const out = [...graphContracts];
    for (const contract of sourceContracts) {
      if (seenContractIds.has(contract.contractId)) continue;
      seenContractIds.add(contract.contractId);
      out.push(contract);
    }
    return out;
  }
}
