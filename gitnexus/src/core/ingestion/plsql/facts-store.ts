/**
 * Per-run store of extracted PL/SQL facts, and the lazy entry point to the
 * ANTLR parser.
 *
 * The generated parser is large (~14 MB of JS, ~120 MB resident), so nothing
 * that every analysis loads — the provider registry, parse workers, the scope
 * resolver — imports it. The `plsql` phase calls `loadPlSqlParser()` only when
 * the repository holds PL/SQL, and rename awaits it before parsing; other
 * synchronous callers fall back to a synchronous load.
 *
 * Facts are keyed by path and content hash, so an edited or renamed source can
 * never be served stale facts. The store holds one run: the processor resets
 * it at the start of each run with room for every PL/SQL file, and other
 * callers add misses under a small bounded budget. Facts are not persisted
 * across runs (see PLSQL-07 in docs/languages/plsql-ingestion-gaps.md).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as ExtractModule from './extract.js';
import type { PlSqlFileFacts, PlSqlLexedToken } from './extract.js';

type Extractor = typeof ExtractModule;

let extractor: Extractor | undefined;

/** Load the ANTLR parser and fact extractor; idempotent. */
export async function loadPlSqlParser(): Promise<void> {
  extractor ??= await import('./extract.js');
}

function loadedExtractor(): Extractor {
  if (extractor) return extractor;
  try {
    // Synchronous fallback for callers that cannot await (require(esm), Node >= 22.12).
    extractor = createRequire(import.meta.url)('./extract.js') as Extractor;
  } catch (cause) {
    throw new Error('PL/SQL parser is not loaded: await loadPlSqlParser() before extracting', {
      cause,
    });
  }
  return extractor;
}

/** Head-room for extractions outside the phase (rename re-parses edited sources). */
const EXTRA_ENTRIES = 64;

let capacity = EXTRA_ENTRIES;
let store = new Map<string, PlSqlFileFacts>();

const keyOf = (filePath: string, content: string) =>
  `${filePath}\0${createHash('sha1').update(content).digest('hex')}`;

/** Start a run sized for `fileCount` PL/SQL files; drops the previous run's facts. */
export function resetPlSqlFactsStore(fileCount: number): void {
  store = new Map();
  capacity = fileCount + EXTRA_ENTRIES;
}

/** Facts for `content` at `filePath`, extracted at most once per run. */
export function plsqlFactsForFile(filePath: string, content: string): PlSqlFileFacts {
  const key = keyOf(filePath, content);
  const cached = store.get(key);
  if (cached) return cached;
  const facts = loadedExtractor().extractPlSqlFacts(content);
  if (store.size >= capacity) store.delete(store.keys().next().value!);
  store.set(key, facts);
  return facts;
}

/** Identifier-candidate tokens of pre-processed text, for rename. */
export function plsqlLexTokens(preprocessed: string): PlSqlLexedToken[] {
  return loadedExtractor().lexPlSqlTokens(preprocessed);
}
