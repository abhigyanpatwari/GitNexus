import { describe, it, expect } from 'vitest';
import { mergeAnalyzeOptions } from '../../../src/cli/analyze-config.js';
import { computeChunkHash } from '../../../src/storage/parse-cache.js';

// U5 — the `--pdg` opt-in plumbing (R7). The flag has TWO sinks downstream of
// PipelineOptions.pdg: the parse worker (CFG build, gated on workerData.pdg)
// and scope-resolution (BasicBlock/CFG emit, gated on the run input). These
// tests pin the observable plumbing: the CLI/.gitnexusrc merge, and that the
// flag perturbs the parse-cache/worker-dispatch key so a pdg run never reuses
// a pdg-off shard. The full worker-build + main-emit round-trip is exercised
// end-to-end by the U7 runPipelineFromRepo({ pdg: true }) integration test.

describe('U5 — --pdg merges from CLI and .gitnexusrc', () => {
  it('a CLI --pdg flag flows into the merged options', () => {
    expect(mergeAnalyzeOptions({ pdg: true }, undefined).pdg).toBe(true);
  });

  it('a .gitnexusrc pdg value flows through when the CLI omits it', () => {
    expect(mergeAnalyzeOptions({}, { pdg: true }).pdg).toBe(true);
  });

  it('the CLI flag wins over the file config', () => {
    expect(mergeAnalyzeOptions({ pdg: true }, { pdg: false }).pdg).toBe(true);
  });

  it('absent everywhere ⇒ pdg is undefined (default off)', () => {
    expect(mergeAnalyzeOptions({}, undefined).pdg).toBeUndefined();
  });
});

describe('U5 — pdg perturbs the parse-cache / worker-dispatch key', () => {
  // The chunk hash is what decides whether a chunk is re-dispatched to the
  // workers (and thus whether the worker builds a CFG). Folding pdg in is the
  // mechanism that makes the worker sink honor the flag across warm caches.
  it('a pdg run computes a different chunk key than a pdg-off run', () => {
    const entries = [{ filePath: 'a.ts', contentHash: 'h1' }];
    expect(computeChunkHash(entries, true)).not.toBe(computeChunkHash(entries, false));
  });
});
