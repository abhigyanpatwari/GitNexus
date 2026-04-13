/**
 * Phase 14: Cross-file type binding propagation
 *
 * When file A exports `const user = getUser()` (resolved to type User), and
 * file B imports `user`, Phase 14 seeds `user → User` into file B's type
 * environment, enabling `user.save()` in file B to produce a CALLS edge to
 * User#save.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

const CROSS_FILE_FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'cross-file-binding');

// ---------------------------------------------------------------------------
// Simple cross-file: models → service → app
// models.ts exports getUser(): User
// service.ts exports const user = getUser()   (user → User via call-result)
// app.ts imports user from service → seeds user → User → resolves user.save()
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript simple cross-file', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'ts-simple'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser function and main function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Function')).toContain('main');
  });

  it('resolves user.save() in main() to User#save via cross-file binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.getName() in main() to User#getName via cross-file binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'getName' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and getName to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'getName');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });

  it('emits IMPORTS edges across all three files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // service.ts → models.ts and app.ts → service.ts
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const paths = imports.map((e) => `${e.sourceFilePath} → ${e.targetFilePath}`);
    expect(paths.some((p) => p.includes('service') && p.includes('models'))).toBe(true);
    expect(paths.some((p) => p.includes('app') && p.includes('service'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: core → index (barrel) → app
// core.ts exports getConfig(): Config
// index.ts re-exports getConfig from core (no new bindings)
// app.ts imports getConfig from index, creates local const config = getConfig()
// → config.validate() resolves to Config#validate via local call-result binding
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript re-export chain', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'ts-reexport'), () => {});
  }, 60000);

  it('detects Config class with validate method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Config');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('detects getConfig function and init function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getConfig');
    expect(getNodesByLabel(result, 'Function')).toContain('init');
  });

  it('resolves config.validate() in init() to Config#validate', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.source === 'init' && c.targetFilePath.includes('core'),
    );
    expect(validateCall).toBeDefined();
  });

  it('emits HAS_METHOD edge from Config to validate', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'Config' && e.target === 'validate');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// E3: Cross-file return type propagation
// api.ts exports getConfig(): Config
// consumer.ts imports getConfig, calls const c = getConfig(); c.validate()
// → c is typed Config via importedReturnTypes (E3), enabling Config#validate edge
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript E3 return type propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'ts-return-type'), () => {});
  }, 60000);

  it('detects Config class with validate method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Config');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('detects getConfig function and run function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getConfig');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('resolves c.validate() in run() to Config#validate via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.source === 'run' && c.targetFilePath.includes('api'),
    );
    expect(validateCall).toBeDefined();
  });

  it('emits HAS_METHOD edge from Config to validate', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'Config' && e.target === 'validate');
    expect(edge).toBeDefined();
  });

  it('emits IMPORTS edge from consumer to api', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('consumer') && e.targetFilePath.includes('api'),
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Circular imports: a.ts ↔ b.ts
// a.ts imports getB from b.ts; b.ts imports A from a.ts
// Conservative expectation: pipeline completes without error.
// Cross-file binding propagation across cycles is not guaranteed.
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript circular imports', () => {
  let result: PipelineResult;
  let pipelineError: unknown;

  beforeAll(async () => {
    try {
      result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'ts-circular'), () => {});
    } catch (err) {
      pipelineError = err;
    }
  }, 60000);

  it('pipeline completes without throwing on circular imports', () => {
    expect(pipelineError).toBeUndefined();
  });

  it('detects both class A and class B', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('A');
    expect(getNodesByLabel(result, 'Class')).toContain('B');
  });

  it('detects doA and doB methods', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('doA');
    expect(getNodesByLabel(result, 'Method')).toContain('doB');
  });

  it('detects processA and getB functions', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('processA');
    expect(getNodesByLabel(result, 'Function')).toContain('getB');
  });

  it('emits IMPORTS edges reflecting the circular dependency', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const paths = imports.map((e) => `${e.sourceFilePath} → ${e.targetFilePath}`);
    // a.ts imports from b.ts
    expect(paths.some((p) => p.includes('a.ts') && p.includes('b.ts'))).toBe(true);
    // b.ts imports from a.ts
    expect(paths.some((p) => p.includes('b.ts') && p.includes('a.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SM-15 / Phase 9: Cross-file call-result variable binding — multi-language
//
// Each suite below loads a multi-file fixture where:
//   - File A defines a factory function getUser() / get_user() → User
//   - File B imports that function, calls `u = getUser()`, then calls u.save()
//
// The acceptance criteria: u.save() / u.save() / u.get_name() must resolve
// to the correct User method via cross-file call-result variable binding.
// These tests cover both the SymbolTable path (languages with explicit return
// type annotations) and validate that the Phase 9 BindingAccumulator wiring
// does not break existing behavior.
// ---------------------------------------------------------------------------

describe('Phase 9 — Cross-File Call-Result Binding: Java', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'java-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser factory and run method', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('getUser');
    expect(getNodesByLabel(result, 'Method')).toContain('run');
  });

  it('resolves user.save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.getName() in run() to User#getName via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'getName' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(getNameCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: Python', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'py-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    // Python tree-sitter captures all function_definitions as Function, including methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('get_name');
  });

  it('detects get_user function and run function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('resolves u.save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves u.get_name() in run() to User#get_name via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'get_name' && c.source === 'run' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: Go', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'go-cross-file'), () => {});
  }, 60000);

  it('detects User struct with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Method')).toContain('GetName');
  });

  it('detects GetUser function and main function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('GetUser');
    expect(getNodesByLabel(result, 'Function')).toContain('main');
  });

  it('resolves user.Save() in main() to User#Save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: Kotlin', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'kotlin-cross-file'),
      () => {},
    );
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser function and run method', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Method')).toContain('run');
  });

  it('resolves u.save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: Rust', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'rs-cross-file'), () => {});
  }, 60000);

  it('detects User struct with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    // Rust tree-sitter captures impl fns as Function nodes
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('get_name');
  });

  it('detects get_user function and process function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('process');
  });

  it('resolves u.save() in process() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── R5: Missing language coverage (PR #763 review finding #5) ────────────

describe('Phase 9 — Cross-File Call-Result Binding: JavaScript', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'js-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser factory and run function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('resolves u.save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: C++', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'cpp-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('get_name');
  });

  it('detects get_user factory function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
  });

  it('resolves user.save() in process() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Cross-File Call Resolution: pure C transitive #include', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'c-cross-file'), () => {});
  }, 60000);

  it('detects dictFind and dictFetchValue functions', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('dictFind');
    expect(getNodesByLabel(result, 'Function')).toContain('dictFetchValue');
  });

  it('detects lookupKey and dbGet in db.c', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('lookupKey');
    expect(getNodesByLabel(result, 'Function')).toContain('dbGet');
  });

  it('resolves dictFind() call in db.c to dict via transitive header chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossFileCall = calls.find(
      (c) =>
        c.target === 'dictFind' && c.source === 'lookupKey' && c.targetFilePath.includes('dict'),
    );
    expect(crossFileCall).toBeDefined();
  });

  it('resolves dictFetchValue() call in db.c to dict via transitive header chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossFileCall = calls.find(
      (c) =>
        c.target === 'dictFetchValue' && c.source === 'dbGet' && c.targetFilePath.includes('dict'),
    );
    expect(crossFileCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: C#', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'csharp-cross-file'),
      () => {},
    );
  }, 60000);

  it('detects User class with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Method')).toContain('GetName');
  });

  it('detects GetUser factory and Run method', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('GetUser');
    expect(getNodesByLabel(result, 'Method')).toContain('Run');
  });

  it('resolves u.Save() in Run() to User#Save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: PHP', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'php-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser factory function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('resolves $u->save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Phase 9 — Cross-File Call-Result Binding: Ruby', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'rb-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('get_name');
  });

  it('detects get_user factory method', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('get_user');
  });

  it('resolves user.save in process() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Note: shadowed import tier gating is tested at the unit level
// (call-processor.test.ts "Phase 9 tier gating" tests) because the scenario
// requires invalid TypeScript (same name imported and locally defined).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression: consumer file processed before provider in sequential path
// a-consumer.ts (alphabetically first) imports getUser from b-provider.ts.
// Without the two-pass flush fix, the accumulator wouldn't have b-provider's
// bindings when a-consumer's verifyConstructorBindings runs.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Consumer-before-provider regression tests (sequential ordering fix)
//
// Each language fixture has a consumer file that sorts alphabetically before
// the provider file. In the sequential path, the consumer is processed first.
// The two-pass flush ensures the accumulator has provider bindings before
// verifyConstructorBindings runs for the consumer.
// ---------------------------------------------------------------------------

describe('Consumer-Before-Provider: TypeScript', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'ts-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method from provider', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves x.save() to User#save despite consumer sorted before provider', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('b-provider'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: JavaScript', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'js-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves u.save() in main() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('b-provider'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Python', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'py-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    // Python tree-sitter captures all function_definitions as Function, including methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves u.save() in main() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('b_provider'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Java', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'java-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() in run() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Go', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'go-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User struct and Save method', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });

  it('resolves user.Save() in main() to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'main');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: C++', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'cpp-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() in process() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: C#', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'csharp-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });

  it('resolves u.Save() in Run() to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'Run');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Kotlin', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'kotlin-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves u.save() in run() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: PHP', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'php-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves $u->save() in run() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Ruby', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'rb-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save in process() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Rust', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'rs-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User struct and save function', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    // Rust tree-sitter captures impl fns as Function nodes
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves u.save() in process() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });
});
