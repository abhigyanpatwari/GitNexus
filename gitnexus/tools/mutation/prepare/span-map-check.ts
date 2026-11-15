/**
 * Span-map check (KTD7): proves, mutant by mutant, that a span Stryker reports on the prepared
 * file means the same change on the original file, so global identities (mutant-identity.ts)
 * can name mutants by original spans.
 *
 * Stryker's locations refer to the text it mutated, the report's `files[path].source` (the
 * prepared copy's text). The prepare step changes that text only by blanking `as` assertions to
 * spaces of the same length, keeping line terminators, so a location must convert to the same
 * offsets in both files.
 *
 * Blanked ranges come from a code-unit diff of the two texts: a position is blanked when the
 * prepared text has a space there and the original has a different character that is not a
 * line terminator (blank-assertions.ts replaces every such character, tabs and both halves of a
 * surrogate pair included, with one space per code unit). Any other difference, and any length
 * difference, is foreign: the prepare step never makes it. Deriving the ranges from the texts
 * needs no parse and no record from the prepare step, and a foreign difference cannot hide in
 * them because only "space where the original had a non-terminator" is masked.
 *
 * Applying a mutant's replacement at the same offsets to two texts of equal length gives two
 * mutated texts that differ exactly where the inputs differ outside the span; inside the span
 * both hold the replacement. The check therefore compares, with blanked positions masked, the
 * text around the span (the mutated texts) and the span text itself (what the mutant removes,
 * which is what the global identity claims it removes from the original). A mutant fails when:
 *   - the files differ in length, or the location converts to different offsets in each;
 *   - the location lies outside either file;
 *   - a span boundary falls strictly inside a blanked run (it would cut an assertion);
 *   - the span text, or the text around it, differs outside blanked positions.
 * Every failure message names the mutant's global identity.
 */
import type {
  MutationReport,
  ReportLocation,
  ReportPosition,
  RunIdentities,
} from './mutant-identity.js';

/** Line boundaries of a text, using the line terminators Babel (and so Stryker) counts. */
export interface SourceIndex {
  /** How messages name the text, e.g. `prepared file`. */
  name: string;
  text: string;
  /** Offset of the first character of each line. */
  lineStarts: readonly number[];
  /** Offset just past the last non-terminator character of each line. */
  lineEnds: readonly number[];
}

/** 0-based offsets, `end` exclusive. */
export interface Offsets {
  start: number;
  end: number;
}

export interface SpanMapEntry {
  localId: string;
  globalId: string;
  /** Offsets of the span, the same in both files. */
  start: number;
  end: number;
  originalText: string;
  preparedText: string;
}

export interface SpanMapFailure {
  localId: string;
  globalId: string;
  message: string;
}

export interface SpanMapResult {
  checked: number;
  mapped: SpanMapEntry[];
  failures: SpanMapFailure[];
}

const CR = 0x0d;
const LF = 0x0a;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const SPACE = 0x20;
/** Failures listed in an {@link assertSpanMap} error; the count covers the rest. */
const LISTED_FAILURES = 20;
/** Code units quoted on each side of a span-text difference. */
const EXCERPT_RADIUS = 24;

const isLineTerminator = (code: number): boolean =>
  code === LF || code === CR || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;

/** Indexes a text's lines: `\r\n`, `\r`, `\n`, U+2028 and U+2029 each end a line. */
export function indexSource(text: string, name = 'file'): SourceIndex {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isLineTerminator(code)) continue;
    lineEnds.push(i);
    if (code === CR && text.charCodeAt(i + 1) === LF) i++;
    lineStarts.push(i + 1);
  }
  lineEnds.push(text.length);
  return { name, text, lineStarts, lineEnds };
}

function positionToOffset(index: SourceIndex, { line, column }: ReportPosition): number {
  const lines = index.lineStarts.length;
  if (!Number.isInteger(line) || line < 1 || line > lines) {
    throw new RangeError(`line ${line} is outside the ${index.name} (${lines} lines)`);
  }
  const lineStart = index.lineStarts[line - 1];
  const length = index.lineEnds[line - 1] - lineStart;
  // An exclusive end may sit just past the line's last character, on its terminator.
  if (!Number.isInteger(column) || column < 1 || column > length + 1) {
    throw new RangeError(
      `column ${column} is outside line ${line} of the ${index.name} (${length} characters)`,
    );
  }
  return lineStart + column - 1;
}

/** Converts a 1-based, end-exclusive report location to 0-based offsets. */
export function locationToOffsets(index: SourceIndex, location: ReportLocation): Offsets {
  const start = positionToOffset(index, location.start);
  const end = positionToOffset(index, location.end);
  if (end < start) throw new RangeError(`the location ends before it starts in the ${index.name}`);
  return { start, end };
}

/** The 1-based `line:column` of an offset. */
function describeOffset(index: SourceIndex, offset: number): string {
  let low = 0;
  let high = index.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (index.lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return `${low + 1}:${offset - index.lineStarts[low] + 1}`;
}

/** Index of the first value `>= target` in a sorted array. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

interface FileComparison {
  original: SourceIndex;
  prepared: SourceIndex;
  sameLength: boolean;
  /** 1 where the prepared text holds a blanking space. */
  blanked: Uint8Array;
  /** Sorted offsets where the texts differ and the difference is not a blank. */
  foreign: number[];
}

function compareFiles(original: string, prepared: string): FileComparison {
  const comparison: FileComparison = {
    original: indexSource(original, 'original file'),
    prepared: indexSource(prepared, 'prepared file'),
    sameLength: original.length === prepared.length,
    blanked: new Uint8Array(prepared.length),
    foreign: [],
  };
  if (!comparison.sameLength) return comparison;
  for (let i = 0; i < original.length; i++) {
    const before = original.charCodeAt(i);
    const after = prepared.charCodeAt(i);
    if (before === after) continue;
    if (after === SPACE && !isLineTerminator(before)) comparison.blanked[i] = 1;
    else comparison.foreign.push(i);
  }
  return comparison;
}

/** True when `offset` falls strictly inside a run of blanked positions. */
const cutsBlankedRun = (blanked: Uint8Array, offset: number): boolean =>
  offset > 0 && blanked[offset - 1] === 1 && blanked[offset] === 1;

/** The reason one mutant's span does not map, or `null` when it maps. */
function spanProblem(comparison: FileComparison, location: ReportLocation): string | null {
  const { original, prepared, blanked, foreign } = comparison;
  if (!comparison.sameLength) {
    return (
      `the prepared file has ${prepared.text.length} characters and the original ` +
      `${original.text.length}, so columns do not map`
    );
  }
  let span: Offsets;
  let originalSpan: Offsets;
  try {
    span = locationToOffsets(prepared, location);
    originalSpan = locationToOffsets(original, location);
  } catch (error) {
    if (error instanceof RangeError) return error.message;
    throw error;
  }
  if (span.start !== originalSpan.start || span.end !== originalSpan.end) {
    return (
      `the location is at offsets ${span.start}-${span.end} in the prepared file but ` +
      `${originalSpan.start}-${originalSpan.end} in the original`
    );
  }
  for (const [side, offset] of [
    ['start', span.start],
    ['end', span.end],
  ] as const) {
    if (cutsBlankedRun(blanked, offset)) {
      return `the span ${side} cuts a blanked assertion at ${describeOffset(original, offset)}`;
    }
  }
  const inside = foreign[lowerBound(foreign, span.start)];
  if (inside !== undefined && inside < span.end) {
    // Quote a window of the span around the difference, so a long span stays readable.
    const from = Math.max(span.start, inside - EXCERPT_RADIUS);
    const to = Math.min(span.end, inside + EXCERPT_RADIUS);
    const quote = (text: string): string =>
      (from > span.start ? '…' : '') +
      JSON.stringify(text.slice(from, to)) +
      (to < span.end ? '…' : '');
    return (
      `the original span text differs from the prepared span text at ` +
      `${describeOffset(original, inside)} outside blanked assertions ` +
      `(original ${quote(original.text)}, prepared ${quote(prepared.text)})`
    );
  }
  // No foreign offset lies inside the span, so the first one, if any, lies around it.
  const outside = foreign[0];
  if (outside !== undefined) {
    return (
      `the original file differs from the prepared file at ` +
      `${describeOffset(original, outside)} outside blanked assertions`
    );
  }
  return null;
}

/**
 * Checks every mutant of a run (see the module comment). `run` must come from
 * `identifyMutants(report, ...)`: it supplies the original texts and the global ids.
 */
export function checkSpanMap(report: MutationReport, run: RunIdentities): SpanMapResult {
  const comparisons = new Map<string, FileComparison>();
  const result: SpanMapResult = { checked: 0, mapped: [], failures: [] };
  for (const { localId, globalId, identity, reportFile } of run.mutants) {
    const fileResult = report.files[reportFile];
    const original = run.originals.get(identity.file);
    if (fileResult === undefined || original === undefined) {
      throw new Error(`span map: mutant ${globalId} does not belong to this report`);
    }
    let comparison = comparisons.get(reportFile);
    if (comparison === undefined) {
      comparison = compareFiles(original, fileResult.source);
      comparisons.set(reportFile, comparison);
    }
    result.checked++;
    const problem = spanProblem(comparison, identity.location);
    if (problem !== null) {
      result.failures.push({
        localId,
        globalId,
        message: `span map: mutant ${globalId} (local id ${localId}): ${problem}`,
      });
      continue;
    }
    const { start, end } = locationToOffsets(comparison.original, identity.location);
    result.mapped.push({
      localId,
      globalId,
      start,
      end,
      originalText: original.slice(start, end),
      preparedText: fileResult.source.slice(start, end),
    });
  }
  return result;
}

/** Throws when any mutant failed the check, listing the first failures by global id. */
export function assertSpanMap(result: SpanMapResult): void {
  const { failures, checked } = result;
  if (failures.length === 0) return;
  const listed = failures.slice(0, LISTED_FAILURES).map((failure) => `  ${failure.message}`);
  const rest = failures.length - listed.length;
  throw new Error(
    [
      `span map: ${failures.length} of ${checked} mutants failed:`,
      ...listed,
      ...(rest > 0 ? [`  ... and ${rest} more`] : []),
    ].join('\n'),
  );
}
