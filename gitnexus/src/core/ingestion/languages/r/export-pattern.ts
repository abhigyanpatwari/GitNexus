import { compileLinearRegex } from './linear-regex.js';

/**
 * `exportPattern("...")` compilation for R NAMESPACE files.
 *
 * R evaluates `exportPattern()` arguments as POSIX (TRE) extended regular
 * expressions, whose bracket expressions support named classes such as
 * `[[:alpha:]]`. JavaScript's `RegExp` has no such classes: it reads
 * `[[:alpha:]]` as the set `[:alph` followed by a literal `]`. The RStudio
 * new-package template writes `exportPattern("^[[:alpha:]]+")`, so without a
 * translation step that pattern never matches anything.
 *
 * {@link compileRExportPattern} rewrites POSIX classes inside bracket
 * expressions to ASCII JS equivalents (the C-locale meaning of each class) and
 * compiles the result once. Patterns without `[:` are compiled verbatim, so
 * their behaviour is unchanged. It never throws.
 *
 * The compiled form is a linear-time matcher, not a `RegExp`: the pattern text comes
 * from the repository being analysed, and a backtracking engine lets a hostile
 * pattern such as `^(a+)+$` hang the analyzer (R itself uses the non-backtracking
 * TRE). See `linear-regex.ts` for the supported subset; a pattern outside it
 * compiles to null and therefore matches nothing.
 *
 * The argument reaches {@link compileRExportPattern} as an R string *value*:
 * {@link unescapeRString} first turns the NAMESPACE source text `"\\."` (the
 * R string value `\.`) into the regex `\.`. Callers that read a pattern out
 * of NAMESPACE text must unescape before compiling.
 */

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  alnum: 'A-Za-z0-9',
  digit: '0-9',
  upper: 'A-Z',
  lower: 'a-z',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
  xdigit: '0-9A-Fa-f',
};

/**
 * Translate one bracket expression starting at `src[start] === '['`.
 * Returns the JS equivalent and the index just past its closing `]`, or null
 * when the expression is unterminated or names an unknown class.
 */
function translateBracket(src: string, start: number): { text: string; end: number } | null {
  let i = start + 1;
  let out = '[';
  if (src[i] === '^') {
    out += '^';
    i++;
  }
  // A `]` in first position is a literal member, not the terminator.
  if (src[i] === ']') {
    out += '\\]';
    i++;
  }
  while (i < src.length) {
    const ch = src[i];
    if (ch === ']') return { text: out + ']', end: i + 1 };
    if (ch === '[' && src[i + 1] === ':') {
      const close = src.indexOf(':]', i + 2);
      if (close === -1) return null;
      const expansion = POSIX_CLASSES[src.slice(i + 2, close)];
      if (expansion === undefined) return null;
      out += expansion;
      i = close + 2;
    } else if (ch === '\\' && i + 1 < src.length) {
      out += ch + src[i + 1];
      i += 2;
    } else if (ch === '[' || ch === '^') {
      out += '\\' + ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return null;
}

function translatePosixClasses(src: string): string | null {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      out += ch + src[i + 1];
      i += 2;
    } else if (ch === '[') {
      const bracket = translateBracket(src, i);
      if (bracket === null) return null;
      out += bracket.text;
      i = bracket.end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** A compiled `exportPattern()`; `test` answers whether the pattern matches anywhere in `name`. */
export interface RExportMatcher {
  /** The pattern text that was compiled (after POSIX-class translation). */
  readonly source: string;
  test(name: string): boolean;
}

/** Compile an `exportPattern()` argument; null when it cannot be compiled safely. */
export function compileRExportPattern(source: string): RExportMatcher | null {
  try {
    if (!source.includes('[:')) return compileLinearRegex(source);
    const translated = translatePosixClasses(source);
    return translated === null ? null : compileLinearRegex(translated);
  } catch {
    return null;
  }
}

const SIMPLE_R_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '`': '`',
  ' ': ' ',
};

/**
 * Turn the body of an R string literal (the text between the quotes) into the
 * string value R would hold: `\\` -> `\`, `\"` -> `"`, `\n` -> newline, and
 * likewise `\t \r \a \b \f \v \' \``, backslash-space, `\xHH`,
 * `\uXXXX` / `\u{X..}` and `\UXXXXXXXX` / `\U{X..}` (code points). R
 * rejects any other backslash sequence; this leniently keeps it verbatim, so a
 * mistaken `"\."` still reaches the regex compiler as `\.`. Never throws.
 */
export function unescapeRString(body: string): string {
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i + 1 >= body.length) {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    const simple = SIMPLE_R_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i++;
      continue;
    }
    const hex = readHexEscape(body, i + 1);
    if (hex !== null) {
      out += hex.text;
      i = hex.end - 1;
      continue;
    }
    out += ch; // Unknown escape: keep the backslash; the next char is emitted normally.
  }
  return out;
}

/** `x`/`u`/`U` escape whose introducer is at `body[at]`; null when malformed. */
function readHexEscape(body: string, at: number): { text: string; end: number } | null {
  const kind = body[at];
  const maxDigits = kind === 'x' ? 2 : kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
  if (maxDigits === 0) return null;
  let i = at + 1;
  const braced = kind !== 'x' && body[i] === '{';
  if (braced) i++;
  const start = i;
  while (i < body.length && i - start < maxDigits && /[0-9A-Fa-f]/.test(body[i])) i++;
  if (i === start) return null;
  if (braced) {
    if (body[i] !== '}') return null;
  }
  const code = parseInt(body.slice(start, i), 16);
  if (code > 0x10ffff) return null;
  return { text: String.fromCodePoint(code), end: braced ? i + 1 : i };
}
