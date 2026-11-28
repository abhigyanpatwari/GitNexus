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

describe('Phase 9 — Cross-File Call-Result Binding: Python', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'py-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toEqual(expect.arrayContaining(['save', 'get_name']));
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

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves u.save() in main() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath.includes('b_provider'),
    );
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
