/**
 * Solidity language resolution — MVP coverage for inheritance, imports, calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

let solidityAvailable = isLanguageAvailable(SupportedLanguages.Solidity);
if (solidityAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Solidity);
  } catch {
    solidityAvailable = false;
  }
}

describe.skipIf(!solidityAvailable)('Solidity child extends parent', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'solidity-child-extends-parent'),
      () => {},
    );
  }, 60000);

  it('detects contracts and interface', () => {
    const classes = getNodesByLabel(result, 'Class');
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(classes).toEqual(expect.arrayContaining(['Parent', 'Child', 'App']));
    expect(interfaces).toContain('IParent');
  });

  it('emits EXTENDS Child → Parent and Parent IMPLEMENTS IParent', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');

    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toContain('Parent → IParent');
  });

  it('creates IMPORTS edges for relative .sol imports', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const childImportsParent = imports.filter(
      (e) =>
        e.sourceFilePath.includes('Child.sol') && e.targetFilePath.includes('Parent.sol'),
    );
    expect(childImportsParent.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves c.parentMethod() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'parentMethod' && c.sourceFilePath.includes('App.sol'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('run');
  });

  it('emits METHOD_OVERRIDES Child → Parent.parentMethod', () => {
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
    const edge = overrides.find(
      (o) =>
        o.source === 'Child' &&
        o.target === 'parentMethod' &&
        o.targetFilePath.includes('Parent.sol'),
    );
    expect(edge).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity library calls', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-calls'), () => {});
  }, 60000);

  it('detects Caller contract and MathLib library', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toEqual(expect.arrayContaining(['Caller', 'MathLib']));
  });

  it('resolves MathLib.add call from Caller.run', () => {
    const calls = getRelationships(result, 'CALLS');
    const addCall = calls.find(
      (c) =>
        c.target === 'add' &&
        c.source === 'run' &&
        c.sourceFilePath.includes('Caller.sol') &&
        c.targetFilePath.includes('MathLib.sol'),
    );
    expect(addCall).toBeDefined();
  });

  it('creates IMPORTS edge Caller → MathLib', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.filter(
      (e) =>
        e.sourceFilePath.includes('Caller.sol') && e.targetFilePath.includes('MathLib.sol'),
    );
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!solidityAvailable)('Solidity named brace imports', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-named-imports'), () => {});
  }, 60000);

  it('imports MathLib and Helper (as H) from Lib.sol', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.filter(
      (e) =>
        e.sourceFilePath.includes('Caller.sol') && e.targetFilePath.includes('Lib.sol'),
    );
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves MathLib.add and H.ping via named/aliased bindings', () => {
    const calls = getRelationships(result, 'CALLS');
    const addCall = calls.find(
      (c) =>
        c.target === 'add' &&
        c.source === 'run' &&
        c.sourceFilePath.includes('Caller.sol') &&
        c.targetFilePath.includes('Lib.sol'),
    );
    const pingCall = calls.find(
      (c) =>
        c.target === 'ping' &&
        c.source === 'run' &&
        c.sourceFilePath.includes('Caller.sol') &&
        c.targetFilePath.includes('Lib.sol'),
    );
    expect(addCall).toBeDefined();
    expect(pingCall).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity modifier invocations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-modifiers'), () => {});
  }, 60000);

  it('indexes Guarded contract and onlyOwner / onlyRole modifiers', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Guarded');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toEqual(expect.arrayContaining(['onlyOwner', 'onlyRole', 'setOwner', 'privileged']));
  });

  it('emits CALLS from setOwner → onlyOwner', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'setOwner' &&
        c.target === 'onlyOwner' &&
        c.sourceFilePath.includes('Guarded.sol'),
    );
    expect(edge).toBeDefined();
  });

  it('emits CALLS from privileged → onlyOwner and onlyRole', () => {
    const calls = getRelationships(result, 'CALLS');
    const toOwner = calls.find(
      (c) => c.source === 'privileged' && c.target === 'onlyOwner',
    );
    const toRole = calls.find(
      (c) => c.source === 'privileged' && c.target === 'onlyRole',
    );
    expect(toOwner).toBeDefined();
    expect(toRole).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity inherited modifier invocations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-modifier-inherits'), () => {});
  }, 60000);

  it('emits CALLS from Child.setOwner → Base.onlyOwner via inheritance MRO', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'setOwner' &&
        c.target === 'onlyOwner' &&
        c.sourceFilePath.includes('Child.sol') &&
        c.targetFilePath.includes('Base.sol'),
    );
    expect(edge).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity using-for library attachment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-using-for'), () => {});
  }, 60000);

  it('resolves x.add(2) → MathLib.add via using MathLib for uint256', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'run' &&
        c.target === 'add' &&
        c.sourceFilePath.includes('Caller.sol') &&
        c.targetFilePath.includes('MathLib.sol'),
    );
    expect(edge).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity emit / revert', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-emit-revert'), () => {});
  }, 60000);

  it('indexes Transfer event and Unauthorized error', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toEqual(expect.arrayContaining(['EventsAndErrors', 'Transfer', 'Unauthorized']));
  });

  it('emits CALLS pay → Transfer and deny → Unauthorized', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(
      calls.find((c) => c.source === 'pay' && c.target === 'Transfer'),
    ).toBeDefined();
    expect(
      calls.find((c) => c.source === 'deny' && c.target === 'Unauthorized'),
    ).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity foundry remappings', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-remappings'), () => {});
  }, 60000);

  it('resolves import forge-std/Helper.sol via remappings.txt', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.filter(
      (e) =>
        e.sourceFilePath.includes('App.sol') && e.targetFilePath.includes('Helper.sol'),
    );
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves Helper.ping call across remapped import', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'run' &&
        c.target === 'ping' &&
        c.sourceFilePath.includes('App.sol') &&
        c.targetFilePath.includes('Helper.sol'),
    );
    expect(edge).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity this / super member calls (Phase 3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-this-super'), () => {});
  }, 60000);

  it('emits EXTENDS Child → Base', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Base');
  });

  it('resolves this.localPing() → Child.localPing', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'viaThis' &&
        c.target === 'localPing' &&
        c.sourceFilePath.includes('Child.sol') &&
        c.targetFilePath.includes('Child.sol'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves super.basePing() → Base.basePing (inheritance dispatch)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'viaSuper' &&
        c.target === 'basePing' &&
        c.sourceFilePath.includes('Child.sol') &&
        c.targetFilePath.includes('Base.sol'),
    );
    expect(edge).toBeDefined();
  });
});

describe.skipIf(!solidityAvailable)('Solidity Foundry receiver noise filter (Phase 3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'solidity-foundry-noise'), () => {});
  }, 60000);

  it('does not emit CALLS to prank from vm.prank', () => {
    const calls = getRelationships(result, 'CALLS');
    const prank = calls.find(
      (c) => c.source === 'setUp' && c.target === 'prank' && c.sourceFilePath.includes('FoundryNoise.sol'),
    );
    expect(prank).toBeUndefined();
  });

  it('does not emit CALLS to require (built-in free call)', () => {
    const calls = getRelationships(result, 'CALLS');
    const req = calls.find(
      (c) => c.source === 'setUp' && c.target === 'require' && c.sourceFilePath.includes('FoundryNoise.sol'),
    );
    expect(req).toBeUndefined();
  });
});
