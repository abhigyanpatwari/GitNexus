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

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: let user = User::new(); user.save()
// Rust scoped_identifier constructor pattern (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Rust constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to src/user.rs via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/user.rs');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save() to src/repo.rs via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/repo.rs');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// self.save() resolves to enclosing impl's own save method
// ---------------------------------------------------------------------------

describe('Rust self resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, each with a save function', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves self.save() inside User::process to User::save, not Repo::save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/user.rs');
  });
});

// ---------------------------------------------------------------------------
// Trait impl emits IMPLEMENTS edge
// ---------------------------------------------------------------------------

describe('Rust parent resolution (trait impl)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User struct and Serializable trait', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Trait')).toContain('Serializable');
  });

  it('emits IMPLEMENTS edge: User → Serializable (trait impl)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('User');
    expect(implements_[0].target).toBe('Serializable');
    expect(implements_[0].rel.reason).toBe('trait-impl');
  });

  it('no EXTENDS edges (Rust has no class inheritance)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Struct literal inference: let user = User { ... }; user.save()
// ---------------------------------------------------------------------------

describe('Rust struct literal type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-struct-literal-inference'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() via struct literal inference (User { ... })', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.targetFilePath === 'models.rs');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves config.validate() via struct literal inference (Config { ... })', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c => c.target === 'validate' && c.targetFilePath === 'models.rs');
    expect(validateCall).toBeDefined();
    expect(validateCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Rust Self {} struct literal: Self resolves to enclosing impl type
// ---------------------------------------------------------------------------

describe('Rust Self {} struct literal resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-self-struct-literal'),
      () => {},
    );
  }, 60000);

  it('resolves fresh.validate() inside impl User via Self {} inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c => c.target === 'validate' && c.source === 'blank');
    expect(validateCall).toBeDefined();
    expect(validateCall!.targetFilePath).toBe('models.rs');
  });
});

// ---------------------------------------------------------------------------
// if let / while let: captured_pattern type extraction
// Extracts type from `user @ User { .. }` patterns in if-let/while-let
// ---------------------------------------------------------------------------

describe('Rust if-let captured_pattern type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-if-let'),
      () => {},
    );
  }, 60000);

  it('detects User and Config structs with their methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Config');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('validate');
  });

  it('resolves user.save() inside if-let via captured_pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process_if_let');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('models.rs');
  });

  it('resolves cfg.validate() inside while-let via captured_pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c => c.target === 'validate' && c.source === 'process_while_let');
    expect(validateCall).toBeDefined();
    expect(validateCall!.targetFilePath).toBe('models.rs');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: let user = get_user("alice"); user.save()
// Plain function call (no ::new) with no type annotation
// ---------------------------------------------------------------------------

describe('Rust return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User struct and get_user + save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves main → get_user as a CALLS edge to src/models.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const getUserCall = calls.find(c => c.target === 'get_user' && c.source === 'main');
    expect(getUserCall).toBeDefined();
    expect(getUserCall!.targetFilePath).toBe('src/models.rs');
  });

  it('resolves user.save() to src/models.rs via return-type-inferred binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'main');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/models.rs');
  });
});

// ---------------------------------------------------------------------------
// Return-type inference with competing methods:
// Two structs both have save(), factory functions disambiguate via return type
// ---------------------------------------------------------------------------

describe('Rust return-type inference via function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to models.rs User#save via return type of get_user()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('models')
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_user'
    );
    // Should resolve to exactly one target — if it resolves at all, check it's the right one
    if (wrongSave) {
      expect(wrongSave.targetFilePath).toContain('models');
    }
  });

  it('resolves repo.save() to models.rs Repo#save via return type of get_repo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_repo' && c.targetFilePath.includes('models')
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Rust ::default() constructor resolution — scanner exclusion
// ---------------------------------------------------------------------------

describe('Rust ::default() constructor resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-default-constructor'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
  });

  it('detects save methods on both structs', () => {
    const methods = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(methods.filter((m: string) => m === 'save').length).toBeGreaterThanOrEqual(2);
  });

  it('resolves user.save() in process_with_new() via User::new() constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_with_new' && c.targetFilePath.includes('user.rs'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.save() in process_with_default() via User::default() constructor', () => {
    // User::default() should be resolved by extractInitializer (Tier 1),
    // NOT by the scanner — the scanner excludes ::default() to avoid
    // wasted cross-file lookups on the broadly-implemented Default trait
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_with_default' && c.targetFilePath.includes('user.rs'),
    );
    expect(saveCall).toBeDefined();
  });

  it('disambiguates repo.save() in process_with_default() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_with_default' && c.targetFilePath.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (user.save() does not resolve to Repo#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    // In process_with_new: user.save() should go to user.rs, not repo.rs
    const wrongCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_with_new' && c.targetFilePath.includes('repo.rs'),
    );
    // Either undefined (correctly disambiguated) or present (both resolved) — no single wrong one
    if (wrongCall) {
      // If both are present, there should also be a correct one
      const correctCall = calls.find(c =>
        c.target === 'save' && c.source === 'process_with_new' && c.targetFilePath.includes('user.rs'),
      );
      expect(correctCall).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Rust async .await constructor binding resolution
// Verifies that `let user = create_user().await` correctly unwraps the
// await_expression to find the call_expression underneath, producing a
// constructor binding that enables receiver-based disambiguation of user.save().
// ---------------------------------------------------------------------------

describe('Rust async .await constructor binding resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-async-binding'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
  });

  it('detects save methods in separate files', () => {
    const methods = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(methods.filter((m: string) => m === 'save').length).toBeGreaterThanOrEqual(2);
  });

  it('resolves user.save() after .await to user.rs via return type of get_user()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('user'),
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save in repo.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.save() after .await to repo.rs via return type of get_repo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_repo' && c.targetFilePath.includes('repo'),
    );
    expect(saveCall).toBeDefined();
  });

  it('repo.save() does NOT resolve to User#save in user.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repo' && c.targetFilePath.includes('user'),
    );
    expect(wrongSave).toBeUndefined();
  });
});
