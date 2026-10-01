/**
 * Standing invariant: the R worker never emits an owner id.
 *
 * R classes are calls (`R6::R6Class`, `setRefClass`, `setMethod`), not syntactic containers, so
 * `findEnclosingClassNodeOrFileOwner` finds no container node for any R definition and the worker
 * never stamps `ownerId` on an R node or symbol. The owner arrives later: the worker leaves an
 * `ownerNameHint` string that the R post-parse pass resolves once every Class is registered.
 *
 * That "always absent" premise is what lets the worker-side `!enclosingClassId` guard be dropped when
 * the hint moves into a `definitionPropertiesExtractor` (that context cannot express the guard), and
 * what lets the all-language node `ownerId` spread go. The attach-side already-owned early return is
 * the local backstop if the premise ever fails; this test keeps the premise honest.
 *
 * Runs the compiled worker over every `.R` file of the six r-* fixtures, before any post-parse.
 * Requires `dist/`; skipped locally when it is missing, hard-fails on CI (as the other worker-backed
 * suites do).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './resolvers/helpers.js';
import { distWorkerExists, parseFilesWithWorkers } from '../helpers/worker-parse.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const hasDistWorker = distWorkerExists();
if (!hasDistWorker && process.env.CI) {
  throw new Error(
    'dist/parse-worker.js missing on CI — the R worker owner-absence test would silently skip. ' +
      'Ensure the build runs before this suite.',
  );
}

// fixture -> number of R Method/Property nodes carrying an ownerNameHint (== the post-parse ownerId
// count before the attach moved behind the provider hook, because every hint in these fixtures resolves). 37 in total.
const EXPECTED_HINTS: Record<string, number> = {
  'r-packages': 22,
  'r-root-package': 0,
  'r-namespace-imports': 2,
  'r-call-attribution': 10,
  'r-native-pipes': 3,
  'r-dotted-s3-collision': 0,
};

const collectRFiles = (
  dir: string,
  root: string,
  out: { path: string; content: string }[] = [],
) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRFiles(full, root, out);
    else if (/\.[Rr]$/.test(entry.name)) {
      out.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        content: fs.readFileSync(full, 'utf-8'),
      });
    }
  }
  return out;
};

describe.skipIf(!hasDistWorker)('R worker never emits an owner id (before post-parse)', () => {
  it.each(Object.entries(EXPECTED_HINTS))(
    '%s: no R node or symbol carries ownerId; %i members carry ownerNameHint',
    async (fixture, expectedHints) => {
      const root = path.join(FIXTURES, fixture);
      const files = collectRFiles(root, root);
      expect(files.length).toBeGreaterThan(0);

      const raw: ParseWorkerResult[] = [];
      const { graph } = await parseFilesWithWorkers(files, { outRawResults: raw });

      let ownedNodes = 0;
      let hintedMembers = 0;
      graph.forEachNode((n) => {
        if (n.properties.language !== 'r') return;
        if (typeof n.properties.ownerId === 'string') ownedNodes++;
        if (
          (n.label === 'Method' || n.label === 'Property') &&
          typeof n.properties.ownerNameHint === 'string'
        ) {
          hintedMembers++;
        }
      });

      let symbols = 0;
      let ownedSymbols = 0;
      for (const result of raw) {
        for (const symbol of result.symbols) {
          symbols++;
          if (symbol.ownerId) ownedSymbols++;
        }
      }

      expect(symbols).toBeGreaterThan(0);
      expect(ownedNodes).toBe(0);
      expect(ownedSymbols).toBe(0);
      expect(hintedMembers).toBe(expectedHints);
    },
    60000,
  );
});
