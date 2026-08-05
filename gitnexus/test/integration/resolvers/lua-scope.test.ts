/**
 * Lua scope-resolution integration tests.
 *
 * Validates the cross-file member-call contract: `local X = require("mod")`
 * binds X as a namespace receiver so `X.foo()` resolves to `foo` in the
 * target file via collectNamespaceTargets (Case 1 of receiver-bound-calls).
 *
 * Mirrors `ruby-scope.test.ts` (require_relative) and the cross-file-binding
 * standard: a 2-file fixture indexed via runPipelineFromRepo with CALLS /
 * IMPORTS edge assertions at the graph level, not just registration/ABI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// require("lib.util") + member call util.answer() across files
// ---------------------------------------------------------------------------

describe('Lua scope: require + cross-file member call', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-imports-'));
    writeFixtureRepo(tmpDir, {
      'lib/util.lua': `local M = {}
function M.answer()
  return 42
end
return M
`,
      'main.lua': `local util = require("lib.util")
local function run()
  return util.answer()
end
run()
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits IMPORTS edge from main.lua to lib/util.lua', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(
      (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
    );
    expect(imp).toBeDefined();
  });

  it('resolves run -> util.answer() as CALLS edge to util.lua', () => {
    const calls = getRelationships(result, 'CALLS');
    const answerCall = calls.find(
      (c) => c.target === 'answer' && c.source === 'run' && c.targetFilePath?.includes('util.lua'),
    );
    expect(answerCall).toBeDefined();
  });

  it('detects answer as a Method node and run as a Function node', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('answer');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });
});
