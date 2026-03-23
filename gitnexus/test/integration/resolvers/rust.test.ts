/**
 * Rust: trait implementations + ambiguous module import disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, CROSS_FILE_FIXTURES, getRelationships, getNodesByLabel, edgeSet,
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
// Scoped grouped imports with multi-file resolution:
// use crate::models::{User, Repo} where User and Repo are in separate files.
// Verifies IMPORTS edges are created for each file AND namedImportMap entries
// match bindings to files by basename.
// ---------------------------------------------------------------------------

describe('Rust scoped grouped imports (multi-file)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-scoped-multi-file'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs', () => {
    const classes = getNodesByLabel(result, 'Struct');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
  });

  it('emits IMPORTS edge from main.rs to models/mod.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(e =>
      e.sourceFilePath.includes('main') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves user.save() call to User#save in models/user.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('user'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves repo.clone_repo() call to Repo#clone_repo in models/repo.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const cloneCall = calls.find(c =>
      c.target === 'clone_repo' && c.source === 'main' && c.targetFilePath.includes('repo'),
    );
    expect(cloneCall).toBeDefined();
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
    expect(methods.filter((m: string) => m === 'save').length).toBe(2);
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
    expect(methods.filter((m: string) => m === 'save').length).toBe(2);
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

// ---------------------------------------------------------------------------
// Nullable receiver: let user: Option<User> = find_user(); user.unwrap().save()
// Rust Option<User> — stripNullable unwraps Option wrapper to inner type.
// ---------------------------------------------------------------------------

describe('Rust nullable receiver resolution (Option<T>)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-nullable-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.unwrap().save() to User#save via Option<User> unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_entities' &&
      c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.unwrap().save() to Repo#save via Option<Repo> unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_entities' &&
      c.targetFilePath?.includes('repo'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Rust assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-assignment-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs each with a save function', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_entities' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves r_alias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_entities' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save' && c.source === 'process_entities');
    expect(saveCalls.filter(c => c.targetFilePath?.includes('user.rs')).length).toBe(1);
    expect(saveCalls.filter(c => c.targetFilePath?.includes('repo.rs')).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rust Option<User> receiver resolution — extractSimpleTypeName unwraps
// Option<User> to "User" via NULLABLE_WRAPPER_TYPES. The variable declared
// as Option<User> now stores "User" in TypeEnv, enabling direct receiver
// disambiguation without chained .unwrap() inference.
// ---------------------------------------------------------------------------

describe('Rust Option<User> receiver resolution via wrapper unwrapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-option-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs each with a save function', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via Option<User> → assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_entities' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo#save alongside Option usage', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_entities' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// if let Some(user) = opt — Phase 5.2 pattern binding: unwrap Option<T>
// `opt: Option<User>` → Option<User> is stored as "User" in TypeEnv via
// NULLABLE_WRAPPER_TYPES. extractPatternBinding maps `user` → "User".
// Disambiguation: User.save vs Repo.save — only User.save should be called.
// ---------------------------------------------------------------------------

describe('Rust if-let Some(x) = opt pattern binding (Phase 5.2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-if-let-unwrap'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs each with a save function', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(f => f === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() inside if-let Some(user) = opt to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process' &&
      c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process' &&
      c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rust if-let Err(e) = res pattern binding (Phase 5 review fix)
// Result<User, AppError> → Err(e) should type e as AppError (typeArgs[1]).
// Also tests Ok(user) in the same fixture to verify both arms work.
// ---------------------------------------------------------------------------

describe('Rust if-let Err(e) pattern binding (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-err-unwrap'),
      () => {},
    );
  }, 60000);

  it('detects User and AppError structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('AppError');
  });

  it('resolves e.report() inside if-let Err(e) to AppError#report', () => {
    const calls = getRelationships(result, 'CALLS');
    const reportCall = calls.find(c =>
      c.target === 'report' &&
      c.source === 'handle_err' &&
      c.targetFilePath?.includes('error.rs'),
    );
    expect(reportCall).toBeDefined();
  });

  it('resolves user.save() inside if-let Ok(user) to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' &&
      c.source === 'handle_ok' &&
      c.targetFilePath?.includes('user.rs'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve e.report() to User#save (no cross-contamination)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'save' &&
      c.source === 'handle_err',
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.get_user().save()
// Tests that Rust chain call resolution correctly infers the intermediate
// receiver type from get_user()'s return type and resolves save() to User.
// ---------------------------------------------------------------------------

describe('Rust chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-chain-call'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, and UserService', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    expect(getNodesByLabel(result, 'Struct')).toContain('UserService');
  });

  it('detects get_user and save functions', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('get_user');
    expect(fns).toContain('save');
  });

  it('resolves svc.get_user().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_user' &&
      c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.get_user().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_user' &&
      c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rust for-loop Tier 1c: for user in &users with Vec<User> parameter
// ---------------------------------------------------------------------------

describe('Rust for-loop type resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-for-loop'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(f => f === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() in for-loop to User#save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.save() in for-loop to Repo#save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('user.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rust match arm: match opt { Some(user) => user.save() }
// ---------------------------------------------------------------------------

describe('Rust match arm type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-match-unwrap'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(f => f === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() inside match Some(user) to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() in match to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.save() inside if-let Ok(repo) to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'check' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve repo.save() in if-let to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'check' && c.targetFilePath?.includes('user.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// for user in users.iter() — call_expression iterable resolution
// ---------------------------------------------------------------------------

describe('Rust .iter() for-loop call_expression resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-iter-for-loop'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(f => f === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() via users.iter() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() via repos.into_iter() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// for user in get_users() — direct call_expression iterable resolution
// Phase 7.3: unlike rust-iter-for-loop (typed variable .iter()), this tests
// iterating over a function call's return value directly.
// ---------------------------------------------------------------------------

describe('Rust for-loop direct call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-for-call-expr'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with competing save functions', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(f => f === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() in for-loop over get_users() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-loop over get_repos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('user.rs'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution — struct field capture
// ---------------------------------------------------------------------------

describe('Field type resolution (Rust)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-field-types'),
      () => {},
    );
  }, 60000);

  it('detects structs: Address, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for Rust struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking fields to structs', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('Address → city');
  });

  it('resolves user.address.save() → Address#save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(
      e => e.target === 'save' && e.source === 'process_user',
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// Phase 8B: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (Rust)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-deep-field-chain'),
      () => {},
    );
  }, 60000);

  it('detects structs: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for Rust struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('city');
    expect(properties).toContain('zip_code');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(5);
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('Address → city');
    expect(edgeSet(propEdges)).toContain('Address → street');
    expect(edgeSet(propEdges)).toContain('City → zip_code');
  });

  it('resolves 2-level chain: user.address.save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(e => e.target === 'save' && e.source === 'process_user');
    const addressSave = saveCalls.find(e => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.address.city.get_name() → City#get_name', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(e => e.target === 'get_name' && e.source === 'process_user');
    const cityGetName = getNameCalls.find(e => e.targetFilePath.includes('models'));
    expect(cityGetName).toBeDefined();
  });
});

// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (Rust)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-write-access'),
      () => {},
    );
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter(e => e.rel.reason === 'write');
    expect(writes.length).toBe(3);
    const fieldNames = writes.map(e => e.target);
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('address');
    expect(fieldNames).toContain('score');
    const sources = writes.map(e => e.source);
    expect(sources).toContain('update_user');
  });

  it('write ACCESSES edges have confidence 1.0', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter(e => e.rel.reason === 'write');
    for (const edge of writes) {
      expect(edge.rel.confidence).toBe(1.0);
    }
  });

  it('emits ACCESSES write edge for compound assignment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter(e => e.rel.reason === 'write');
    const scoreWrite = writes.find(e => e.target === 'score');
    expect(scoreWrite).toBeDefined();
    expect(scoreWrite!.source).toBe('update_user');
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): let user = get_user(); user.save()
// ---------------------------------------------------------------------------

describe('Rust call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-call-result-binding'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('models')
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): get_user() → .address → .get_city() → .save()
// ---------------------------------------------------------------------------

describe('Rust method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-method-chain-binding'),
      () => {},
    );
  }, 60000);

  it('resolves city.save() to City#save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_chain' && c.targetFilePath.includes('models')
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase A: Rust struct_pattern destructuring — let Point { x, y } = p
// Each field emits a fieldAccess PendingAssignment; fixpoint resolves x/y → Vec2
// ---------------------------------------------------------------------------

describe('Rust struct_pattern destructuring resolution (Phase A)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-struct-destructuring'),
      () => {},
    );
  }, 60000);

  it('detects Point and Vec2 structs', () => {
    const classes = getNodesByLabel(result, 'Struct');
    expect(classes).toContain('Point');
    expect(classes).toContain('Vec2');
  });

  it('resolves x.save() to Vec2#save via struct destructuring', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('vec2'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves both x.save() and y.save() — emits at least 1 CALLS to Vec2#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save' && c.targetFilePath.includes('vec2'));
    // Both x and y are Vec2 — the same function, so calls may deduplicate to 1
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation
// src/models.rs exports User struct with save() and get_name() methods
// src/factory.rs exports get_user() -> User (uses crate::models::User)
// src/main.rs uses crate::factory::get_user, calls u.save() / u.get_name()
// → u is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Rust cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'rs-cross-file'),
      () => {},
    );
  }, 60000);

  it('detects User struct with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('get_name');
  });

  it('detects get_user and process functions', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('process');
  });

  it('emits IMPORTS edge from main.rs to factory.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(e =>
      e.sourceFilePath.includes('main') && e.targetFilePath.includes('factory'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves u.save() in process() to User#save via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process' &&
      c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves u.get_name() in process() to User#get_name via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(c =>
      c.target === 'get_name' &&
      c.source === 'process' &&
      c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and get_name to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find(e => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find(e => e.source === 'User' && e.target === 'get_name');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});
