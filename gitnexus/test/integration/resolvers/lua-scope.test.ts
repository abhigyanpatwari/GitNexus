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
import { emitLuaScopeCaptures } from '../../../src/core/ingestion/languages/lua/index.js';
import { collectLuaCaptureSideChannel } from '../../../src/core/ingestion/languages/lua/capture-side-channel.js';

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
    const utilImports = imports.filter(
      (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
    );
    expect(utilImports).toHaveLength(1);
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

describe('Lua scope: bare require import', () => {
  it('emits one IMPORTS edge for an unbound side-effect require', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-bare-import-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'main.lua': 'require("lib.util")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter(
        (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
      );
      expect(imports).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// middleclass: class("Name", Parent) → EXTENDS + HAS_METHOD across files
// ---------------------------------------------------------------------------

describe('Lua scope: middleclass EXTENDS + HAS_METHOD', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-'));
    writeFixtureRepo(tmpDir, {
      'base.lua': `local class = require("lib.class")
local Animal = class("Animal")
function Animal:speak()
  return "..."
end
return Animal
`,
      'dog.lua': `local class = require("lib.class")
local Animal = require("base")
local Dog = class("Dog", Animal)
function Dog:bark()
  return "woof"
end
return Dog
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits EXTENDS from Dog to Animal across files', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtendsAnimal = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtendsAnimal).toBeDefined();
  });

  it('emits HAS_METHOD from each class to its methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    expect(hasMethod.find((e) => e.source === 'Animal' && e.target === 'speak')).toBeDefined();
    expect(hasMethod.find((e) => e.source === 'Dog' && e.target === 'bark')).toBeDefined();
  });

  it('detects Dog and Animal as Class nodes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Dog');
    expect(classes).toContain('Animal');
  });
});

// ---------------------------------------------------------------------------
// middleclass heritage: duplicate class names must follow imports or decline
// ---------------------------------------------------------------------------

describe('Lua scope: middleclass heritage name collisions', () => {
  it('resolves an imported duplicate parent to the imported file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-collision-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/a.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'lib/b.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local class = require("lib.class")
local Animal = require("lib.a")
local Dog = class("Dog", Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const dogExtendsAnimal = getRelationships(result, 'EXTENDS').find(
        (edge) => edge.source === 'Dog' && edge.target === 'Animal',
      );
      expect(dogExtendsAnimal).toBeDefined();
      expect(dogExtendsAnimal?.targetFilePath).toContain(path.join('lib', 'a.lua'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not guess when duplicate parents are not disambiguated by imports', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-ambiguous-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/a.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'lib/b.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local class = require("lib.class")
local Dog = class("Dog", Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'EXTENDS').some(
          (edge) => edge.source === 'Dog' && edge.target === 'Animal',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// heritage lifecycle: re-capture with no middleclass must not retain stale
// EXTENDS / HAS_METHOD facts from a prior pass (reanalysis regression)
// ---------------------------------------------------------------------------

describe('Lua scope: heritage lifecycle (no stale facts on reanalysis)', () => {
  // The capture side channel is a module-level map populated by
  // `emitLuaScopeCaptures` (worker) and snapshotted by
  // `collectLuaCaptureSideChannel`. Calling both here in the test process
  // exercises the same module instance, so a re-capture that produces no
  // heritage must drop the prior facts — otherwise reanalysis of a file that
  // lost its middleclass class would emit stale EXTENDS / HAS_METHOD edges.
  const heritageSrc = `local class = require("lib.class")
local Animal = class("Animal")
function Animal:speak() return "..." end
local Dog = class("Dog", Animal)
function Dog:bark() return "woof" end
return Dog
`;
  const noHeritageSrc = `local x = 1
return x
`;

  it('populates facts on a middleclass capture', () => {
    emitLuaScopeCaptures(heritageSrc, 'lifecycle.lua');
    const facts = collectLuaCaptureSideChannel('lifecycle.lua');
    expect(facts).toBeDefined();
    expect(facts?.extendsPairs.length).toBeGreaterThan(0);
    expect(facts?.methodOwners.length).toBeGreaterThan(0);
  });

  it('clears facts on a subsequent no-heritage capture (no stale state)', () => {
    // First capture establishes heritage facts for the file.
    emitLuaScopeCaptures(heritageSrc, 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')).toBeDefined();
    // Re-capture with no middleclass — the prior facts must be dropped, not
    // retained for collectLuaCaptureSideChannel to snapshot as stale edges.
    emitLuaScopeCaptures(noHeritageSrc, 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')).toBeUndefined();
  });
});
