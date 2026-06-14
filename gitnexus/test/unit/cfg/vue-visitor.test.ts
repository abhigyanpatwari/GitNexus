import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import TypeScript from 'tree-sitter-typescript';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { makeCfgHarness, block, edgeKinds, reaches } from '../../helpers/cfg-harness.js';
import { extractVueScript } from '../../../src/core/ingestion/vue-sfc-extractor.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';

// #2195 capstone — Vue reuses the TypeScript CfgVisitor (vue.ts wires
// `createTypeScriptCfgVisitor()`). This unit test replicates the worker's Vue
// path WITHOUT the worker: the SFC <script> block is extracted by
// `extractVueScript`, then parsed with the TypeScript grammar and fed through
// the Vue provider's `cfgVisitor` — exactly the worker's Vue→TypeScript grammar
// mapping. Proving the visitor reuse here means the worker-mode pipeline test
// (pipeline-pdg.test.ts) is exercising the same builder end-to-end.

const vueVisitor = getProvider(SupportedLanguages.Vue).cfgVisitor;
if (!vueVisitor) throw new Error('Vue provider has no cfgVisitor');

// The worker maps SupportedLanguages.Vue → TypeScript.typescript (parse-worker
// languageMap); mirror that grammar here so the harness parses the same way.
const harness = makeCfgHarness(TypeScript.typescript, vueVisitor, 'C.vue');

/** Extract the SFC script content the way the worker does, then CFG it. */
function cfgsOfSfc(sfc: string): FunctionCfg[] {
  const extraction = extractVueScript(sfc);
  if (!extraction) throw new Error('extractVueScript returned null');
  return harness.cfgsOf(extraction.scriptContent);
}

const FIXTURE = path.join(__dirname, '../../integration/cfg/fixtures/vue-hazards.vue');

describe('Vue CfgVisitor reuse — SFC <script> → TypeScript CFG', () => {
  it('extracts the <script setup> block and builds one CFG per script function', () => {
    const sfc = fs.readFileSync(FIXTURE, 'utf8');
    const extraction = extractVueScript(sfc);
    expect(extraction).not.toBeNull();
    // `lang="ts"` ⇒ TypeScript grammar wins (the worker's mapping).
    expect(extraction?.lang).toBe('');
    expect(extraction?.isSetup).toBe(true);

    const cfgs = cfgsOfSfc(sfc);
    // classify, eventLoop, onClick, plus the small helpers — many CFG-bearing fns.
    expect(cfgs.length).toBeGreaterThanOrEqual(1);
    for (const cfg of cfgs) {
      expect(cfg.blocks[cfg.entryIndex].kind).toBe('entry');
      expect(cfg.blocks[cfg.exitIndex].kind).toBe('exit');
    }
  });

  it('if/else-if/else in the script produces a branching CFG (cond-true + cond-false)', () => {
    const cfgs = cfgsOfSfc(fs.readFileSync(FIXTURE, 'utf8'));
    // Locate the `classify` function's CFG by its distinctive arm text.
    const classify = cfgs.find((c) => c.blocks.some((b) => b.text.includes('positive()')));
    expect(classify).toBeDefined();
    if (!classify) return;
    const kinds = edgeKinds(classify);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    // each arm rejoins and reaches EXIT
    for (const arm of ['positive()', 'negative()', 'zero()']) {
      expect(reaches(classify, classify.entryIndex, block(classify, arm))).toBe(true);
      expect(reaches(classify, block(classify, arm), classify.exitIndex)).toBe(true);
    }
  });

  it('a `while (true)` script keeps EXIT reverse-reachable and yields CDG > 0', () => {
    // The smallest reproduction of the silent-zero hazard, through the SFC path.
    const sfc = `
<script setup lang="ts">
function loopForever(x: number): number {
  let sum = 0;
  while (true) {
    if (shouldStop(x)) {
      return sum;
    }
    sum = sum + x;
  }
}
</script>
`;
    const cfgs = cfgsOfSfc(sfc);
    const loop = cfgs.find((c) => c.blocks.some((b) => b.text.includes('sum = sum + x')));
    expect(loop).toBeDefined();
    if (!loop) return;

    // The non-terminating loop has a back-edge but EXIT must still be reachable
    // from EVERY block (the structural escape edge feeds the post-dom pass).
    expect(edgeKinds(loop).has('loop-back')).toBe(true);
    expect(isExitReachableFromAllBlocks(loop)).toBe(true);

    // Control dependence is computable and non-empty — the worker's CDG pass
    // would emit > 0 edges for this function (matches the pipeline assertion).
    const cd = computeControlDependence(loop);
    expect(cd.edges.length).toBeGreaterThan(0);
    for (const e of cd.edges) {
      expect(['T', 'F']).toContain(e.label);
    }
  });
});
