/**
 * Splitting a wiki module whose source is too large for one page.
 *
 * The module is divided by directory below the directory its files share, so
 * a Gradle or Maven module splits at its packages, not at `src/main`. Files
 * that sit directly in a directory stay on one page instead of getting a page
 * each. A directory still over the budget is divided the same way.
 * Neighbouring directories under the budget share a page, up to the budget,
 * so the number of pages follows the size of the module rather than its
 * number of directories.
 */

/** One page of a split module. */
export interface ModulePart {
  /**
   * The directories the page covers, as the steps taken below the module's
   * own directory (`main/entity`). Unique within the module.
   */
  label: string;
  files: string[];
}

/** Label of the files that sit directly in the module's own directory. */
export const TOP_LEVEL_LABEL = 'top-level files';

/** A module or directory with fewer files is never divided. */
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

const byName = (a: Directory, b: Directory): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** `a`, `a, b`, or `a … z` for directories sharing a page, in name order. */
function sharedPageName(directories: readonly Directory[]): string {
  const first = directories[0].name;
  const last = directories[directories.length - 1].name;
  if (directories.length === 1) return first;
  return directories.length === 2 ? `${first}, ${last}` : `${first} … ${last}`;
}

/**
 * Divide `files` into pages of at most `budget` tokens where the directory
 * layout allows it. A group that cannot be divided further (fewer than four
 * files, or all of them in one directory) is returned whole, over budget.
 * Pages come in directory order, the files sitting directly in a directory
 * first; files keep their input order within each directory.
 */
export function splitModuleByDirectory(
  files: readonly string[],
  tokensOf: (file: string) => number,
  budget: number,
): ModulePart[] {
  const parts: ModulePart[] = [];
  const total = (list: readonly string[]): number =>
    list.reduce((sum, file) => sum + tokensOf(file), 0);
  const emit = (steps: readonly string[], list: readonly string[]): void => {
    parts.push({ label: steps.join('/') || TOP_LEVEL_LABEL, files: [...list] });
  };

  const divide = (group: readonly string[], steps: readonly string[]): void => {
    if (group.length < MIN_FILES_TO_SPLIT || total(group) <= budget) return emit(steps, group);

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
    // Every file sits in the same directory: there is nothing to divide on.
    if (named.size === 0) return emit(steps, group);
    if (loose.length > 0) emit(steps, loose);

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

  if (files.length > 0) divide(files, []);
  return parts;
}
