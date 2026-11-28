/**
 * Parse a declared TYPE-PARAMETER LIST out of its own source text.
 *
 * The sibling of `template-arguments.ts`, on the other axis: that file reads the
 * arguments a declaration was written AGAINST (`Vec<bool>` → `['bool']`), this
 * one reads the parameters it was written IN TERMS OF (`template <class T>`,
 * `class Box<T extends Repo>`). See `TypeParameter` in `gitnexus-shared` for why
 * conflating them is a defect rather than a simplification.
 *
 * ── WHY TEXT AND NOT A PER-LANGUAGE JSON PAYLOAD ─────────────────────────────
 *
 * The `@declaration.parameter-types` precedent synthesizes JSON inside each
 * language's `captures.ts`, because a *parameter type* can itself contain a
 * comma (`Dict[str, int]`) and needs a quoting convention. A type-parameter list
 * needs none: every language that has one delimits it with `<…>` and separates
 * entries with commas, and the nesting those commas can hide (`T extends
 * Map<K, V>`) is bracket nesting the same scanner already has to track. So the
 * capture can be the raw list node and the whole parse is shared, which keeps
 * the per-language cost at one query capture instead of a branch in six
 * emitters.
 *
 * ── WHY THIS NAMES NO LANGUAGE (AGENTS.md R6) ────────────────────────────────
 *
 * It recognizes TOKENS, not languages, and every token it recognizes is
 * recognized for all input. `extends` and `:` both introduce a bound wherever
 * they appear; the name is the last identifier ahead of the bound wherever it
 * appears, which is what makes `class T`, `typename T`, `in T`, `out T`,
 * `reified T` and a bare `T` one rule rather than six. No caller passes a
 * language tag and none is inspected — the direct analogue of
 * `extractTemplateArguments`, which has parsed `<…>` for every language from
 * shared code since it was written.
 */

import type { TypeParameter } from 'gitnexus-shared';

/** Matches a trailing identifier: the parameter's name sits at the END of the
 *  pre-bound text, after any keyword or variance modifier. Unicode is not
 *  attempted — every language measured restricts type-parameter names to ASCII
 *  identifier characters, and a name this rejects yields no parameter rather
 *  than a wrong one. */
const TRAILING_IDENTIFIER = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/;

/**
 * The declared type parameters in `text`, in source order, or `undefined` when
 * `text` holds no parseable list.
 *
 * `text` is the raw source of the list node — `<T extends Repo, U>`,
 * `<class T, typename U = int>`, `[T any]` is NOT accepted (see the bracket note
 * below). Leading content before the first `<` is skipped, so a capture that
 * spans `template <class T>` parses identically to one spanning `<class T>`.
 *
 * ANGLE BRACKETS ONLY. Every language this is wired to delimits with `<…>`.
 * Square brackets would be ambiguous against an array/subscript spelling in the
 * same position, and the one language that uses them for this (Go) is served by
 * its own main-thread reader — so accepting `[…]` here would buy nothing and
 * risk reading `int[]` as a parameter list.
 */
export function parseTypeParameterList(text: string): TypeParameter[] | undefined {
  text = withoutTypeComments(text);
  const open = text.indexOf('<');
  if (open === -1) return undefined;
  const finalCloser = text.lastIndexOf('>');
  const out: TypeParameter[] = [];
  let start = open + 1;
  let depth = 0;
  let inDefault = false;
  for (const i of ungroupedOffsets(text, start)) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>' && depth > 0) depth--;
    else if (depth === 0) {
      // A comparison inside a default has its own closing angle later.
      // In a bound like Box<U>=Default, the nested angle closes above.
      if (ch === '=') inDefault = true;
      if (ch === '>' && inDefault && text[i + 1] === '=' && i < finalCloser) continue;
      if (ch !== ',' && ch !== '>') continue;
      const parameter = parseEntry(text.slice(start, i));
      if (parameter) out.push(parameter);
      if (ch === '>') return out.length ? out : undefined;
      start = i + 1;
      inDefault = false;
    }
  }
  return undefined;
}

/**
 * One list entry → its parameter, or `undefined` when the entry declares no
 * type parameter this can name.
 *
 * DECLINING IS A RESULT, not a failure to handle: a Rust lifetime (`'a`) and a
 * C++ non-type parameter spelled without a trailing identifier declare nothing
 * a member lookup can be performed on, and admitting them under a made-up name
 * would put a binding in the shadowing guard that shadows nothing real.
 */
function parseEntry(entry: string): TypeParameter | undefined {
  // A default (`= int`, `= Repo<User>`) is not part of either the name or the
  // bound. Cut it first so `class T = int` still ends in its name. Only a
  // top-level `=` counts — `T extends Fn<() => void>` must keep its bound.
  const head = beforeTopLevelDefault(entry);

  const boundAt = findBoundIntroducer(head);
  const namePart = boundAt === undefined ? head : head.slice(0, boundAt.index);
  const bound =
    boundAt === undefined ? undefined : head.slice(boundAt.index + boundAt.length).trim();

  // The NAME is the trailing identifier of the pre-bound text. That one rule
  // covers a bare `T`, a keyword-prefixed `class T` / `typename T`, a
  // variance-annotated `in T` / `out T`, a modifier-prefixed `reified T`, and a
  // variadic `class... Ts` — every measured spelling puts the name last.
  const matched = TRAILING_IDENTIFIER.exec(namePart);
  const name = matched?.[1];
  if (matched === undefined || matched === null || name === undefined) return undefined;

  // A LIFETIME (`'a`) is not a type parameter. Its name would otherwise be read
  // as the bare identifier after the sigil, putting `a` into the shadowing set
  // and hiding any real declaration by that name from every lookup in the
  // declaration's body — a missing edge invented out of a construct that
  // declares no type at all.
  if (namePart[matched.index - 1] === "'") return undefined;

  const defaultType = head.length < entry.length ? entry.slice(head.length + 1).trim() : undefined;
  return { name, ...(bound && { bound }), ...(defaultType && { defaultType }) };
}

/** Return the prefix before the default's top-level `=`. A generic bound
 *  can close immediately before that delimiter, as in `T extends Box<U>=V`. */
function beforeTopLevelDefault(entry: string): string {
  let depth = 0;
  for (const i of ungroupedOffsets(entry)) {
    const ch = entry[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (ch === '=' && depth === 0 && entry[i - 1] !== '=' && entry[i + 1] !== '=') {
      return entry.slice(0, i);
    }
  }
  return entry;
}

/**
 * Where the bound starts in `head`, or `undefined` when the entry declares none.
 *
 * Two introducers, both at depth 0 only: the keyword `extends` and a bare `:`.
 * `:` is checked as a single character rather than a word, and `extends` is
 * required to stand as a whole word so a parameter named `extendsFoo` is not
 * mistaken for one.
 *
 * A `:` that is NOT a bound — C++ `template <int N>` has none, and a Rust const
 * generic `const N: usize` states a const parameter's TYPE — yields a `bound`
 * that no consumer can resolve to a class and therefore falls out harmlessly at
 * lookup. Reading it as a bound is the conservative direction: it can only fail
 * to find a member, never invent one.
 */
function findBoundIntroducer(head: string): { index: number; length: number } | undefined {
  let depth = 0;
  for (const i of ungroupedOffsets(head)) {
    const ch = head[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (depth !== 0) continue;
    else if (ch === ':') return { index: i, length: 1 };
    else if (
      ch === 'e' &&
      head.startsWith('extends', i) &&
      isWholeWord(head, i, 'extends'.length)
    ) {
      return { index: i, length: 'extends'.length };
    }
  }
  return undefined;
}

function isWholeWord(text: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : text[index - 1]!;
  const after = text[index + length] ?? '';
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

/** Operators in a grouped expression, e.g. `(N >= 1)`, cannot close the outer parameter list. */
function* ungroupedOffsets(text: string, start = 0): Generator<number> {
  let depth = 0;
  for (const i of syntaxOffsets(text, start)) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0) yield i;
  }
}

// A number starts at a token boundary, so the 8 in the character literal u8','
// cannot consume its opening quote. Separators stay in the numeric spelling.
const numericLiteral =
  /\b(?:0x[\da-f.](?:'?[\da-f]|\.)*|0b[01](?:'?[01])*|\d(?:'?\d|\.)*)(?:[ep][+-]?\d(?:'?\d)*)?/iy;

/** Comments and quoted strings are opaque even when they contain each other's delimiters. */
function* opaqueSpans(text: string, start: number) {
  let lastCommentEnd = start;
  const hasApostrophe = text.includes("'");
  let cursor = start;
  while (cursor < text.length) {
    const i = cursor++;
    const ch = text[i];
    const end = ch === '/' ? endOfComment(text, i) : undefined;
    if (end !== undefined) {
      yield { start: i, end, comment: true };
      lastCommentEnd = end;
      cursor = end;
    } else if (ch === '<' && text[i + 1] === '=') {
      // Both <= and <=> are single operators. Their angles do not delimit a list.
      cursor = text[i + 2] === '>' ? i + 3 : i + 2;
      yield { start: i, end: cursor, comment: false };
    } else if ((ch === '=' || ch === '-') && text[i + 1] === '>') {
      yield { start: i, end: i + 2, comment: false };
      cursor = i + 2;
    } else if (hasApostrophe && ch >= '0' && ch <= '9') {
      numericLiteral.lastIndex = i;
      if (numericLiteral.test(text)) cursor = numericLiteral.lastIndex;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== ch) {
        end += text[end] === '\\' ? 2 : 1;
      }
      if (end < text.length && !isLifetimePair(text, i, end, lastCommentEnd)) {
        yield { start: i, end: end + 1, comment: false };
        cursor = end + 1;
      }
    }
  }
}

function endOfComment(text: string, start: number): number | undefined {
  if (text[start + 1] === '*') {
    const close = text.indexOf('*/', start + 2);
    return close === -1 ? text.length : close + 2;
  }
  if (text[start + 1] !== '/') return undefined;
  let end = start + 2;
  while (end < text.length && !'\n\r\u2028\u2029'.includes(text[end])) end++;
  return end;
}

/** Structural offsets in the original source spelling. */
export function* syntaxOffsets(text: string, start = 0): Generator<number> {
  let i = start;
  for (const span of opaqueSpans(text, start)) {
    for (; i < span.start; i++) yield i;
    i = span.end;
  }
  for (; i < text.length; i++) yield i;
}

/** Preserve token boundaries in semantic type spellings when discarding comments. */
export function withoutTypeComments(text: string): string {
  if (!text.includes('/*') && !text.includes('//')) return text;
  let result = '';
  let start = 0;
  for (const span of opaqueSpans(text, 0)) {
    if (!span.comment) continue;
    result += text.slice(start, span.start) + ' ';
    start = span.end;
  }
  return start ? result + text.slice(start) : text;
}

/** In <'a, T, 'b> each apostrophe starts a name. Neither quotes the comma. */
function isLifetimePair(text: string, start: number, end: number, lastCommentEnd: number): boolean {
  if (text[start] !== "'") return false;
  let before = start - 1;
  while (before >= 0 && /\s/u.test(text[before])) before--;
  if (before >= lastCommentEnd && !'<,:&+'.includes(text[before])) return false;
  const name = /'[_\p{XID_Start}][_\p{XID_Continue}]*/uy;
  name.lastIndex = start;
  if (!name.test(text) || name.lastIndex === end) return false; // e.g. 'x'_suffix

  // If the apparent closing quote is another lifetime or lies in a comment
  // after a separator, the outer scanner must see the intervening tokens.
  let separator = false;
  let cursor = name.lastIndex;
  while (cursor < end) {
    const i = cursor++;
    if (/\s/u.test(text[i])) continue;
    const after = text[i] === '/' ? endOfComment(text, i) : undefined;
    if (after !== undefined) {
      if (after > end) return separator && after < text.length;
      cursor = after;
    } else {
      separator = '<,:&+='.includes(text[i]);
    }
  }
  name.lastIndex = end;
  return separator && name.test(text);
}

function isIdentifierChar(ch: string): boolean {
  return ch.length === 1 && /[A-Za-z0-9_$]/.test(ch);
}
