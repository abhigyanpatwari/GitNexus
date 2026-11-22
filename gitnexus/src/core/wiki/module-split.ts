/**
 * Splitting a wiki module whose source is too large for one page.
 *
 * The module is divided by directory below the directory its files share, so
 * a Gradle or Maven module splits at its packages, not at `src/main`. A
 * directory still over the budget is divided the same way. Neighbouring
 * directories under the budget share a page, up to the budget, and so do the
 * files that sit directly in a directory, so the number of pages follows the
 * size of the module rather than its number of directories or files.
 */

/** One page of a split module. */
export interface ModulePart {
  /**
   * The directories the page covers, as the steps taken below the module's
   * own directory (`main/entity`), with `(1 of 2)` after it when its files
   * fill several pages. A directory can carry the same name as a label, so
   * labels can repeat; the generator numbers page names that meet.
   */
  label: string;
  files: string[];
}

/** Label of the files that sit directly in the module's own directory. */
export const TOP_LEVEL_LABEL = 'top-level files';

/** A module with fewer files is never divided. */
const MIN_FILES_TO_SPLIT = 4;

interface Directory {
  name: string;
  files: string[];
  tokens: number;
}

const directoriesOf = (file: string): string[] => file.replace(/\\/g, '/').split('/').slice(0, -1);

/** Number of leading directories every file shares. */
function sharedDepth(files: readonly string[]): number {
  let shared = directoriesOf(files[0]);
  for (const file of files) {
    const directories = directoriesOf(file);
    let depth = 0;
    while (
      depth < shared.length &&
      depth < directories.length &&
      shared[depth] === directories[depth]
    ) {
      depth++;
    }
    shared = shared.slice(0, depth);
  }
  return shared.length;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: Directory, b: Directory): number => compare(a.name, b.name);

/** `a`, `a, b`, or `a … z` for directories sharing a page, in name order. */
function sharedPageName(directories: readonly Directory[]): string {
  const first = directories[0].name;
  const last = directories[directories.length - 1].name;
  if (directories.length === 1) return first;
  return directories.length === 2 ? `${first}, ${last}` : `${first} … ${last}`;
}

/**
 * Divide `files` into pages of at most `budget` tokens. Only a single file
 * over the budget makes a page over it. A module of fewer than four files is
 * returned whole. Pages come in directory order, the files sitting directly
 * in a directory first; files keep their input order within each directory,
 * except files that fill several pages, which go in name order.
 */
export function splitModuleByDirectory(
  files: readonly string[],
  tokensOf: (file: string) => number,
  budget: number,
): ModulePart[] {
  const parts: ModulePart[] = [];
  const total = (list: readonly string[]): number =>
    list.reduce((sum, file) => sum + tokensOf(file), 0);
  const labelOf = (steps: readonly string[]): string => steps.join('/') || TOP_LEVEL_LABEL;
  const emit = (steps: readonly string[], list: readonly string[]): void => {
    parts.push({ label: labelOf(steps), files: [...list] });
  };

  // Files sharing one directory: as many name-ordered pages as the budget asks.
  const pack = (steps: readonly string[], list: readonly string[]): void => {
    if (total(list) <= budget) return emit(steps, list);
    const pages: string[][] = [];
    let page: string[] = [];
    let pageTokens = 0;
    for (const file of [...list].sort(compare)) {
      const tokens = tokensOf(file);
      if (page.length > 0 && pageTokens + tokens > budget) {
        pages.push(page);
        page = [];
        pageTokens = 0;
      }
      page.push(file);
      pageTokens += tokens;
    }
    pages.push(page);
    // A single file over the budget: nothing smaller to make.
    if (pages.length === 1) return emit(steps, page);
    pages.forEach((files, i) => {
      parts.push({ label: `${labelOf(steps)} (${i + 1} of ${pages.length})`, files });
    });
  };

  const divide = (group: readonly string[], steps: readonly string[]): void => {
    if (total(group) <= budget) return emit(steps, group);

    const depth = sharedDepth(group);
    const loose: string[] = [];
    const named = new Map<string, string[]>();
    for (const file of group) {
      const directories = directoriesOf(file);
      if (directories.length === depth) {
        loose.push(file);
        continue;
      }
      const name = directories[depth];
      const list = named.get(name);
      if (list) list.push(file);
      else named.set(name, [file]);
    }
    // Every file sits in the same directory: there is no directory to divide on.
    if (named.size === 0) return pack(steps, group);
    if (loose.length > 0) pack(steps, loose);

    const directories = [...named]
      .map(([name, list]) => ({ name, files: list, tokens: total(list) }))
      .sort(byName);
    let shared: Directory[] = [];
    let sharedTokens = 0;
    const flush = (): void => {
      if (shared.length === 0) return;
      emit(
        [...steps, sharedPageName(shared)],
        shared.flatMap((directory) => directory.files),
      );
      shared = [];
      sharedTokens = 0;
    };
    for (const directory of directories) {
      if (directory.tokens > budget) {
        flush();
        divide(directory.files, [...steps, directory.name]);
        continue;
      }
      if (sharedTokens + directory.tokens > budget) flush();
      shared.push(directory);
      sharedTokens += directory.tokens;
    }
    flush();
  };

  if (files.length === 0) return parts;
  if (files.length < MIN_FILES_TO_SPLIT) emit([], files);
  else divide(files, []);
  return parts;
}
