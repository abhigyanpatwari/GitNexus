/**
 * NAMESPACE `importFrom()` parsing for R packages.
 *
 * `parseRNamespaceImportFrom` is a pure, package-blind tokenizer: it reads the
 * text of one NAMESPACE file and returns every `importFrom(pkg, name, ...)`
 * pair in file order. It deliberately returns *all* entries — including a
 * package importing from itself and duplicate names from different packages —
 * because those policy decisions (own-package drop, last-wins, external-package
 * skip) belong to the consumer that knows the workspace, not to the parser.
 *
 * The tokenizer ({@link scanRNamespaceDirectives}) is generic (directive head +
 * balanced argument list across newlines, honouring `"…"`, `'…'` and backtick
 * quoting, `#` comments stripped outside quotes). Two consumers sit on it:
 * {@link parseRNamespaceImportFrom} (`importFrom` only; `import`,
 * `importClassesFrom` and `importMethodsFrom` are deferred) and
 * {@link parseRNamespaceExports} (`export`, `exportClasses`, `exportMethods`,
 * `S3method`, `exportPattern`). `useDynLib` and anything under an
 * `if (…)` / `else` conditional are ignored. Unbalanced or garbled input never
 * throws: scanning stops at the offending directive and everything parsed
 * before it is kept.
 *
 * Runtime import direction is `language-config.ts` → this file; any type from
 * `language-config.ts` must be taken with `import type` only, so no runtime
 * import cycle forms.
 *
 * The second half of the file binds those entries to workspace definitions:
 * {@link populateRNamespaceImports} synthesises `named` imports for
 * `importFrom()` names that a *local* package provides, and
 * {@link resolveRImportTarget}'s `named` branch (`import-resolvers/r.ts`)
 * resolves them using {@link rFileTopLevel} / {@link rPackageDirForFile}.
 */

import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import type { RPackageConfig } from '../../language-config.js';
import { unescapeRString } from './export-pattern.js';

/** One `importFrom(pkg, name)` pair, in NAMESPACE file order. */
export interface RNamespaceImportFromEntry {
  readonly pkg: string;
  readonly name: string;
}

const IMPORT_FROM_DIRECTIVES: ReadonlySet<string> = new Set(['importFrom']);

/** Directives whose arguments name exported symbols (`S3method` is handled separately). */
const EXPORT_NAME_DIRECTIVES: ReadonlySet<string> = new Set([
  'export',
  'exportClasses',
  'exportMethods',
]);

const EXPORT_DIRECTIVES: ReadonlySet<string> = new Set([
  ...EXPORT_NAME_DIRECTIVES,
  'S3method',
  'exportPattern',
]);

/** Directives whose following statement is conditional and therefore ignored. */
const CONDITIONAL_HEADS: ReadonlySet<string> = new Set(['if', 'else']);

const isIdentStart = (ch: string): boolean => /[A-Za-z_.]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_.]/.test(ch);
const isQuote = (ch: string): boolean => ch === '"' || ch === "'" || ch === '`';

/**
 * Advance past a quoted region starting at `start` (which holds the opening
 * quote). Returns the index just after the closing quote, or `-1` when the
 * quote never closes. Backslash escapes the next character (R string rules;
 * harmless inside backticks).
 */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return -1;
}

function skipLineComment(text: string, start: number): number {
  const nl = text.indexOf('\n', start);
  return nl === -1 ? text.length : nl + 1;
}

/**
 * Parse a balanced `( … )` group whose opening paren is at `openIdx`. Returns
 * the comma-separated top-level arguments (raw, comment-stripped, unquoted only
 * at the outer layer) and the index just after the closing paren, or `null`
 * when the group is unbalanced.
 */
function parseArgs(text: string, openIdx: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = openIdx; i < text.length;) {
    const ch = text[i];
    if (ch === '#') {
      i = skipLineComment(text, i);
      continue;
    }
    if (isQuote(ch)) {
      const end = skipQuoted(text, i);
      if (end === -1) return null;
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth > 1) current += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) {
        args.push(current);
        return { args, end: i + 1 };
      }
      current += ch;
      i++;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  return null;
}

/**
 * Strip whitespace and one layer of surrounding quotes/backticks from a raw
 * argument. Returns `''` for empty or non-simple arguments (unterminated quote,
 * or anything that is not a single bare/quoted token) so callers can skip them.
 */
function normaliseArg(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (isQuote(first)) {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) return '';
    const end = skipQuoted(trimmed, 0);
    if (end !== trimmed.length) return '';
    return trimmed.slice(1, -1).trim();
  }
  // Bare token: reject anything containing whitespace, quotes, or parens (e.g. `x = y`, nested calls).
  if (/[\s"'`()=]/.test(trimmed)) return '';
  return trimmed;
}

/**
 * Skip one statement following an `if (…)` / `else`: either a `{ … }` block or a
 * single directive call. Returns the index to resume scanning from.
 */
function skipConditionalBody(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return i;
  if (text[i] === '{') {
    let depth = 0;
    for (; i < text.length;) {
      const ch = text[i];
      if (ch === '#') {
        i = skipLineComment(text, i);
        continue;
      }
      if (isQuote(ch)) {
        const end = skipQuoted(text, i);
        if (end === -1) return text.length;
        i = end;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  if (isIdentStart(text[i])) {
    let j = i + 1;
    while (j < text.length && isIdentPart(text[j])) j++;
    const head = text.slice(i, j);
    if (CONDITIONAL_HEADS.has(head)) return j; // `else if (…)` — let the main loop handle the chain.
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '(') {
      const group = parseArgs(text, j);
      return group ? group.end : text.length;
    }
    return j;
  }
  return i;
}

/** One top-level NAMESPACE directive: its head and its raw (comment-stripped) arguments. */
interface RawDirective {
  readonly head: string;
  readonly args: readonly string[];
}

/**
 * Tokenise NAMESPACE text into the top-level directives whose head is in
 * `heads`, in file order. Conditional (`if` / `else`) bodies are skipped, and
 * directives nested inside another directive's arguments are never emitted.
 * Never throws; stops at the first unbalanced group, keeping what came before.
 */
function scanRNamespaceDirectives(text: string, heads: ReadonlySet<string>): RawDirective[] {
  const directives: RawDirective[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      i = skipLineComment(text, i);
      continue;
    }
    if (isQuote(ch)) {
      const end = skipQuoted(text, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (!isIdentStart(ch)) {
      i++;
      continue;
    }

    let j = i + 1;
    while (j < text.length && isIdentPart(text[j])) j++;
    const head = text.slice(i, j);
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;

    if (text[k] !== '(') {
      // `else` may be followed directly by a directive with no parens of its own.
      if (head === 'else') {
        i = skipConditionalBody(text, k);
        continue;
      }
      i = j;
      continue;
    }

    const group = parseArgs(text, k);
    if (!group) break; // Unbalanced: the rest of the file cannot be tokenised reliably.
    i = group.end;

    if (CONDITIONAL_HEADS.has(head)) {
      i = skipConditionalBody(text, i);
      continue;
    }
    if (heads.has(head)) directives.push({ head, args: group.args });
  }
  return directives;
}

/**
 * Extract every `importFrom(pkg, name, ...)` pair from NAMESPACE text, in file
 * order. Never throws; returns `[]` for empty, garbled or unbalanced input.
 */
export function parseRNamespaceImportFrom(text: string): RNamespaceImportFromEntry[] {
  const entries: RNamespaceImportFromEntry[] = [];
  for (const { args } of scanRNamespaceDirectives(text, IMPORT_FROM_DIRECTIVES)) {
    const values = args.map(normaliseArg);
    const pkg = values[0];
    if (!pkg) continue;
    for (let n = 1; n < values.length; n++) {
      if (values[n]) entries.push({ pkg, name: values[n] });
    }
  }
  return entries;
}

/** What a NAMESPACE file exports, as read by {@link parseRNamespaceExports}. */
export interface RNamespaceExports {
  /** Names from `export()`, `exportClasses()`, `exportMethods()` and `S3method()` (as `generic.class`), in file order. */
  readonly namedExports: readonly string[];
  /** `exportPattern()` arguments, R-unescaped (an R string `"\\."` yields the regex source `\.`), in file order. */
  readonly exportPatterns: readonly string[];
}

/**
 * The single-token string argument of `exportPattern()`, R-unescaped, or `''`
 * when the argument is empty, not a quoted string, or unterminated. Only `"`
 * and `'` quote a string in R (a backticked name is a symbol, not a pattern).
 */
function exportPatternArg(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return '';
  if (skipQuoted(trimmed, 0) !== trimmed.length) return '';
  return unescapeRString(trimmed.slice(1, -1));
}

/**
 * Extract the export directives from NAMESPACE text: `export`, `exportClasses`
 * and `exportMethods` names, `S3method(generic, class[, method])` as
 * `generic.class`, and `exportPattern("…")` sources. Multi-line, quoted,
 * backticked, commented and CRLF input is handled like {@link
 * parseRNamespaceImportFrom}. Non-simple arguments (named, nested calls) are
 * skipped. Never throws; returns empty lists for empty or garbled input.
 */
export function parseRNamespaceExports(text: string): RNamespaceExports {
  const namedExports: string[] = [];
  const exportPatterns: string[] = [];
  for (const { head, args } of scanRNamespaceDirectives(text, EXPORT_DIRECTIVES)) {
    if (head === 'exportPattern') {
      for (const raw of args) {
        const pattern = exportPatternArg(raw);
        if (pattern) exportPatterns.push(pattern);
      }
    } else if (head === 'S3method') {
      const generic = normaliseArg(args[0] ?? '');
      const cls = normaliseArg(args[1] ?? '');
      if (generic && cls) namedExports.push(`${generic}.${cls}`);
    } else {
      for (const raw of args) {
        const name = normaliseArg(raw);
        if (name) namedExports.push(name);
      }
    }
  }
  return { namedExports, exportPatterns };
}

// ─── Package lookup ─────────────────────────────────────────────────────────

/** A local R package located by {@link rPackageDirForFile}. */
export interface RPackageLocation {
  /** `Package:` name from `DESCRIPTION`. */
  readonly name: string;
  /** Package directory relative to the repo root; `''` for a root-level package. */
  readonly dir: string;
}

/** `R/` directory prefix of a package dir (`'R/'` for a root-level package). */
export function rRDirPrefix(pkgDir: string): string {
  return pkgDir === '' ? 'R/' : `${pkgDir}/R/`;
}

/**
 * The local package whose `<pkgDir>/R/**` contains `filePath`, or `undefined`.
 *
 * NAMESPACE effects apply only to a package's `R/` sources (R loads nothing
 * else into the namespace), so files under `tests/`, `scripts/`, `inst/`, a
 * root-level `plumber.R`, … belong to no package here. When package dirs nest,
 * the longest matching dir wins. A root-level package (`dir === ''`) is
 * handled without ever building a `'' + '/'` prefix.
 */
export function rPackageDirForFile(
  filePath: string,
  cfg: RPackageConfig | null | undefined,
): RPackageLocation | undefined {
  if (cfg === null || cfg === undefined) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  let best: RPackageLocation | undefined;
  for (const [name, dir] of cfg.packages) {
    if (!normalized.startsWith(rRDirPrefix(dir))) continue;
    if (best === undefined || dir.length > best.dir.length) best = { name, dir };
  }
  return best;
}

// ─── Top-level definitions of a parsed file ────────────────────────────────

/** Def kinds an R `importFrom()` can bind to (functions and R6/R5/S4 classes). */
const TOP_LEVEL_BINDABLE_TYPES: ReadonlySet<string> = new Set(['Function', 'Class']);

/** What one R file defines at top level, read from its Module scope. */
export interface RFileTopLevel {
  /** Names of top-level function/class definitions, exactly as bound (backticks kept). */
  readonly names: ReadonlySet<string>;
  /** For each dotted name in {@link names}, the text after its last `.`. */
  readonly dottedTails: ReadonlySet<string>;
}

const EMPTY_TOP_LEVEL: RFileTopLevel = { names: new Set(), dottedTails: new Set() };
const topLevelCache = new WeakMap<ParsedFile, RFileTopLevel>();

/**
 * Top-level definitions of `parsed`, read from the Module scope's hoisted
 * bindings.
 *
 * Since the caller-attribution fix (fork #5) a top-level function def is
 * owned by its *own* Function scope and only its binding is hoisted into the
 * Module scope, so neither the Module scope's `ownedDefs` nor the flat
 * `localDefs` (which also lists nested functions and R6/R5 members) answers
 * "is `name` defined at top level?". A `local`-origin Module binding to a
 * function/class def does. Bindings are read at extraction time, before
 * `finalizeScopeModel` adds import/wildcard bindings.
 */
export function rFileTopLevel(parsed: ParsedFile): RFileTopLevel {
  const cached = topLevelCache.get(parsed);
  if (cached !== undefined) return cached;
  const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
  let result = EMPTY_TOP_LEVEL;
  if (moduleScope !== undefined) {
    const names = new Set<string>();
    const dottedTails = new Set<string>();
    for (const [name, refs] of moduleScope.bindings) {
      if (!refs.some((r) => r.origin === 'local' && TOP_LEVEL_BINDABLE_TYPES.has(r.def.type))) {
        continue;
      }
      names.add(name);
      const dot = name.lastIndexOf('.');
      if (dot >= 0) dottedTails.add(name.slice(dot + 1));
    }
    result = { names, dottedTails };
  }
  topLevelCache.set(parsed, result);
  return result;
}

// ─── Import synthesis (populateWorkspaceReferences) ─────────────────────────

/**
 * Per local package, the set of names it defines at top level in its `R/`
 * files, recorded by {@link populateRNamespaceImports} for the packages that
 * take part in an `importFrom()` (as caller or as provider). Keyed by the
 * `resolutionConfig` object, which reaches both this hook and the
 * free-call-fallback veto. A missing entry means "cannot decide".
 */
const packageTopLevelNames = new WeakMap<object, ReadonlyMap<string, ReadonlySet<string>>>();

/** Recorded top-level names per package for `resolutionConfig`, if the hook ran with imports. */
export function rRecordedPackageTopLevelNames(
  resolutionConfig: unknown,
): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  if (typeof resolutionConfig !== 'object' || resolutionConfig === null) return undefined;
  return packageTopLevelNames.get(resolutionConfig);
}

interface CallerPlan {
  readonly dir: string;
  /** Surviving `name → provider package` after last-wins / self-drop / external-skip. */
  readonly bindable: ReadonlyMap<string, string>;
}

/**
 * Synthesise `named` imports for NAMESPACE `importFrom(pkg, name)` entries
 * whose `pkg` is a local package, into every `R/` file of the caller package.
 *
 * NOTE: `populateWorkspaceReferences` is documented as reference-site
 * enrichment; it is reused here (same call site and ctx as the Zig static
 * gating precedent) because it runs before `finalizeScopeModel`, receives the
 * mutable `ParsedFile[]`, and also runs over warm-cache ParsedFiles, so the
 * synthesised imports are never persisted stale. If this is ever upstreamed,
 * propose widening that contract's doc string.
 *
 * Order of operations per caller package (decided rules):
 *  1. last-wins over ALL entries for a name, in file order, external
 *     packages included (R replaces the earlier `importFrom` binding);
 *  2. drop the surviving entry when its `pkg` is the caller itself;
 *  3. skip it when its `pkg` is not a local package (an earlier local entry
 *     never resurrects);
 *  4. skip it when the caller's own package defines `name` at top level in
 *     any `R/` file (the own namespace masks its imports; `rMergeBindings`
 *     only shadows within a single scope);
 *  5. append a `named` import to every `R/` file of the caller package.
 */
export function populateRNamespaceImports(
  parsedFiles: ParsedFile[],
  ctx: { readonly resolutionConfig?: unknown },
): void {
  const cfg = (ctx.resolutionConfig as RPackageConfig | null | undefined) ?? null;
  if (cfg === null || cfg.packages.size === 0) return;

  // Steps 1-3: collapse each caller's entries; note which packages we need names for.
  const plans = new Map<string, CallerPlan>();
  const needNamesFor = new Set<string>();
  for (const [callerName, dir] of cfg.packages) {
    const info = cfg.namespaceInfoByPackageDir.get(dir);
    if (info === undefined || info.importFrom.length === 0) continue;
    const last = new Map<string, string>();
    for (const entry of info.importFrom) last.set(entry.name, entry.pkg);
    const bindable = new Map<string, string>();
    for (const [name, pkg] of last) {
      if (cfg.packages.has(pkg)) needNamesFor.add(pkg); // C5 reads the provider's names too
      if (pkg === callerName || !cfg.packages.has(pkg)) continue;
      bindable.set(name, pkg);
    }
    if (bindable.size === 0) continue;
    plans.set(callerName, { dir, bindable });
    needNamesFor.add(callerName);
  }
  if (plans.size === 0) return;

  // One pass over the parsed files: group caller files, collect top-level names.
  const namesByPackage = new Map<string, Set<string>>();
  const callerFiles = new Map<string, number[]>();
  for (let i = 0; i < parsedFiles.length; i++) {
    const location = rPackageDirForFile(parsedFiles[i].filePath, cfg);
    if (location === undefined) continue;
    if (needNamesFor.has(location.name)) {
      let names = namesByPackage.get(location.name);
      if (names === undefined) namesByPackage.set(location.name, (names = new Set()));
      for (const name of rFileTopLevel(parsedFiles[i]).names) names.add(name);
    }
    if (plans.has(location.name)) {
      const indices = callerFiles.get(location.name);
      if (indices === undefined) callerFiles.set(location.name, [i]);
      else indices.push(i);
    }
  }
  for (const pkg of needNamesFor) if (!namesByPackage.has(pkg)) namesByPackage.set(pkg, new Set());
  packageTopLevelNames.set(cfg, namesByPackage);

  // Steps 4-5.
  for (const [callerName, plan] of plans) {
    const ownNames = namesByPackage.get(callerName);
    const synthesised: Extract<ParsedImport, { kind: 'named' }>[] = [];
    for (const [name, pkg] of plan.bindable) {
      if (ownNames?.has(name) === true) continue;
      synthesised.push({ kind: 'named', localName: name, importedName: name, targetRaw: pkg });
    }
    if (synthesised.length === 0) continue;
    for (const index of callerFiles.get(callerName) ?? []) {
      const parsed = parsedFiles[index];
      const fresh = synthesised.filter(
        (imp) =>
          !parsed.parsedImports.some(
            (existing) =>
              existing.kind === 'named' &&
              existing.localName === imp.localName &&
              existing.targetRaw === imp.targetRaw,
          ),
      );
      if (fresh.length === 0) continue;
      parsedFiles[index] = Object.freeze({
        ...parsed,
        parsedImports: Object.freeze([...parsed.parsedImports, ...fresh]),
      });
    }
  }
}

// ─── Global-name fallback veto (isGlobalNameFallbackPlausible) ──────────────

/**
 * Structural subset of the hook context `isRGlobalNameFallbackPlausible`
 * reads; the shared contract's full context is assignable to it.
 */
export interface RGlobalNameFallbackContext {
  readonly callerParsed: { readonly filePath: string };
  readonly candidate: { readonly filePath: string };
  /** Opaque `loadResolutionConfig` result; an {@link RPackageConfig} for R. */
  readonly resolutionConfig?: unknown;
  readonly site: { readonly name: string };
}

/**
 * Refuse a `global-name-fallback` guess that the caller package's NAMESPACE
 * contradicts. Returns `false` (veto) only when ALL of these hold:
 *
 *  - the caller file lives under `<pkgDir>/R/**` of a package with a NAMESPACE
 *    that has an `importFrom(P, <site.name>)` entry (the LAST such entry over
 *    all entries, external packages included — the same rule C4 applies);
 *  - `P` is not the caller's own package (a self-import binds nothing);
 *  - the candidate lives under some package's `R/**`, and that package is
 *    neither the caller's own (own namespace masks; a plain 0.5 fallback edge
 *    until own-package binding exists) nor `P`;
 *  - if `P` is local, it defines `site.name` at top level; otherwise `P`
 *    re-exports the name from a third package and the candidate may be the
 *    real origin (unknown per-package names = cannot decide = allow).
 *
 * Everything else — no config, caller outside a package `R/` (`tests/`,
 * `scripts/`, root `plumber.R`), no entry, candidate outside any package
 * `R/` — answers `true`, so `source()`/`library()` script flows are untouched.
 *
 * Known unsound shapes, pinned by characterisation tests (fork #7): the
 * qualifier of `pkg::name()` is discarded, so a correct `legacyscore::mutate()`
 * edge is refused when `importFrom(dplyr, mutate)` exists; and `import(pkg)`
 * is not tokenised, so a later `import(pkg)` that R would prefer is invisible.
 */
export function isRGlobalNameFallbackPlausible(ctx: RGlobalNameFallbackContext): boolean {
  const cfg = ctx.resolutionConfig as RPackageConfig | null | undefined;
  if (
    typeof cfg !== 'object' ||
    cfg === null ||
    !(cfg.packages instanceof Map) ||
    !(cfg.namespaceInfoByPackageDir instanceof Map)
  ) {
    return true;
  }

  const caller = rPackageDirForFile(ctx.callerParsed.filePath, cfg);
  if (caller === undefined) return true;
  const importFrom = cfg.namespaceInfoByPackageDir.get(caller.dir)?.importFrom;
  if (importFrom === undefined) return true;

  let lastEntry: RNamespaceImportFromEntry | undefined;
  for (const entry of importFrom) if (entry.name === ctx.site.name) lastEntry = entry;
  if (lastEntry === undefined) return true;
  const importedFrom = lastEntry.pkg;
  if (importedFrom === caller.name) return true;

  const candidatePkg = rPackageDirForFile(ctx.candidate.filePath, cfg);
  if (candidatePkg === undefined) return true;
  if (candidatePkg.name === caller.name || candidatePkg.name === importedFrom) return true;

  if (cfg.packages.has(importedFrom)) {
    const providerNames = rRecordedPackageTopLevelNames(cfg)?.get(importedFrom);
    if (providerNames === undefined || !providerNames.has(ctx.site.name)) return true;
  }
  return false;
}
