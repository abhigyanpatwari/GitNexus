import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { createTreeReleaser } from '../../tree-sitter/native-tree-release.js';
import { toZeroBasedLine } from '../../ingestion/utils/line-base.js';
import { logger } from '../../logger.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../ingestion/route-extractors/data-route-table.js';
import { stripLeadingTemplatePrefix } from '../../ingestion/route-extractors/route-path.js';
import {
  getPluginForFile,
  HTTP_SCAN_GLOB,
  type HttpDetection,
  type HttpLanguagePlugin,
  type HttpProjectScan,
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

/** Parallel scans have no row order. Stabilize both output and first-wins
 * duplicate selection using every projected contract field, before resolving. */
function orderGraphContractRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const columns = [
    'filePath',
    'fileId',
    'routePath',
    'routeMethod',
    'routeId',
    'handlerSymbolId',
    'routeSource',
    'fetchReason',
    'responseKeys',
  ];
  return rows
    .map((row) => ({ row, key: JSON.stringify(columns.map((key) => row[key] ?? null)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ row }) => row);
}

// Function/Method/CodeElement symbols (with line spans) in a file, addressed by
// repo-relative path so the source-scan paths — which have a path but no graph
// `fileId` — can resolve the symbol CONTAINING an HTTP call by line-span
// containment. Matched by `filePath` rather than a File-[DEFINES]->sym edge so
// it also reaches methods nested in classes (Java/Kotlin), where the File
// defines the class and the class defines the method. (Exported, with
// CONTAINING_FILES_QUERY, so integration tests can compare the two against a
// real LadybugDB.)
//
// No ORDER BY: on a connection with more than one execution thread the engine
// returns the UNION ALL branches, and the rows inside one branch, in an order
// that changes from call to call. `ord` is the row's scan offset in its node
// table; orderFileSymbols sorts on it, so the resolvers never see that order.
export const CONTAINING_QUERY = `
MATCH (sym:Function)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord
UNION ALL
MATCH (sym:Method)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord
UNION ALL
MATCH (sym:CodeElement)
WHERE sym.filePath = $filePath AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord`;

// CONTAINING_QUERY for many files in one query. `filePath` has no index, so
// each CONTAINING_QUERY scans the three node tables to find one file's rows.
// Joining the tables to the unwound path list is a hash join in the engine:
// one scan per table whatever the length of the list, and only the listed
// files' rows come back. (`sym.filePath IN $filePaths` is a LIST_CONTAINS
// filter instead, which walks the whole list for every scanned row.) The paths
// must be distinct, or a file's rows repeat.
export const CONTAINING_FILES_QUERY = `
UNWIND $filePaths AS fp MATCH (sym:Function)
WHERE sym.filePath = fp AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord
UNION ALL
UNWIND $filePaths AS fp MATCH (sym:Method)
WHERE sym.filePath = fp AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord
UNION ALL
UNWIND $filePaths AS fp MATCH (sym:CodeElement)
WHERE sym.filePath = fp AND sym.startLine IS NOT NULL AND sym.endLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath,
       sym.startLine AS startLine, sym.endLine AS endLine, labels(sym) AS labels,
       offset(id(sym)) AS ord`;

const SYMBOL_LABEL_ORDER = ['Function', 'Method', 'CodeElement'];

/**
 * One file's symbol rows in a fixed order: Function rows, then Method, then
 * CodeElement, each by scan offset. That is the order a single-thread
 * CONTAINING_QUERY returns. resolveSymbolByName takes the first name match and
 * resolveContainingSymbol the first of two equal spans, so without this the
 * winner of such a tie would depend on the engine's row order and on which
 * query loaded the file. Rows without `ord` keep their arrival order per label.
 */
function orderFileSymbols(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const labelRank = (row: Record<string, unknown>): number => {
    const labels = JSON.stringify(row.labels ?? row[5] ?? '');
    return SYMBOL_LABEL_ORDER.findIndex((label) => labels.includes(label));
  };
  const scanOffset = (row: Record<string, unknown>): number => Number(row.ord ?? row[6] ?? 0) || 0;
  return [...rows].sort((a, b) => labelRank(a) - labelRank(b) || scanOffset(a) - scanOffset(b));
}

/**
 * Load the CONTAINING_QUERY rows of every file in `filePaths` into `cache` with
 * one CONTAINING_FILES_QUERY. A requested file without rows caches []. A failed
 * query caches nothing, so the caller falls back to CONTAINING_QUERY.
 */
async function prefetchFileSymbols(
  db: CypherExecutor,
  filePaths: readonly string[],
  cache: Map<string, Record<string, unknown>[]>,
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await db(CONTAINING_FILES_QUERY, { filePaths });
  } catch (err) {
    logger.debug(
      `[http-route-extractor] symbol batch for ${filePaths.length} files failed; using one query per file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  const byFile = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const filePath = String(row.filePath ?? row[2] ?? '');
    const list = byFile.get(filePath);
    if (list) list.push(row);
    else byFile.set(filePath, [row]);
  }
  for (const filePath of filePaths) {
    if (!cache.has(filePath)) cache.set(filePath, orderFileSymbols(byFile.get(filePath) ?? []));
  }
}

/** The CONTAINING_QUERY rows of each file, cached for one extract(). */
interface FileSymbols {
  /** Files about to be loaded: the next cache miss fetches them all in one query. */
  expect(filePaths: Iterable<string>): void;
  findById(filePath: string, uid: string): Promise<Record<string, unknown> | undefined>;
}

// Repo-wide lookup of a symbol by exact name. Used to resolve a provider's
// named handler when it is defined in a file OTHER than its route registration —
// and only honored when the result is unique (see resolveSymbolByNameUnique).
//
// Label filtering uses `labels(n) IN [...]` rather than the openCypher
// disjunction `MATCH (n:A|B|C)`. NOTE: this 3-label set (Function/Method/
// CodeElement) actually PARSES — LadybugDB only rejects a disjunction that
// names a reserved keyword (e.g. `Macro`, `Union`) or a missing node table,
// neither of which applies here. So this query was NOT broken by #2325; it
// uses the `labels(n) IN` form for consistency with the manifest custom-branch
// fix (which WAS broken) and to stay immune if a reserved-keyword label is
// added later. `labels(n)` returns the node's single label as a string here, so
// `IN [...]` is an exact allowlist. (Exported so integration tests can run the
// exact production query against a real LadybugDB — the bug shipped because no
// test ran these strings against the real parser.)
//
// `n.filePath <> ''` excludes synthetic non-source `CodeElement` nodes that
// carry no real file — ORM model/table nodes (orm.ts emits `filePath: ''`) and
// similar — so a handler name colliding with an ORM model neither resolves to a
// degenerate edge-less node NOR inflates the uniqueness count and masks the real
// handler. `LIMIT 2` bounds materialization: distinguishing unique (1) from
// ambiguous (>=2) never needs more than two rows (the count guard stays exact).
//
// determinism: probe — uniqueness discriminator, not a window. `toResolvedSymbol`
// reads row 0 only when `rows.length === 1`; a 2-row result is discarded whole,
// so WHICH two rows came back can never reach a caller.
export const RESOLVE_BY_NAME_QUERY = `
MATCH (n) WHERE labels(n) IN ['Function','Method','CodeElement']
  AND n.name = $name AND n.filePath <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

// Resolve an IMPORTED handler by pinning it to the import's target module: the
// declared export `$name` whose file is the module the handler was imported from
// (`$filePaths` contains exact source-file and directory-index candidates). This is
// the precise rung — it survives aliases and local same-name collisions that a
// repo-wide name lookup cannot, and only resolves on a unique match within that
// module. `LIMIT 2` keeps the uniqueness count exact (see RESOLVE_BY_NAME_QUERY).
//
// determinism: probe — uniqueness discriminator, not a window. Same consumer as
// RESOLVE_BY_NAME_QUERY: `toResolvedSymbol` reads row 0 only when exactly one row
// came back, and discards a 2-row result whole.
export const RESOLVE_IN_MODULE_QUERY = `
MATCH (n) WHERE labels(n) IN ['Function','Method','CodeElement']
  AND n.name = $name AND (n.filePath STARTS WITH $fileDot OR n.filePath STARTS WITH $fileSlash)
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

// determinism: probe — uniqueness discriminator, not a window. The consumer
// accepts exactly one row and rejects a 2-row result whole, so row identity
// cannot affect the resolution decision.
export const RESOLVE_IN_EXACT_MODULE_QUERY = `
MATCH (n) WHERE labels(n) IN ['Function','Method','CodeElement']
  AND n.name = $name AND n.filePath IN $filePaths
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

// Source-file extensions an import specifier may resolve to (stripped before
// building the module file-prefix so `./h/users` and `./h/users.ts` agree).
const SOURCE_EXT_RE = /\.(?:m|c)?[jt]sx?$/;

/**
 * Resolve an import specifier to a repo-relative FILE BASE (path without
 * extension) so exact target-file candidates can be constructed.
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

const MODULE_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
];

function moduleFileCandidates(base: string): string[] {
  return [
    ...MODULE_SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_SOURCE_EXTENSIONS.map((extension) =>
      extension === '.py' ? `${base}/__init__.py` : `${base}/index${extension}`,
    ),
  ];
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
  // Detection lines are 1-based (`HttpDetection.line`); symbol spans are stored
  // 0-based for the languages indexed today (parse-worker records
  // `startPosition.row`). So the base-correct probe is `toZeroBasedLine(line)` —
  // the same named 1-based→graph-space conversion the ingestion emitters use
  // (#2377), rather than a bare literal. Pick the INNERMOST (smallest-span)
  // symbol whose span contains the probe. Only if nothing contains the 0-based
  // probe do we retry with the raw `line` — a defensive fallback for any future
  // language that stores 1-based spans. Probing 0-based first (rather than
  // OR-ing both) avoids the +1 slack mis-picking a one-line sibling that sits on
  // `line`. The helper's `Math.max(0, …)` clamp is inert here: every plugin sets
  // `line` from `startPosition.row + 1`, so it is always >= 1.
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
  return pick(toZeroBasedLine(line)) ?? pick(line);
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

function resolveFileSymbolByNameUnique(
  rows: Record<string, unknown>[],
  name: string,
): ResolvedSymbol | null {
  const matches = rows
    .map((row) => resolveSymbolByName([row], name))
    .filter((match): match is ResolvedSymbol => match !== null);
  const byUid = new Map(matches.map((match) => [match.uid, match]));
  return byUid.size === 1 ? (byUid.values().next().value ?? null) : null;
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
 * Placeholder substituted for `${...}` before WHATWG `URL` parsing so the
 * parser cannot percent-encode our own `{param}` markers. A genuine encoded
 * segment like `%7Bfoo%7D` then survives as a literal, instead of being
 * rewritten into braces and folded into `{param}`.
 *
 * Private-use U+E000 cannot appear in a real URL path, so a literal
 * `__gitnexus_http_param__` segment is not rewritten into `{param}`.
 */
const CONSUMER_PARAM_SENTINEL = '\uE000';
const CONSUMER_PARAM_SENTINEL_ENC = '%ee%80%80';

function restoreConsumerParamSentinel(pathOnly: string): string {
  return pathOnly
    .split(CONSUMER_PARAM_SENTINEL)
    .join('{param}')
    .replace(new RegExp(CONSUMER_PARAM_SENTINEL_ENC, 'gi'), '{param}');
}

/** Canonicalize a consumer URL after `stripLeadingTemplatePrefix`. */
function normalizeConsumerPath(url: string): string | null {
  const stripped = stripLeadingTemplatePrefix(url.trim());
  if (stripped === null) return null;
  const templated = stripped.replace(/\$\{[^}]+\}/g, CONSUMER_PARAM_SENTINEL).trim();
  let pathOnly = templated;
  if (/^https?:\/\//i.test(templated)) {
    try {
      pathOnly = new URL(templated).pathname;
    } catch {
      pathOnly = templated.replace(/^https?:\/\/[^/]+/i, '');
    }
  }
  pathOnly = restoreConsumerParamSentinel(pathOnly);
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

export function normalizeRepoRelPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
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
    // both graph-assisted enrichment and source-scan emission. Only results
    // are kept, never trees: a tree lives while its own file is processed.
    const parser = new Parser();
    const cachedDetections = new Map<string, HttpDetection[]>();
    // A file's own `scan` detections, keyed by the raw rel the file was read
    // with. An empty entry also marks a file with no plugin or no parse.
    const ownDetections = new Map<string, HttpDetection[]>();
    const projectDetections = new Map<string, HttpDetection[]>();
    const completedProjectScans = new Set<HttpProjectScan>();
    const releaseTrees = createTreeReleaser();

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
        const ctx = await plugin.prepareRepo({
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

    // Parse one file, run its plugin's `scan` and, inside a project-scan pass,
    // the family's `collect`. Synchronous so that the tree is unreachable as
    // soon as this returns. The detections and facts outlive the file, so both
    // go through `structuredClone`: it throws if a plugin leaks a tree or a
    // syntax node into them, and it copies strings sliced from the file's
    // source so they do not keep it alive.
    const parseAndScan = (
      plugin: HttpLanguagePlugin,
      rel: string,
      repoContext: unknown,
      projectScan: HttpProjectScan | undefined,
    ): { facts: unknown } | null => {
      const content = readSafe(repoPath, rel);
      if (!content) return null;
      let tree: Parser.Tree;
      try {
        parser.setLanguage(plugin.language);
        tree = parseSourceSafe(parser, content);
      } catch {
        return null;
      }
      // A throw here fails the extraction, as before; it names the plugin and
      // the file, which a bare DataCloneError does not.
      try {
        ownDetections.set(rel, structuredClone(plugin.scan(tree, repoContext, rel)));
        return {
          facts: projectScan
            ? structuredClone(projectScan.collect({ filePath: rel, tree }, repoContext))
            : undefined,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`HTTP plugin ${plugin.name} failed on ${rel}: ${reason}`, { cause: err });
      }
    };

    const analyzeFile = async (
      rel: string,
      projectScan?: HttpProjectScan,
    ): Promise<{ facts: unknown; repoContext: unknown } | null> => {
      const plugin = getPluginForFile(rel);
      const repoContext = plugin ? await ensureRepoContext(plugin) : undefined;
      const result = plugin ? parseAndScan(plugin, rel, repoContext, projectScan) : null;
      if (!result) {
        ownDetections.set(rel, []);
        return null;
      }
      // Let the dropped trees' native memory go (see native-tree-release.ts).
      await releaseTrees();
      return { facts: result.facts, repoContext };
    };

    const getDetections = async (rel: string): Promise<HttpDetection[]> => {
      // Graph enrichment needs composed providers too. Resolve only this
      // project's plugin family; unrelated complete-coverage languages can
      // still skip parsing when their graph handlers already resolved.
      const projectScan = getPluginForFile(rel)?.projectScan;
      if (projectScan && !completedProjectScans.has(projectScan))
        await collectProjectDetections(await getScannedFiles(), projectScan);
      const key = normalizeRepoRelPath(rel);
      const cached = cachedDetections.get(key);
      if (cached) return cached;
      if (!ownDetections.has(rel)) await analyzeFile(rel);
      const detections = [...(ownDetections.get(rel) ?? []), ...(projectDetections.get(key) ?? [])];
      cachedDetections.set(key, detections);
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

    // One pass per project family: each file is parsed, scanned and reduced to
    // its facts in turn, and only the facts reach the cross-file `resolve`.
    const collectProjectDetections = async (
      files: string[],
      onlyScan?: HttpProjectScan,
    ): Promise<void> => {
      const byScan = new Map<HttpProjectScan, { facts: unknown[]; repoContext: unknown }>();
      for (const rel of files) {
        const projectScan = getPluginForFile(rel)?.projectScan;
        if (
          !projectScan ||
          completedProjectScans.has(projectScan) ||
          (onlyScan && onlyScan !== projectScan)
        )
          continue;
        const family = byScan.get(projectScan) ?? { facts: [], repoContext: undefined };
        byScan.set(projectScan, family);
        if (ownDetections.has(rel)) continue;
        const analyzed = await analyzeFile(rel, projectScan);
        if (!analyzed) continue;
        // The family resolves against its first parsed file's context.
        if (family.facts.length === 0) family.repoContext = analyzed.repoContext;
        family.facts.push(analyzed.facts);
      }

      // Shared project-scan identity pools grammar variants without teaching
      // the orchestrator which languages belong to the same project family.
      for (const [projectScan, { facts, repoContext }] of byScan) {
        completedProjectScans.add(projectScan);
        if (facts.length === 0) continue;
        const results = projectScan.resolve(facts, repoContext);
        for (const result of results) {
          const key = normalizeRepoRelPath(result.filePath);
          const existing = projectDetections.get(key) ?? [];
          projectDetections.set(key, [...existing, ...result.detections]);
          cachedDetections.delete(key);
        }
      }
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
    //
    // Files named through `expect` wait in `pendingSymbolFiles`; the first miss
    // loads them all, and the file asked for, with one CONTAINING_FILES_QUERY.
    // Every pass names its files before it resolves them, so a healthy
    // extract() issues a handful of symbol queries however many files it reads.
    // A file nobody named, or one whose batch failed, gets its own
    // CONTAINING_QUERY.
    const fileSymbolCache = new Map<string, Record<string, unknown>[]>();
    const fileSymbolIds = new Map<string, Map<string, Record<string, unknown>>>();
    const pendingSymbolFiles = new Set<string>();
    const loadFileSymbols = async (filePath: string): Promise<Record<string, unknown>[]> => {
      if (!dbExecutor) return [];
      const cached = fileSymbolCache.get(filePath);
      if (cached) return cached;
      if (pendingSymbolFiles.size > 0) {
        pendingSymbolFiles.add(filePath);
        const batch = [...pendingSymbolFiles].filter((f) => !fileSymbolCache.has(f));
        pendingSymbolFiles.clear();
        await prefetchFileSymbols(dbExecutor, batch, fileSymbolCache);
        const prefetched = fileSymbolCache.get(filePath);
        if (prefetched) return prefetched;
      }
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await dbExecutor(CONTAINING_QUERY, { filePath });
      } catch {
        rows = [];
      }
      rows = orderFileSymbols(rows);
      fileSymbolCache.set(filePath, rows);
      return rows;
    };
    const fileSymbols: FileSymbols = {
      expect: (filePaths) => {
        if (!dbExecutor) return;
        for (const f of filePaths) if (f && !fileSymbolCache.has(f)) pendingSymbolFiles.add(f);
      },
      findById: async (filePath, uid) => {
        let ids = fileSymbolIds.get(filePath);
        if (!ids) {
          ids = new Map();
          for (const row of await loadFileSymbols(filePath)) {
            const id = String(row.uid ?? row[0]);
            if (!ids.has(id)) ids.set(id, row);
          }
          fileSymbolIds.set(filePath, ids);
        }
        return ids.get(uid);
      },
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
    // Resolve a handler imported from a relative module to the unique declared
    // symbol inside its target file. The caller decides whether a miss may use
    // the historical unique repository-wide fallback.
    const importedSymbolCache = new Map<string, ResolvedSymbol | null>();
    const resolveImportedSymbol = async (
      fromFile: string,
      imp: { name: string; module: string },
      strict = false,
    ): Promise<ResolvedSymbol | null> => {
      if (!dbExecutor) return null;
      const base = resolveModuleBase(fromFile, imp.module);
      if (base === null) return null;
      const cacheKey = JSON.stringify([base, imp.name, strict]);
      const cached = importedSymbolCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await dbExecutor(
          strict ? RESOLVE_IN_EXACT_MODULE_QUERY : RESOLVE_IN_MODULE_QUERY,
          strict
            ? { name: imp.name, filePaths: moduleFileCandidates(base) }
            : { name: imp.name, fileDot: `${base}.`, fileSlash: `${base}/` },
        );
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
      if (d.role === 'provider' && d.unresolvedHandler) return null;
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
          const byImport = await resolveImportedSymbol(
            filePath,
            d.handlerImport,
            d.strictHandlerResolution,
          );
          if (byImport) return byImport;
          if (d.strictHandlerResolution) return null;
          return resolveSymbolByNameUnique(d.handlerImport.name);
        }
        // A qualified designator (`recv.name`) does not prove the handler is
        // declared in this file, so the file-first rung could bind an
        // unrelated same-named local symbol: go straight to the unique
        // repo-wide match.
        if (!d.qualifiedHandler) {
          const byName = d.strictHandlerResolution
            ? resolveFileSymbolByNameUnique(syms, d.name)
            : resolveSymbolByName(syms, d.name);
          if (byName) return byName;
          if (d.strictHandlerResolution) return null;
        }
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
            fileSymbols,
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
    // The source-scan passes and the graph consumer pass resolve a symbol for
    // each detection, so every scanned file with a detection is about to be
    // loaded. (getDetections is cached; those passes read the same results.)
    if (dbExecutor) {
      const detectionFiles: string[] = [];
      for (const rel of scanFiles) {
        if ((await getDetections(rel)).length > 0) detectionFiles.push(normalizeRepoRelPath(rel));
      }
      fileSymbols.expect(detectionFiles);
    }

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
    fileSymbols: FileSymbols,
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
      rows = orderGraphContractRows(await db(HANDLES_ROUTE_QUERY));
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
    // The loop below reads the symbols of the route files (by handler id, or
    // through a detection when the row has none), so name them up front and
    // they load in one query.
    fileSymbols.expect(rows.map((row) => String(row.filePath ?? '')));

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
          const hit = await fileSymbols.findById(filePath, handlerSymbolId);
          if (hit) {
            symbolName = String(hit.name ?? hit[1]) || symbolName;
            symPath = String(hit.filePath ?? hit[2]) || filePath;
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
    const candidates: Array<{
      detection: HttpDetection;
      filePath: string;
      pathNorm: string;
      resolved: ResolvedSymbol | null;
    }> = [];
    for (const rel of files) {
      const detections = await getDetections(rel);
      const filePath = normalizeRepoRelPath(rel);
      for (const d of detections) {
        if (d.role !== 'provider') continue;
        const pathNorm = normalizeHttpPath(d.path);
        // Resolve the handler to a real symbol (named handler, or the inline
        // arrow that encloses the registration line) so the contract carries a
        // real symbolUid; fall back to the file + detection name otherwise.
        const resolved = await resolveSymbol(filePath, d);
        candidates.push({ detection: d, filePath, pathNorm, resolved });
      }
    }

    const dataCandidatesByIdentity = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      if (candidate.detection.framework !== DATA_ROUTE_TABLE_SOURCE) continue;
      const identity = contractIdFor(candidate.detection.method, candidate.pathNorm);
      const grouped = dataCandidatesByIdentity.get(identity) ?? [];
      grouped.push(candidate);
      dataCandidatesByIdentity.set(identity, grouped);
    }
    const ambiguousDataIdentities = new Set<string>();
    for (const [identity, grouped] of dataCandidatesByIdentity) {
      if (grouped.length < 2) continue;
      const resolvedIds = new Set(
        grouped.flatMap((candidate) =>
          candidate.resolved === null ? [] : [candidate.resolved.uid],
        ),
      );
      if (grouped.some((candidate) => candidate.resolved === null) || resolvedIds.size !== 1) {
        ambiguousDataIdentities.add(identity);
      }
    }

    const out: ExtractedContract[] = [];
    for (const { detection: d, filePath, pathNorm, resolved } of candidates) {
      const contractId = contractIdFor(d.method, pathNorm);
      if (d.framework === DATA_ROUTE_TABLE_SOURCE && ambiguousDataIdentities.has(contractId)) {
        continue;
      }
      out.push({
        contractId,
        type: 'http',
        role: 'provider',
        symbolUid: resolved?.uid ?? '',
        symbolRef: {
          filePath: resolved?.filePath || filePath,
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
      rows = orderGraphContractRows(await db(FETCHES_QUERY));
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
      const filePath = normalizeRepoRelPath(rel);
      for (const d of detections) {
        if (d.role !== 'consumer') continue;
        const pathNorm = normalizeConsumerPath(d.path);
        // A consumer url that cannot be reduced to a routable path (e.g. a
        // leading template binding that is neither a clean prefix nor a
        // remainder that starts with `/`) is dropped here rather than emitted
        // as a never-matching contract — same treatment the plugins give
        // static relative urls at scan time.
        if (pathNorm === null) continue;
        // Resolve the function CONTAINING the fetch/axios call so the consumer
        // contract carries a real symbolUid (was always '' — the gap that left
        // cross-repo trace/impact unable to traverse HTTP links).
        const resolved = await resolveSymbol(filePath, d);
        out.push({
          contractId: contractIdFor(d.method, pathNorm),
          type: 'http',
          role: 'consumer',
          symbolUid: resolved?.uid ?? '',
          symbolRef: { filePath: resolved?.filePath || filePath, name: resolved?.name ?? 'fetch' },
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
