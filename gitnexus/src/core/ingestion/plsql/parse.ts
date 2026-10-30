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
  ParseCancellationException,
  PredictionMode,
  type ATNSimulator,
  type ParseTreeListener,
  type ParserRuleContext,
  type RecognitionException,
  type Recognizer,
  type Token,
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

/** Parse listener that aborts once the deadline passes (checked every 512 rules). */
function deadlineListener(deadline: number): ParseTreeListener {
  let ticks = 0;
  return {
    visitTerminal() {},
    visitErrorNode() {},
    enterEveryRule() {
      if ((++ticks & 511) === 0 && performance.now() > deadline) throw new DeadlineExceeded();
    },
    exitEveryRule() {},
  };
}

/**
 * Parser over `text`. Lexer errors (characters no token rule matches) are
 * counted too: the lexer skips them and the parser may then succeed, so they
 * must still mark the segment as degraded.
 */
function newParser(text: string): { parser: PlSqlParser; lexerErrors: CountingErrorListener } {
  const lexer = new PlSqlLexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  const lexerErrors = new CountingErrorListener();
  lexer.addErrorListener(lexerErrors);
  const parser = new PlSqlParser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  return { parser, lexerErrors };
}

function parseSegment(
  text: string,
  deadlineMs: number,
): Omit<PlSqlSegment, 'startLine' | 'endLine' | 'text'> {
  const deadline = performance.now() + deadlineMs;
  try {
    const sll = newParser(text);
    sll.parser.interpreter.predictionMode = PredictionMode.SLL;
    sll.parser.errorHandler = new BailErrorStrategy();
    sll.parser.addParseListener(deadlineListener(deadline));
    try {
      const tree = sll.parser.sql_script();
      return {
        tree,
        syntaxErrors: sll.lexerErrors.count,
        firstError: sll.lexerErrors.first,
        mode: 'sll',
      };
    } catch (e) {
      if (!(e instanceof ParseCancellationException)) throw e;
    }
    const ll = newParser(text);
    const errors = new CountingErrorListener();
    ll.parser.addErrorListener(errors);
    ll.parser.interpreter.predictionMode = PredictionMode.LL;
    ll.parser.errorHandler = new DefaultErrorStrategy();
    ll.parser.addParseListener(deadlineListener(deadline));
    const tree = ll.parser.sql_script();
    return {
      tree,
      syntaxErrors: errors.count + ll.lexerErrors.count,
      firstError: ll.lexerErrors.first ?? errors.first,
      mode: 'll',
    };
  } catch (e) {
    if (e instanceof DeadlineExceeded)
      return { syntaxErrors: 1, firstError: 'deadline exceeded', mode: 'timeout' };
    throw e;
  }
}

/** Split pre-processed text at lone `/` lines; each segment keeps its line offset. */
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
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '/') {
      flush(i + 1);
      start = i + 1;
    }
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
