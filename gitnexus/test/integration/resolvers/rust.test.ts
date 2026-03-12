/**
 * Rust: trait implementations + ambiguous module import disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: trait implementations
// ---------------------------------------------------------------------------

describe('Rust trait implementation resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-traits'),
      () => {},
    );
  }, 60000);

  it('detects exactly 1 struct and 2 traits', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Button']);
    expect(getNodesByLabel(result, 'Trait')).toEqual(['Clickable', 'Drawable']);
  });

  it('emits exactly 2 IMPLEMENTS edges with reason trait-impl', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(2);
    expect(edgeSet(implements_)).toEqual([
      'Button → Clickable',
      'Button → Drawable',
    ]);
    for (const edge of implements_) {
      expect(edge.rel.reason).toBe('trait-impl');
    }
  });

  it('does not emit any EXTENDS edges for trait impls', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(0);
  });

  it('resolves exactly 1 IMPORTS edge: main.rs → button.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('main.rs');
    expect(imports[0].target).toBe('button.rs');
  });

  it('detects 2 modules and 4 functions', () => {
    expect(getNodesByLabel(result, 'Module')).toEqual(['impls', 'traits']);
    expect(getNodesByLabel(result, 'Function')).toEqual(['draw', 'is_enabled', 'main', 'on_click', 'resize']);
  });

  it('no OVERRIDES edges target Property nodes', () => {
    const overrides = getRelationships(result, 'OVERRIDES');
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.label).not.toBe('Property');
    }
  });
});

// ---------------------------------------------------------------------------
// Ambiguous: Handler struct in two modules, crate:: import disambiguates
// ---------------------------------------------------------------------------

describe('Rust ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler structs in separate modules', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    const handlers = structs.filter(s => s.startsWith('Handler@'));
    expect(handlers.length).toBe(2);
    expect(handlers.some(h => h.includes('src/models/'))).toBe(true);
    expect(handlers.some(h => h.includes('src/other/'))).toBe(true);
  });

  it('import resolves to src/models/mod.rs (not src/other/mod.rs)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const modelsImport = imports.find(e => e.targetFilePath.includes('models'));
    expect(modelsImport).toBeDefined();
    expect(modelsImport!.targetFilePath).toBe('src/models/mod.rs');
  });

  it('no import edge to src/other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    for (const imp of imports) {
      expect(imp.targetFilePath).not.toMatch(/src\/other\//);
    }
  });
});

describe('Rust call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-calls'),
      () => {},
    );
  }, 60000);

  it('resolves main → write_audit to src/onearg/mod.rs via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('main');
    expect(calls[0].target).toBe('write_audit');
    expect(calls[0].targetFilePath).toBe('src/onearg/mod.rs');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Rust member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves process_user → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process_user');
    expect(saveCall!.targetFilePath).toBe('src/user.rs');
  });

  it('detects User struct and save function (Rust impl fns are Function nodes)', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    // Rust tree-sitter captures all function_item as Function, including impl methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Struct literal resolution: User { ... } resolves to Struct node
// ---------------------------------------------------------------------------

describe('Rust struct literal resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-struct-literals'),
      () => {},
    );
  }, 60000);

  it('resolves User { ... } as a CALLS edge to the User struct', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('process_user');
    expect(ctorCall!.targetLabel).toBe('Struct');
    expect(ctorCall!.targetFilePath).toBe('user.rs');
    expect(ctorCall!.rel.reason).toBe('import-resolved');
  });

  it('also resolves user.save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process_user');
  });

  it('detects User struct and process_user function', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('process_user');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('Rust receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with save functions', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    // Rust tree-sitter captures impl fns as Function nodes
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'src/user.rs');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'src/repo.rs');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
    expect(repoSave!.source).toBe('process_entities');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: use crate::models::User as U resolves U → User
// ---------------------------------------------------------------------------

describe('Rust alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with their methods', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('persist');
  });

  it('resolves u.save() to src/models.rs and r.persist() to src/models.rs via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    const persistCall = calls.find(c => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('src/models.rs');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('src/models.rs');
  });

  it('emits exactly 1 IMPORTS edge: src/main.rs → src/models.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].sourceFilePath).toBe('src/main.rs');
    expect(imports[0].targetFilePath).toBe('src/models.rs');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Re-export chain: pub use in mod.rs followed through to definition file
// ---------------------------------------------------------------------------

describe('Rust re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-reexport-chain'),
      () => {},
    );
  }, 60000);

  it('detects Handler struct in handler.rs', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    expect(structs).toContain('Handler@src/models/handler.rs');
  });

  it('resolves Handler { ... } to src/models/handler.rs via re-export chain, not mod.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'Handler');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('main');
    expect(ctorCall!.targetLabel).toBe('Struct');
    expect(ctorCall!.targetFilePath).toBe('src/models/handler.rs');
  });

  it('resolves h.process() to src/models/handler.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find(c => c.target === 'process');
    expect(processCall).toBeDefined();
    expect(processCall!.source).toBe('main');
    expect(processCall!.targetFilePath).toBe('src/models/handler.rs');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('Rust local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/main.rs');
  });

  it('does NOT resolve save to utils.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/utils.rs');
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Grouped imports: use crate::helpers::{func_a, func_b}
// Verifies no spurious binding for the path prefix (e.g. "helpers")
// ---------------------------------------------------------------------------

describe('Rust grouped import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-grouped-imports'),
      () => {},
    );
  }, 60000);

  it('resolves main → format_name to src/helpers/mod.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const call = calls.find(c => c.target === 'format_name');
    expect(call).toBeDefined();
    expect(call!.source).toBe('main');
    expect(call!.targetFilePath).toBe('src/helpers/mod.rs');
    expect(call!.rel.reason).toBe('import-resolved');
  });

  it('resolves main → validate_email to src/helpers/mod.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const call = calls.find(c => c.target === 'validate_email');
    expect(call).toBeDefined();
    expect(call!.source).toBe('main');
    expect(call!.targetFilePath).toBe('src/helpers/mod.rs');
    expect(call!.rel.reason).toBe('import-resolved');
  });

  it('does not create a spurious CALLS edge for the path prefix "helpers"', () => {
    const calls = getRelationships(result, 'CALLS');
    const spurious = calls.find(c => c.target === 'helpers' || c.source === 'helpers');
    expect(spurious).toBeUndefined();
  });

  it('emits exactly 1 IMPORTS edge: main.rs → helpers/mod.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('main.rs');
    expect(imports[0].target).toBe('mod.rs');
    expect(imports[0].targetFilePath).toBe('src/helpers/mod.rs');
  });
});
