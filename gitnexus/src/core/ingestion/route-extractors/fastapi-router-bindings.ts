/**
 * FastAPI router-prefix detection — pure functions, no worker thread.
 *
 * NOT A WORKER. This module exports plain synchronous functions; it
 * does not import `worker_threads`, does not call `parentPort`, and
 * is not a new worker entry point. It lives next to the other route
 * extractors (expo, nextjs, php, laravel) for that reason.
 *
 * The implementation was historically inlined in `workers/parse-worker.ts`,
 * but parse-worker.ts is itself the worker entry point and cannot be
 * loaded from the main thread (see the same constraint used by
 * `test/unit/call-attribution-issue-1166.test.ts`). Splitting the pure
 * extraction here lets unit tests import the function directly without
 * booting a worker, satisfying DoD §2.7.
 *
 * Worker phase is per-file, so the heavy cross-file resolution lives in
 * `pipeline-phases/parse-impl.ts`. Here we only extract two raw record
 * kinds and let the pipeline aggregate them across files:
 *
 *   • {@link ExtractedRouterInclude} — every
 *     `<host>.include_router(<routerExpr>, prefix='/x')` site, where
 *     `<routerExpr>` is either `<module>.router` (Shape A) or a bare
 *     local name (Shape B). `<host>` is intentionally unconstrained:
 *     production code uses `app`, `api`, `application`, `asgi_app`,
 *     etc., and the call shape (`include_router` invoked with a
 *     `prefix=` keyword) is specific enough on its own.
 *
 *   • {@link ExtractedRouterImport} — every
 *     `from <module> import router [as <alias>]`, captured for both
 *     absolute and relative module paths (`from .calls import …`).
 *     parse-impl uses the imports to resolve Shape-B local names back
 *     to the file that declares the router.
 *
 * Module keying is two-tiered to avoid prefix bleed between same-named
 * files in different packages (e.g. `api/users.py` vs `admin/users.py`):
 *
 *   • short key — basename without `.py`                  (`users`)
 *   • long  key — `<parent-dir>/<basename>`               (`api/users`)
 *
 * Imports always carry the short key and, when the module path was
 * multi-segment, also the long key. parse-impl matches against the
 * long key first and falls back to the short key, so cross-package
 * collisions are eliminated for Shape B and minimised for Shape A.
 *
 * The functions in this module are pure (no Worker / parentPort
 * dependency) so they can be unit-tested directly without booting a
 * worker thread.
 */

/**
 * One `<host>.include_router(<routerExpr>, prefix='/x')` site.
 *
 * `routerExpr` is the raw text of the first argument — either
 * `<module>.router` (Shape A) or a bare local name (Shape B).
 * parse-impl resolves Shape B against {@link ExtractedRouterImport}
 * records emitted by the same file.
 */
export interface ExtractedRouterInclude {
  filePath: string;
  routerExpr: string;
  prefix: string;
  lineNumber: number;
}

/**
 * One `from <module> import router [as <alias>]` discovered in a
 * Python file.
 *
 * `moduleKey` is the short key (last `.`-segment of the module path,
 * e.g. `api.users` → `users`). `moduleKeyLong` is the long key (last
 * two segments joined with `/`, e.g. `api/users`); it is the empty
 * string / undefined when the import is single-segment (e.g.
 * `from users import router`) or pure-dots (e.g. `from . import
 * router`). The long key, when present, gives parse-impl a precise
 * way to bind a Shape-B `include_router` call to exactly one Python
 * file even when other packages contain a same-named module.
 */
export interface ExtractedRouterImport {
  filePath: string;
  localName: string;
  moduleKey: string;
  moduleKeyLong?: string;
}

/**
 * One `from <package> import <module>` discovered in a Python file
 * where `<module>` is later used as a Shape-A include receiver
 * (`<host>.include_router(<module>.router, prefix='/x')`). Without
 * this record parse-impl would have to fall back to the short key
 * `<module>`, which collides between e.g. `api/users.py` and
 * `admin/users.py`. The record carries the long key
 * (`<package>/<module>`) so parse-impl can pin the prefix onto the
 * exact source file.
 *
 * Only emitted when the import path was multi-segment (a single
 * `from users import users` would yield no long key). All fields
 * carry the same module-key semantics as
 * {@link ExtractedRouterImport}.
 */
export interface ExtractedRouterModuleAlias {
  filePath: string;
  /** Local name in the importing file (== imported name or its alias). */
  localName: string;
  /** Long key (`<parent>/<stem>`) — non-empty for every emitted record. */
  moduleKeyLong: string;
}

export interface ExtractedRouterConstructorPrefix {
  filePath: string;
  prefix: string;
}

// `<host>.include_router(<module>.router, ..., prefix='/x')` (Shape A).
// `<host>` is left unrestricted — common production names include
// `app`, `api`, `application`, `asgi_app`. Pinning to the literal
// `app` would silently drop these.
const INCLUDE_ROUTER_ATTR_RE =
  /\b(?:[A-Za-z_][\w.]*)\.include_router\s*\(\s*([A-Za-z_][\w]*)\.router\b[^)]*?\bprefix\s*=\s*(['"])([^'"]*)\2/g;

// `<host>.include_router(<local_name>, ..., prefix='/x')` (Shape B).
const INCLUDE_ROUTER_NAME_RE =
  /\b(?:[A-Za-z_][\w.]*)\.include_router\s*\(\s*([A-Za-z_][\w]*)\b[^)]*?\bprefix\s*=\s*(['"])([^'"]*)\2/g;

// Module path: a sequence of dots (`.`, `..`, `...`) for "current
// package" imports, OR an optional leading-dot prefix followed by a
// dotted identifier (`api.users`, `.api.users`, `..siblings.users`).
// The latter is the common case and the only one we can map back to
// a module stem.
const FROM_IMPORT_ROUTER_RE = /^\s*from\s+(\.+|\.*[A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm;
const API_ROUTER_ASSIGN_RE = /\brouter\s*=\s*APIRouter\s*\(/g;
const API_ROUTER_PREFIX_ARG_RE = /\bprefix\s*=\s*(['"])([^'"]*)\1/;

/**
 * Last `.`-separated segment of a (possibly relative) Python module
 * path. Strips any leading dots first so `from .api.assistant import
 * …` and `from api.assistant import …` both yield `assistant`.
 * Pure-dot inputs (`.`, `..`) have no segment and return the empty
 * string; callers should skip empty results.
 */
export function lastDottedSegment(text: string): string {
  const stripped = text.replace(/^\.+/, '');
  if (!stripped) return '';
  const dot = stripped.lastIndexOf('.');
  return dot >= 0 ? stripped.slice(dot + 1) : stripped;
}

/**
 * Last two `.`-separated segments of a (possibly relative) module
 * path joined with `/`, e.g. `api.users` → `api/users`. Mirrors the
 * long-key shape used for files (`api/users.py` → `api/users`).
 * Returns the empty string when no parent segment is available
 * (single-segment imports or pure dots); callers should fall back
 * to the short key in that case.
 */
export function lastTwoSegmentsAsPath(text: string): string {
  const stripped = text.replace(/^\.+/, '');
  if (!stripped) return '';
  const last = stripped.lastIndexOf('.');
  if (last <= 0) return '';
  const beforeLast = stripped.slice(0, last);
  const stem = stripped.slice(last + 1);
  const prev = beforeLast.lastIndexOf('.');
  const parent = prev >= 0 ? beforeLast.slice(prev + 1) : beforeLast;
  return `${parent}/${stem}`;
}

function findMatchingParen(content: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ')') return i;
    }
  }
  return -1;
}

/**
 * Scan a single Python file's source text for FastAPI router
 * `include_router` sites and `from <module> import router` imports,
 * appending raw records to the supplied collectors.
 *
 * `outModuleAliases` is optional: when supplied, every multi-segment
 * `from <pkg> import <name>` (other than `router` itself) is recorded
 * as a module alias so parse-impl can pin Shape-A
 * `<name>.include_router(...)` calls onto the exact module file. When
 * omitted, the function preserves the pre-existing behaviour and
 * skips the alias collection — this keeps the function signature
 * back-compat with older callers (and the parse-cache replay path).
 */
export function extractFastAPIRouterBindings(
  filePath: string,
  content: string,
  outIncludes: ExtractedRouterInclude[],
  outImports: ExtractedRouterImport[],
  outModuleAliases?: ExtractedRouterModuleAlias[],
  outConstructorPrefixes?: ExtractedRouterConstructorPrefix[],
): void {
  if (!content.includes('include_router') && !content.includes('router')) return;

  // `from <module> import router [as <alias>]`. We capture every name
  // in the import list. `router` (with or without an `as` alias) maps
  // to outImports; every other name lands in outModuleAliases when a
  // long key is available, so Shape-A `<name>.router` includes can be
  // pinned to the exact module file.
  if (content.includes(' import ')) {
    FROM_IMPORT_ROUTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_IMPORT_ROUTER_RE.exec(content)) !== null) {
      const moduleText = m[1];
      const importList = m[2];
      const moduleShort = lastDottedSegment(moduleText);
      if (!moduleShort) continue;
      // Long key for the imported MODULE itself (used by router
      // imports — `from api.users import router` sets
      // `moduleKeyLong = api/users`).
      const moduleLong = lastTwoSegmentsAsPath(moduleText);
      // Strip surrounding parens / trailing whitespace; split on
      // commas. (Multiline import groups already have their newlines
      // present in the captured list.)
      const cleaned = importList.replace(/[()]/g, '').trim();
      for (const rawPart of cleaned.split(',')) {
        const part = rawPart.trim();
        if (!part) continue;

        // `router` or `router as foo` → ExtractedRouterImport.
        const routerAlias = /^router(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(part);
        if (routerAlias) {
          const localName = routerAlias[1] ?? 'router';
          outImports.push({
            filePath,
            localName,
            moduleKey: moduleShort,
            ...(moduleLong ? { moduleKeyLong: moduleLong } : {}),
          });
          continue;
        }

        // Any other `<name>` or `<name> as <alias>` — recorded as a
        // module alias so parse-impl can pin Shape-A includes. The
        // long key here is computed against the IMPORTED MODULE PATH
        // (`<moduleText>.<name>`), not the package path that `<name>`
        // was imported FROM. `from api import users` therefore yields
        // `api/users`, the same long key as the file it points at.
        if (!outModuleAliases) continue;
        const otherAlias = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(part);
        if (!otherAlias) continue;
        const importedName = otherAlias[1];
        const localName = otherAlias[2] ?? importedName;
        const aliasLong = lastTwoSegmentsAsPath(`${moduleText}.${importedName}`);
        if (!aliasLong) continue;
        outModuleAliases.push({
          filePath,
          localName,
          moduleKeyLong: aliasLong,
        });
      }
    }
  }

  if (outConstructorPrefixes && content.includes('APIRouter') && content.includes('prefix')) {
    API_ROUTER_ASSIGN_RE.lastIndex = 0;
    // Only `router = APIRouter(...)` is captured (the apply gate and the
    // group-layer tree-sitter both pin to the literal name `router`).
    while (API_ROUTER_ASSIGN_RE.exec(content) !== null) {
      const openParen = API_ROUTER_ASSIGN_RE.lastIndex - 1;
      const closeParen = findMatchingParen(content, openParen);
      if (closeParen < 0) continue;
      const args = content.slice(openParen + 1, closeParen);
      const prefixMatch = API_ROUTER_PREFIX_ARG_RE.exec(args);
      if (!prefixMatch) continue;
      outConstructorPrefixes.push({
        filePath,
        prefix: prefixMatch[2],
      });
    }
  }

  if (!content.includes('include_router')) return;

  // Shape A: `<host>.include_router(<module>.router, prefix='/x')`.
  INCLUDE_ROUTER_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_ROUTER_ATTR_RE.exec(content)) !== null) {
    outIncludes.push({
      filePath,
      routerExpr: `${m[1]}.router`,
      prefix: m[3],
      lineNumber: content.substring(0, m.index).split('\n').length,
    });
  }

  // Shape B: `<host>.include_router(my_router, prefix='/x')`.
  // Resolution to a module key happens in parse-impl using
  // outImports from the same file.
  INCLUDE_ROUTER_NAME_RE.lastIndex = 0;
  while ((m = INCLUDE_ROUTER_NAME_RE.exec(content)) !== null) {
    // Skip cases that already matched Shape A — INCLUDE_ROUTER_NAME_RE
    // is intentionally permissive and would re-capture `<mod>.router`
    // as the bare name `mod`. Discriminate by re-checking the
    // immediate source around the captured argument position.
    const argStart = m.index + m[0].indexOf(m[1]);
    const dotProbe = content.slice(argStart + m[1].length, argStart + m[1].length + 8);
    if (/^\s*\.\s*router/.test(dotProbe)) continue;
    outIncludes.push({
      filePath,
      routerExpr: m[1],
      prefix: m[3],
      lineNumber: content.substring(0, m.index).split('\n').length,
    });
  }
}
