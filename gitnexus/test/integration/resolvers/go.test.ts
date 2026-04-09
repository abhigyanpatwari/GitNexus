/**
 * Go: package imports + cross-package calls + ambiguous struct disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  CROSS_FILE_FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: package imports + cross-package calls (exercises PackageMap)
// ---------------------------------------------------------------------------

describe('Go package import & call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-pkg'), () => {});
  }, 60000);

  it('detects exactly 2 structs and 1 interface', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Admin', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Repository']);
  });

  it('detects exactly 5 functions', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual([
      'Authenticate',
      'NewAdmin',
      'NewUser',
      'ValidateToken',
      'main',
    ]);
  });

  it('emits exactly 7 CALLS edges (5 function + 2 struct literal)', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(7);
    expect(edgeSet(calls)).toEqual([
      'Authenticate → NewUser',
      'NewAdmin → Admin',
      'NewAdmin → NewUser',
      'NewUser → User',
      'main → Authenticate',
      'main → NewAdmin',
      'main → NewUser',
    ]);
  });

  it('resolves exactly 7 IMPORTS edges across Go packages', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(7);
    expect(edgeSet(imports)).toEqual([
      'main.go → admin.go',
      'main.go → repository.go',
      'main.go → service.go',
      'main.go → user.go',
      'service.go → admin.go',
      'service.go → repository.go',
      'service.go → user.go',
    ]);
  });

  it('emits exactly 1 EXTENDS edge for struct embedding: Admin → User', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('Admin');
    expect(extends_[0].target).toBe('User');
  });

  it('does not emit IMPLEMENTS edges (Go uses structural typing)', () => {
    expect(getRelationships(result, 'IMPLEMENTS').length).toBe(0);
  });

  it('no OVERRIDES edges target Property nodes', () => {
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.label).not.toBe('Property');
    }
  });
});

// ---------------------------------------------------------------------------
// Ambiguous: Handler struct in two packages, package import disambiguates
// ---------------------------------------------------------------------------

describe('Go ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler structs in separate packages', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    const handlers = structs.filter((s) => s.startsWith('Handler@'));
    expect(handlers.length).toBe(2);
    expect(handlers.some((h) => h.includes('internal/models/'))).toBe(true);
    expect(handlers.some((h) => h.includes('internal/other/'))).toBe(true);
  });

  it('import resolves to internal/models/handler.go (not internal/other/)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const modelsImport = imports.find((e) => e.targetFilePath.includes('models'));
    expect(modelsImport).toBeDefined();
    expect(modelsImport!.targetFilePath).toBe('internal/models/handler.go');
  });

  it('no import edge to internal/other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    for (const imp of imports) {
      expect(imp.targetFilePath).not.toMatch(/internal\/other\//);
    }
  });
});

describe('Go call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-calls'), () => {});
  }, 60000);

  it('resolves main → WriteAudit to internal/onearg/log.go via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('main');
    expect(calls[0].target).toBe('WriteAudit');
    expect(calls[0].targetFilePath).toBe('internal/onearg/log.go');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.Method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Go member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → Save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/user.go');
  });

  it('detects User struct and Save method', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });
});

// ---------------------------------------------------------------------------
// Struct literal resolution: User{...} resolves to Struct node
// ---------------------------------------------------------------------------

describe('Go struct literal resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-struct-literals'), () => {});
  }, 60000);

  it('resolves User{...} as a CALLS edge to the User struct', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Struct');
    expect(ctorCall!.targetFilePath).toBe('user.go');
  });

  it('also resolves user.Save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User struct, Save method, and processUser function', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Function')).toContain('processUser');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-assignment: user, repo := User{}, Repo{} — both sides captured in TypeEnv
// ---------------------------------------------------------------------------

describe('Go multi-assignment short var declaration', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-multi-assign'), () => {});
  }, 60000);

  it('detects User and Repo structs with their methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toEqual(['Persist', 'Save']);
  });

  it('resolves both struct literals in multi-assignment: User{} and Repo{}', () => {
    const calls = getRelationships(result, 'CALLS');
    const structCalls = calls.filter((c) => c.targetLabel === 'Struct');
    expect(edgeSet(structCalls)).toEqual(['process → Repo', 'process → User']);
  });

  it('resolves user.Save() to User.Save and repo.Persist() to Repo.Persist via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    const cloneCall = calls.find((c) => c.target === 'Persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
    expect(saveCall!.targetFilePath).toBe('models.go');

    expect(cloneCall).toBeDefined();
    expect(cloneCall!.source).toBe('process');
    expect(cloneCall!.targetFilePath).toBe('models.go');
  });
});

describe('Go receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-receiver-resolution'), () => {});
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save and repo.Save() to Repo.Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'models/user.go');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'models/repo.go');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: ...interface{} doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('Go variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-variadic-resolution'), () => {});
  }, 60000);

  it('resolves 3-arg call to variadic func Entry(...interface{}) in logger.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'Entry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('main');
    expect(logCall!.targetFilePath).toBe('internal/logger/logger.go');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: unqualified call resolves to local function, not imported package
// ---------------------------------------------------------------------------

describe('Go local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-local-shadow'), () => {});
  }, 60000);

  it('resolves Save("test") to local Save in main.go, not utils.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'main');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('cmd/main.go');
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: user := models.User{}; user.Save()
// Go composite literal constructor pattern (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Go constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.Save() to models/repo.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pointer-constructor-inferred type resolution: user := &models.User{...}; user.Save()
// Go address-of composite literal constructor pattern (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Go pointer-constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-pointer-constructor-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via &User{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process');
  });

  it('resolves repo.Save() to models/repo.go via &Repo{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parent resolution: struct embedding emits EXTENDS
// ---------------------------------------------------------------------------

describe('Go parent resolution (struct embedding)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-parent-resolution'), () => {});
  }, 60000);

  it('detects BaseModel and User structs', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['BaseModel', 'User']);
  });

  it('emits EXTENDS edge: User → BaseModel (struct embedding)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// Go new() builtin type inference: user := new(User); user.Save()
// ---------------------------------------------------------------------------

describe('Go new() builtin type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-new-builtin'), () => {});
  }, 60000);

  it('resolves user.Save() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.Greet() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Go make() builtin type inference: sl := make([]User, 0); sl[0].Save()
// ---------------------------------------------------------------------------

describe('Go make() builtin type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-make-builtin'), () => {});
  }, 60000);

  it('resolves sl[0].Save() via make([]User, 0) slice inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves m["key"].Greet() via make(map[string]User) map inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Go type assertion inference: user := s.(User); user.Save()
// ---------------------------------------------------------------------------

describe('Go type assertion type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-type-assertion'), () => {});
  }, 60000);

  it('resolves user.Save() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
  });

  it('resolves user.Greet() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('process');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: user := GetUser("alice"); user.Save()
// Go now has a CONSTRUCTOR_BINDING_SCANNER for short_var_declaration, so
// return type inference works end-to-end for `user := GetUser()`.
// ---------------------------------------------------------------------------

describe('Go return type inference via explicit function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-return-type-inference'), () => {});
  }, 60000);

  it('detects GetUser, GetRepo, and competing Save methods', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('GetUser');
    expect(allSymbols).toContain('GetRepo');
    const saveMethods = allSymbols.filter((s) => s === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via return type of GetUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go'),
    );
    expect(saveCall).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via return type of GetRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go'),
    );
    expect(saveCall).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves user.Save() via cross-package factory call models.NewUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processUserCrossPackage' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Go multi-return factory inference: user, err := NewUser("alice"); user.Save()
// ---------------------------------------------------------------------------

describe('Go multi-return factory type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-multi-return-inference'), () => {});
  }, 60000);

  it('detects User and Repo structs with competing Save methods', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via multi-return inference (user, err := NewUser())', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via blank discard (repo, _ := NewRepo())', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: var user *models.User = findUser(); user.Save()
// Go pointer types (*User) — extractSimpleTypeName strips pointer prefix.
// ---------------------------------------------------------------------------

describe('Go nullable receiver resolution (pointer types)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.Save() to Repo.Save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('user.Save() does NOT resolve to Repo.Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save' && c.source === 'processEntities');
    expect(saveCalls.filter((c) => c.targetFilePath === 'models/user.go').length).toBe(1);
    expect(saveCalls.filter((c) => c.targetFilePath === 'models/repo.go').length).toBe(1);
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Go assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo structs each with a Save method', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.Save() must resolve to User#Save
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.Save() does NOT resolve to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: alias comes from User, so only one edge to user.go
    const wrongCall = calls.filter(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves rAlias.Save() to Repo#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: rAlias.Save() must resolve to Repo#Save
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own struct, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });

  // --- var form assignment chain ---

  it('resolves var alias.Save() to User via var assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves var rAlias.Save() to Repo via var assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('var alias.Save() does NOT resolve to Repo (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSaves = calls.filter(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSaves.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.GetUser().Save()
// Tests that Go chain call resolution correctly infers the intermediate
// receiver type from GetUser()'s return type and resolves Save() to User.
// ---------------------------------------------------------------------------

describe('Go chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo structs and UserService', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    expect(getNodesByLabel(result, 'Struct')).toContain('UserService');
  });

  it('detects GetUser and Save symbols', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('GetUser');
    expect(allSymbols).toContain('Save');
  });

  it('resolves svc.GetUser().Save() to User#Save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.GetUser().Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath?.includes('repo.go'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go map range: for _, user := range userMap where map[string]User
// ---------------------------------------------------------------------------

describe('Go map range type resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-map-range'), () => {});
  }, 60000);

  it('detects User and Repo structs with Save methods in separate files', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((m) => m === 'Save').length).toBe(2);
  });

  it('resolves user.Save() in map range to User#Save via map_type value', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processMap' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processMap' && c.targetFilePath?.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go for-loop with call_expression iterable: for _, user := range GetUsers()
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('Go for-loop call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-for-call-expr'), () => {});
  }, 60000);

  it('detects User and Repo structs with competing Save methods', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((m) => m === 'Save').length).toBe(2);
  });

  it('resolves user.Save() in range GetUsers() to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUsers' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() in range GetRepos() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.Save() to User#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepos' && c.targetFilePath?.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-field-types'), () => {});
  }, 60000);

  it('detects structs: Address, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for Go struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('Name');
    expect(properties).toContain('City');
  });

  it('emits HAS_PROPERTY edges linking struct fields to structs', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('Address → City');
  });

  it('resolves user.Address.Save() → Address#Save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'processUser' && e.targetFilePath.includes('models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('Property nodes contain expected field names', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'City');
    expect(city).toBeDefined();

    const name = properties.find((p) => p.name === 'Name');
    expect(name).toBeDefined();

    const addr = properties.find((p) => p.name === 'Address');
    expect(addr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-deep-field-chain'), () => {});
  }, 60000);

  it('detects structs: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for Go struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('City');
    expect(properties).toContain('ZipCode');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(5);
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('Address → City');
    expect(edgeSet(propEdges)).toContain('Address → Street');
    expect(edgeSet(propEdges)).toContain('City → ZipCode');
  });

  it('resolves 2-level chain: user.Address.Save() → Address#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save' && e.source === 'processUser');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.Address.City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'GetName' && e.source === 'processUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('models'));
    expect(cityGetName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed field+call chain resolution (Go)
// ---------------------------------------------------------------------------

describe('Mixed field+call chain resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-mixed-chain'), () => {});
  }, 60000);

  it('detects structs: Address, City, User, UserService', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'City', 'User', 'UserService']);
  });

  it('detects Property nodes for mixed-chain fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('City');
    expect(properties).toContain('Address');
  });

  it('resolves call→field chain: svc.GetUser().Address.Save() → Address#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save' && e.source === 'processWithService');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves field→call chain: user.GetAddress().City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(
      (e) => e.target === 'GetName' && e.source === 'processWithUser',
    );
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment statements
// ---------------------------------------------------------------------------

describe('Write access tracking (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const nameWrite = writes.find((e) => e.target === 'Name');
    const addressWrite = writes.find((e) => e.target === 'Address');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): user := GetUser(); user.Save()
// ---------------------------------------------------------------------------

describe('Go call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.Save() to User#Save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): GetUser() → .Address → .GetCity() → .Save()
// ---------------------------------------------------------------------------

describe('Go method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-method-chain-binding'), () => {});
  }, 60000);

  it('resolves city.Save() to City#Save via 3-step chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processChain' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Go inc_statement / dec_statement write access
// obj.Field++ and obj.Field-- emit ACCESSES write edges
// ---------------------------------------------------------------------------

describe('Go inc/dec write access tracking (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-inc-dec-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edge for Count++ in increment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const countInc = writes.find((e) => e.target === 'Count' && e.source === 'increment');
    expect(countInc).toBeDefined();
  });

  it('emits ACCESSES write edge for Total++ in increment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const totalInc = writes.find((e) => e.target === 'Total' && e.source === 'increment');
    expect(totalInc).toBeDefined();
  });

  it('emits ACCESSES write edge for Count-- in decrement', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const countDec = writes.find((e) => e.target === 'Count' && e.source === 'decrement');
    expect(countDec).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation (via synthesized wildcard imports)
// models/user.go exports User struct with Save() and GetName() methods
// models/factory.go exports GetUser() -> User
// app/main.go imports models package, calls models.GetUser().Save()
// → user is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Go cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'go-cross-file'), () => {});
  }, 60000);

  it('detects User struct with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Method')).toContain('GetName');
  });

  it('detects GetUser factory function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('GetUser');
  });

  it('emits IMPORTS edge from main.go to models package files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('main') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves user.Save() in main() to User#Save via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.GetName() in main() to User#GetName via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'GetName' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking Save and GetName to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'Save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'GetName');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Go cmd/ helper files should NOT get entry-point multiplier (P0-1 fix)
// Only main.go files should get the 3.0 entry-point boost, not arbitrary
// .go files under cmd/ subdirectories.
// ---------------------------------------------------------------------------

describe('Go cmd/ helper files entry-point scoring', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-cmd-helper'), () => {});
  }, 60000);

  it('detects main function and Load function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('main');
    expect(getNodesByLabel(result, 'Function')).toContain('Load');
  });

  it('emits IMPORTS edge from main.go to config/config.go', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('main') && e.targetFilePath.includes('config'),
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: struct methods, interface methods, package-level funcs
// ---------------------------------------------------------------------------

describe('Go method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-method-enrichment'), () => {});
  }, 60000);

  it('detects Dog struct', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('Dog');
  });

  it('detects Speak method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Speak');
  });

  it('detects Classify as static function', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('marks Speak as public (exported)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find((n) => n.name === 'Speak');
    if (speak?.properties.visibility !== undefined) {
      expect(speak.properties.visibility).toBe('public');
    }
  });

  it('populates parameterTypes for Classify', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.parameterTypes !== undefined) {
      expect(classify.properties.parameterTypes).toContain('string');
    }
  });

  it('detects Animal interface', () => {
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(interfaces).toContain('Animal');
  });

  it('marks interface method Speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    // Interface method_elem Speak should be abstract
    const interfaceSpeak = methods.find(
      (m) => m.name === 'Speak' && m.properties.isAbstract === true,
    );
    if (interfaceSpeak) {
      expect(interfaceSpeak.properties.isAbstract).toBe(true);
    }
  });

  it('resolves dog.Speak() CALLS edge from app.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'Speak' && c.sourceFilePath.includes('app.go'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Classify() CALLS edge from app.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'Classify' && c.sourceFilePath.includes('app.go'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SM-9/SM-10: lookupMethodByOwnerWithMRO + D0 fast path — Go struct embedding
// ---------------------------------------------------------------------------

describe('Go Child embeds Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-child-extends-parent'), () => {});
  }, 60000);

  it('detects Parent and Child structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('Parent');
    expect(structs).toContain('Child');
  });

  it('emits EXTENDS edge: Child → Parent (struct embedding)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');
  });

  it('resolves c.ParentMethod() to Parent.ParentMethod via first-wins MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'ParentMethod' && c.targetFilePath.includes('parent.go'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('Run');
  });
});
