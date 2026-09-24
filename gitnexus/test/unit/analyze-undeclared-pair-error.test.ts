/**
 * Tests for the undeclared FROM→TO label-pair failure path in the
 * `analyzeCommand` CLI (#2789).
 *
 * `assertDeclaredPair` aborts the run when an extracted edge's endpoint-label
 * pair is missing from GitNexus's own relation DDL — deliberately, because the
 * alternative is a late `COPY` failure that silently drops edges. Before this
 * branch existed the user got `Analysis failed` plus a stack trace through
 * GitNexus internals: no file, no relationship, and an implicit "try again"
 * that can never work. The CLI must instead name the pair, the relationship
 * type and the offending file, and point at an issue report.
 *
 * The CLI does NOT compose that text: it prints `err.message` indented (the
 * `LbugWipeError` idiom in the same catch block), because the message is
 * self-contained — `gitnexus serve` forwards only `err.message` over worker
 * IPC, so anything rendered here instead would be invisible to serve users.
 * The needles below are therefore the SAME strings
 * `test/unit/rel-pair-routing.test.ts` pins on the message itself.
 *
 * Mirrors analyze-http-endpoint-error.test.ts:
 *   - vi.mock the heavy dependencies so no real DB / git is touched
 *   - drive `analyzeCommand` with a mocked `runFullAnalysis` that rejects
 *   - assert on process.exitCode and the captured logger records
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
  LbugWipeError: class LbugWipeError extends Error {},
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

// analyze.ts imports isHfDownloadFailure from hf-env.js — mock it to break the
// transitive gitnexus-shared chain (same reason as the sibling suite).
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: vi.fn(() => false),
}));

const PAIR_ERROR_ARGS = [
  'Method|Annotation',
  'ANNOTATED_BY',
  'Method:src/main/java/app/BeanConfig.java:BeanConfig.dataSource#42',
  'Annotation:src/main/java/app/BeanConfig.java:ConditionalOnMissingBean',
] as const;

describe('analyzeCommand undeclared relation-pair handling (#2789)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('renders an actionable schema-gap message naming the pair, relationship, ids and file', async () => {
    const { UndeclaredRelationPairError } = await import('../../src/core/lbug/rel-pair-routing.js');
    runFullAnalysisMock.mockRejectedValue(new UndeclaredRelationPairError(...PAIR_ERROR_ARGS));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const record = cap.records().find((r) => r.recoveryHint === 'undeclared-relation-pair');
    cap.restore();

    expect(record).toMatchObject({
      recoveryHint: 'undeclared-relation-pair',
      labelPair: 'Method|Annotation',
      relationType: 'ANNOTATED_BY',
      sourceFile: 'src/main/java/app/BeanConfig.java',
    });
    // The CLI renders `err.message` indented (the `LbugWipeError` idiom) rather
    // than re-formatting the structured fields, so these needles are the ONE
    // wording — `test/unit/rel-pair-routing.test.ts` pins the same strings on
    // the message itself and a reword updates one place, not two.
    // Filter-to-empty, not an array of booleans: the failure output NAMES the
    // missing string instead of making you count positions.
    const text = typeof record?.msg === 'string' ? record.msg : '';
    const required = [
      'Method → Annotation',
      'ANNOTATED_BY',
      'src/main/java/app/BeanConfig.java',
      'Method:src/main/java/app/BeanConfig.java:BeanConfig.dataSource#42',
      'Annotation:src/main/java/app/BeanConfig.java:ConditionalOnMissingBean',
      // Names it as a GitNexus gap, tells the user a re-run is pointless, and
      // points at both actionable next steps.
      "gap in GitNexus's own relation schema",
      're-running the analysis will fail',
      'https://github.com/abhigyanpatwari/GitNexus/issues/new',
      '.gitnexusignore',
    ];
    expect(required.filter((needle) => !text.includes(needle))).toEqual([]);
  });

  it('still fires when the ingestion phase runner has rewrapped it as a cause', async () => {
    // The guard throws inside an emit phase, and the phase runner rewraps every
    // phase failure as `new Error("Phase 'X' failed: …", { cause })` — a bare
    // instanceof check at the CLI boundary would miss it entirely.
    const { UndeclaredRelationPairError } = await import('../../src/core/lbug/rel-pair-routing.js');
    const original = new UndeclaredRelationPairError(...PAIR_ERROR_ARGS);
    // The wrapper deliberately does NOT interpolate the cause's message: the
    // branch must render `undeclaredPair.message`, i.e. the message of the link
    // it FOUND in the chain, not the outer wrapper's message.
    runFullAnalysisMock.mockRejectedValue(
      new Error(`Phase 'graph-emit' failed`, { cause: original }),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    cap.restore();

    const record = records.find((r) => r.recoveryHint === 'undeclared-relation-pair');
    expect(record).toMatchObject({ labelPair: 'Method|Annotation' });
    const text = typeof record?.msg === 'string' ? record.msg : '';
    expect(
      ['Method → Annotation', '.gitnexusignore'].filter((needle) => !text.includes(needle)),
    ).toEqual([]);
    // The generic large-repo / module-not-found guidance must not also appear.
    expect(records.some((r) => r.recoveryHint === 'large-repo')).toBe(false);
    expect(records.some((r) => r.recoveryHint === 'module-not-found')).toBe(false);
  });

  it('does not claim an unrelated failure', async () => {
    runFullAnalysisMock.mockRejectedValue(new Error('LadybugDB write failed'));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    cap.restore();
    expect(records.some((r) => r.recoveryHint === 'undeclared-relation-pair')).toBe(false);
  });
});
