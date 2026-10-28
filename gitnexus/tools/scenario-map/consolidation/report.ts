import type { CoverageWorkFile } from '../path-coverage/run-coverage.js';
import type { Layer2Test } from '../scenario-map.js';
import type { FixtureProfile } from '../facet/fixture-profile.js';
import type { AssertionEvidence } from './assertions.js';
import { FixtureCloneIndex, type FixtureOverlap } from './fixture-clones.js';
import { sha1, sortedUnique } from '../util.js';

export interface Overlap {
  shared: number;
  totalA: number;
  totalB: number;
  coverageA: number;
  coverageB: number;
  jaccard: number;
}
export interface ConsolidationGroup {
  id: string;
  tests: string[];
  fixture: FixtureProfile;
  blocks: number[];
  assertions: AssertionEvidence;
  limitations: string[];
}
export interface ConsolidationOpportunity {
  a: string;
  b: string;
  representedPairs: number;
  kind:
    | 'same-observed-input-path-assertions'
    | 'parameterize-expectations'
    | 'parameterize-fixtures'
    | 'share-language-scenario'
    | 'extract-shared-scenario';
  fixture: FixtureOverlap;
  path: Overlap;
  assertions: Overlap;
  assertionShapes: Overlap;
  sharedAssertions: string[];
  onlyAssertionsA: string[];
  onlyAssertionsB: string[];
  onlyBlocksA: string[];
  onlyBlocksB: string[];
  sharedBlocks: string[];
  limitations: string[];
}
export interface ConsolidationReport {
  version: 1;
  thresholds: {
    fixtureContainment: number;
    pathContainment: number;
    assertionContainment: number;
    assertionShapeContainment: number;
  };
  tool: {
    name: string;
    version: string;
    sources: number;
    fragments: number;
    capturedFiles?: number;
    scannedFiles?: number;
    formats?: string[];
    verifiedPairs?: number;
  };
  summary: {
    inventoryTests: number;
    eligibleTests: number;
    groups: number;
    comparisons: number;
    opportunities: number;
    representedPairs: number;
    excluded: Record<string, number>;
  };
  groups: ConsolidationGroup[];
  opportunities: ConsolidationOpportunity[];
}

/** Multiset intersection: repeated assertions count, while callers pass distinct coverage blocks. */
export function overlap(a: readonly (string | number)[], b: readonly (string | number)[]): Overlap {
  const counts = new Map<string | number, number>();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of a) {
    const n = counts.get(item) ?? 0;
    if (n) {
      shared++;
      counts.set(item, n - 1);
    }
  }
  return {
    shared,
    totalA: a.length,
    totalB: b.length,
    coverageA: a.length ? shared / a.length : 0,
    coverageB: b.length ? shared / b.length : 0,
    jaccard: a.length + b.length - shared ? shared / (a.length + b.length - shared) : 0,
  };
}

const containment = (metric: Pick<Overlap, 'coverageA' | 'coverageB'>): number =>
  Math.max(metric.coverageA, metric.coverageB);
const equal = (metric: Overlap): boolean =>
  metric.shared > 0 && metric.coverageA === 1 && metric.coverageB === 1;

/** Conjunctive retrieval: fixture, executed blocks, and assertions must each support the lead. */
export function consolidationReport(
  work: CoverageWorkFile,
  layer2: readonly Layer2Test[],
  clones: FixtureCloneIndex,
  considerFixturePair?: (a: FixtureProfile, b: FixtureProfile) => void,
): ConsolidationReport {
  const thresholds = {
    fixtureContainment: 0.5,
    pathContainment: 0.5,
    assertionContainment: 0.25,
    assertionShapeContainment: 0.8,
  };
  const details = new Map(layer2.map((test) => [test.id, test]));
  const grouped = new Map<string, ConsolidationGroup>();
  const excluded: Record<string, number> = {};
  const reject = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  for (const test of work.tests) {
    const detail = details.get(test.id),
      fixture = detail?.fixture,
      assertions = detail?.assertionEvidence;
    if (test.state !== 'passed') {
      reject('not-passing');
      continue;
    }
    if (test.concurrent || !test.provenance.known) {
      reject('unattributable-execution');
      continue;
    }
    if (!fixture?.files.length) {
      reject('no-fixture-evidence');
      continue;
    }
    if (fixture.unresolved.length) {
      reject('incomplete-fixture');
      continue;
    }
    if (!assertions?.atoms.length) {
      reject('no-assertion-evidence');
      continue;
    }
    if (!assertions.atoms.some((atom) => atom.key !== null)) {
      reject('no-static-expectation');
      continue;
    }
    const blocks = [...new Set(test.blocks)]
      .filter((id) => work.blocks[id] !== undefined && !work.blocks[id].endsWith(':0'))
      .sort((a, b) => a - b);
    if (!blocks.length) {
      reject('no-executed-production-blocks');
      continue;
    }
    const limitations = sortedUnique([
      ...assertions.unresolved,
      ...(detail?.facet?.unresolved ?? []),
      ...(detail?.joinProblems ?? []),
      ...(detail?.inventoryUnresolved ?? []),
      ...((fixture.sourceKeys ?? []).length === 0 ? ['captured fixture sources unavailable'] : []),
      ...(test.provenance.nativeEntries.length
        ? ['native execution is not represented by JavaScript blocks']
        : []),
      ...(test.provenance.workerSpawns.length
        ? ['worker execution is not represented by parent JavaScript blocks']
        : []),
      ...(test.provenance.excludedCandidates.length
        ? ['some executed files are outside the coverage scope']
        : []),
    ]);
    const signature = sha1(
      JSON.stringify([
        fixture.sourceKeys,
        fixture.contentKey,
        fixture.features,
        blocks,
        assertions.atoms.map((a) => [a.shapeKey, a.key]),
        limitations,
      ]),
    );
    const group = grouped.get(signature);
    if (group) group.tests.push(test.id);
    else
      grouped.set(signature, {
        id: `c${signature}`,
        tests: [test.id],
        fixture,
        blocks,
        assertions,
        limitations,
      });
  }
  const groups = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
  const postings = new Map<string, number[]>();
  const opportunities: ConsolidationOpportunity[] = [];
  const fixtureCache = new Map<string, FixtureOverlap | null>();
  let comparisons = 0;
  const compare = (a: ConsolidationGroup, b: ConsolidationGroup, representedPairs: number) => {
    comparisons++;
    const shapesA = a.assertions.atoms.map((atom) => atom.shapeKey),
      shapesB = b.assertions.atoms.map((atom) => atom.shapeKey);
    const assertionShapes = overlap(shapesA, shapesB);
    const keysA = a.assertions.atoms.flatMap((atom) => (atom.key === null ? [] : [atom.key])),
      keysB = b.assertions.atoms.flatMap((atom) => (atom.key === null ? [] : [atom.key]));
    // Unknown atoms stay in the denominator and can never match one another.
    const assertions = overlap(
      a.assertions.atoms.map((atom, i) => atom.key ?? `unknown-a:${i}`),
      b.assertions.atoms.map((atom, i) => atom.key ?? `unknown-b:${i}`),
    );
    const parameterRows =
      keysA.length === a.assertions.atoms.length && keysB.length === b.assertions.atoms.length;
    if (assertions.shared === 0 && !parameterRows) return;
    if (
      containment(assertions) < thresholds.assertionContainment &&
      containment(assertionShapes) < thresholds.assertionShapeContainment
    )
      return;
    const path = overlap(a.blocks, b.blocks);
    if (containment(path) < thresholds.pathContainment || path.shared === 0) return;
    considerFixturePair?.(a.fixture, b.fixture);
    const fixtureKey = JSON.stringify([
      a.fixture.sourceKeys,
      a.fixture.contentKey,
      a.fixture.features,
      a.fixture.languages,
      b.fixture.sourceKeys,
      b.fixture.contentKey,
      b.fixture.features,
      b.fixture.languages,
    ]);
    if (!fixtureCache.has(fixtureKey))
      fixtureCache.set(fixtureKey, clones.compare(a.fixture, b.fixture));
    const fixture = fixtureCache.get(fixtureKey);
    if (!fixture || containment(fixture) < thresholds.fixtureContainment) return;
    const limitations = sortedUnique([
      ...a.limitations,
      ...b.limitations,
      ...(fixture.kind === 'cross-language-structure'
        ? [
            'structural similarity depends on parser/provider output; it does not prove semantic equivalence',
          ]
        : []),
    ]);
    let kind: ConsolidationOpportunity['kind'];
    if (fixture.kind === 'cross-language-structure' || fixture.crossLanguage)
      kind = 'share-language-scenario';
    else if (
      fixture.kind === 'content' &&
      equal(path) &&
      equal(assertions) &&
      limitations.length === 0
    )
      kind = 'same-observed-input-path-assertions';
    else if (
      assertions.shared === 0 &&
      containment(assertionShapes) >= thresholds.assertionShapeContainment
    )
      kind = 'parameterize-expectations';
    else if (
      fixture.kind === 'clone' &&
      Math.min(fixture.coverageA, fixture.coverageB) >= 0.8 &&
      equal(assertions)
    )
      kind = 'parameterize-fixtures';
    else kind = 'extract-shared-scenario';
    const labels = (group: ConsolidationGroup, other: string[], shared: boolean): string[] => {
      const counts = new Map<string, number>();
      for (const key of other) counts.set(key, (counts.get(key) ?? 0) + 1);
      return group.assertions.atoms
        .filter((atom) => {
          const n = atom.key === null ? 0 : (counts.get(atom.key) ?? 0);
          if (n && atom.key !== null) counts.set(atom.key, n - 1);
          return n > 0 === shared;
        })
        .map(
          (atom) =>
            `${atom.line}: ${atom.shape} subject=${atom.observed ?? 'unresolved'} expected=${atom.expected ?? 'unknown'}`,
        );
    };
    const ba = new Set(a.blocks),
      bb = new Set(b.blocks);
    opportunities.push({
      a: a.id,
      b: b.id,
      representedPairs,
      kind,
      fixture,
      path,
      assertions,
      assertionShapes,
      sharedAssertions: labels(a, keysB, true),
      onlyAssertionsA: labels(a, keysB, false),
      onlyAssertionsB: labels(b, keysA, false),
      sharedBlocks: a.blocks
        .filter((id) => bb.has(id))
        .slice(0, 20)
        .map((id) => work.blocks[id]),
      onlyBlocksA: a.blocks
        .filter((id) => !bb.has(id))
        .slice(0, 20)
        .map((id) => work.blocks[id]),
      onlyBlocksB: b.blocks
        .filter((id) => !ba.has(id))
        .slice(0, 20)
        .map((id) => work.blocks[id]),
      limitations,
    });
  };
  groups.forEach((group, index) => {
    group.tests.sort();
    if (group.tests.length > 1)
      compare(group, group, (group.tests.length * (group.tests.length - 1)) / 2);
    const keys = sortedUnique(group.assertions.atoms.map((atom) => atom.shapeKey));
    const other = new Set<number>();
    for (const key of keys) for (const previous of postings.get(key) ?? []) other.add(previous);
    for (const previous of other)
      compare(groups[previous], group, groups[previous].tests.length * group.tests.length);
    for (const key of keys) {
      const bucket = postings.get(key) ?? [];
      bucket.push(index);
      postings.set(key, bucket);
    }
  });
  opportunities.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      b.representedPairs - a.representedPairs ||
      a.a.localeCompare(b.a) ||
      a.b.localeCompare(b.b),
  );
  return {
    version: 1,
    thresholds,
    tool: {
      name: clones.run.tool,
      version: clones.run.version,
      sources: clones.run.sourceCount,
      fragments: clones.run.clones.length,
      capturedFiles: clones.run.capturedFiles,
      scannedFiles: clones.run.scannedFiles,
      formats: clones.run.formats,
      verifiedPairs: clones.run.verifiedPairs,
    },
    summary: {
      inventoryTests: work.tests.length,
      eligibleTests: groups.reduce((n, g) => n + g.tests.length, 0),
      groups: groups.length,
      comparisons,
      opportunities: opportunities.length,
      representedPairs: opportunities.reduce((n, o) => n + o.representedPairs, 0),
      excluded,
    },
    groups,
    opportunities,
  };
}

export function renderConsolidationReport(report: ConsolidationReport): string {
  const data = JSON.stringify({
    ...report,
    groups: report.groups.map(({ id, tests }) => ({ id, tests })),
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Test consolidation opportunities</title><style>body{font:16px/1.5 system-ui;margin:36px;color:#173042}input,select{font:inherit;padding:8px}article{border:1px solid #bbcbd5;border-radius:8px;padding:18px;margin:16px 0}pre{white-space:pre-wrap;font-size:12px}small{color:#526777}.metrics{font-weight:600}summary{cursor:pointer}</style><h1>Test consolidation opportunities</h1><p>Each lead compares fixture inputs, executed JavaScript blocks, and assertions. Partial matches retain the unique checks and paths listed below. Cross-language suggestions preserve each language's coverage. Observed equality describes this captured execution, not a proof for all future inputs.</p><p id="summary"></p><details><summary>Inventory coverage and exclusions</summary><pre id="coverage"></pre></details><input id="query" placeholder="Filter test, language, or opportunity"><select id="kind"><option value="">All kinds</option></select><main id="results"></main><script>const report=${data};document.getElementById('coverage').textContent=JSON.stringify({inventory:report.summary,fixtureEngine:report.tool},null,2);const groups=new Map(report.groups.map(g=>[g.id,g]));const kinds=[...new Set(report.opportunities.map(o=>o.kind))];const select=document.getElementById('kind');for(const k of kinds){const o=document.createElement('option');o.value=k;o.textContent=k;select.append(o);}function add(parent,tag,text){const el=document.createElement(tag);el.textContent=text;parent.append(el);return el;}function render(){const q=document.getElementById('query').value.toLowerCase();const found=report.opportunities.filter(o=>(!select.value||o.kind===select.value)&&JSON.stringify([o,groups.get(o.a).tests,groups.get(o.b).tests]).toLowerCase().includes(q));const root=document.getElementById('results');root.replaceChildren();document.getElementById('summary').textContent=report.summary.inventoryTests+' inventory cases; '+report.summary.eligibleTests+' eligible cases; '+found.length+' opportunity groups shown by this filter. First 200 rendered; all evidence is in consolidation.json. Fixture engine: '+report.tool.name+' '+report.tool.version;for(const o of found.slice(0,200)){const box=add(root,'article','');add(box,'h2',o.kind+' · '+o.representedPairs+' test pairs');add(box,'p',groups.get(o.a).tests.join(' | ')+' ↔ '+groups.get(o.b).tests.join(' | '));add(box,'p',(o.fixture.kind==='cross-language-structure'?'Fixture structure similarity ':'Fixture byte overlap ')+(100*o.fixture.coverageA).toFixed(1)+'% / '+(100*o.fixture.coverageB).toFixed(1)+'%; path overlap '+(100*o.path.coverageA).toFixed(1)+'% / '+(100*o.path.coverageB).toFixed(1)+'%; exact assertions '+o.assertions.shared+' shared ('+o.assertions.totalA+' / '+o.assertions.totalB+').');const details=add(box,'details','');add(details,'summary','Shared and unique evidence to preserve');add(details,'pre',JSON.stringify({sharedAssertions:o.sharedAssertions,uniqueAssertionsA:o.onlyAssertionsA,uniqueAssertionsB:o.onlyAssertionsB,sharedPathSamples:o.sharedBlocks,uniquePathSamplesA:o.onlyBlocksA,uniquePathSamplesB:o.onlyBlocksB,fixtureFragments:o.fixture.matches,unmatchedFixtureSpansA:o.fixture.unmatchedA,unmatchedFixtureSpansB:o.fixture.unmatchedB,limitations:o.limitations},null,2));}}document.getElementById('query').addEventListener('input',render);select.addEventListener('change',render);render();</script></html>`;
}
