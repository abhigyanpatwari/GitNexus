/**
 * Per-run store of extracted PL/SQL facts, so each file is ANTLR-parsed once
 * per analyze: the `plsql` phase extracts every file, and the scope phase's
 * `emitScopeCaptures` (plus rename's `parseSource`) reuse those facts.
 *
 * Entries are keyed by path and content hash, so an edited or renamed source
 * can never be served stale facts. The store holds one run: the processor
 * resets it at the start of each run with room for every PL/SQL file, and
 * other callers add misses under a small bounded budget. Facts are not
 * persisted across runs (see PLSQL-07 in docs/languages/plsql-ingestion-gaps.md).
 */

import { createHash } from 'node:crypto';
import { extractPlSqlFacts, type PlSqlFileFacts } from './extract.js';

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
  const facts = extractPlSqlFacts(content);
  if (store.size >= capacity) store.delete(store.keys().next().value!);
  store.set(key, facts);
  return facts;
}
