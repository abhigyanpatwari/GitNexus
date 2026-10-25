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
 * throws: a malformed directive is discarded and scanning RESYNCHRONISES at the
 * next line that begins, at column 0, with `identifier(` (see
 * {@link resyncAfterMalformed}); everything parsed before and after is kept.
 * Quoted strings never span lines, and a column-0 `identifier(` line ends any
 * argument list still open, so a broken directive cannot swallow those after it.
 *
 * Runtime import direction is `language-config.ts` → this file; any type from
 * `language-config.ts` must be taken with `import type` only, so no runtime
 * import cycle forms.
 *
 * The second half of the file binds those entries to workspace definitions:
 * {@link populateRNamespaceImports} synthesises `named` imports for
 * `importFrom()` names that a *local* package provides, and
 * {@link resolveRImportTarget}'s `named` branch (`languages/r/import-target.ts`)
 * resolves them using {@link rFileTopLevel} / {@link rPackageDirForFile}.
 *
 * The file also hosts the pieces of `pkg::name()` qualifier handling that the
 * global-name-fallback veto ({@link isRGlobalNameFallbackPlausible}) shares
 * with `qualified-call.ts`: {@link parseRQualifier} and the per-package
 * definition-count registry. The qualified-call decisions themselves live in
 * `qualified-call.ts`.
 */

import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import type { RNamespaceInfo, RPackageConfig } from './package-config.js';
import { unescapeRString } from './export-pattern.js';
import { rBareName } from './bare-name.js';
import { resolveRNamedImport } from './import-target.js';

/** One `importFrom(pkg, name)` pair, in NAMESPACE file order. */
export interface RNamespaceImportFromEntry {
  readonly pkg: string;
  readonly name: string;
}

const IMPORT_FROM_DIRECTIVES: ReadonlySet<string> = new Set(['importFrom']);

/** Directives that import from a package: whole (`import`), by name, or S4 classes and methods. */
const IMPORT_DIRECTIVES: ReadonlySet<string> = new Set([
  'import',
  'importFrom',
  'importClassesFrom',
  'importMethodsFrom',
]);

/** An import-family directive head followed by `(`, anywhere in a piece of NAMESPACE text. */
const IMPORT_HEAD_IN_TEXT = new RegExp(
  `(?<![\\p{L}\\p{N}._])(?:${[...IMPORT_DIRECTIVES].join('|')})\\s*\\(`,
  'u',
);

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

/** An export-family directive head followed by `(`, anywhere in a piece of NAMESPACE text. */
const EXPORT_HEAD_IN_TEXT = new RegExp(
  `(?<![\\p{L}\\p{N}._])(?:${[...EXPORT_DIRECTIVES].join('|')})\\s*\\(`,
  'u',
);

/** Directives whose following statement is conditional and therefore ignored. */
const CONDITIONAL_HEADS: ReadonlySet<string> = new Set(['if', 'else']);

const isIdentStart = (ch: string): boolean => /[A-Za-z_.]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_.]/.test(ch);
const isQuote = (ch: string): boolean => ch === '"' || ch === "'" || ch === '`';

/**
 * Advance past a quoted region starting at `start` (which holds the opening
 * quote). Returns the index just after the closing quote, or `-1` when the
 * quote does not close on the same line. Backslash escapes the next character
 * (R string rules; harmless inside backticks). Quotes never span lines: a
 * NAMESPACE directive argument is a one-line token, and letting a stray quote
 * run on would pair with a later one and swallow the directives between them.
 */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      i++;
      if (text[i] === '\n') return -1;
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

/** A directive-looking line start: `identifier(` (no leading whitespace, no space before `(`). */
const DIRECTIVE_LINE_START = /[A-Za-z_.][A-Za-z0-9_.]*\(/y;

/** True when `i` is the start of a line (column 0) that begins with `identifier(`. */
function isDirectiveLineStart(text: string, i: number): boolean {
  if (i > 0 && text[i - 1] !== '\n') return false;
  DIRECTIVE_LINE_START.lastIndex = i;
  return DIRECTIVE_LINE_START.test(text);
}

/**
 * Resynchronisation point after a malformed directive that began at `from`: the
 * start of the first line AFTER the line containing `from` that begins, at
 * column 0, with `identifier(`; `text.length` when there is none. The result
 * is always greater than `from` (or the end of text), so callers make forward
 * progress and each failure costs at most one pass over the text it skips.
 */
function resyncAfterMalformed(text: string, from: number): number {
  let nl = text.indexOf('\n', from);
  while (nl !== -1) {
    const lineStart = nl + 1;
    if (isDirectiveLineStart(text, lineStart)) return lineStart;
    nl = text.indexOf('\n', lineStart);
  }
  return text.length;
}

/**
 * Parse a balanced `( … )` group whose opening paren is at `openIdx`. Returns
 * the comma-separated top-level arguments (raw, comment-stripped, unquoted only
 * at the outer layer) and the index just after the closing paren, or `null`
 * when the group is unbalanced, holds an unterminated quote, or is still open
 * when a line starting `identifier(` at column 0 begins (which bounds the scan,
 * so an unbalanced group cannot run to the end of the file).
 */
function parseArgs(text: string, openIdx: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = openIdx; i < text.length; ) {
    if (i > openIdx && isDirectiveLineStart(text, i)) return null;
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

/** A bare directive argument R reads as a symbol: a letter or `.`, then letters, digits, `.` and `_`. */
const BARE_NAME = /^[\p{L}.][\p{L}\p{N}._]*$/u;

/**
 * Strip the whitespace around a raw argument and one layer of surrounding quotes/backticks; the
 * text inside the quotes is kept as written, spaces included. Returns `''` for empty or
 * non-simple arguments (unterminated quote, or anything that is not a single quoted token or bare
 * symbol) so callers can skip them. A bare operator or indexing expression (`a+b`, `x[1]`) is not a symbol.
 */
function normaliseArg(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (isQuote(first)) {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) return '';
    const end = skipQuoted(trimmed, 0);
    if (end !== trimmed.length) return '';
    const inner = trimmed.slice(1, -1);
    // A string is R-unescaped; a backticked name keeps an escaped backtick as written (see `rBareName`).
    // Not trimmed: R reads the quoted text as it stands, so `" a "` names the symbol ` a `.
    return first === '`' ? inner : unescapeRString(inner);
  }
  // Bare token: a syntactic name. Anything else (`x = y`, a nested call, an expression) is rejected.
  return BARE_NAME.test(trimmed) ? trimmed : '';
}

/**
 * `text` without its trailing colons: what `text.replace(/:+$/, '')` gives, in linear time. The
 * regex retries from every colon of a long run, which is quadratic in its length, and a
 * NAMESPACE is repository input.
 */
export function trimTrailingColons(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 58) end--;
  return text.slice(0, end);
}

/**
 * The generic named by the first argument of `S3method()`. R >= 3.6 also accepts a generic of
 * another package, `S3method(pkg::generic, class)` (roxygen2 writes it for
 * `@exportS3Method pkg::generic`), whose method is still `generic.class`: the text after the
 * last `::` or `:::` outside quotes and backticks is the generic. `''` when the argument is not
 * a plain name, a quoted name, or a `pkg::name` pair of those.
 */
function s3GenericArg(raw: string): string {
  const trimmed = raw.trim();
  let operatorEnd = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (isQuote(ch)) {
      const end = skipQuoted(trimmed, i);
      if (end === -1) return '';
      i = end - 1;
    } else if (ch === ':' && trimmed[i + 1] === ':') {
      operatorEnd = trimmed[i + 2] === ':' ? i + 3 : i + 2;
      i = operatorEnd - 1;
    }
  }
  if (operatorEnd === -1) {
    // A quoted generic spelled with its package: `"pkg::generic"`.
    const name = normaliseArg(trimmed);
    const colons = name.lastIndexOf('::');
    return colons === -1 ? name : name.slice(colons + 2).replace(/^:/, '');
  }
  // Both sides must be names; the package side is only checked, never used.
  const before = trimTrailingColons(trimmed.slice(0, operatorEnd));
  return normaliseArg(before) ? normaliseArg(trimmed.slice(operatorEnd)) : '';
}

/**
 * When `text[i]` starts an `if (cond)`, the index just after its condition group; `-1`
 * when the condition is malformed; `null` when no `if` starts here.
 */
function nestedIfCondition(text: string, i: number): number | null {
  if (i >= text.length || !isIdentStart(text[i])) return null;
  let j = i + 1;
  while (j < text.length && isIdentPart(text[j])) j++;
  if (text.slice(i, j) !== 'if') return null;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] !== '(') return null;
  const group = parseArgs(text, j);
  return group ? group.end : -1;
}

/**
 * Where each `{ … }` block of NAMESPACE text ends, answered in constant time after one linear
 * pass over the text. Scanning a block from its own `{` instead costs a pass over the rest of
 * the file whenever the block never closes, and a file of `if (a) {` lines with no `}` made
 * that quadratic (a 300 KB input took 8.8 s).
 *
 * The pass tokenises like the block scan it replaces: `#` comments run to the end of the line,
 * a quote that does not close on its line aborts every block still open at that point, and a
 * `}` closes the innermost open one. A comment or a quote never spans lines, so every line
 * start is a clean token boundary and the tokens from any `{` the directive scanner reaches
 * are the same as the tokens of the pass from the start of the text.
 */
class BraceBlocks {
  private ends: Map<number, number> | undefined;

  constructor(private readonly text: string) {}

  /** The index just after the `}` closing the block opened at `open`; `-1` when it never closes. */
  endOf(open: number): number {
    this.ends ??= this.index();
    return this.ends.get(open) ?? -1;
  }

  private index(): Map<number, number> {
    const { text } = this;
    const ends = new Map<number, number>();
    const open: number[] = [];
    for (let i = 0; i < text.length; ) {
      const ch = text[i];
      if (ch === '#') {
        i = skipLineComment(text, i);
      } else if (isQuote(ch)) {
        const end = skipQuoted(text, i);
        if (end !== -1) {
          i = end;
          continue;
        }
        // An unterminated quote aborts every block open here; resume on the next line.
        open.length = 0;
        const newline = text.indexOf('\n', i);
        i = newline === -1 ? text.length : newline + 1;
      } else {
        if (ch === '{') open.push(i);
        else if (ch === '}') {
          const start = open.pop();
          if (start !== undefined) ends.set(start, i + 1);
        }
        i++;
      }
    }
    return ends;
  }
}

/**
 * Skip one statement following an `if (…)` / `else`: either a `{ … }` block or a
 * single directive call. Returns the index to resume scanning from.
 */
function skipConditionalBody(text: string, from: number, blocks: BraceBlocks): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    // `else if (cond) body` and `if (a) if (b) body`: the nested `if` owns the body that
    // follows its condition, so step over `if (cond)` and skip that body instead
    // (iteratively: an `if` chain can be arbitrarily long).
    const nested = nestedIfCondition(text, i);
    if (nested === null) break;
    if (nested === -1) return resyncAfterMalformed(text, i);
    i = nested;
  }
  if (i >= text.length) return i;
  if (text[i] === '{') {
    const end = blocks.endOf(i);
    return end === -1 ? resyncAfterMalformed(text, i) : end; // -1: unterminated `{ … }`
  }
  if (isIdentStart(text[i])) {
    let j = i + 1;
    while (j < text.length && isIdentPart(text[j])) j++;
    const head = text.slice(i, j);
    if (CONDITIONAL_HEADS.has(head)) return j; // a bare `else` here has no body to skip
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '(') {
      const group = parseArgs(text, j);
      return group ? group.end : resyncAfterMalformed(text, i);
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
 * Never throws. A malformed directive (unbalanced group, unterminated quote,
 * unterminated `{` block) is discarded and scanning resumes at the next line
 * starting `identifier(` at column 0 ({@link resyncAfterMalformed}); everything
 * before and after is kept. Directives indented after a malformed one are
 * dropped with it.
 */
function scanRNamespaceDirectives(
  text: string,
  heads: ReadonlySet<string>,
  hiddenHead: RegExp = EXPORT_HEAD_IN_TEXT,
): { directives: RawDirective[]; hidesExport: boolean } {
  const directives: RawDirective[] = [];
  const blocks = new BraceBlocks(text);
  // Set when the scan skipped or discarded text that names a directive `hiddenHead` matches (by
  // default the export family). The regions are disjoint (every skip moves `i` forward), so the
  // tests cost one pass in total.
  let hidesExport = false;
  const skipped = (from: number, to: number): void => {
    if (!hidesExport && hiddenHead.test(text.slice(from, to))) hidesExport = true;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      i = skipLineComment(text, i);
      continue;
    }
    if (isQuote(ch)) {
      const end = skipQuoted(text, i);
      if (end === -1) {
        const resume = resyncAfterMalformed(text, i); // stray unterminated quote
        skipped(i, resume);
        i = resume;
        continue;
      }
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
        const end = skipConditionalBody(text, k, blocks);
        skipped(k, end);
        i = end;
        continue;
      }
      i = j;
      continue;
    }

    const group = parseArgs(text, k);
    if (!group) {
      const resume = resyncAfterMalformed(text, i); // discard this directive, resume at the next one
      skipped(i, resume);
      i = resume;
      continue;
    }
    i = group.end;

    if (CONDITIONAL_HEADS.has(head)) {
      const end = skipConditionalBody(text, i, blocks);
      skipped(i, end);
      i = end;
      continue;
    }
    if (heads.has(head)) directives.push({ head, args: group.args });
  }
  return { directives, hidesExport };
}

/**
 * Extract every `importFrom(pkg, name, ...)` pair from NAMESPACE text, in file
 * order. Never throws; returns `[]` for empty, garbled or unbalanced input.
 */
export function parseRNamespaceImportFrom(text: string): RNamespaceImportFromEntry[] {
  const entries: RNamespaceImportFromEntry[] = [];
  for (const { args } of scanRNamespaceDirectives(text, IMPORT_FROM_DIRECTIVES).directives) {
    const values = args.map(normaliseArg);
    const pkg = values[0];
    if (!pkg) continue;
    for (let n = 1; n < values.length; n++) {
      if (values[n]) entries.push({ pkg, name: values[n] });
    }
  }
  return entries;
}

/** The packages a NAMESPACE file imports from, as read by {@link parseRNamespaceImportPackages}. */
export interface RNamespaceImportPackages {
  /** Packages of `import()`, `importClassesFrom()` and `importMethodsFrom()`, in file order. */
  readonly packages: readonly string[];
  /**
   * True when the reader skipped or could not read something that may hide an import: a
   * conditional (`if` / `else`) body or a malformed directive that names an import-family
   * directive, or an argument of an `import()` or `importFrom()` it cannot read.
   */
  readonly unreadable: boolean;
}

/**
 * Read the packages a NAMESPACE imports from without naming each object: `import(a, b)` (a named
 * argument such as `except = c(...)` is skipped, the packages are still imported) and the package
 * of `importClassesFrom()` / `importMethodsFrom()`. `importFrom()` entries are read by
 * {@link parseRNamespaceImportFrom}; here they only count toward {@link
 * RNamespaceImportPackages.unreadable}. Never throws.
 */
export function parseRNamespaceImportPackages(text: string): RNamespaceImportPackages {
  const packages: string[] = [];
  const scan = scanRNamespaceDirectives(text, IMPORT_DIRECTIVES, IMPORT_HEAD_IN_TEXT);
  let unreadable = scan.hidesExport;
  for (const { head, args } of scan.directives) {
    if (head === 'import') {
      for (const raw of args) {
        if (/^\s*[A-Za-z_.][A-Za-z0-9_.]*\s*=/.test(raw)) continue; // except = ...
        const pkg = normaliseArg(raw);
        if (pkg) packages.push(pkg);
        else if (raw.trim()) unreadable = true;
      }
    } else if (head === 'importFrom') {
      for (const raw of args) if (!normaliseArg(raw) && raw.trim()) unreadable = true;
    } else {
      const pkg = normaliseArg(args[0] ?? '');
      if (pkg) packages.push(pkg);
      else unreadable = true;
    }
  }
  return { packages, unreadable };
}

/** What a NAMESPACE file exports, as read by {@link parseRNamespaceExports}. */
export interface RNamespaceExports {
  /** Names from `export()`, `exportClasses()`, `exportMethods()` and `S3method()` (the third argument, else `generic.class`), in file order. */
  readonly namedExports: readonly string[];
  /** `exportPattern()` arguments, R-unescaped (an R string `"\\."` yields the regex source `\.`), in file order. */
  readonly exportPatterns: readonly string[];
  /**
   * True when the reader skipped, dropped or could not read something that may hide an export:
   * a conditional (`if` / `else`) body or a malformed directive that names an export-family
   * directive, or an argument of one it cannot read (an R 4.0 raw string, a string that spans
   * lines, a name given as an expression, an `S3method()` without a readable generic and class).
   * The lists above are then a lower bound, so the absence of a name from them does not show
   * that it is private.
   */
  readonly unreadable: boolean;
  /**
   * The `S3method()` names (as in {@link namedExports}) that no `export()`, `exportClasses()` or
   * `exportMethods()` entry also lists, in file order. `S3method()` registers a method for S3
   * dispatch; it does not export the function (`pkg::name` errors and `library(pkg)` does not
   * attach it), so `loadRPackageConfig` takes these out of the exports resolution sees. Optional
   * so that hand-built values read as "no registration-only name".
   */
  readonly s3RegisteredOnly?: readonly string[];
  /** Every `S3method()` name (as in {@link namedExports}), in file order. Optional, as above. */
  readonly s3Registered?: readonly string[];
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
 * and `exportMethods` names, `S3method(generic, class[, method])` as `method`
 * (else `generic.class`; `pkg::generic` names the generic after the `::`), and `exportPattern("…")` sources. Multi-line, quoted,
 * backticked, commented and CRLF input is handled like {@link
 * parseRNamespaceImportFrom}. Non-simple arguments (named, nested calls) are
 * skipped, and so are conditional bodies and malformed directives; each of those that may hide
 * an export sets {@link RNamespaceExports.unreadable}. Never throws; returns empty lists for
 * empty or garbled input.
 */
export function parseRNamespaceExports(text: string): RNamespaceExports {
  const namedExports: string[] = [];
  const s3Registered: string[] = [];
  const exportedByName = new Set<string>();
  const exportPatterns: string[] = [];
  const scan = scanRNamespaceDirectives(text, EXPORT_DIRECTIVES);
  let unreadable = scan.hidesExport;
  for (const { head, args } of scan.directives) {
    if (head === 'exportPattern') {
      for (const raw of args) {
        const pattern = exportPatternArg(raw);
        if (pattern) exportPatterns.push(pattern);
        else if (raw.trim()) unreadable = true;
      }
    } else if (head === 'S3method') {
      const generic = s3GenericArg(args[0] ?? '');
      const cls = normaliseArg(args[1] ?? '');
      if (generic && cls) {
        // The optional third argument names the function registered as the method;
        // without it the method is `generic.class`.
        const method = normaliseArg(args[2] ?? '');
        namedExports.push(method || `${generic}.${cls}`);
        s3Registered.push(method || `${generic}.${cls}`);
        // A third argument that is not a plain name (`method = impl`) registers a function
        // this reader does not name.
        if (!method && (args[2] ?? '').trim()) unreadable = true;
      } else {
        unreadable = true;
      }
    } else {
      for (const raw of args) {
        const name = normaliseArg(raw);
        if (name) {
          namedExports.push(name);
          exportedByName.add(name);
        } else if (raw.trim()) unreadable = true;
      }
    }
  }
  const s3RegisteredOnly = s3Registered.filter((name) => !exportedByName.has(name));
  return { namedExports, exportPatterns, unreadable, s3RegisteredOnly, s3Registered };
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

/**
 * The directory of the package whose `R/` sources contain `filePath`, or `undefined`.
 *
 * Unlike {@link rPackageDirForFile} this considers every directory that has a NAMESPACE as
 * well as every registered package, so the nearest enclosing package owns a file and a nested
 * package without a NAMESPACE never inherits the enclosing package's. The longest matching
 * directory wins; the root package (`''`) is matched without building a `'' + '/'` prefix.
 */
export function rOwningPackageDir(
  filePath: string,
  cfg: RPackageConfig | null | undefined,
): string | undefined {
  if (cfg === null || cfg === undefined) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  let best: string | undefined;
  const consider = (dir: string): void => {
    if (!normalized.startsWith(rRDirPrefix(dir))) return;
    if (best === undefined || dir.length > best.length) best = dir;
  };
  for (const dir of cfg.packages.values()) consider(dir);
  for (const dir of cfg.namespaceInfoByPackageDir.keys()) consider(dir);
  return best;
}

/**
 * The directory of the package whose TREE contains `filePath`, or `undefined`: the same
 * candidate directories as {@link rOwningPackageDir} (registered packages and NAMESPACE
 * directories), but a file counts as inside a directory when it sits anywhere under it (prefix
 * `dir + '/'`, every path when `dir` is `''`), so `tests/`, `inst/` and `vignettes/` belong to
 * the package too. The longest matching directory wins, so a nested package claims its own files
 * and the enclosing package the rest. For a root-level package every file outside a nested
 * package is inside, so what the caller-inside-the-package exemption covers is broad there.
 *
 * A caller is "inside package P" iff this equals P's directory. {@link rOwningPackageDir}, which
 * decides whose NAMESPACE governs a DEFINITION (only `R/` files), is unchanged.
 */
export function rEnclosingPackageDir(
  filePath: string,
  cfg: RPackageConfig | null | undefined,
): string | undefined {
  if (cfg === null || cfg === undefined) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  let best: string | undefined;
  const consider = (dir: string): void => {
    if (dir !== '' && !normalized.startsWith(`${dir}/`)) return;
    if (best === undefined || dir.length > best.length) best = dir;
  };
  for (const dir of cfg.packages.values()) consider(dir);
  for (const dir of cfg.namespaceInfoByPackageDir.keys()) consider(dir);
  return best;
}

/**
 * True when `filePath` sits under the `R/` directory of any package discovery read a
 * `DESCRIPTION` for: a registered package, a directory with a NAMESPACE, or a same-name copy
 * recorded only in {@link RPackageConfig.packageDirs}. Such a file belongs to the package its
 * `DESCRIPTION` names, whatever its directory is called.
 */
export function rFileBelongsToDiscoveredPackage(
  filePath: string,
  cfg: RPackageConfig | null | undefined,
): boolean {
  if (cfg === null || cfg === undefined) return false;
  if (rOwningPackageDir(filePath, cfg) !== undefined) return true;
  if (cfg.packageDirs === undefined) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const dir of cfg.packageDirs) if (normalized.startsWith(rRDirPrefix(dir))) return true;
  return false;
}

// ─── Top-level definitions of a parsed file ────────────────────────────────

/** Def kinds an R `importFrom()` (or a `pkg::name()` call) can bind to (functions and R6/R5/S4 classes). */
export const TOP_LEVEL_BINDABLE_TYPES: ReadonlySet<string> = new Set(['Function', 'Class']);

/** What one R file defines at top level, read from its Module scope. */
export interface RFileTopLevel {
  /**
   * Symbols of the top-level function/class definitions: the name without the backticks it may
   * be written in (`` `%||%` `` is `%||%`), which is how NAMESPACE entries and `importFrom()` spell it.
   */
  readonly names: ReadonlySet<string>;
  /**
   * For each dotted definition, the text after the last `.` of its name as bound (backticks
   * kept): the key the shared finalize pass indexes the definition under.
   */
  readonly dottedTails: ReadonlySet<string>;
  /**
   * For each symbol in {@link names} written with backticks somewhere, every spelling bound in
   * this file (the plain one too, when it is also bound). Empty for a file with no such name.
   */
  readonly writtenAs: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_TOP_LEVEL: RFileTopLevel = {
  names: new Set(),
  dottedTails: new Set(),
  writtenAs: new Map(),
};
const topLevelCache = new WeakMap<ParsedFile, RFileTopLevel>();

/**
 * Top-level definitions of `parsed`, read from the Module scope's hoisted
 * bindings.
 *
 * Since R scope queries anchor a `@scope.function` on every named function, a top-level function def is
 * owned by its *own* Function scope and only its binding is hoisted into the
 * Module scope, so neither the Module scope's `ownedDefs` nor the flat
 * `localDefs` (which also lists nested functions and R6/R5 members) answers
 * "is `name` defined at top level?". A `local`-origin Module binding to a
 * function/class def does. Bindings are read at extraction time, before
 * `finalizeScopeModel` adds import/wildcard bindings.
 *
 * A binding key keeps the backticks the definition was written with; {@link RFileTopLevel.names}
 * is keyed by the symbol (see `rBareName`) so it can be compared with a NAMESPACE entry, and
 * {@link RFileTopLevel.writtenAs} keeps the spelling a call site and the file's exports use.
 */
export function rFileTopLevel(parsed: ParsedFile): RFileTopLevel {
  const cached = topLevelCache.get(parsed);
  if (cached !== undefined) return cached;
  const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
  let result = EMPTY_TOP_LEVEL;
  if (moduleScope !== undefined) {
    const names = new Set<string>();
    const dottedTails = new Set<string>();
    const writtenAs = new Map<string, string[]>();
    const bindsTopLevel = (refs: readonly { origin: string; def: { type: string } }[]): boolean =>
      refs.some((r) => r.origin === 'local' && TOP_LEVEL_BINDABLE_TYPES.has(r.def.type));
    for (const [name, refs] of moduleScope.bindings) {
      if (!bindsTopLevel(refs)) continue;
      const symbol = rBareName(name);
      names.add(symbol);
      if (symbol !== name) {
        const spellings = writtenAs.get(symbol);
        if (spellings === undefined) writtenAs.set(symbol, [name]);
        else spellings.push(name);
      }
      const dot = name.lastIndexOf('.');
      if (dot >= 0) dottedTails.add(name.slice(dot + 1));
    }
    for (const [symbol, spellings] of writtenAs) {
      const plain = moduleScope.bindings.get(symbol);
      if (plain !== undefined && bindsTopLevel(plain)) spellings.unshift(symbol);
    }
    result = { names, dottedTails, writtenAs };
  }
  topLevelCache.set(parsed, result);
  return result;
}

interface RDefIds {
  /** Ids of the function and class definitions the file binds at top level. */
  readonly topLevel: ReadonlySet<string>;
  /** Ids of every definition the file's scope model holds, nested or not. */
  readonly all: ReadonlySet<string>;
}

const defIdsCache = new WeakMap<ParsedFile, RDefIds>();

/**
 * The function and class definitions of `parsed` that are bound at top level: the `local`
 * bindings of its Module scope. A function written inside another function is owned by that
 * function's scope (and `localDefs` lists it all the same), so its id is in `all` only.
 */
function rDefIds(parsed: ParsedFile): RDefIds {
  const cached = defIdsCache.get(parsed);
  if (cached !== undefined) return cached;
  const topLevel = new Set<string>();
  const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
  if (moduleScope !== undefined) {
    for (const refs of moduleScope.bindings.values()) {
      for (const ref of refs) {
        if (ref.origin === 'local' && TOP_LEVEL_BINDABLE_TYPES.has(ref.def.type)) {
          topLevel.add(ref.def.nodeId);
        }
      }
    }
  }
  const result = { topLevel, all: new Set(parsed.localDefs.map((d) => d.nodeId)) };
  defIdsCache.set(parsed, result);
  return result;
}

// ─── Import synthesis (populateWorkspaceReferences) ─────────────────────────

/**
 * Per local package, the set of symbols it defines at top level in its `R/`
 * files (a backtick-quoted definition under its bare symbol), recorded by {@link populateRNamespaceImports} for the packages that
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
 * Order of operations per caller package:
 *  1. last-wins over ALL entries for a name, in file order, external
 *     packages included (R replaces the earlier `importFrom` binding);
 *  2. drop the surviving entry when its `pkg` is the caller itself;
 *  3. skip it when its `pkg` is not a local package (an earlier local entry
 *     never resurrects);
 *  4. skip it when the caller's own package defines `name` at top level in
 *     any `R/` file (the own namespace masks its imports; `rMergeBindings`
 *     only shadows within a single scope);
 *  5. append a `named` import to every `R/` file of the caller package, one per spelling
 *     the provider binds the symbol under (a definition written in backticks keeps them, so
 *     the call site and the provider file's own export both match the import).
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
    for (const entry of info.importFrom) last.set(rBareName(entry.name), entry.pkg);
    const bindable = new Map<string, string>();
    for (const [name, pkg] of last) {
      if (cfg.packages.has(pkg)) needNamesFor.add(pkg); // the fallback veto reads the provider's names too
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
  const spellingsByPackage = new Map<string, Map<string, string[]>>();
  const callerFiles = new Map<string, number[]>();
  for (let i = 0; i < parsedFiles.length; i++) {
    const location = rPackageDirForFile(parsedFiles[i].filePath, cfg);
    if (location === undefined) continue;
    if (needNamesFor.has(location.name)) {
      let names = namesByPackage.get(location.name);
      if (names === undefined) namesByPackage.set(location.name, (names = new Set()));
      const topLevel = rFileTopLevel(parsedFiles[i]);
      for (const name of topLevel.names) names.add(name);
      for (const [symbol, written] of topLevel.writtenAs) {
        let bySymbol = spellingsByPackage.get(location.name);
        if (bySymbol === undefined) spellingsByPackage.set(location.name, (bySymbol = new Map()));
        let known = bySymbol.get(symbol);
        if (known === undefined) bySymbol.set(symbol, (known = []));
        for (const spelling of written) if (!known.includes(spelling)) known.push(spelling);
      }
    }
    if (plans.has(location.name)) {
      const indices = callerFiles.get(location.name);
      if (indices === undefined) callerFiles.set(location.name, [i]);
      else indices.push(i);
    }
  }
  for (const pkg of needNamesFor) if (!namesByPackage.has(pkg)) namesByPackage.set(pkg, new Set());
  packageTopLevelNames.set(cfg, namesByPackage);

  // A symbol written with backticks in one file may be written plainly in another: complete the
  // spellings before importing them.
  if (spellingsByPackage.size > 0) {
    for (const parsed of parsedFiles) {
      const owner = rPackageDirForFile(parsed.filePath, cfg)?.name;
      const bySymbol = owner === undefined ? undefined : spellingsByPackage.get(owner);
      if (bySymbol === undefined) continue;
      const topLevel = rFileTopLevel(parsed);
      for (const [symbol, known] of bySymbol) {
        if (
          topLevel.names.has(symbol) &&
          !topLevel.writtenAs.has(symbol) &&
          !known.includes(symbol)
        ) {
          known.unshift(symbol);
        }
      }
    }
  }

  // Steps 4-5.
  for (const [callerName, plan] of plans) {
    const ownNames = namesByPackage.get(callerName);
    const synthesised: Extract<ParsedImport, { kind: 'named' }>[] = [];
    for (const [name, pkg] of plan.bindable) {
      if (ownNames?.has(name) === true) continue;
      for (const spelling of spellingsByPackage.get(pkg)?.get(name) ?? [name]) {
        // `null` means the name can never bind. A synthesised import for it would stay unresolved
        // yet count as an explicit name claim, suppressing the documented `global-name-fallback`.
        // (Importing the resolver forms a cycle with languages/r/import-target.ts; every use is deferred
        // to call time, so it is safe at runtime.)
        if (resolveRNamedImport(cfg, pkg, spelling, parsedFiles) === null) continue;
        synthesised.push({
          kind: 'named',
          localName: spelling,
          importedName: spelling,
          targetRaw: pkg,
        });
      }
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

// ─── `pkg::name()` qualifier helpers ────────────────────────────────────────

/**
 * The package named by the text of an `@reference.qualified-name` capture (the
 * whole `namespace_operator`, e.g. `pkg::f`, `pkg:::f`, `pkg ::: f`,
 * `"pkg"::f`, `` `pkg`::f ``): the text before the first `::` / `:::`,
 * trimmed, with one pair of surrounding `"`, `'` or backticks removed.
 * `undefined` when there is no `::` or the package part is empty. The
 * function name is not parsed here: it is the site's own `name`.
 *
 * Lives here (not in `qualified-call.ts`, which re-exports it) because the
 * veto below needs it and `qualified-call.ts` imports this file.
 */
export function parseRQualifier(raw: string): string | undefined {
  // Not a lazy `^([\s\S]*?)\s*::`, which is quadratic on a long run of blanks.
  const colons = raw.indexOf('::');
  if (colons === -1) return undefined;
  let pkg = raw.slice(0, colons).trim();
  if (pkg.length >= 2 && /^(["'`])[\s\S]*\1$/.test(pkg)) pkg = pkg.slice(1, -1);
  return pkg.length === 0 ? undefined : pkg;
}

/**
 * The namespace operator of an `@reference.qualified-name` capture: `:::` when the first `::`
 * is followed by a third colon (`pkg:::f`, `pkg ::: f`), `::` otherwise, `undefined` when the
 * text has no `::` at all. {@link parseRQualifier} reads the package from the same text.
 */
export function parseRQualifierOperator(raw: string): '::' | ':::' | undefined {
  const colons = raw.indexOf('::');
  if (colons === -1) return undefined;
  return raw[colons + 2] === ':' ? ':::' : '::';
}

/**
 * The package a package's NAMESPACE imports `symbol` from (`importFrom(origin, symbol)`; the
 * LAST such entry wins, as the synthesised imports and the fallback veto read it), or
 * `undefined` when there is none or the package imports from itself. One hop: the origin's own
 * imports are not followed. Whether the package also exports the name is the caller's question.
 */
export function rReexportOrigin(
  cfg: RPackageConfig,
  pkgDir: string,
  pkgName: string,
  symbol: string,
): string | undefined {
  const importFrom = cfg.namespaceInfoByPackageDir.get(pkgDir)?.importFrom;
  if (importFrom === undefined) return undefined;
  let last: RNamespaceImportFromEntry | undefined;
  for (const entry of importFrom) if (rBareName(entry.name) === symbol) last = entry;
  return last === undefined || last.pkg === pkgName ? undefined : last.pkg;
}

/** Whether a name is reachable through a package's NAMESPACE (see {@link rSymbolVisibility}). */
export type RSymbolVisibility = 'public' | 'private' | 'unknown';

/**
 * Per package directory, the visibility of each top-level name (and each name the package
 * imports, i.e. may re-export), decided once per pass by `rBuildSymbolVisibilityMemo`
 * (`package-config.ts`) so that it does not depend on the order sites are judged in: whether a
 * name is `private` or `unknown` reads the export-pattern budget, which every pattern match
 * spends. Keyed by the `resolutionConfig` object, like the other per-pass registries here.
 */
const symbolVisibilityMemo = new WeakMap<
  object,
  ReadonlyMap<string, ReadonlyMap<string, RSymbolVisibility>>
>();

/** Record (replacing any earlier record) the visibility memo for `resolutionConfig`. */
export function rRecordSymbolVisibilityMemo(
  resolutionConfig: object,
  memo: ReadonlyMap<string, ReadonlyMap<string, RSymbolVisibility>>,
): void {
  symbolVisibilityMemo.set(resolutionConfig, memo);
}

/**
 * Visibility of `symbol` (the name without backticks) for a package-level reader, in the package
 * whose directory is `pkgDir`:
 *
 *  - `public`: the package has no NAMESPACE file (nothing is declared, so every name stays
 *    visible), or its NAMESPACE exports the name;
 *  - `private`: the NAMESPACE is present, readable and complete, and does not export the name;
 *  - `unknown`: not exported, but the NAMESPACE is unreadable or an `exportPattern()` was dropped
 *    or cut short, so the name may still be exported; also any name the memo does not hold.
 */
export function rPackageSymbolVisibility(
  cfg: RPackageConfig,
  pkgDir: string,
  symbol: string,
): RSymbolVisibility {
  const info = cfg.namespaceInfoByPackageDir.get(pkgDir);
  if (info === undefined || !info.hasNamespaceFile) return 'public';
  return symbolVisibilityMemo.get(cfg)?.get(pkgDir)?.get(symbol) ?? 'unknown';
}

/**
 * Visibility of the definition of `symbol` in `filePath`. Only a definition under a package's
 * `R/` directory is judged ({@link rOwningPackageDir}; R loads nothing else into a namespace),
 * so a file outside every package reads `public`.
 */
export function rSymbolVisibility(
  cfg: RPackageConfig | null | undefined,
  filePath: string,
  symbol: string,
): RSymbolVisibility {
  if (cfg === null || cfg === undefined) return 'public';
  const dir = rOwningPackageDir(filePath, cfg);
  return dir === undefined ? 'public' : rPackageSymbolVisibility(cfg, dir, rBareName(symbol));
}

/**
 * Per local package, how many top-level definitions of each symbol (the name without its
 * backticks) it has in its
 * `R/` files, recorded by `populateRQualifiedCalls` for the packages that some
 * `pkg::name()` call in the workspace names. Keyed by the `resolutionConfig`
 * object (like {@link packageTopLevelNames}), which reaches both that hook and
 * the free-call-fallback veto. A missing entry means "cannot decide".
 */
const qualifiedDefinitionCounts = new WeakMap<
  object,
  ReadonlyMap<string, ReadonlyMap<string, number>>
>();

/** Record (replacing any earlier record) the per-package definition counts for `resolutionConfig`. */
export function rRecordQualifiedDefinitionCounts(
  resolutionConfig: object,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
): void {
  qualifiedDefinitionCounts.set(resolutionConfig, counts);
}

/**
 * Number of top-level definitions of `name` recorded for local package `pkg`,
 * or `undefined` when nothing was recorded (hook did not run for that package).
 */
export function rQualifiedDefinitionCount(
  resolutionConfig: object,
  pkg: string,
  name: string,
): number | undefined {
  const byName = qualifiedDefinitionCounts.get(resolutionConfig)?.get(pkg);
  return byName === undefined ? undefined : (byName.get(name) ?? 0);
}

// ─── Global-name fallback veto (isGlobalNameFallbackPlausible) ──────────────

/**
 * Structural subset of the hook context `isRGlobalNameFallbackPlausible`
 * reads; the shared contract's full context is assignable to it.
 */
export interface RGlobalNameFallbackContext {
  readonly callerParsed: {
    readonly filePath: string;
    /** The caller file's imports; absent in hand-built contexts (no `library()` / `source()`). */
    readonly parsedImports?: readonly { readonly kind: string; readonly targetRaw: string }[];
    /** The caller file's reference sites; absent in hand-built contexts (no call). */
    readonly referenceSites?: readonly { readonly name: string; readonly kind: string }[];
  };
  readonly candidate: {
    readonly filePath: string;
    readonly nodeId?: string;
    readonly type?: string;
  };
  /** Reaches the candidate's parse; absent in hand-built contexts, which read as "cannot decide". */
  readonly parsedFileOf?: (filePath: string) => ParsedFile | undefined;
  /** Opaque `loadResolutionConfig` result; an {@link RPackageConfig} for R. */
  readonly resolutionConfig?: unknown;
  readonly site: { readonly name: string; readonly rawQualifiedName?: string };
}

/**
 * True when the candidate is a function or class that its file's scope model holds and binds
 * below the top level. A candidate the scope model does not hold (the semantic model's own
 * entry for a dotted name carries a graph id, not a scope definition id) is not judged.
 */
function isClosureLocalCandidate(ctx: RGlobalNameFallbackContext): boolean {
  const { candidate } = ctx;
  if (candidate.nodeId === undefined || candidate.type === undefined) return false;
  if (!TOP_LEVEL_BINDABLE_TYPES.has(candidate.type)) return false;
  const parsed = ctx.parsedFileOf?.(candidate.filePath);
  if (parsed === undefined) return false;
  const ids = rDefIds(parsed);
  return ids.all.has(candidate.nodeId) && !ids.topLevel.has(candidate.nodeId);
}

/** A file's own `source()`, `system.file()` or `test_path()` call: it may load a script itself. */
function callerLoadsScripts(callerParsed: RGlobalNameFallbackContext['callerParsed']): boolean {
  if (callerParsed.parsedImports?.some((imp) => imp.kind === 'side-effect') === true) return true;
  return (
    callerParsed.referenceSites?.some(
      (site) =>
        site.kind === 'call' &&
        (rBareName(site.name) === 'system.file' || rBareName(site.name) === 'test_path'),
    ) === true
  );
}

/**
 * Rule D of the package-visibility rules: a caller under `<P>/tests/` and a candidate under
 * `<P>/data-raw/` or `<P>/inst/`. Tests run against the loaded package; `data-raw/` is never
 * installed and `inst/` files are not sourced into the namespace, so a test reaches such a script
 * only by loading it itself. Not applied when the caller's file calls `source()`, `system.file()`
 * or `test_path()` (it may do exactly that).
 */
function isRTestReachingUnloadedScript(
  ctx: RGlobalNameFallbackContext,
  cfg: RPackageConfig,
): boolean {
  const tree = rEnclosingPackageDir(ctx.callerParsed.filePath, cfg);
  if (tree === undefined) return false;
  const base = tree === '' ? '' : `${tree}/`;
  const callerFile = ctx.callerParsed.filePath.replace(/\\/g, '/');
  const candidateFile = ctx.candidate.filePath.replace(/\\/g, '/');
  if (!callerFile.startsWith(`${base}tests/`)) return false;
  if (!candidateFile.startsWith(`${base}data-raw/`) && !candidateFile.startsWith(`${base}inst/`)) {
    return false;
  }
  // A nested package claims its own files: the candidate must be in the caller's package tree.
  if (rEnclosingPackageDir(ctx.candidate.filePath, cfg) !== tree) return false;
  return !callerLoadsScripts(ctx.callerParsed);
}

/**
 * Whether `pkg` is attached or imported by package P (`callerInfo`) or the caller's file: `import(pkg)`
 * and the S4 import forms, a `library(pkg)` / `require(pkg)` in the caller's file, or `pkg` in the
 * transitive `Depends:` closure of P over repository packages (attaching a package attaches its
 * `Depends:` too). `undefined` when the closure reaches a repository package whose `Depends:` was
 * not recorded (it has no NAMESPACE): cannot decide.
 */
function rPackageDeclaresLink(
  ctx: RGlobalNameFallbackContext,
  cfg: RPackageConfig,
  callerInfo: RNamespaceInfo,
  pkg: string,
): boolean | undefined {
  if (callerInfo.importPackages?.has(pkg) === true) return true;
  const attaches = ctx.callerParsed.parsedImports?.some(
    (imp) => imp.kind === 'wildcard' && imp.targetRaw.replace(/^["']|["']$/g, '') === pkg,
  );
  if (attaches === true) return true;
  const seen = new Set<string>();
  const queue = [...(callerInfo.depends ?? [])];
  let undecided = false;
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (next === pkg) return true;
    const dir = cfg.packages.get(next);
    if (dir === undefined) continue; // an external package: its Depends are not known here
    const info = cfg.namespaceInfoByPackageDir.get(dir);
    if (info === undefined) {
      undecided = true;
      continue;
    }
    for (const dep of info.depends ?? []) if (!seen.has(dep)) queue.push(dep);
  }
  return undecided ? undefined : false;
}

/**
 * Rules A and B of the package-visibility rules, for a bare call in `P/R/` of a package whose
 * NAMESPACE was read completely (imports and exports). True (refuse) when the candidate is in
 * another package Q's `R/` and P declares no link to Q (Rule A: no `importFrom()` entry for the
 * name, no `import(Q)`, Q not in the transitive `Depends:`, no `library(Q)` in the caller's file),
 * or in no package's `R/` at all, a loose script (Rule B: no `importFrom()` entry for the name).
 *
 * Such a call is not impossible in R: an undeclared use is an R CMD check NOTE ("no visible global
 * function definition"), and package code falls through to the global environment and the search
 * path, where a sibling package may be attached (`devtools::load_all()`, monorepo sessions). The
 * rules refuse calls that are unsupported for check-clean package code, which the package's
 * declared dependencies cannot justify: an unresolved call is preferred to an unsupported
 * cross-package edge. That is stricter than the hook contract's "impossible", a trade stated in
 * the R provider guide. With an `importFrom()` entry for the name the importFrom rules below
 * decide, as before.
 */
function isRPackageCallUndeclared(
  ctx: RGlobalNameFallbackContext,
  cfg: RPackageConfig,
  caller: RPackageLocation,
  callerInfo: RNamespaceInfo,
  symbol: string,
): boolean {
  if (!callerInfo.hasNamespaceFile) return false;
  if (callerInfo.exportsUnreadable === true || callerInfo.importsUnreadable === true) return false;
  if (callerInfo.importFrom.some((entry) => rBareName(entry.name) === symbol)) return false;
  const candidatePkg = rPackageDirForFile(ctx.candidate.filePath, cfg);
  if (candidatePkg === undefined) {
    // In the `R/` of a package discovery read but did not register (a same-name copy): its name
    // is not known here, so the link cannot be checked. Cannot decide: allow.
    if (rFileBelongsToDiscoveredPackage(ctx.candidate.filePath, cfg)) return false;
    return true; // Rule B
  }
  if (candidatePkg.name === caller.name) return false;
  return rPackageDeclaresLink(ctx, cfg, callerInfo, candidatePkg.name) === false; // Rule A
}

/**
 * Refuse a `global-name-fallback` guess that R cannot make, or that check-clean package code
 * cannot make. Returns `false` (veto) when the candidate is a function or class bound inside
 * another function or a block (not at top level), when its package's NAMESPACE proves it private
 * to a caller outside that package's directory tree, when the package-visibility rules refuse it
 * (a bare call from a package's `R/` into a package it declares no link to, or into a loose
 * script, see {@link isRPackageCallUndeclared}; a call from `tests/` into the package's own
 * `data-raw/` or `inst/`, see {@link isRTestReachingUnloadedScript}), or when the caller
 * package's NAMESPACE contradicts the guess.
 *
 * The private-candidate veto applies when the candidate is a top-level function or class under
 * package P's `R/`, {@link rSymbolVisibility} says `private` (P has a readable, complete
 * NAMESPACE that does not export the name), and the caller is outside P's tree
 * ({@link rEnclosingPackageDir}: `tests/` and `inst/` of P count as inside). `unknown`
 * (unreadable NAMESPACE, a cut-short `exportPattern()`) is not vetoed: a guess is vetoed only
 * when impossible. A `source()` of the private file is not honoured (R puts sourced names in
 * the global environment); that is a documented gap.
 *
 * The NAMESPACE veto applies only when
 * ALL of these hold:
 *
 *  - the caller file lives under `<pkgDir>/R/**` of a package with a NAMESPACE
 *    that has an `importFrom(P, <site.name>)` entry (the LAST such entry over
 *    all entries, external packages included — the same last-wins rule the synthesised imports follow);
 *  - `P` is not the caller's own package (a self-import binds nothing);
 *  - the candidate lives under some package's `R/**`, and that package is
 *    neither the caller's own (own namespace masks; a plain 0.5 fallback edge
 *    until own-package binding exists) nor `P`;
 *  - if `P` is local, it defines `site.name` at top level; otherwise `P`
 *    re-exports the name from a third package and the candidate may be the
 *    real origin (unknown per-package names = cannot decide = allow).
 *
 * Everything else — no config, no parse of the candidate's file, caller outside a package `R/`
 * (`tests/`, `scripts/`, root `plumber.R`) other than Rule D, a call the package-visibility rules
 * allow with no `importFrom()` entry for the name, a candidate outside any package `R/` reached
 * through an entry — answers `true`, so `source()`/`library()` script flows are untouched.
 *
 * A qualified call `pkg::name()` (site carries `rawQualifiedName`) is judged
 * by its qualifier first: with `pkg` a local package, a candidate
 * inside `pkg` is plausible whatever the NAMESPACE says, and a candidate
 * elsewhere is vetoed when `pkg` itself defines `name`, or when its NAMESPACE proves `name`
 * private (a re-export is an `export()` entry plus an `importFrom()`). A `pkg` that is not a
 * local package falls through to the NAMESPACE rules above. (`populateRQualifiedCalls` resolves or
 * drops every qualified site before the fallback runs, so this branch is a second line.)
 *
 * Known unsound shape, pinned by a characterisation test: an `import(pkg)` is read only as a link
 * to `pkg` for the package-visibility rules; it does not take part in the `importFrom()` rules, so
 * a later `import(pkg)` that R would prefer to an `importFrom()` entry is invisible to them.
 */
export function isRGlobalNameFallbackPlausible(ctx: RGlobalNameFallbackContext): boolean {
  // A function or class bound inside another function lives in that call's frame: no other
  // function, in this file or another, can reach it by its bare name. Only top-level
  // definitions are candidates for a unique-name guess.
  if (isClosureLocalCandidate(ctx)) return false;

  const cfg = ctx.resolutionConfig as RPackageConfig | null | undefined;
  if (
    typeof cfg !== 'object' ||
    cfg === null ||
    !(cfg.packages instanceof Map) ||
    !(cfg.namespaceInfoByPackageDir instanceof Map)
  ) {
    return true;
  }

  // Qualified call `pkg::name()`: the source named the package, so the package
  // outranks the caller's NAMESPACE. A candidate inside a local `pkg` is right;
  // a candidate elsewhere contradicts the qualifier when `pkg` defines `name`
  // itself. A `pkg` that defines nothing of that name (a re-export) or that has
  // no recorded counts cannot be judged from here: fall through to the rules
  // below, i.e. today's behaviour. An unknown or external `pkg` falls through
  // too (external sites are dropped upstream, before any fallback tier).
  const qualifier =
    ctx.site.rawQualifiedName === undefined
      ? undefined
      : parseRQualifier(ctx.site.rawQualifiedName);
  const symbol = rBareName(ctx.site.name);
  if (qualifier !== undefined && cfg.packages.has(qualifier)) {
    if (rPackageDirForFile(ctx.candidate.filePath, cfg)?.name === qualifier) return true;
    if ((rQualifiedDefinitionCount(cfg, qualifier, symbol) ?? 0) > 0) return false;
    const qualifierDir = cfg.packages.get(qualifier);
    if (
      qualifierDir !== undefined &&
      rPackageSymbolVisibility(cfg, qualifierDir, symbol) === 'private'
    ) {
      return false;
    }
  }

  // A candidate a readable, complete NAMESPACE proves private is not reachable by its bare name
  // from outside its package's tree.
  if (
    ctx.candidate.type !== undefined &&
    TOP_LEVEL_BINDABLE_TYPES.has(ctx.candidate.type) &&
    rSymbolVisibility(cfg, ctx.candidate.filePath, symbol) === 'private' &&
    rEnclosingPackageDir(ctx.callerParsed.filePath, cfg) !==
      rOwningPackageDir(ctx.candidate.filePath, cfg)
  ) {
    return false;
  }

  // The package-visibility rules judge a bare name; a qualified site was decided above (and by
  // `populateRQualifiedCalls`, which runs first).
  if (ctx.site.rawQualifiedName === undefined && isRTestReachingUnloadedScript(ctx, cfg)) {
    return false;
  }

  const caller = rPackageDirForFile(ctx.callerParsed.filePath, cfg);
  if (caller === undefined) return true;
  const callerInfo = cfg.namespaceInfoByPackageDir.get(caller.dir);
  if (
    ctx.site.rawQualifiedName === undefined &&
    callerInfo !== undefined &&
    isRPackageCallUndeclared(ctx, cfg, caller, callerInfo, symbol)
  ) {
    return false;
  }
  const importFrom = callerInfo?.importFrom;
  if (importFrom === undefined) return true;

  let lastEntry: RNamespaceImportFromEntry | undefined;
  for (const entry of importFrom) if (rBareName(entry.name) === symbol) lastEntry = entry;
  if (lastEntry === undefined) return true;
  const importedFrom = lastEntry.pkg;
  if (importedFrom === caller.name) return true;

  const candidatePkg = rPackageDirForFile(ctx.candidate.filePath, cfg);
  if (candidatePkg === undefined) return true;
  if (candidatePkg.name === caller.name || candidatePkg.name === importedFrom) return true;

  if (cfg.packages.has(importedFrom)) {
    const providerNames = rRecordedPackageTopLevelNames(cfg)?.get(importedFrom);
    if (providerNames === undefined || !providerNames.has(symbol)) return true;
  }
  return false;
}
