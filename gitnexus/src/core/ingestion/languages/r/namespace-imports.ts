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
 * The tokenizer is generic (directive head + balanced argument list across
 * newlines, honouring `"…"`, `'…'` and backtick quoting, `#` comments stripped
 * outside quotes) but only `importFrom` is emitted. `import`,
 * `importClassesFrom` and `importMethodsFrom` are deferred and would be
 * one-line additions to {@link EMITTED_DIRECTIVES}. `S3method`, `export*`,
 * `useDynLib` and anything under an `if (…)` / `else` conditional are ignored.
 * Unbalanced or garbled input never throws: the offending directive is dropped.
 *
 * Runtime import direction is `language-config.ts` → this file; any type from
 * `language-config.ts` must be taken with `import type` only, so no runtime
 * import cycle forms.
 */

/** One `importFrom(pkg, name)` pair, in NAMESPACE file order. */
export interface RNamespaceImportFromEntry {
  readonly pkg: string;
  readonly name: string;
}

const EMITTED_DIRECTIVES: ReadonlySet<string> = new Set(['importFrom']);

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

/**
 * Extract every `importFrom(pkg, name, ...)` pair from NAMESPACE text, in file
 * order. Never throws; returns `[]` for empty, garbled or unbalanced input.
 */
export function parseRNamespaceImportFrom(text: string): RNamespaceImportFromEntry[] {
  const entries: RNamespaceImportFromEntry[] = [];
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
    if (!EMITTED_DIRECTIVES.has(head)) continue;

    const values = group.args.map(normaliseArg);
    const pkg = values[0];
    if (!pkg) continue;
    for (let n = 1; n < values.length; n++) {
      if (values[n]) entries.push({ pkg, name: values[n] });
    }
  }
  return entries;
}
