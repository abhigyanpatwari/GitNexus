/**
 * R: what a typed receiver (`u <- User$new(); u$m()`) reaches, and which receivers get no lookup.
 *
 * - A typed receiver reads the public interface of the instance, as `self` does: a private
 *   member of the class or of a parent is not on it (no edge, `member-lookup-ambiguous`, the
 *   shared pass's closest label for "member not found"), and a child's private member does not
 *   hide a parent's public one. A dotted member that the owner lookup does not find (`to.json`)
 *   is unresolved too, never a free function of that name.
 * - An active binding (`u$full()`) keeps its edge: R runs the active function on access.
 * - `u@save()` mints no site (`@` on an R6 instance errors in R).
 * - A generator object (`User$save()`, no `$new()`) never carries instance methods: no edge.
 * - A dotted class name (`My.Class`) gets no receiver lookup at all (`receiver-unresolved`), for
 *   `self` and for a typed local alike: own, inherited and missing methods lose their edge rather
 *   than reach a free function of the name (R-13).
 * - (limit) A dotted free call (`data.frame(x)`, `Stack.push(x)`) still reaches an R6 method whose
 *   qualified name matches, at 0.35: no R-only route refuses it.
 *
 * Fixture `r-typed-receiver-members/` (no DESCRIPTION): `R/free.R` and `R/classes.R` hold free
 * functions named like the members, the decoys.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

/** Every CALLS edge of the repository, by source node id: `targetId:reason:confidence`. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  'Function:R/use.R:p1': [],
  'Function:R/use.R:p2': [],
  'Function:R/use.R:p3': ['Method:R/models.R:Pub.shared#0:import-resolved:0.85'],
  'Function:R/use.R:a1': ['Method:R/models.R:User.full#1:import-resolved:0.85'],
  'Function:R/use.R:s1': [],
  'Function:R/use.R:g1': [],
  'Function:R/use.R:g2': [],
  'Function:R/use.R:f1': [],
  'Function:R/use.R:ctl': ['Method:R/models.R:User.save#0:import-resolved:0.85'],
  'Function:R/q19.R:q19': [],
  'Method:R/classes.R:My.Class.c_own#0': [],
  'Method:R/classes.R:My.Class.c_inh#0': [],
  'Method:R/classes.R:My.Class.c_missing#0': [],
  'Function:scripts/use.R:u5': [],
  'Function:scripts/use.R:u6': [],
  // (limit) no R-only route keeps a receiverless dotted call off a class member.
  'Function:scripts/use.R:u2': ['Method:R/classes.R:data.frame#0:scope-resolution: call:0.35'],
  'Function:scripts/use.R:u3': ['Method:R/classes.R:Stack.push#1:scope-resolution: call:0.35'],
};

/** Every suppressed site of the repository: `file:line:name:reason`. */
const SUPPRESSED: readonly string[] = [
  'R/use.R:4:secret:member-lookup-ambiguous',
  'R/use.R:9:secret:member-lookup-ambiguous',
  // A field called as a function: no method of that name, so the typed-receiver miss is recorded.
  'R/use.R:32:name:member-lookup-ambiguous',
  'R/q19.R:8:to.json:member-lookup-ambiguous',
  'R/classes.R:5:own:receiver-unresolved',
  'R/classes.R:6:inh:receiver-unresolved',
  'R/classes.R:7:nothere:receiver-unresolved',
  'scripts/use.R:2:new:receiver-unresolved',
  'scripts/use.R:3:inh:receiver-unresolved',
  'scripts/use.R:6:new:receiver-unresolved',
  'scripts/use.R:7:own:receiver-unresolved',
];

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-typed-receiver-members'), () => {});
}, 120000);

const callsFrom = (sourceId: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.rel.sourceId === sourceId)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

describe('R typed receivers: public members only, no generator or dotted-class lookup', () => {
  it.each(Object.entries(EXPECTED))('%s', (sourceId, expected) => {
    expect(callsFrom(sourceId)).toEqual([...expected].sort());
  });

  it('the table lists every CALLS edge of the repository', () => {
    const sources = [...new Set(getRelationships(result, 'CALLS').map((e) => e.rel.sourceId))];
    const withEdges = Object.entries(EXPECTED)
      .filter(([, targets]) => targets.length > 0)
      .map(([sourceId]) => sourceId);
    expect(sources.sort()).toEqual(withEdges.sort());
  });

  it('records the unresolved sites, and nothing for u@save() (no site)', () => {
    const suppressed = getResolutionOutcomes(result)
      .filter((o) => o.kind === 'suppressed')
      .map((o) => `${o.filePath}:${o.range.startLine}:${o.name}:${o.reason}`);
    expect(suppressed.sort()).toEqual([...SUPPRESSED].sort());
  });

  it('no CALLS edge reaches a free function used as a decoy', () => {
    const decoys = getRelationships(result, 'CALLS').filter(
      (e) => e.targetLabel === 'Function' && e.targetFilePath.startsWith('R/'),
    );
    expect(decoys.map((e) => `${e.rel.sourceId} -> ${e.rel.targetId}`)).toEqual([]);
  });
});
