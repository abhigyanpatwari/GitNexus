import { getLanguageFromFilename } from 'gitnexus-shared';

/**
 * Shebang-based classification for extensionless scripts (#2707).
 *
 * A file such as `scripts/deploy` starting with `#!/usr/bin/env python3` has
 * no extension, so filename detection leaves it unparsed and its symbols never
 * reach the graph. A provider whose interpreter runs such scripts claims them
 * through `classifyFileContent` with `shebangClassifier(<its interpreters>)`.
 *
 * Deliberately conservative, as `classifyFileContent` requires: only paths
 * whose basename has no extension and that filename detection does not already
 * claim (Rakefile, Gemfile, … keep their filename language), and only the
 * interpreter named on the first line, directly or through `env`.
 */

/** True for a path whose basename has no extension and no filename-based language. */
export function isExtensionlessScriptPath(filePath: string): boolean {
  const basename = filePath.slice(filePath.lastIndexOf('/') + 1);
  return (
    basename.length > 0 && !basename.includes('.') && getLanguageFromFilename(filePath) === null
  );
}

/** `env` options whose value is the next word (GNU and BSD spellings). */
const ENV_OPTIONS_WITH_OPERAND = new Set(['-u', '--unset', '-C', '--chdir', '-P']);

/**
 * The interpreter named by a `#!` first line, e.g. `python3` for
 * `#!/usr/bin/env -S python3 -u`; null when there is no shebang.
 */
export function shebangInterpreter(sourceText: string): string | null {
  if (!sourceText.startsWith('#!')) return null;
  const newline = sourceText.indexOf('\n');
  const words = sourceText
    .slice(2, newline === -1 ? undefined : newline)
    .trim()
    .split(/\s+/);
  let program = words.shift();
  if (program === undefined || program === '') return null;
  if (program.slice(program.lastIndexOf('/') + 1) === 'env') {
    // `env [-S] [-i] [-u NAME] [-C DIR] [-P PATH] [NAME=value…] interpreter args`
    program = undefined;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (ENV_OPTIONS_WITH_OPERAND.has(w)) i++;
      else if (!w.startsWith('-') && !w.includes('=')) {
        program = w;
        break;
      }
    }
    if (program === undefined) return null;
  }
  return program.slice(program.lastIndexOf('/') + 1) || null;
}

/**
 * `classifyFileContent` / `shouldClassifyFileContent` pair claiming
 * extensionless scripts whose shebang interpreter matches `interpreters`.
 */
export function shebangClassifier(interpreters: RegExp) {
  return {
    classifyFileContent: (filePath: string, sourceText: string): boolean => {
      if (!isExtensionlessScriptPath(filePath)) return false;
      const interpreter = shebangInterpreter(sourceText);
      return interpreter !== null && interpreters.test(interpreter);
    },
    shouldClassifyFileContent: isExtensionlessScriptPath,
  };
}
