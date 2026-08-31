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
import { SupportedLanguages, type BindingRef, type ScopeId } from 'gitnexus-shared';
import { emitLuaScopeCaptures } from '../../../src/core/ingestion/languages/lua/index.js';
import { collectLuaCaptureSideChannel } from '../../../src/core/ingestion/languages/lua/capture-side-channel.js';
import { luaScopeResolver } from '../../../src/core/ingestion/languages/lua/scope-resolver.js';
import { interpretLuaImport } from '../../../src/core/ingestion/languages/lua/interpret.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

describe('Lua scope resolver binding merge', () => {
  it('retains imported bindings when layering them onto existing bindings', () => {
    const local = {
      def: { nodeId: 'local', filePath: 'main.lua', type: 'Variable', qualifiedName: 'local' },
      origin: 'local',
    } satisfies BindingRef;
    const imported = {
      def: { nodeId: 'imported', filePath: 'lib.lua', type: 'Variable', qualifiedName: 'imported' },
      origin: 'import',
    } satisfies BindingRef;

    expect(luaScopeResolver.mergeBindings([local], [imported], 'scope:main' as ScopeId)).toEqual([
      local,
      imported,
    ]);
    expect(luaScopeResolver.language).toBe(SupportedLanguages.Lua);
  });
});

describe('Lua scope resolver import extensions', () => {
  it('prefers the Lua module when another language has the same module stem', () => {
    const files = new Set(['main.lua', 'foo.ts', 'foo.lua']);
    expect(luaScopeResolver.resolveImportTarget('foo', 'main.lua', files)).toBe('foo.lua');
  });

  it('does not bind an extensionless collision ahead of the Lua module', () => {
    const files = new Set(['main.lua', 'foo', 'foo.lua']);
    expect(luaScopeResolver.resolveImportTarget('foo', 'main.lua', files)).toBe('foo.lua');
  });

  it('unwraps quoted and long-bracket require sources', () => {
    const sources = ['"lib.util"', "'lib.util'", '[[lib.util]]', '[=[lib.util]=]'];
    for (const source of sources) {
      expect(
        interpretLuaImport({
          '@import.source': { text: source },
        } as never),
      ).toEqual({ kind: 'wildcard', targetRaw: 'lib.util' });
    }
  });
});

describe('Lua scope resolver arity compatibility', () => {
  it('accepts fixed arity and rejects impossible argument counts', () => {
    const def = {
      nodeId: 'fixed',
      filePath: 'x.lua',
      type: 'Function',
      qualifiedName: 'fixed',
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: [],
    } as const;
    expect(luaScopeResolver.arityCompatibility({ arity: 2 }, def)).toBe('compatible');
    expect(luaScopeResolver.arityCompatibility({ arity: 1 }, def)).toBe('incompatible');
    expect(luaScopeResolver.arityCompatibility({ arity: 3 }, def)).toBe('incompatible');
  });

  it('accepts extra arguments for a vararg definition', () => {
    const def = {
      nodeId: 'variadic',
      filePath: 'x.lua',
      type: 'Function',
      qualifiedName: 'variadic',
      requiredParameterCount: 1,
      parameterTypes: ['params'],
    } as const;
    expect(luaScopeResolver.arityCompatibility({ arity: 1 }, def)).toBe('compatible');
    expect(luaScopeResolver.arityCompatibility({ arity: 5 }, def)).toBe('compatible');
    expect(luaScopeResolver.arityCompatibility({ arity: 0 }, def)).toBe('incompatible');
  });
});

describe('Lua scope resolver require syntax and positional bindings', () => {
  it('pairs multi-assignment requires by position without cross-binding', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-multi-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'x.lua': 'return {}\n',
        'y.lua': 'return {}\n',
        'main.lua': 'local a, b = require("x"), require("y")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual(['x.lua', 'y.lua']);
      expect(imports).toHaveLength(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('recognizes parenthesis-free short and long-bracket requires', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-require-forms-'));
    try {
      writeFixtureRepo(tmpDir, {
        'short.lua': 'return {}\n',
        'long.lua': 'return {}\n',
        'main.lua': 'local short = require "short"\nrequire [[long]]\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual(['long.lua', 'short.lua']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('finds requires nested in local initializers without duplicating direct bindings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'direct.lua': 'return {}\n',
        'function.lua': 'return {}\n',
        'wrapped.lua': 'return {}\n',
        'main.lua': `local direct = require("direct")
local loader = function() require("function") end
local value = wrap(require("wrapped"))
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual([
        'direct.lua',
        'function.lua',
        'wrapped.lua',
      ]);
      expect(imports).toHaveLength(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

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

  it('resolves a local alias of a statically known callable value', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-callable-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': `local M = {}
function M.answer()
  return 42
end
return M
`,
        'main.lua': `local util = require("lib.util")
local answer = util.answer
answer()
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'CALLS').some(
          (edge) => edge.sourceFilePath?.endsWith('main.lua') && edge.target === 'answer',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
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

  it('resolves a long-bracket require source in the graph', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-long-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'main.lua': 'require([[lib.util]])\n',
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

  it('leaves computed module names unresolved', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-dynamic-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'main.lua': 'local name = "lib.util"\nrequire(name)\nrequire("lib." .. "util")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'IMPORTS').some((edge) =>
          edge.sourceFilePath?.endsWith('main.lua'),
        ),
      ).toBe(false);
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
      expect(dogExtendsAnimal?.targetFilePath?.replaceAll('\\', '/')).toContain('lib/a.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves an aliased imported parent to the returned class', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves an aliased parent when the imported module defines multiple classes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-multi-class-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
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

describe('Lua scope: middleclass method ownership boundaries', () => {
  it('captures assignment-form methods when the owner is a known class', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-assignment-method-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = class("Dog")
Dog.bark = function(self)
  return "woof"
end
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'Dog' && edge.target === 'bark',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not attach a nested function method to a middleclass owner', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-method-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = class("Dog")
local function factory()
  function Dog:helper()
    return true
  end
end
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'Dog' && edge.target === 'helper',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua scope: explicit table exports', () => {
  it('selects the imported parent from a named table export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-table-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
return { Animal = Animal, Cat = Cat }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not treat a nested function return as a module export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
local function make()
  return Animal
end
return { Cat = Cat }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
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

  it('does not fall back to the only class when a dotted export is missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-missing-table-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
return { Cat = Animal }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
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

describe('Lua scope: middleclass inherited dispatch', () => {
  it('resolves a call on a child class to an inherited parent method', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-mro-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
function Animal:speak()
  return "..."
end
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
Dog.speak()
return Dog
`,
        'main.lua': 'local Dog = require("dog")\n',
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'CALLS').some(
          (edge) => edge.sourceFilePath?.endsWith('dog.lua') && edge.target === 'speak',
        ),
      ).toBe(true);
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
