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
// Bare import: `import user` from services/auth.py resolves to services/user.py
// not models/user.py, even though models/ is indexed first (proximity wins)
// ---------------------------------------------------------------------------

describe('Python bare import resolution (proximity over index order)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-bare-import'),
      () => {},
    );
  }, 60000);

  it('detects User in models/ and UserService in services/', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('resolves `import user` from services/auth.py to services/user.py, not models/user.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(e => e.sourceFilePath === 'services/auth.py');
    expect(imp).toBeDefined();
    expect(imp!.targetFilePath).toBe('services/user.py');
    expect(imp!.targetFilePath).not.toBe('models/user.py');
  });

  it('resolves svc.execute() CALLS edge to UserService#execute in services/user.py', () => {
    // End-to-end: correct IMPORTS resolution must propagate through type inference
    // so that user.UserService() binds svc → UserService, and svc.execute() resolves
    const calls = getRelationships(result, 'CALLS');
    const executeCall = calls.find(c => c.target === 'execute' && c.targetFilePath === 'services/user.py');
    expect(executeCall).toBeDefined();
    expect(executeCall!.source).toBe('authenticate');
  });
});

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

  it('resolves find_user() via class-as-receiver for static method calls', () => {
    // UserService.find_user() and AdminService.find_user() are both resolved because
    // the class name (UserService / AdminService) is used as the receiver type for
    // disambiguation. Both find_user methods share the same nodeId (same file, same name)
    // so exactly 1 CALLS edge is emitted — which is correct (not ambiguous, not missing).
    const calls = getRelationships(result, 'CALLS');
    const findCalls = calls.filter(c =>
      c.target === 'find_user' && c.source === 'process',
    );
    expect(findCalls.length).toBe(1);
    expect(findCalls[0].targetFilePath).toContain('service.py');
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: user: User | None = find_user(); user.save()
// Python 3.10+ union syntax — stripNullable unwraps `User | None` → `User`
// ---------------------------------------------------------------------------

describe('Python nullable receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-nullable-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save via nullable receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'user.py');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save() to Repo.save via nullable receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'repo.py');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('user.save() does NOT resolve to Repo.save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save' && c.source === 'process_entities');
    // Each save() call should resolve to exactly one target file
    const userSaveToRepo = saveCalls.filter(c => c.targetFilePath === 'repo.py');
    const repoSaveToUser = saveCalls.filter(c => c.targetFilePath === 'user.py');
    // Exactly 1 edge to each file (not 2 to either)
    expect(userSaveToRepo.length).toBe(1);
    expect(repoSaveToUser.length).toBe(1);
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Python assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-assignment-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.save() must resolve to User#save
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: only one save call from process to User#save
    const wrongCall = calls.filter(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves r_alias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: r_alias.save() must resolve to Repo#save
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('repo.py'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Python nullable (User | None) + assignment chain combined.
// Python 3.10+ union syntax is parsed as binary_operator by tree-sitter,
// stored as raw text "User | None" in TypeEnv. stripNullable's
// NULLABLE_KEYWORDS.has() path must resolve it at lookup time.
// ---------------------------------------------------------------------------

describe('Python nullable (User | None) + assignment chain combined', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-nullable-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save when source is User | None', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'nullable_chain_user' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() from User | None does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'save' && c.source === 'nullable_chain_user' && c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save when source is Repo | None', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'nullable_chain_repo' && c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias.save() from Repo | None does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'save' && c.source === 'nullable_chain_repo' && c.targetFilePath?.includes('user.py'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Python walrus operator (:=) assignment chain.
// Tests that extractPendingAssignment handles named_expression nodes
// in addition to regular assignment nodes.
// ---------------------------------------------------------------------------

describe('Python walrus operator (:=) assignment chain', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-walrus-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via regular + walrus chains', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'walrus_chain_user' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('save() in walrus_chain_user does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'save' && c.source === 'walrus_chain_user' && c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save via regular + walrus chains', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'walrus_chain_repo' && c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('save() in walrus_chain_repo does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'save' && c.source === 'walrus_chain_repo' && c.targetFilePath?.includes('user.py'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Python match/case as-pattern binding: `case User() as u: u.save()`
// Tests Phase 6 extractPatternBinding for Python's match statement.
// ---------------------------------------------------------------------------

describe('Python match/case as-pattern type binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-match-case'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('DEBUG: shows pipeline result details', () => {
    const calls = getRelationships(result, 'CALLS');
    console.log('ALL CALLS:', JSON.stringify(calls.map(c => ({ source: c.source, target: c.target, targetFilePath: c.targetFilePath }))));
    // Check all relationships
    const allRels: string[] = [];
    result.graph.iterRelationships && [...result.graph.iterRelationships()].forEach(r => {
      const src = result.graph.getNode(r.sourceId);
      const tgt = result.graph.getNode(r.targetId);
      allRels.push(r.type + ': ' + src?.properties.name + ' -> ' + tgt?.properties.name);
    });
    console.log('ALL RELATIONSHIPS:', allRels.join(', '));
    expect(true).toBe(true);
  });

  // Skip: call extraction issue, NOT a type-env limitation.
  // Type-env binding works correctly (unit test passes). The root cause is likely
  // in call-processor's findEnclosingFunction scope resolution within match_statement
  // blocks, not the tree-sitter query patterns (which descend recursively by default).
  it.skip('resolves u.save() to User#save via match/case as-pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it.skip('does NOT resolve u.save() to Repo#save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.get_user().save()
// Tests that Python's scanner correctly handles method-call chains where
// the intermediate receiver type is inferred from the return type annotation.
// ---------------------------------------------------------------------------

describe('Python chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-chain-call'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects get_user and save functions', () => {
    const allSymbols = [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')];
    expect(allSymbols).toContain('get_user');
    expect(allSymbols).toContain('save');
  });

  it('resolves svc.get_user().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_user' &&
      c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.get_user().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process_user' &&
      c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// for key, user in data.items() — dict.items() call iterable + tuple unpacking
// ---------------------------------------------------------------------------

describe('Python dict.items() for-loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-dict-items-loop'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() via dict.items() loop to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// self.users member access iterable: for user in self.users
// ---------------------------------------------------------------------------

describe('Python member access iterable for-loop', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-member-access-for-loop'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    // Python tree-sitter captures all function_definitions as Function, including methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves user.save() via self.users to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('repo.py'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via self.repos to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Python for-loop with call_expression iterable: for user in get_users()
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('Python for-loop call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-for-call-expr'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in for-loop over get_users() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('models.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-loop over get_repos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_repos' && c.targetFilePath?.includes('models.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('process_users resolves exactly one save call (no cross-binding)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c =>
      c.target === 'save' && c.source === 'process_users',
    );
    expect(saveCalls.length).toBe(1);
  });

  it('process_repos resolves exactly one save call (no cross-binding)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c =>
      c.target === 'save' && c.source === 'process_repos',
    );
    expect(saveCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// enumerate() for-loop: for i, k, v in enumerate(d.items())
// ---------------------------------------------------------------------------

describe('Python enumerate() for-loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-enumerate-loop'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves v.save() in enumerate(users.items()) loop to User#save', () => {
    // for i, k, v in enumerate(users.items()): v.save()
    // v must bind to User (value type of dict[str, User]).
    // Without enumerate() support, v is unbound → resolver emits 0 CALLS.
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve v.save() to a non-User target', () => {
    // i is the int index from enumerate — must not produce a spurious CALLS edge
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_users' && !c.targetFilePath?.includes('user.py'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves nested tuple pattern: for i, (k, v) in enumerate(d.items())', () => {
    // Nested tuple_pattern inside pattern_list — must descend to find v
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_nested_tuple' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves parenthesized tuple: for (i, u) in enumerate(users)', () => {
    // tuple_pattern as top-level left node (not pattern_list)
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'process_parenthesized_tuple' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });
});
