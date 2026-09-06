/**
 * Per-language census of the global-name fallback: how many CALLS edges rest on
 * a unique-name guess, and how many guesses each language's visibility rules
 * refused.
 *
 * Both halves are needed and neither is meaningful alone. A guess count with no
 * refusal count cannot distinguish a language with genuinely few impossible
 * candidates from one whose hook is missing; a refusal count with no guess count
 * cannot distinguish a working guard from one that rejects everything. The pair
 * is what makes the guard auditable on a real repository, which is the whole
 * point of recording it — before this, guessed edges were emitted with the same
 * reason and confidence as import-resolved ones and the number was unknowable.
 *
 * Structural sibling of `unresolved-receivers.ts`'s summary, and persisted the
 * same way (`RepoMeta.nameFallbackEdges`).
 */

import { getLanguageFromFilename } from 'gitnexus-shared';
import { logger } from '../../logger.js';
import type { ResolutionOutcome } from './resolution-outcome.js';

/**
 * Distinct caller-file/callee-name pairs per language, from the caller→callee-name index the pipeline
 * builds while its streaming sink is live (so it is complete under `--force`),
 * bucketed by the CALLER's file language. Gives `NameFallbackSummary.byLanguage`
 * its denominator: a guess count is only readable as a share of the calls.
 */
export function countCallsByLanguage(
  index: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  nodes: { getNode(id: string): { properties: Record<string, unknown> } | undefined } | undefined,
): Readonly<Record<string, number>> | undefined {
  if (index === undefined || nodes === undefined) return undefined;
  const counts = new Map<string, number>();
  const namesByFile = new Map<string, Set<string>>();
  for (const [callerId, callees] of index) {
    const filePath = nodes.getNode(callerId)?.properties?.filePath;
    if (typeof filePath !== 'string') continue;
    let names = namesByFile.get(filePath);
    if (names === undefined) {
      names = new Set<string>();
      namesByFile.set(filePath, names);
    }
    for (const name of callees) names.add(name);
  }
  for (const [filePath, names] of namesByFile) {
    const language = getLanguageFromFilename(filePath) ?? 'unknown';
    counts.set(language, (counts.get(language) ?? 0) + names.size);
  }
  if (counts.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [language, count] of [...counts.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    out[language] = count;
  }
  return out;
}

/** Unattributed bucket for a pass that recorded no language. */
const UNKNOWN_LANGUAGE = 'unknown';

export interface NameFallbackLanguageCounts {
  /** Labeled `global-name-fallback` edges emitted for this language — CALL SITES. */
  readonly guessed: number;
  /**
   * Distinct (caller file, callee name) pairs among those sites — the unit
   * `callsByLanguage` counts in, so `guessedPairs / callsByLanguage[lang]` is a
   * ratio bounded by 1. Absent on a summary persisted before this field existed.
   */
  readonly guessedPairs?: number;
  /** Candidates this language's `isGlobalNameFallbackPlausible` hook refused. */
  readonly refused: number;
}

export interface NameFallbackSummary {
  /** Language → guessed/refused counts. Languages with neither are absent. */
  readonly byLanguage: Readonly<Record<string, NameFallbackLanguageCounts>>;
  /** Guessed call sites, repo-wide. */
  readonly totalGuessed: number;
  /** Distinct (caller file, callee name) pairs among the guessed sites. */
  readonly distinctGuessedPairs?: number;
  readonly totalRefused: number;
  /**
   * Barrel names refused because two `export *` sources both declared them
   * (`reexport-ambiguous`). Not a guess and not per-language — a name the
   * finalize pass declined to bind at all — but it belongs in the same census:
   * it is the other place the resolver used to publish an arbitrary winner as
   * `import-resolved`.
   */
  readonly totalAmbiguousReexports: number;
  /**
   * The refused barrel names themselves (`file:name`), sorted, capped at
   * `MAX_AMBIGUOUS_NAMES`. A count alone cannot say whether a refusal landed on
   * a name anyone calls; the list can be joined against the ledger's `byName`.
   */
  readonly ambiguousReexportNames?: readonly string[];
  /**
   * Distinct caller-file/callee-name pairs per language (through any path), so `guessedPairs` can be
   * read as a SHARE of a language's call graph rather than a bare count. Absent
   * when the caller did not supply the totals.
   */
  readonly callsByLanguage?: Readonly<Record<string, number>>;
}

/** Bound on the persisted ambiguous-name list; the total beside it stays exact. */
export const MAX_AMBIGUOUS_NAMES = 200;

/**
 * Build the summary, or `undefined` when the run neither guessed nor refused —
 * a repository with no opt-in language stores no key at all, so the artifact
 * stays absent rather than recording a row of zeroes.
 */
export function summarizeNameFallback(
  outcomes: readonly ResolutionOutcome[],
  callsByLanguage?: Readonly<Record<string, number>>,
): NameFallbackSummary | undefined {
  const guessed = new Map<string, number>();
  const guessedPairsByLanguage = new Map<string, number>();
  const refused = new Map<string, number>();
  const ambiguousNames = new Set<string>();
  // Two units, both kept. `guessed` counts call SITES — the number of emitted
  // guessed edges, which is what the log line has always reported and what
  // earlier persisted summaries hold. `guessedPairs` dedupes by (caller file,
  // callee name), the unit `callsByLanguage` is counted in: ten guessed `foo()`
  // calls in one file are one pair against a denominator that counts `foo`
  // once, so the guessy RATIO uses pairs and is bounded by 1. Changing the unit
  // of `guessed` itself silently read as a large improvement across engines.
  const guessedPairs = new Set<string>();
  let totalGuessed = 0;
  let totalRefused = 0;
  let totalAmbiguousReexports = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === 'fallback-guessed') {
      const language = outcome.language ?? UNKNOWN_LANGUAGE;
      guessed.set(language, (guessed.get(language) ?? 0) + 1);
      totalGuessed++;
      const pair = `${outcome.filePath}\u0000${outcome.name}`;
      if (!guessedPairs.has(pair)) {
        guessedPairs.add(pair);
        guessedPairsByLanguage.set(language, (guessedPairsByLanguage.get(language) ?? 0) + 1);
      }
    } else if (outcome.kind === 'fallback-refused') {
      const language = outcome.language ?? UNKNOWN_LANGUAGE;
      refused.set(language, (refused.get(language) ?? 0) + 1);
      totalRefused++;
    } else if (outcome.kind === 'reexport-ambiguous') {
      totalAmbiguousReexports++;
      ambiguousNames.add(`${outcome.filePath}:${outcome.name}`);
    }
  }
  if (totalGuessed === 0 && totalRefused === 0 && totalAmbiguousReexports === 0) return undefined;

  const byLanguage: Record<string, NameFallbackLanguageCounts> = {};
  for (const language of new Set([...guessed.keys(), ...refused.keys()])) {
    byLanguage[language] = {
      guessed: guessed.get(language) ?? 0,
      guessedPairs: guessedPairsByLanguage.get(language) ?? 0,
      refused: refused.get(language) ?? 0,
    };
  }
  const sortedNames = [...ambiguousNames].sort();
  return {
    byLanguage,
    totalGuessed,
    distinctGuessedPairs: guessedPairs.size,
    totalRefused,
    totalAmbiguousReexports,
    ...(sortedNames.length > 0
      ? { ambiguousReexportNames: sortedNames.slice(0, MAX_AMBIGUOUS_NAMES) }
      : {}),
    ...(callsByLanguage !== undefined ? { callsByLanguage } : {}),
  };
}

/**
 * One-line readout for the analyze summary. `undefined` when there is nothing to
 * report, so a run on a repository with no opt-in language prints no line.
 */
export function formatNameFallbackSummary(
  summary: NameFallbackSummary | undefined,
): string | undefined {
  if (summary === undefined) return undefined;
  const perLanguage = Object.entries(summary.byLanguage)
    .sort(([, a], [, b]) => b.guessed + b.refused - (a.guessed + a.refused))
    .map(([language, counts]) => `${language} ${counts.guessed}/${counts.refused}`)
    .join(', ');
  const ambiguous =
    summary.totalAmbiguousReexports > 0
      ? `; ${summary.totalAmbiguousReexports} barrel name(s) refused as ambiguous \`export *\``
      : '';
  const languages = perLanguage === '' ? 'none' : perLanguage;
  const pairs =
    summary.distinctGuessedPairs !== undefined
      ? ` (${summary.distinctGuessedPairs} distinct caller-file/name pairs)`
      : '';
  return `name-guessed CALLS edges: ${summary.totalGuessed} call sites${pairs}, ${summary.totalRefused} refused as impossible (guessed/refused by language: ${languages})${ambiguous}`;
}

/**
 * Print the readout as part of the analyze summary. Unconditional (not behind a
 * debug env var, unlike the receiver-drop diagnostic): a reader deciding how far
 * to trust this index's call graph needs to know how much of it is guessed, and
 * a number nobody sees is the state this work exists to end.
 */
export function logNameFallbackSummary(summary: NameFallbackSummary | undefined): void {
  const line = formatNameFallbackSummary(summary);
  if (line === undefined) return;
  logger.info(line);
}
