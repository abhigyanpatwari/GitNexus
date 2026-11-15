import { RenameFailure, type OccurrenceEdit, type ReportedEdit } from './types.js';

/** Validate original-source spans before constructing output or reporting edits. */
export function prepareRenameEdits(
  snapshot: string,
  unsorted: readonly OccurrenceEdit[],
  file: string,
): { edits: OccurrenceEdit[]; reports: ReportedEdit[] } {
  const edits: OccurrenceEdit[] = [];
  for (const edit of [...unsorted].sort((a, b) => a.start - b.start || a.length - b.length)) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.length) ||
      edit.start < 0 ||
      edit.length <= 0 ||
      edit.start + edit.length > snapshot.length ||
      snapshot.slice(edit.start, edit.start + edit.length) !== edit.old_text
    )
      throw new RenameFailure('invalid_edit', `Invalid rename span or expected text in ${file}.`);
    const previous = edits.at(-1);
    if (previous && previous.start + previous.length > edit.start) {
      if (
        previous.start === edit.start &&
        previous.length === edit.length &&
        previous.old_text === edit.old_text &&
        previous.new_text === edit.new_text
      )
        continue;
      throw new RenameFailure('overlapping_edits', `Conflicting rename spans in ${file}.`);
    }
    edits.push(edit);
  }
  // Sorted offsets allow one forward walk through the source instead of
  // counting every preceding line again for every occurrence.
  let line = 1;
  let lineStart = 0;
  let nextLine = snapshot.indexOf('\n');
  const reports = edits.map(({ file_path: _file, ...edit }): ReportedEdit => {
    while (nextLine >= 0 && nextLine < edit.start) {
      line++;
      lineStart = nextLine + 1;
      nextLine = snapshot.indexOf('\n', lineStart);
    }
    const lineEnd = nextLine < 0 ? snapshot.length : nextLine;
    return {
      ...edit,
      confidence: 'semantic',
      line,
      before: snapshot.slice(lineStart, lineEnd),
      after:
        snapshot.slice(lineStart, edit.start) +
        edit.new_text +
        snapshot.slice(edit.start + edit.length, lineEnd),
    };
  });
  return { edits, reports };
}
