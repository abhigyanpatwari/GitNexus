/**
 * Blanks TypeScript `as` assertions for mutation testing (KTD7).
 *
 * Stryker's instrumenter skips every `TSAsExpression` subtree, so code inside `x as T`
 * (including every `as const` table) is never mutated. This step replaces the ` as <type>`
 * text of each assertion with spaces of the same length and keeps line terminators, so every
 * line and column of the file is unchanged and the span map is an identity on columns.
 *
 * "Still parses" is not enough: ASI before `(`, `[` or a template literal, and precedence
 * (`a + b as T * c`), can turn the blanked text into a different tree. A file is accepted only
 * when the AST of its blanked text equals the original AST with every `TSAsExpression`
 * replaced by its operand, compared without positions, comments or `extra`. `satisfies` and
 * the non-null `!` are not on Stryker's skip list and stay.
 */
import { parse, type ParserOptions } from '@babel/parser';

export type BlankOutcome =
  | { ok: true; text: string; assertions: number }
  | { ok: false; reason: string; assertions: number };

export interface ScopeFile {
  path: string;
  source: string;
}

export interface BlankedScope {
  written: { path: string; text: string; assertions: number }[];
  failed: { path: string; reason: string }[];
}

const PARSER_OPTIONS: ParserOptions = {
  sourceType: 'module',
  plugins: ['typescript', 'decorators-legacy'],
};

/** Keys that carry positions, comments or raw text; they never change what the tree means. */
const IGNORED_KEYS = new Set([
  'start',
  'end',
  'loc',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'errors',
]);

/** Line terminators stay in place so line numbers do not move. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

interface Positioned {
  type: string;
  start: number;
  end: number;
}

interface AsExpression extends Positioned {
  expression: Positioned;
  typeAnnotation: Positioned;
}

interface Token {
  type: unknown;
  value?: unknown;
  start: number;
  end: number;
}

type Range = readonly [start: number, end: number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isAsExpression = (value: unknown): value is AsExpression =>
  isRecord(value) && value.type === 'TSAsExpression';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every `TSAsExpression` node in the tree, outer before inner. */
function collectAsExpressions(root: unknown): AsExpression[] {
  const found: AsExpression[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    if (isAsExpression(node)) found.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key) && typeof value === 'object') stack.push(value);
    }
  }
  return found;
}

/** Index of the first token that starts at or after `offset`. */
function firstTokenAt(tokens: readonly Token[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].start < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The text range to blank for one assertion: from its `as` keyword to the end of the node.
 * Only closing parens of the operand, the `as` keyword and opening parens of the type sit
 * between the operand and the type, so the one `as` name token there is the keyword.
 */
function assertionRange(node: AsExpression, tokens: readonly Token[], source: string): Range {
  for (let i = firstTokenAt(tokens, node.expression.end); i < tokens.length; i++) {
    const token = tokens[i];
    if (token.start >= node.typeAnnotation.start) break;
    // Comments are tokens too, with a string `type`; real tokens carry a token-type object.
    if (typeof token.type === 'object' && token.value === 'as') {
      if (source.slice(token.start, token.end) !== 'as') break;
      return [token.start, node.end];
    }
  }
  throw new Error(`no \`as\` keyword found for the assertion at offset ${node.start}`);
}

/** Replaces every non-line-terminator code unit inside `ranges` with a space. */
function blankRanges(source: string, ranges: readonly Range[]): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let text = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    if (from >= end) continue;
    text += source.slice(cursor, from);
    for (const char of source.slice(from, end)) {
      text += LINE_TERMINATOR.test(char) ? char : ' '.repeat(char.length);
    }
    cursor = end;
  }
  return text + source.slice(cursor);
}

/**
 * The first place where `original`, with every `TSAsExpression` unwrapped, and `blanked`
 * differ, as a property path; `null` when the trees are equal.
 */
function firstDifference(original: unknown, blanked: unknown, at: string): string | null {
  let left = original;
  while (isAsExpression(left)) left = left.expression;
  if (Array.isArray(left) || Array.isArray(blanked)) {
    if (!Array.isArray(left) || !Array.isArray(blanked) || left.length !== blanked.length) {
      return at;
    }
    for (let i = 0; i < left.length; i++) {
      const difference = firstDifference(left[i], blanked[i], `${at}[${i}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (isRecord(left) && isRecord(blanked)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(blanked)]);
    for (const key of [...keys].sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      const difference = firstDifference(left[key], blanked[key], `${at}.${key}`);
      if (difference !== null) return difference;
    }
    return null;
  }
  return Object.is(left, blanked) ? null : at;
}

/** Blanks every `as` assertion in one TypeScript source and checks the result (KTD7). */
export function blankAssertions(source: string): BlankOutcome {
  let original: ReturnType<typeof parse>;
  try {
    original = parse(source, { ...PARSER_OPTIONS, tokens: true });
  } catch (error) {
    return { ok: false, assertions: 0, reason: `original does not parse: ${errorMessage(error)}` };
  }
  const assertions = collectAsExpressions(original.program);
  if (assertions.length === 0) return { ok: true, assertions: 0, text: source };

  const tokens: readonly Token[] = original.tokens ?? [];
  let text: string;
  try {
    text = blankRanges(
      source,
      assertions.map((node) => assertionRange(node, tokens, source)),
    );
  } catch (error) {
    return { ok: false, assertions: assertions.length, reason: errorMessage(error) };
  }

  let blanked: ReturnType<typeof parse>;
  try {
    blanked = parse(text, PARSER_OPTIONS);
  } catch (error) {
    return {
      ok: false,
      assertions: assertions.length,
      reason: `blanked text does not parse: ${errorMessage(error)}`,
    };
  }
  const difference = firstDifference(original.program, blanked.program, 'program');
  if (difference !== null) {
    return {
      ok: false,
      assertions: assertions.length,
      reason: `AST differs from the unwrapped original at ${difference}`,
    };
  }
  return { ok: true, assertions: assertions.length, text };
}

/**
 * Blanks a mutate scope. A file that fails the check is reported in `failed` and never
 * appears in `written`, so the caller keeps its original text.
 */
export function blankScope(files: readonly ScopeFile[]): BlankedScope {
  const scope: BlankedScope = { written: [], failed: [] };
  for (const file of files) {
    const outcome = blankAssertions(file.source);
    // `in` narrows the union under tsconfig's `strict: false`, where `ok` alone does not.
    if ('reason' in outcome) {
      scope.failed.push({ path: file.path, reason: outcome.reason });
    } else {
      scope.written.push({ path: file.path, text: outcome.text, assertions: outcome.assertions });
    }
  }
  return scope;
}
