/**
 * Regression guard for #87 — "duplicate Interface nodes at import sites".
 *
 * Bug claim: importing a TypeScript interface in another file produced
 * duplicate Interface graph nodes (one from the defining file, one from
 * the importing file). If the bug ever resurfaces, this test fails.
 *
 * Strategy: run the full ingestion pipeline on a temp repo with two
 * .ts files — foo.ts defines `interface Foo {}`, bar.ts imports it.
 * Assert there is exactly one Interface node named `Foo` (whose
 * filePath is foo.ts, the definition site).
 *
 * If the bug is present, there will be 2+ Interface nodes named `Foo`
 * and this test will fail.
 */
// Regression guard for #87 — bugs are already resolved by previous merges. This test pins the current behavior.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runPipelineFromRepo, type PipelineResult } from '../../src/core/ingestion/pipeline.js';
import { FIXTURES } from '../integration/resolvers/helpers.js';

describe('TypeScript interface dedup at import sites (#87)', () => {
  let tmpDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-iface-dedup-'));
    fs.writeFileSync(
      path.join(tmpDir, 'foo.ts'),
      `export interface Foo {\n  name: string;\n}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'bar.ts'),
      `import type { Foo } from './foo';\nexport const usesFoo = (f: Foo): string => f.name;\n`,
    );

    result = await runPipelineFromRepo(tmpDir, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits exactly one Interface node named Foo across the two-file repo', () => {
    const fooInterfaces: Array<{ name: string; filePath?: string; startLine?: number }> = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Interface' && n.properties.name === 'Foo') {
        fooInterfaces.push({
          name: n.properties.name,
          filePath: n.properties.filePath,
          startLine: n.properties.startLine,
        });
      }
    });
    expect(fooInterfaces).toHaveLength(1);
  });

  it('the Foo Interface node is associated with the definition file (foo.ts)', () => {
    let filePath: string | undefined;
    result.graph.forEachNode(n => {
      if (n.label === 'Interface' && n.properties.name === 'Foo') {
        filePath = n.properties.filePath;
      }
    });
    expect(filePath).toBeDefined();
    expect(filePath!).toMatch(/foo\.ts$/);
  });

  it('the IMPORTS edge bar → foo is present (sanity: the import was processed)', () => {
    let hasImport = false;
    result.graph.forEachRelationship(rel => {
      if (rel.type !== 'IMPORTS') return;
      const src = result.graph.getNode(rel.sourceId);
      const tgt = result.graph.getNode(rel.targetId);
      if (src?.properties.filePath?.endsWith('bar.ts') && tgt?.properties.filePath?.endsWith('foo.ts')) {
        hasImport = true;
      }
    });
    expect(hasImport).toBe(true);
  });

  // Sanity: also test against the existing typescript-ambiguous fixture,
  // which defines ILogger once and imports it from multiple files.
  it('typescript-ambiguous fixture has exactly one ILogger Interface node', async () => {
    const ambResult = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-ambiguous'),
      () => {},
      { skipGraphPhases: true },
    );
    let count = 0;
    ambResult.graph.forEachNode(n => {
      if (n.label === 'Interface' && n.properties.name === 'ILogger') count++;
    });
    expect(count).toBe(1);
  }, 60000);
});
