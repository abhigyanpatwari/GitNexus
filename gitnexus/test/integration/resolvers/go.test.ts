/**
 * Go: package imports + cross-package calls + ambiguous struct disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: package imports + cross-package calls (exercises PackageMap)
// ---------------------------------------------------------------------------

describe('Go package import & call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-pkg'),
      () => {},
    );
  }, 60000);

  it('detects exactly 2 structs and 1 interface', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Admin', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Repository']);
  });

  it('detects exactly 5 functions', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual([
      'Authenticate', 'NewAdmin', 'NewUser', 'ValidateToken', 'main',
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
    const overrides = getRelationships(result, 'OVERRIDES');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler structs in separate packages', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    const handlers = structs.filter(s => s.startsWith('Handler@'));
    expect(handlers.length).toBe(2);
    expect(handlers.some(h => h.includes('internal/models/'))).toBe(true);
    expect(handlers.some(h => h.includes('internal/other/'))).toBe(true);
  });

  it('import resolves to internal/models/handler.go (not internal/other/)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const modelsImport = imports.find(e => e.targetFilePath.includes('models'));
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-calls'),
      () => {},
    );
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → Save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/user.go');
  });

  it('detects User struct and Save method', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-struct-literals'),
      () => {},
    );
  }, 60000);

  it('resolves User{...} as a CALLS edge to the User struct', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Struct');
    expect(ctorCall!.targetFilePath).toBe('user.go');
  });

  it('also resolves user.Save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User struct, Save method, and processUser function', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-multi-assign'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with their methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toEqual(['Persist', 'Save']);
  });

  it('resolves both struct literals in multi-assignment: User{} and Repo{}', () => {
    const calls = getRelationships(result, 'CALLS');
    const structCalls = calls.filter(c => c.targetLabel === 'Struct');
    expect(edgeSet(structCalls)).toEqual([
      'process → Repo',
      'process → User',
    ]);
  });

  it('resolves user.Save() to User.Save and repo.Persist() to Repo.Persist via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    const cloneCall = calls.find(c => c.target === 'Persist');

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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    const structs: string[] = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save and repo.Save() to Repo.Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'models/user.go');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'models/repo.go');

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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves 3-arg call to variadic func Entry(...interface{}) in logger.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(c => c.target === 'Entry');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves Save("test") to local Save in main.go, not utils.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.source === 'main');
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
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models/user.go');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.Save() to models/repo.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models/repo.go');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save');
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
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via &User{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models/user.go');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process');
  });

  it('resolves repo.Save() to models/repo.go via &Repo{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models/repo.go');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parent resolution: struct embedding emits EXTENDS
// ---------------------------------------------------------------------------

describe('Go parent resolution (struct embedding)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-parent-resolution'),
      () => {},
    );
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-new-builtin'),
      () => {},
    );
  }, 60000);

  it('resolves user.Save() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.Greet() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find(c => c.target === 'Greet' && c.targetFilePath === 'models.go');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-make-builtin'),
      () => {},
    );
  }, 60000);

  it('resolves sl[0].Save() via make([]User, 0) slice inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves m["key"].Greet() via make(map[string]User) map inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find(c => c.target === 'Greet' && c.targetFilePath === 'models.go');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-type-assertion'),
      () => {},
    );
  }, 60000);

  it('resolves user.Save() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
  });

  it('resolves user.Greet() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find(c => c.target === 'Greet' && c.targetFilePath === 'models.go');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects GetUser, GetRepo, and competing Save methods', () => {
    const allSymbols = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(allSymbols).toContain('GetUser');
    expect(allSymbols).toContain('GetRepo');
    const saveMethods = allSymbols.filter(s => s === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via return type of GetUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go')
    );
    expect(saveCall).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go')
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via return type of GetRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go')
    );
    expect(saveCall).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go')
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves user.Save() via cross-package factory call models.NewUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'Save' && c.source === 'processUserCrossPackage' && c.targetFilePath.includes('user.go')
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-multi-return-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs with competing Save methods', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via multi-return inference (user, err := NewUser())', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go')
    );
    expect(userSave).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go')
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via blank discard (repo, _ := NewRepo())', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go')
    );
    expect(repoSave).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go')
    );
    expect(wrongSave).toBeUndefined();
  });
});
