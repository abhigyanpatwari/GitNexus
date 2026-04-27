/**
 * Coverage-gap detection.
 *
 * Surfaces silent indexing gaps where the repo contains a meaningful number of
 * source files in a language GitNexus does not yet support. Without this,
 * `analyze` "succeeds" on, e.g., a Clojure-majority monorepo while extracting
 * zero symbols from `.clj/.cljs/.cljc` — a precise but dangerously partial
 * graph that callers may trust without knowing the limitation.
 *
 * The check is reporting-only: it never alters pipeline behavior or exit
 * status. The CLI prints any returned gaps in the analyze summary.
 */

import { getProviderForFile } from './ingestion/languages/index.js';

/**
 * Extensions for languages that are clearly source code but currently have no
 * GitNexus LanguageProvider. New providers SHOULD remove their extensions from
 * this map when added so the warning self-deactivates.
 *
 * Curated list — broad enough to catch real coverage cliffs, narrow enough to
 * avoid yelling at every config or asset extension. Markup, configuration,
 * and stylesheet formats are intentionally omitted.
 */
const UNSUPPORTED_SOURCE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  // Clojure family
  ['.clj', 'Clojure'],
  ['.cljs', 'ClojureScript'],
  ['.cljc', 'Clojure (cross-platform)'],
  ['.edn', 'Clojure (EDN)'],
  // JVM
  ['.scala', 'Scala'],
  ['.sc', 'Scala'],
  ['.groovy', 'Groovy'],
  // BEAM
  ['.ex', 'Elixir'],
  ['.exs', 'Elixir'],
  ['.erl', 'Erlang'],
  ['.hrl', 'Erlang'],
  // ML family
  ['.ml', 'OCaml'],
  ['.mli', 'OCaml'],
  ['.fs', 'F#'],
  ['.fsi', 'F#'],
  ['.fsx', 'F#'],
  ['.hs', 'Haskell'],
  ['.lhs', 'Haskell'],
  ['.elm', 'Elm'],
  // Scripting / scientific
  ['.lua', 'Lua'],
  ['.r', 'R'],
  ['.jl', 'Julia'],
  ['.pl', 'Perl'],
  ['.pm', 'Perl'],
  // Systems
  ['.nim', 'Nim'],
  ['.zig', 'Zig'],
  ['.v', 'V'],
  ['.cr', 'Crystal'],
  // Shell-ish (only the genuinely-source ones)
  ['.sh', 'Shell'],
  ['.bash', 'Bash'],
  ['.zsh', 'Zsh'],
  ['.ps1', 'PowerShell'],
]);

/** Minimum file count for a gap to be worth surfacing. */
const DEFAULT_MIN_FILES = 10;

export interface CoverageGap {
  /** Lower-cased file extension including the leading dot, e.g. `.cljs`. */
  extension: string;
  /** Human-readable language name shown in the warning. */
  language: string;
  /** Number of files with this extension in the scanned repo. */
  fileCount: number;
}

export interface DetectCoverageGapsOptions {
  /** Minimum file count threshold (default 10). */
  minFiles?: number;
}

/**
 * Tally extensions across `filePaths` and return one gap per
 * unsupported-but-meaningfully-present language, sorted by file count desc.
 *
 * Pure function. Does not read the filesystem.
 */
export function detectCoverageGaps(
  filePaths: readonly string[],
  options?: DetectCoverageGapsOptions,
): CoverageGap[] {
  const minFiles = options?.minFiles ?? DEFAULT_MIN_FILES;

  const counts = new Map<string, number>();
  for (const filePath of filePaths) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = filePath.slice(dot).toLowerCase();
    if (!UNSUPPORTED_SOURCE_LANGUAGES.has(ext)) continue;
    // Defensive: a future provider may claim one of these extensions. Treat
    // "has provider" as the source of truth and skip — no gap to report.
    if (getProviderForFile(filePath) !== null) continue;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }

  const gaps: CoverageGap[] = [];
  for (const [ext, fileCount] of counts) {
    if (fileCount < minFiles) continue;
    gaps.push({
      extension: ext,
      language: UNSUPPORTED_SOURCE_LANGUAGES.get(ext)!,
      fileCount,
    });
  }

  gaps.sort((a, b) => b.fileCount - a.fileCount);
  return gaps;
}

/**
 * Format gaps as a multi-line CLI warning block. Returns null when there are
 * no gaps to report so callers can keep the no-op path silent.
 */
export function formatCoverageGapWarning(gaps: readonly CoverageGap[]): string | null {
  if (gaps.length === 0) return null;

  const lines: string[] = [];
  lines.push('  Coverage gaps detected:');
  for (const gap of gaps) {
    lines.push(
      `    ${gap.fileCount.toLocaleString()} ${gap.extension} files — ` +
        `${gap.language} not supported. No symbols extracted from these files.`,
    );
  }
  lines.push(
    '  These files were registered but produced no callable symbols in the graph.',
  );
  return lines.join('\n');
}
