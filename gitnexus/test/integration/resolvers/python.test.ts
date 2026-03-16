/**
 * Python: relative imports + class inheritance + ambiguous module disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: relative imports + class inheritance
// ---------------------------------------------------------------------------

describe('Python relative import & heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-pkg'),
      () => {},
    );
  }, 60000);

  it('detects exactly 3 classes and 5 functions', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['AuthService', 'BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Function')).toEqual(['authenticate', 'get_name', 'process_model', 'save', 'validate']);
  });

  it('emits exactly 1 EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('resolves all 3 relative imports', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(3);
    expect(edgeSet(imports)).toEqual([
      'auth.py → user.py',
      'helpers.py → base.py',
      'user.py → base.py',
    ]);
  });

  it('emits exactly 3 CALLS edges', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(3);
    expect(edgeSet(calls)).toEqual([
      'authenticate → validate',
      'process_model → save',
      'process_model → validate',
    ]);
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
// Ambiguous: Handler in two packages, relative import disambiguates
// ---------------------------------------------------------------------------

describe('Python ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    expect(classes).toContain('UserHandler');
  });

  it('resolves EXTENDS to models/handler.py (not other/handler.py)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('models/handler.py');
  });

  it('import edge points to models/ not other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('models/handler.py');
  });

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of getRelationships(result, 'EXTENDS')) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
    }
  });
});

describe('Python call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-calls'),
      () => {},
    );
  }, 60000);

  it('resolves run → write_audit to one.py via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('run');
    expect(calls[0].target).toBe('write_audit');
    expect(calls[0].targetFilePath).toBe('one.py');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Python member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves process_user → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process_user');
    expect(saveCall!.targetFilePath).toBe('user.py');
  });

  it('detects User class and save function (Python methods are Function nodes)', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    // Python tree-sitter captures all function_definitions as Function, including methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('Python receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    // Python tree-sitter captures all function_definitions as Function
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'user.py');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'repo.py');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
    expect(repoSave!.source).toBe('process_entities');
  });
});

// ---------------------------------------------------------------------------
// Named import disambiguation: two modules export same name, from-import resolves
// ---------------------------------------------------------------------------

describe('Python named import disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-named-imports'),
      () => {},
    );
  }, 60000);

  it('resolves process_input → format_data to format_upper.py via from-import', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find(c => c.target === 'format_data');
    expect(formatCall).toBeDefined();
    expect(formatCall!.source).toBe('process_input');
    expect(formatCall!.targetFilePath).toBe('format_upper.py');
  });

  it('emits IMPORTS edge to format_upper.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find(e => e.source === 'app.py');
    expect(appImport).toBeDefined();
    expect(appImport!.targetFilePath).toBe('format_upper.py');
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: *args don't get filtered by arity
// ---------------------------------------------------------------------------

describe('Python variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves process_input → log_entry to logger.py despite 3 args vs *args', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(c => c.target === 'log_entry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('process_input');
    expect(logCall!.targetFilePath).toBe('logger.py');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: from x import User as U resolves U → User
// ---------------------------------------------------------------------------

describe('Python alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves u.save() to models.py and r.persist() to models.py via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    const persistCall = calls.find(c => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('models.py');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('models.py');
  });

  it('emits exactly 1 IMPORTS edge: app.py → models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].sourceFilePath).toBe('app.py');
    expect(imports[0].targetFilePath).toBe('models.py');
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: from .base import X barrel pattern via __init__.py
// ---------------------------------------------------------------------------

describe('Python re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-reexport-chain'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() through __init__.py barrel to models/base.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('models/base.py');
  });

  it('resolves repo.persist() through __init__.py barrel to models/base.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find(c => c.target === 'persist');
    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('models/base.py');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('Python local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves save("test") to local save in app.py, not utils.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'main');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app.py');
  });
});

// ---------------------------------------------------------------------------
// Constructor-call resolution: User("alice") resolves to User class
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: user = User(); user.save() → User.save
// Cross-file SymbolTable verification (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Python constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to models/user.py via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/user.py');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save() to models/repo.py via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/repo.py');
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
// Constructor-call resolution: User("alice") resolves to User class
// ---------------------------------------------------------------------------

describe('Python constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-constructor-calls'),
      () => {},
    );
  }, 60000);

  it('detects User class with __init__ and save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('__init__');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('process');
  });

  it('resolves import from app.py to models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(e => e.source === 'app.py' && e.targetFilePath === 'models.py');
    expect(imp).toBeDefined();
  });

  it('emits HAS_METHOD from User class to __init__ and save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const initEdge = hasMethod.find(e => e.source === 'User' && e.target === '__init__');
    const saveEdge = hasMethod.find(e => e.source === 'User' && e.target === 'save');
    expect(initEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });

  it('resolves user.save() as a method call to models.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
    expect(saveCall!.targetFilePath).toBe('models.py');
  });
});

// ---------------------------------------------------------------------------
// self.save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('Python self resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save function', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves self.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('models/user.py');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS edge
// ---------------------------------------------------------------------------

describe('Python parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('EXTENDS edge points to real graph node in base.py', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const target = result.graph.getNode(extends_[0].rel.targetId);
    expect(target).toBeDefined();
    expect(target!.properties.filePath).toBe('models/base.py');
  });
});

// ---------------------------------------------------------------------------
// super().save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('Python super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super().save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'models/base.py');
    expect(superSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/repo.py');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Python qualified constructor: user = models.User("alice"); user.save()
// ---------------------------------------------------------------------------

describe('Python qualified constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-qualified-constructor'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() via qualified constructor (models.User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.targetFilePath === 'models.py');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.greet() via qualified constructor (models.User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find(c => c.target === 'greet' && c.targetFilePath === 'models.py');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Walrus operator: if (user := User("alice")): user.save()
// ---------------------------------------------------------------------------

describe('Python walrus operator type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-walrus-operator'),
      () => {},
    );
  }, 60000);

  it('detects User class with save and greet methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('greet');
  });

  it('resolves user.save() via walrus operator constructor inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.targetFilePath === 'models.py');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
  });
});

// ---------------------------------------------------------------------------
// Class-level annotations: file-scope `user: User` disambiguates method calls
// ---------------------------------------------------------------------------

describe('Python class-level annotation resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-class-annotations'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves active_user.save() to User.save via file-level annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'user.py');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process');
  });

  it('resolves active_repo.save() to Repo.save via file-level annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'repo.py');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Return type inference: user = get_user('alice'); user.save()
// Python's scanner captures ALL call assignments, enabling return type inference.
// ---------------------------------------------------------------------------

describe('Python return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('detects get_user and save symbols', () => {
    // Python methods inside classes may be labeled Method or Function depending on nesting
    const allSymbols = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(allSymbols).toContain('get_user');
    expect(allSymbols).toContain('save');
  });

  it('resolves user.save() to User#save via return type inference from get_user() -> User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'process_user'
    );
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toContain('models.py');
  });
});

// ---------------------------------------------------------------------------
// Issue #289: static/classmethod classes must have HAS_METHOD edges
// ---------------------------------------------------------------------------

describe('Python static/classmethod class resolution (issue #289)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-static-class-methods'),
      () => {},
    );
  }, 60000);

  it('detects UserService and AdminService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Class')).toContain('AdminService');
  });

  it('detects all static/class methods as symbols', () => {
    const allSymbols = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(allSymbols).toContain('find_user');
    expect(allSymbols).toContain('create_user');
    expect(allSymbols).toContain('from_config');
    expect(allSymbols).toContain('delete_user');
  });

  it('emits HAS_METHOD edges linking static methods to their enclosing class', () => {
    // This is the core of issue #289: without HAS_METHOD, context() and impact()
    // return empty for classes whose methods are all @staticmethod/@classmethod
    const hasMethod = getRelationships(result, 'HAS_METHOD');

    const userServiceMethods = hasMethod.filter(e => e.source === 'UserService');
    expect(userServiceMethods.length).toBeGreaterThanOrEqual(3); // find_user, create_user, from_config

    const adminServiceMethods = hasMethod.filter(e => e.source === 'AdminService');
    expect(adminServiceMethods.length).toBeGreaterThanOrEqual(2); // find_user, delete_user
  });

  it('resolves unique static method calls (create_user, delete_user, from_config)', () => {
    const calls = getRelationships(result, 'CALLS');
    // delete_user is unique to AdminService — should resolve
    const deleteCall = calls.find(c =>
      c.target === 'delete_user' && c.source === 'process' && c.targetFilePath.includes('service.py'),
    );
    expect(deleteCall).toBeDefined();

    // create_user is unique to UserService — should resolve
    const createCall = calls.find(c =>
      c.target === 'create_user' && c.source === 'process' && c.targetFilePath.includes('service.py'),
    );
    expect(createCall).toBeDefined();
  });

  it('does not emit ambiguous find_user() when both classes define it (known limitation)', () => {
    // UserService.find_user() and AdminService.find_user() are ambiguous — the pipeline
    // refuses to guess. Static method calls like ClassName.method() don't have a typed
    // receiver variable, so receiver-constrained disambiguation doesn't apply.
    // This is expected: no false edges is better than wrong edges.
    const calls = getRelationships(result, 'CALLS');
    const findCalls = calls.filter(c =>
      c.target === 'find_user' && c.source === 'process',
    );
    // Either 0 (refused ambiguous) or 2 (both resolved) — not 1 (wrong guess)
    expect(findCalls.length === 0 || findCalls.length === 2).toBe(true);
  });
});
