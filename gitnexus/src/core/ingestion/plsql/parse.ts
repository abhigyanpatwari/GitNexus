/**
 * ANTLR4 driver for the grammars-v4 PlSql grammar.
 *
 * - Source is pre-processed (SQL*Plus, conditional compilation) without moving
 *   any line, then split into segments at lone `/` terminator lines, so a
 *   syntax error or timeout is confined to one compilation unit.
 * - Each segment is parsed with SLL + bail first (fast path) and re-parsed
 *   with full LL + error recovery only when SLL fails.
 * - A per-segment deadline aborts pathological inputs; callers fall back to
 *   regex-level facts for that segment.
 *
 * Segments are parsed as the original text prefixed with blank lines, so token
 * line numbers are file line numbers.
 */

import {
  BailErrorStrategy,
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  DefaultErrorStrategy,
  ListTokenSource,
  Token,
  ParseCancellationException,
  PredictionMode,
  type ATNSimulator,
  type ParseTreeListener,
  type ParserRuleContext,
  type RecognitionException,
  type Recognizer,
} from 'antlr4ng';
import { PlSqlLexer } from './generated/PlSqlLexer.js';
import { PlSqlParser, type Sql_scriptContext } from './generated/PlSqlParser.js';
import {
  preprocessPlSql,
  scriptIncludesOf,
  type ScriptInclude,
  type SqlPlusCommand,
} from './preprocess.js';

/**
 * Wall-clock budget for one segment: a floor plus a per-line allowance.
 * A cold ANTLR DFA cache needs ~5 ms/line on large package bodies (a valid
 * 3.4k-line body took ~18 s in the spike), so a flat budget would drop the
 * largest — usually most important — packages to the regex fallback.
 * `GITNEXUS_PLSQL_SEGMENT_DEADLINE_MS` overrides the floor; 0 disables.
 */
export const SEGMENT_DEADLINE_FLOOR_MS = 10_000;
export const SEGMENT_DEADLINE_PER_LINE_MS = 15;

export function segmentDeadlineMs(lines: number, floorMs = configuredFloorMs()): number {
  if (floorMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(floorMs, lines * SEGMENT_DEADLINE_PER_LINE_MS);
}

function configuredFloorMs(): number {
  const raw = process.env.GITNEXUS_PLSQL_SEGMENT_DEADLINE_MS;
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : SEGMENT_DEADLINE_FLOOR_MS;
}

export interface PlSqlSegment {
  /** 1-based first and last source line of the segment. */
  readonly startLine: number;
  readonly endLine: number;
  /** Pre-processed segment text (same line layout as the source). */
  readonly text: string;
  /** Parse tree; undefined when the segment timed out. */
  readonly tree?: Sql_scriptContext;
  readonly syntaxErrors: number;
  readonly firstError?: string;
  readonly mode: 'sll' | 'll' | 'timeout';
}

export interface ParsedPlSqlSource {
  readonly segments: readonly PlSqlSegment[];
  readonly scriptIncludes: readonly ScriptInclude[];
  /** SQL*Plus client commands blanked by the pre-pass (EXEC, SET, @@, …). */
  readonly sqlplusCommands: readonly SqlPlusCommand[];
}

class CountingErrorListener extends BaseErrorListener {
  count = 0;
  first?: string;
  override syntaxError<S extends Token, T extends ATNSimulator>(
    _recognizer: Recognizer<T>,
    _offendingSymbol: S | null,
    line: number,
    column: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    this.count++;
    this.first ??= `${line}:${column} ${msg.slice(0, 160)}`;
  }
}

class DeadlineExceeded extends Error {}

/** Throws once `deadline` has passed; checked on every 256th call to stay cheap. */
function deadlineGuard(deadline: number): () => void {
  let ticks = 0;
  return () => {
    if ((++ticks & 255) === 0 && performance.now() > deadline) throw new DeadlineExceeded();
  };
}

/** Parse listener that runs the guard on every rule entry and every consumed token. */
function deadlineListener(check: () => void): ParseTreeListener {
  return {
    visitTerminal: check,
    visitErrorNode() {},
    enterEveryRule: check,
    exitEveryRule() {},
  };
}

/**
 * Tokens of `text`, lexed once under the deadline (SLL and LL re-use them).
 * Lexer errors (characters no token rule matches) are counted: the lexer
 * skips them and the parser may then succeed, so they must still mark the
 * segment as degraded.
 */
function lex(
  text: string,
  check: () => void,
): { tokens: Token[]; lexerErrors: CountingErrorListener } {
  const lexer = new PlSqlLexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  const lexerErrors = new CountingErrorListener();
  lexer.addErrorListener(lexerErrors);
  const tokens: Token[] = [];
  for (;;) {
    check();
    const token = lexer.nextToken();
    tokens.push(token);
    if (token.type === Token.EOF) break;
  }
  return { tokens, lexerErrors };
}

/**
 * Parser over pre-lexed tokens with the deadline checked on rule entry, on
 * every consumed token and before every adaptive prediction. A single
 * prediction cannot be interrupted (ANTLR exposes no hook inside one).
 */
function newParser(tokens: Token[], check: () => void): PlSqlParser {
  const parser = new PlSqlParser(new CommonTokenStream(new ListTokenSource(tokens)));
  parser.removeErrorListeners();
  parser.addParseListener(deadlineListener(check));
  const interpreter = parser.interpreter;
  const predict = interpreter.adaptivePredict.bind(interpreter);
  interpreter.adaptivePredict = (...args: Parameters<typeof predict>) => {
    check();
    return predict(...args);
  };
  return parser;
}

function parseSegment(
  text: string,
  deadlineMs: number,
): Omit<PlSqlSegment, 'startLine' | 'endLine' | 'text'> {
  const check = deadlineGuard(performance.now() + deadlineMs);
  try {
    const { tokens, lexerErrors } = lex(text, check);
    const sll = newParser(tokens, check);
    sll.interpreter.predictionMode = PredictionMode.SLL;
    sll.errorHandler = new BailErrorStrategy();
    try {
      const tree = sll.sql_script();
      return { tree, syntaxErrors: lexerErrors.count, firstError: lexerErrors.first, mode: 'sll' };
    } catch (e) {
      if (!(e instanceof ParseCancellationException)) throw e;
    }
    const ll = newParser(tokens, check);
    const errors = new CountingErrorListener();
    ll.addErrorListener(errors);
    ll.interpreter.predictionMode = PredictionMode.LL;
    ll.errorHandler = new DefaultErrorStrategy();
    const tree = ll.sql_script();
    return {
      tree,
      syntaxErrors: errors.count + lexerErrors.count,
      firstError: lexerErrors.first ?? errors.first,
      mode: 'll',
    };
  } catch (e) {
    if (e instanceof DeadlineExceeded)
      return { syntaxErrors: 1, firstError: 'deadline exceeded', mode: 'timeout' };
    throw e;
  }
}

/**
 * Lexical state carried from one line to the next while looking for `/`
 * terminators: a lone `/` inside a block comment or a (multi-line) string
 * literal is text, not a terminator.
 */
type CarryState =
  | { kind: 'code' }
  | { kind: 'block-comment' }
  | { kind: 'string' }
  | { kind: 'q-string'; close: string };

const Q_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };

/** Scan one line from `state`; returns the state at the end of the line. */
function scanLine(line: string, state: CarryState): CarryState {
  let i = 0;
  let st = state;
  while (i < line.length) {
    if (st.kind === 'block-comment') {
      const end = line.indexOf('*/', i);
      if (end < 0) return st;
      i = end + 2;
      st = { kind: 'code' };
    } else if (st.kind === 'string') {
      const end = line.indexOf("'", i);
      if (end < 0) return st;
      if (line[end + 1] === "'") {
        i = end + 2; // '' escape
        continue;
      }
      i = end + 1;
      st = { kind: 'code' };
    } else if (st.kind === 'q-string') {
      const end = line.indexOf(`${st.close}'`, i);
      if (end < 0) return st;
      i = end + 2;
      st = { kind: 'code' };
    } else {
      const ch = line[i]!;
      const next = line[i + 1];
      if (ch === '-' && next === '-') return st; // line comment
      if (ch === '/' && next === '*') {
        st = { kind: 'block-comment' };
        i += 2;
      } else if ((ch === 'q' || ch === 'Q') && next === "'" && !/[\w$#]/.test(line[i - 1] ?? '')) {
        const open = line[i + 2] ?? '';
        st = { kind: 'q-string', close: Q_CLOSE[open] ?? open };
        i += 3;
      } else if (ch === "'") {
        st = { kind: 'string' };
        i += 1;
      } else i += 1;
    }
  }
  return st;
}

/**
 * Split pre-processed text at lone `/` terminator lines; each segment keeps
 * its line offset. A `/` line inside a block comment or a string literal does
 * not split.
 */
export function splitSegments(
  text: string,
): Array<{ startLine: number; endLine: number; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ startLine: number; endLine: number; body: string }> = [];
  let start = 0;
  const flush = (endExclusive: number) => {
    const body = lines.slice(start, endExclusive).join('\n');
    if (body.trim() !== '') out.push({ startLine: start + 1, endLine: endExclusive, body });
  };
  let state: CarryState = { kind: 'code' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (state.kind === 'code' && line.trim() === '/') {
      flush(i + 1);
      start = i + 1;
      continue;
    }
    state = scanLine(line, state);
  }
  flush(lines.length);
  return out;
}

export function parsePlSqlSource(
  source: string,
  /** `segmentDeadlineMs` replaces the size-scaled budget (tests). */
  options: { segmentDeadlineMs?: number } = {},
): ParsedPlSqlSource {
  const commands: SqlPlusCommand[] = [];
  const text = preprocessPlSql(source, commands);
  const segments: PlSqlSegment[] = [];
  for (const seg of splitSegments(text)) {
    // Prefix blank lines so token lines are file lines.
    const padded = '\n'.repeat(seg.startLine - 1) + seg.body;
    const lines = seg.endLine - seg.startLine + 1;
    const result = parseSegment(padded, options.segmentDeadlineMs ?? segmentDeadlineMs(lines));
    segments.push({ startLine: seg.startLine, endLine: seg.endLine, text: seg.body, ...result });
  }
  return { segments, scriptIncludes: scriptIncludesOf(commands), sqlplusCommands: commands };
}

export type { ParserRuleContext };
