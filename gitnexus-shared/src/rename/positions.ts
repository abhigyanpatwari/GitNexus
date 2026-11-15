import type { OccurrenceEdit } from './types.js';

export function applyEdits(content: string, edits: readonly OccurrenceEdit[]): string {
  let cursor = 0;
  const pieces: string[] = [];
  for (const edit of edits) {
    pieces.push(content.slice(cursor, edit.start), edit.new_text);
    cursor = edit.start + edit.length;
  }
  pieces.push(content.slice(cursor));
  return pieces.join('');
}

export function createOffsetLookup(): (
  source: { readonly content: string },
  line: number,
  column: number,
) => number {
  const lineStarts = new WeakMap<{ readonly content: string }, readonly number[]>();
  return (source, line, column) => {
    let starts = lineStarts.get(source);
    if (starts === undefined) {
      const entries = [0];
      for (
        let next = source.content.indexOf('\n');
        next !== -1;
        next = source.content.indexOf('\n', next + 1)
      ) {
        entries.push(next + 1);
      }
      starts = entries;
      lineStarts.set(source, starts);
    }
    const offset = starts[line <= 1 ? 0 : line - 1];
    return offset === undefined ? source.content.length + 1 : offset + column;
  };
}

export function relocated(offset: number, edits: readonly OccurrenceEdit[], end = false): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.start || (offset === edit.start && !end)) break;
    if (offset < edit.start + edit.length)
      return edit.start + delta + (end ? edit.new_text.length : 0);
    delta += edit.new_text.length - edit.length;
  }
  return offset + delta;
}
