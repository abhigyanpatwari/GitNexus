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

/** Compile an `exportPattern()` argument; null when it cannot be compiled. */
export function compileRExportPattern(source: string): RegExp | null {
  try {
    if (!source.includes('[:')) return new RegExp(source);
    const translated = translatePosixClasses(source);
    return translated === null ? null : new RegExp(translated);
  } catch {
    return null;
  }
}
