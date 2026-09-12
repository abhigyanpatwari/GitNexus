/**
 * #2798 — the vector-column width gate.
 *
 * `EMBEDDING_SCHEMA` declares `CodeEmbedding.embedding` as
 * `FLOAT[EMBEDDING_DIMS]`, and `EMBEDDING_DIMS` comes from
 * `GITNEXUS_EMBEDDING_DIMS` at module load. That is why the width is EXCLUDED
 * from `SCHEMA_FINGERPRINT` — an env-derived value inside a digest of CODE
 * makes the same build disagree with itself and thrash rebuilds — and it is
 * also why, until this gate existed, nothing guarded the width at all: flipping
 * the env var on a same-commit clean tree returned `alreadyUpToDate` over a
 * `FLOAT[384]` table while the process embedded at 768.
 *
 * These tests pin both halves:
 *   1. the comparator, including its deliberate divergence from
 *      `schemaFingerprintMismatch` on an ABSENT stamp;
 *   2. that the guard in run-analyze actually DISCRIMINATES — a differing
 *      stamp forces a rebuild through the `alreadyUpToDate` fast path, a
 *      matching one does not, and the rebuild restamps the live width.
 */

import { execSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_DIMS,
  SCHEMA_FINGERPRINT,
  embeddingDimsMismatch,
  schemaFingerprintMismatch,
} from '../../src/core/lbug/schema.js';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import {
  getStoragePaths,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

const CURRENT_ANALYSIS_FEATURES = {
  [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
};

/**
 * `meta.json` is a schema-less `JSON.parse` of on-disk state, so a recorded
 * value need not be a number at all. One cast, named, so the untrusted-input
 * cases below stay typed at every other call site.
 */
const fromUntrustedMeta = (value: unknown): number | undefined => value as number | undefined;

describe('embeddingDimsMismatch (#2798)', () => {
  it.each([
    // Absence is grandfathered: an index predating the field has an unknown
    // width that was consistent with the env that wrote it, and it also
    // predates `schemaFingerprint`, whose guard already rebuilds it once.
    { label: 'absent stamp, default width', recorded: undefined, current: 384, expected: false },
    {
      label: 'absent stamp, non-default live width',
      recorded: undefined,
      current: 768,
      expected: false,
    },
    { label: 'stamp equals the live width', recorded: 384, current: 384, expected: false },
    { label: 'widened (384 -> 768)', recorded: 384, current: 768, expected: true },
    { label: 'narrowed (768 -> 384)', recorded: 768, current: 384, expected: true },
    { label: 'off by one', recorded: 385, current: 384, expected: true },
  ])('$label -> $expected', ({ recorded, current, expected }) => {
    expect(embeddingDimsMismatch(recorded, current)).toBe(expected);
  });

  it.each([
    // Malformed on-disk values err toward a rebuild — the safe direction.
    // Only `undefined` is treated as "written before the field existed".
    { label: 'null', raw: null },
    { label: 'string', raw: '384' },
    { label: 'NaN', raw: Number.NaN },
    { label: 'object', raw: { dims: 384 } },
  ])('a malformed recorded value ($label) reads as a mismatch', ({ raw }) => {
    expect(embeddingDimsMismatch(fromUntrustedMeta(raw), 384)).toBe(true);
  });

  it('diverges from schemaFingerprintMismatch on an absent stamp, deliberately', () => {
    // The two guards sit side by side and answer absence differently. Pinned
    // together so a later "consistency" edit that makes absence force here has
    // to delete this assertion and read why.
    expect({
      dims: embeddingDimsMismatch(undefined, EMBEDDING_DIMS),
      fingerprint: schemaFingerprintMismatch(undefined),
    }).toMatchObject({ dims: false, fingerprint: true });
  });
});

/**
 * Seed a git repo whose index is up to date at HEAD, so the `alreadyUpToDate`
 * fast path is reachable and ONLY the guard under test can stop it. Every
 * other force-rebuild guard is satisfied: current fingerprint, current runner
 * identity, current analysis features, no dirty flag, clean tree, and an
 * absent `cjkSegmentation` that defaults to the resolved 'none'.
 */
async function seedIndexedRepo(
  prefix: string,
  embeddingDims: number | undefined,
): Promise<{ repo: TestDBHandle; home: TestDBHandle; storagePath: string }> {
  const repo = await createTempDir(prefix);
  const home = await createTempDir(`${prefix}home-`);
  execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
  execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
    cwd: repo.dbPath,
    stdio: 'pipe',
  });
  const lastCommit = execSync('git rev-parse HEAD', {
    cwd: repo.dbPath,
    encoding: 'utf-8',
  }).trim();
  const { storagePath } = getStoragePaths(repo.dbPath);
  const meta: RepoMeta = {
    repoPath: repo.dbPath,
    lastCommit,
    indexedAt: new Date().toISOString(),
    schemaFingerprint: SCHEMA_FINGERPRINT,
    analysisFeatures: CURRENT_ANALYSIS_FEATURES,
    runnerIdentity: resolveAnalyzerRunnerIdentity(
      pathToFileURL(path.resolve(__dirname, '../../src/core/run-analyze.ts')).href,
    ),
    embeddingDims,
  };
  await saveMeta(storagePath, meta);
  return { repo, home, storagePath };
}

describe('run-analyze embedding-dims guard (#2798)', () => {
  it.each([
    // Matching: the width this build embeds at is the width the table was
    // created at, so the fast path must survive.
    { label: 'a matching embeddingDims stamp', embeddingDims: EMBEDDING_DIMS },
    // Absent: the grandfathering decision, asserted at the guard and not just
    // at the comparator.
    { label: 'an absent embeddingDims stamp', embeddingDims: undefined },
  ])(
    '$label leaves the already-up-to-date fast path intact',
    async ({ embeddingDims }) => {
      const { repo, home, storagePath } = await seedIndexedRepo(
        'gitnexus-embedding-dims-keep-',
        embeddingDims,
      );
      const savedHome = process.env.GITNEXUS_HOME;
      process.env.GITNEXUS_HOME = home.dbPath;
      try {
        const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
        const result = await runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {} },
        );
        expect(result.alreadyUpToDate).toBe(true);
        // The fast path does not rebuild, so it must not invent a stamp either:
        // the seeded value is exactly what remains on disk.
        expect((await loadMeta(storagePath))?.embeddingDims).toBe(embeddingDims);
      } finally {
        if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
        else process.env.GITNEXUS_HOME = savedHome;
        await home.cleanup();
        await repo.cleanup();
      }
    },
    300_000,
  );

  it('a differing embeddingDims stamp forces a full rebuild that restamps the live width', async () => {
    // The exact hazard: same commit, clean tree, current schema fingerprint —
    // every other condition for the fast path holds, so only this guard can
    // stop the run returning over a table whose vector column is the wrong
    // width. `EMBEDDING_DIMS * 2` mirrors the real 384 -> 768 model switch.
    const stale = EMBEDDING_DIMS * 2;
    const { repo, home, storagePath } = await seedIndexedRepo(
      'gitnexus-embedding-dims-force-',
      stale,
    );
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home.dbPath;
    const logs: string[] = [];
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );
      // Pipeline actually ran (embeddingDims mismatch -> force=true), the
      // notice names both widths, and the rebuild stamped the live one.
      expect(result.alreadyUpToDate).toBeUndefined();
      expect(logs.join('\n')).toContain(
        `embedding dimensions changed (index built with FLOAT[${stale}], this run embeds at ${EMBEDDING_DIMS})`,
      );
      expect((await loadMeta(storagePath))?.embeddingDims).toBe(EMBEDDING_DIMS);
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await home.cleanup();
      await repo.cleanup();
    }
  }, 300_000);
});
