/**
 * End-to-end FTS searchability for full File content (#2317 / PR #2323).
 *
 * PR #2323 removed the 10KB `MAX_FILE_CONTENT` cap so full text-file content
 * reaches `file_fts`. The PR's own test proves the late needle lands in the
 * generated `file.csv`; it does NOT prove an FTS *search* returns content past
 * 10KB. This closes that gap through the REAL pipeline:
 *
 *   write >10KB file on disk → loadGraphToLbug (streamAllCSVsToDisk → COPY of
 *   the multiline quoted cell) → createFTSIndex(file_fts) → searchFTSFromLbug.
 *
 * A Cypher CREATE seed would bypass COPY and pass even if COPY truncated the
 * cell — the exact thing #2317 must guarantee — so this uses `loadGraphToLbug`
 * via the harness's `beforeFTS` hook (which runs before the gated FTS build),
 * reusing `withTestLbugDB`'s offline-skip / GITNEXUS_REQUIRE_FTS gating.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';

// A token near the top (< 10KB) and a distinctive token past ~20KB. Both are
// unique lowercase-alphabetic non-stopwords so they tokenize cleanly under the
// `porter` stemmer and never collide with the printable-ASCII filler (keeping
// the first 1000 chars text, so isBinaryContent does not swap in its sentinel).
const earlyWord = 'sentinelalpha';
const lateNeedle = 'zarquonbeacon';
const FILLER = 'filler line for full file content indexing\n'; // ~43 chars
const FILE_BODY =
  `${earlyWord} appears near the very top of the file\n` +
  FILLER.repeat(500) + // ~21.5KB of filler → lateNeedle lands well past 10KB
  `${lateNeedle} appears far past the old ten kilobyte cutoff\n`;

withTestLbugDB(
  'fts-fullfile-search',
  () => {
    describe('full File content past 10KB is FTS-searchable (#2317)', () => {
      it('returns the file for a needle located past the old 10KB cutoff', async () => {
        const { results } = await searchFTSFromLbug(lateNeedle, 20);
        expect(results.map((r) => r.filePath)).toContain('large.txt');
      });

      it('persists the full multiline cell through COPY — past 10KB, not the binary sentinel', async () => {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        const rows = await adapter.executeQuery(
          "MATCH (f:File {filePath: 'large.txt'}) RETURN f.content AS content",
        );
        const stored = String(rows[0].content);
        expect(stored.length).toBeGreaterThan(10240);
        expect(stored).not.toContain('[Binary file');
        expect(stored).toContain(lateNeedle);
      });

      it('still finds a token within the first 10KB (no short-content regression)', async () => {
        const { results } = await searchFTSFromLbug(earlyWord, 20);
        expect(results.map((r) => r.filePath)).toContain('large.txt');
      });
    });
  },
  {
    // Triggers the FTS-availability probe + offline-skip / GITNEXUS_REQUIRE_FTS
    // gating, and builds file_fts over the COPY'd File rows (after beforeFTS).
    ftsIndexes: [{ table: 'File', indexName: 'file_fts', columns: ['name', 'content'] }],
    // No Cypher `seed`; no pool adapter → searchFTSFromLbug routes through the
    // core-adapter connection loadGraphToLbug + createFTSIndex wrote to.
    beforeFTS: async (dbPath) => {
      // Colocate scratch dirs under the suite temp root so they're auto-cleaned.
      const root = path.dirname(dbPath);
      const repoDir = path.join(root, 'repo');
      const storageDir = path.join(root, 'storage');
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(storageDir, { recursive: true });
      await fs.writeFile(path.join(repoDir, 'large.txt'), FILE_BODY);

      // extractContent reads File content from disk, so the on-disk file is the
      // source of the COPY'd cell. loadGraphToLbug runs the real emit + COPY.
      const graph = buildTestGraph([
        { id: 'file:large.txt', label: 'File', name: 'large.txt', filePath: 'large.txt' },
      ]);
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(graph, repoDir, storageDir);
    },
  },
);
