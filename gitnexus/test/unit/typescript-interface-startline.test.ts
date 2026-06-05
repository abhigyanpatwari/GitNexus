/**
 * Regression guard for #89 — "TypeScript Interface startLine=0 for
 * non-zero-line definitions".
 *
 * Bug claim: TypeScript interfaces defined on non-zero source lines
 * were recorded with startLine=0 (a default/zero fallback instead of
 * the actual tree-sitter row). If the bug ever resurfaces, this test
 * fails.
 *
 * Strategy: run the full ingestion pipeline on a temp repo with a
 * single .ts file whose interface starts on line 42 (1-based) — i.e.,
 * 41 leading blank lines. Assert:
 *   - the Interface node's startLine is NOT 0
 *   - the startLine matches the source line of the interface
 *     declaration (modulo the 0-based vs 1-based convention used
 *     by the codebase)
 *
 * Current convention (parse-worker.ts:2868) uses
 * `definitionNode.startPosition.row` which is 0-based, so the
 * expected value is 41 (row 42 in 1-based source). The test pins
 * the current behavior; if the codebase ever standardizes on
 * 1-based lines, this assertion will need updating.
 */
// Regression guard for #89 — bugs are already resolved by previous merges. This test pins the current behavior.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runPipelineFromRepo, type PipelineResult } from '../../src/core/ingestion/pipeline.js';

describe('TypeScript interface startLine reflects source line (#89)', () => {
  const TARGET_LINE_1BASED = 42; // interface keyword is on this 1-based source line
  const EXPECTED_ROW_0BASED = TARGET_LINE_1BASED - 1; // tree-sitter row is 0-based
  let tmpDir: string;
  let result: PipelineResult;
  let captured: { startLine: number | undefined; filePath: string | undefined };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-iface-line-'));
    // 41 leading newlines → the "interface Foo {}" declaration starts on line 42 (1-based)
    const src = `${'\n'.repeat(41)}export interface Foo {\n  name: string;\n}\n`;
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), src);

    result = await runPipelineFromRepo(tmpDir, () => {}, { skipGraphPhases: true });

    result.graph.forEachNode(n => {
      if (n.label === 'Interface' && n.properties.name === 'Foo') {
        captured = {
          startLine: n.properties.startLine,
          filePath: n.properties.filePath,
        };
      }
    });
  }, 60000);

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('captures the Interface node', () => {
    expect(captured).toBeDefined();
    expect(captured.filePath).toMatch(/foo\.ts$/);
  });

  it('Interface startLine is not 0 (the alleged bug)', () => {
    // The bug: definitionNode was null/missing, falling back to a 0 default.
    // For an interface on source line 42, startLine must be > 0.
    expect(captured.startLine).toBeDefined();
    expect(captured.startLine).not.toBe(0);
  });

  it('Interface startLine matches the source line of the declaration (0-based row)', () => {
    // parse-worker.ts:2868 sets startLine = definitionNode.startPosition.row
    // which is 0-based, so for line 42 (1-based) the value should be 41.
    expect(captured.startLine).toBe(EXPECTED_ROW_0BASED);
  });
});
