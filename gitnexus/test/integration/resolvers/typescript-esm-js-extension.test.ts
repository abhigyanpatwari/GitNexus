/**
 * Integration test: TypeScript ESM .js extension imports produce CALLS edges.
 *
 * Verifies the full pipeline: .js import → resolveImportPath strips .js →
 * resolves to .ts → scope-resolver emits CALLS edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

describe('TypeScript ESM .js extension → CALLS edges', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-esm-js-ext-'));
    writeFixtureRepo(repoDir, {
      'src/utils.ts': `
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
`,
      'src/index.ts': `
import { estimateTokens } from './utils.js';

export function processText(text: string): number {
  return estimateTokens(text);
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('emits CALLS edge from processText → estimateTokens via .js import', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find((c) => c.source === 'processText' && c.target === 'estimateTokens');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('src/utils.ts');
  });

  it('emits IMPORTS edge from index.ts → utils.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath === 'src/index.ts' && e.targetFilePath === 'src/utils.ts',
    );
    expect(edge).toBeDefined();
  });
});
