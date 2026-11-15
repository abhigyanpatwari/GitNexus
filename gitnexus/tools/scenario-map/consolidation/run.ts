import type { CoverageWorkFile } from '../path-coverage/run-coverage.js';
import type { Layer2Test } from '../scenario-map.js';
import {
  FixtureCloneCandidates,
  FixtureCloneIndex,
  runFixtureClones,
  verifyFixtureClonePairs,
} from './fixture-clones.js';
import { consolidationReport } from './report.js';
import path from 'node:path';

export async function runConsolidation(
  work: CoverageWorkFile,
  layer2: readonly Layer2Test[],
  outDir: string,
) {
  const sources = work.fixtureSources ?? {};
  const run = await runFixtureClones(sources, outDir);
  const candidates = new FixtureCloneCandidates(run);
  const initial = consolidationReport(work, layer2, new FixtureCloneIndex(sources, run), (a, b) =>
    candidates.consider(a, b),
  );
  const pairs = candidates.pairs();
  if (!pairs.length) return initial;
  const verified = await verifyFixtureClonePairs(sources, run, pairs, path.join(outDir, 'pairs'));
  return consolidationReport(work, layer2, new FixtureCloneIndex(sources, verified));
}
