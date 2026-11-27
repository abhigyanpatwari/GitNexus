import { getLanguageFromFilename } from 'gitnexus-shared';

/**
 * Shebang support for extensionless scripts (#2707). Language detection is
 * path-based, so `scripts/deploy` with `#!/usr/bin/env python3` was scanned but
 * never parsed. Providers opt in with their own interpreter pattern through the
 * existing content-classification hook.
 */

/** True when the file name has no extension (`bin/deploy`), excluding dotfiles. */
export function isExtensionlessPath(filePath: string): boolean {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  return name !== '' && !name.includes('.');
}

/** A shebang is read from at most this many leading bytes. */
export const SHEBANG_HEAD_BYTES = 256;

/** Extensionless and not already a known filename (`Rakefile`), which keeps its language. */
export function isShebangCandidate(filePath: string): boolean {
  return isExtensionlessPath(filePath) && getLanguageFromFilename(filePath) === null;
}

// `env` options that take a separate argument.
const ENV_OPTIONS_WITH_ARGUMENT = new Set(['-u', '--unset', '-C', '--chdir', '-P']);

const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);

// Package-runner options that take a separate argument (`npx -p tsx node`).
const RUNNER_OPTIONS_WITH_ARGUMENT = new Set(['-p', '--package']);

/**
 * Splits a shebang line into arguments. A quoted command string
 * (`env -S "python3 -u"`) is split further; a quoted assignment value
 * (`FOO="a b"`) stays one argument.
 */
function shebangArguments(line: string): string[] {
  const tokens = line.match(/\w+=(?:"[^"]*"|'[^']*'|\S*)|"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.flatMap((token) => {
    const bare = token.replace(/["']/g, '');
    return /^\w+=/.test(token) ? [bare] : bare.split(/\s+/).filter(Boolean);
  });
}

/**
 * The interpreter a `#!` line runs, e.g. `python3` for `#!/usr/bin/python3` or
 * `#!/usr/bin/env -S python3 -u`. Skips `env` options and NAME=value pairs, and
 * looks through package runners (`npx tsx` runs `tsx`).
 */
export function shebangInterpreter(sourceText: string): string | undefined {
  if (!sourceText.startsWith('#!')) return undefined;
  const firstLine = sourceText.slice(2, SHEBANG_HEAD_BYTES).split(/\r?\n/, 1)[0];
  const args = shebangArguments(firstLine);
  const basename = (arg: string) => arg.slice(arg.lastIndexOf('/') + 1);

  let i = 0;
  if (args.length > 0 && basename(args[0]) === 'env') {
    i = 1;
    while (i < args.length && (args[i].startsWith('-') || /^\w+=/.test(args[i]))) {
      i += ENV_OPTIONS_WITH_ARGUMENT.has(args[i]) ? 2 : 1;
    }
  }
  if (args[i] !== undefined && PACKAGE_RUNNERS.has(basename(args[i]))) {
    i++;
    while (i < args.length && args[i].startsWith('-')) {
      i += RUNNER_OPTIONS_WITH_ARGUMENT.has(args[i]) ? 2 : 1;
    }
  }
  return args[i] === undefined ? undefined : basename(args[i]);
}

/** Provider hooks claiming extensionless files whose interpreter matches `interpreter`. */
export function shebangClassifier(interpreter: RegExp) {
  return {
    shouldClassifyFileContent: isShebangCandidate,
    classifyFileContent: (filePath: string, sourceText: string) => {
      const name = isShebangCandidate(filePath) ? shebangInterpreter(sourceText) : undefined;
      return name !== undefined && interpreter.test(name);
    },
  };
}
