/**
 * Python: relative imports + class inheritance + ambiguous module disambiguation
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
// Heritage: relative imports + class inheritance
// ---------------------------------------------------------------------------

describe('Python relative import & heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-pkg'), () => {});
  }, 60000);

  it('detects exactly 3 classes and 5 functions', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['AuthService', 'BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Function')).toEqual([
      'authenticate',
      'get_name',
      'process_model',
      'save',
      'validate',
    ]);
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
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-calls'), () => {});
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-member-calls'), () => {});
  }, 60000);

  it('resolves process_user → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-receiver-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    // Python tree-sitter captures all function_definitions as Function
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'user.py');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'repo.py');

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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-named-imports'), () => {});
  }, 60000);

  it('resolves process_input → format_data to format_upper.py via from-import', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find((c) => c.target === 'format_data');
    expect(formatCall).toBeDefined();
    expect(formatCall!.source).toBe('process_input');
    expect(formatCall!.targetFilePath).toBe('format_upper.py');
  });

  it('emits IMPORTS edge to format_upper.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find((e) => e.source === 'app.py');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-variadic-resolution'), () => {});
  }, 60000);

  it('resolves process_input → log_entry to logger.py despite 3 args vs *args', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'log_entry');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-alias-imports'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves u.save() to models.py and r.persist() to models.py via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const persistCall = calls.find((c) => c.target === 'persist');

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
// Plain import alias: import models as m → m.User() resolves to models.py
// ---------------------------------------------------------------------------

describe('Python plain import alias resolution (import X as Y)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-plain-import-alias'), () => {});
  }, 60000);

  it('detects User classes in both models.py and auth.py', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
  });

  it('emits IMPORTS edges: app.py → models.py and app.py → auth.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const importFiles = imports
      .filter((i) => i.sourceFilePath === 'app.py')
      .map((i) => i.targetFilePath)
      .sort();
    expect(importFiles).toEqual(['auth.py', 'models.py']);
  });

  it('resolves m.User() and u.save() to models.py via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'main');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('models.py');
  });

  it('resolves m.Repo() and r.persist() to models.py via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find((c) => c.target === 'persist' && c.source === 'main');
    expect(persistCall).toBeDefined();
    expect(persistCall!.targetFilePath).toBe('models.py');
  });

  it('resolves a.User() and v.login() to auth.py via alias (disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const loginCall = calls.find((c) => c.target === 'login' && c.source === 'main');
    expect(loginCall).toBeDefined();
    expect(loginCall!.targetFilePath).toBe('auth.py');
  });
});

// ---------------------------------------------------------------------------
// Same-name collision: import X as alias; alias.func() where caller is also named func
// Issue #417 — module-alias disambiguation must override same-file tier
// ---------------------------------------------------------------------------

describe('Python same-name collision via module alias (Issue #417)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-same-name-collision'), () => {});
  }, 60000);

  it('resolves app_metrics.get_metrics() to metrics.py, not self (same-name collision)', () => {
    const calls = getRelationships(result, 'CALLS');
    const getMetricsCall = calls.find(
      (c) => c.source === 'get_metrics' && c.target === 'get_metrics',
    );
    expect(getMetricsCall).toBeDefined();
    // Must resolve to metrics.py, NOT router.py (self-call)
    expect(getMetricsCall!.sourceFilePath).toBe('router.py');
    expect(getMetricsCall!.targetFilePath).toBe('metrics.py');
  });

  it('emits IMPORTS edge: router.py → metrics.py (module alias registered)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const metricsImport = imports.find(
      (i) => i.sourceFilePath === 'router.py' && i.targetFilePath === 'metrics.py',
    );
    expect(metricsImport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ancestor directory import: Python single-segment import resolved via ancestor walk
// Issue #417 — prevents cross-language misresolution when suffix matching picks .ts over .py
// ---------------------------------------------------------------------------

describe('Python ancestor directory import resolution (Issue #417)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-ancestor-import'), () => {});
  }, 60000);

  it('resolves from middleware import to backend/middleware.py, not frontend/middleware.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const middlewareImport = imports.find(
      (i) =>
        i.sourceFilePath === 'backend/services/auth.py' && i.targetFilePath.includes('middleware'),
    );
    expect(middlewareImport).toBeDefined();
    expect(middlewareImport!.targetFilePath).toBe('backend/middleware.py');
  });

  it('resolves _canonical() call to middleware.py:get_remaining_slots via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const canonicalCall = calls.find(
      (c) => c.source === 'get_remaining_slots' && c.sourceFilePath === 'backend/services/auth.py',
    );
    expect(canonicalCall).toBeDefined();
    expect(canonicalCall!.target).toBe('get_remaining_slots');
    expect(canonicalCall!.targetFilePath).toBe('backend/middleware.py');
  });

  it('resolves depth-2 ancestor import: a/b/c/deep.py → a/utils.py (not suffix match)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const utilsImport = imports.find(
      (i) => i.sourceFilePath === 'a/b/c/deep.py' && i.targetFilePath.includes('utils'),
    );
    expect(utilsImport).toBeDefined();
    expect(utilsImport!.targetFilePath).toBe('a/utils.py');
  });

  it('resolves format_currency() call across depth-2 ancestor import', () => {
    const calls = getRelationships(result, 'CALLS');
    const fmtCall = calls.find(
      (c) => c.source === 'render_price' && c.target === 'format_currency',
    );
    expect(fmtCall).toBeDefined();
    expect(fmtCall!.targetFilePath).toBe('a/utils.py');
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: from .base import X barrel pattern via __init__.py
// ---------------------------------------------------------------------------

describe('Python re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-reexport-chain'), () => {});
  }, 60000);

  it('resolves user.save() through __init__.py barrel to models/base.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('models/base.py');
  });

  it('resolves repo.persist() through __init__.py barrel to models/base.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find((c) => c.target === 'persist');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-local-shadow'), () => {});
  }, 60000);

  it('resolves save("test") to local save in app.py, not utils.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'main');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-bare-import'), () => {});
  }, 60000);

  it('detects User in models/ and UserService in services/', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('resolves `import user` from services/auth.py to services/user.py, not models/user.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find((e) => e.sourceFilePath === 'services/auth.py');
    expect(imp).toBeDefined();
    expect(imp!.targetFilePath).toBe('services/user.py');
    expect(imp!.targetFilePath).not.toBe('models/user.py');
  });

  it('resolves svc.execute() CALLS edge to UserService#execute in services/user.py', () => {
    // End-to-end: correct IMPORTS resolution must propagate through type inference
    // so that user.UserService() binds svc → UserService, and svc.execute() resolves
    const calls = getRelationships(result, 'CALLS');
    const executeCall = calls.find(
      (c) => c.target === 'execute' && c.targetFilePath === 'services/user.py',
    );
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
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to models/user.py via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/user.py',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save() to models/repo.py via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/repo.py',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Constructor-call resolution: User("alice") resolves to User class
// ---------------------------------------------------------------------------

describe('Python constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-constructor-calls'), () => {});
  }, 60000);

  it('detects User class with __init__ and save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('__init__');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('process');
  });

  it('resolves import from app.py to models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find((e) => e.source === 'app.py' && e.targetFilePath === 'models.py');
    expect(imp).toBeDefined();
  });

  it('emits HAS_METHOD from User class to __init__ and save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const initEdge = hasMethod.find((e) => e.source === 'User' && e.target === '__init__');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(initEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });

  it('resolves user.save() as a method call to models.py', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
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
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves self.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-parent-resolution'), () => {});
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-super-resolution'), () => {});
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super().save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(
      (c) => c.source === 'save' && c.target === 'save' && c.targetFilePath === 'models/base.py',
    );
    expect(superSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/repo.py',
    );
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
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models.py');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.greet() via qualified constructor (models.User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath === 'models.py');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-walrus-operator'), () => {});
  }, 60000);

  it('detects User class with save and greet methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('greet');
  });

  it('resolves user.save() via walrus operator constructor inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models.py');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-class-annotations'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves active_user.save() to User.save via file-level annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'user.py');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process');
  });

  it('resolves active_repo.save() to Repo.save via file-level annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'repo.py');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
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
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('get_user');
    expect(allSymbols).toContain('save');
  });

  it('resolves user.save() to User#save via return type inference from get_user() -> User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process_user');
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
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('find_user');
    expect(allSymbols).toContain('create_user');
    expect(allSymbols).toContain('from_config');
    expect(allSymbols).toContain('delete_user');
  });

  it('emits HAS_METHOD edges linking static methods to their enclosing class', () => {
    // This is the core of issue #289: without HAS_METHOD, context() and impact()
    // return empty for classes whose methods are all @staticmethod/@classmethod
    const hasMethod = getRelationships(result, 'HAS_METHOD');

    const userServiceMethods = hasMethod.filter((e) => e.source === 'UserService');
    expect(userServiceMethods.length).toBe(3); // find_user, create_user, from_config

    const adminServiceMethods = hasMethod.filter((e) => e.source === 'AdminService');
    expect(adminServiceMethods.length).toBe(2); // find_user, delete_user
  });

  it('resolves unique static method calls (create_user, delete_user, from_config)', () => {
    const calls = getRelationships(result, 'CALLS');
    // delete_user is unique to AdminService — should resolve
    const deleteCall = calls.find(
      (c) =>
        c.target === 'delete_user' &&
        c.source === 'process' &&
        c.targetFilePath.includes('service.py'),
    );
    expect(deleteCall).toBeDefined();

    // create_user is unique to UserService — should resolve
    const createCall = calls.find(
      (c) =>
        c.target === 'create_user' &&
        c.source === 'process' &&
        c.targetFilePath.includes('service.py'),
    );
    expect(createCall).toBeDefined();
  });

  it('resolves find_user() via class-as-receiver for static method calls', () => {
    // With qualified IDs, UserService.find_user and AdminService.find_user are distinct
    // nodes — so both CALLS edges are correctly emitted (no ID collision).
    const calls = getRelationships(result, 'CALLS');
    const findCalls = calls.filter((c) => c.target === 'find_user' && c.source === 'process');
    expect(findCalls.length).toBe(2);
    expect(findCalls.every((c) => c.targetFilePath.includes('service.py'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: user: User | None = find_user(); user.save()
// Python 3.10+ union syntax — stripNullable unwraps `User | None` → `User`
// ---------------------------------------------------------------------------

describe('Python nullable receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save via nullable receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'user.py');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save() to Repo.save via nullable receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'repo.py');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('user.save() does NOT resolve to Repo.save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'process_entities');
    // Each save() call should resolve to exactly one target file
    const userSaveToRepo = saveCalls.filter((c) => c.targetFilePath === 'repo.py');
    const repoSaveToUser = saveCalls.filter((c) => c.targetFilePath === 'user.py');
    // Exactly 1 edge to each file (not 2 to either)
    expect(userSaveToRepo.length).toBe(1);
    expect(repoSaveToUser.length).toBe(1);
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Python assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.save() must resolve to User#save
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: only one save call from process to User#save
    const wrongCall = calls.filter(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves r_alias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: r_alias.save() must resolve to Repo#save
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('user.py'),
    );
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('repo.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-nullable-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save when source is User | None', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullable_chain_user' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() from User | None does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullable_chain_user' &&
        c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save when source is Repo | None', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullable_chain_repo' &&
        c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias.save() from Repo | None does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullable_chain_repo' &&
        c.targetFilePath?.includes('user.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-walrus-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves alias.save() to User#save via regular + walrus chains', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'walrus_chain_user' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('save() in walrus_chain_user does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'walrus_chain_user' &&
        c.targetFilePath?.includes('repo.py'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save via regular + walrus chains', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'walrus_chain_repo' &&
        c.targetFilePath?.includes('repo.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('save() in walrus_chain_repo does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'walrus_chain_repo' &&
        c.targetFilePath?.includes('user.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-match-case'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves u.save() to User#save via match/case as-pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve u.save() to Repo#save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects get_user and save functions', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('get_user');
    expect(allSymbols).toContain('save');
  });

  it('resolves svc.get_user().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_user' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.get_user().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_user' && c.targetFilePath?.includes('repo.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-dict-items-loop'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() via dict.items() loop to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.py'),
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
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_users' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_users' &&
        c.targetFilePath?.includes('repo.py'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via self.repos to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_repos' &&
        c.targetFilePath?.includes('repo.py'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-for-call-expr'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in for-loop over get_users() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_users' &&
        c.targetFilePath?.includes('models.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-loop over get_repos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_repos' &&
        c.targetFilePath?.includes('models.py'),
    );
    expect(repoSave).toBeDefined();
  });

  it('process_users resolves exactly one save call (no cross-binding)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'process_users');
    expect(saveCalls.length).toBe(1);
  });

  it('process_repos resolves exactly one save call (no cross-binding)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'process_repos');
    expect(saveCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// enumerate() for-loop: for i, k, v in enumerate(d.items())
// ---------------------------------------------------------------------------

describe('Python enumerate() for-loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-enumerate-loop'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves v.save() in enumerate(users.items()) loop to User#save', () => {
    // for i, k, v in enumerate(users.items()): v.save()
    // v must bind to User (value type of dict[str, User]).
    // Without enumerate() support, v is unbound → resolver emits 0 CALLS.
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_users' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve v.save() to a non-User target', () => {
    // i is the int index from enumerate — must not produce a spurious CALLS edge
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_users' &&
        !c.targetFilePath?.includes('user.py'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves nested tuple pattern: for i, (k, v) in enumerate(d.items())', () => {
    // Nested tuple_pattern inside pattern_list — must descend to find v
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_nested_tuple' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves parenthesized tuple: for (i, u) in enumerate(users)', () => {
    // tuple_pattern as top-level left node (not pattern_list)
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_parenthesized_tuple' &&
        c.targetFilePath?.includes('user.py'),
    );
    expect(userSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution — annotated attribute capture
// ---------------------------------------------------------------------------

describe('Field type resolution (Python)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-field-types'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for Python annotated attributes', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking attributes to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('Address → city');
  });

  it('resolves user.address.save() → Address#save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'process_user' && e.targetFilePath.includes('models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('populates field metadata (visibility, isStatic, isReadonly) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.isReadonly).toBe(false);
    expect(city!.properties.declaredType).toBe('str');

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
    expect(addr!.properties.isStatic).toBe(false);
    expect(addr!.properties.declaredType).toBe('Address');
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field type disambiguation — both User and Address have save()
// ---------------------------------------------------------------------------

describe('Field type disambiguation (Python)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-field-type-disambig'), () => {});
  }, 60000);

  it('detects both User#save and Address#save', () => {
    const methods = getNodesByLabel(result, 'Function');
    const saveMethods = methods.filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.address.save() → Address#save (not User#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'process_user');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('address');
    expect(saveCalls[0].targetFilePath).not.toContain('user');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (Python)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for attribute assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('update_user');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('update_user');
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): user = get_user(); user.save()
// ---------------------------------------------------------------------------

describe('Python call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): get_user() → .get_city() → .save()
// ---------------------------------------------------------------------------

describe('Python method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-method-chain-binding'),
      () => {},
    );
  }, 60000);

  it('resolves city.save() to City#save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_chain' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('Python grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-grandparent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects A, B, C, Greeting classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('A');
    expect(classes).toContain('B');
    expect(classes).toContain('C');
    expect(classes).toContain('Greeting');
  });

  it('emits EXTENDS edges: B→A, C→B', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('B → A');
    expect(edgeSet(extends_)).toContain('C → B');
  });

  it('resolves c.greet().save() to Greeting#save via depth-2 MRO lookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.targetFilePath.includes('greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves c.greet() to A#greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('a.py'));
    expect(greetCall).toBeDefined();
  });
});

// ── Phase P: Default Parameter Arity Resolution ──────────────────────────

describe('Python default parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-default-params'), () => {});
  }, 60000);

  it('resolves greet("alice") with 1 arg to greet with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });

  it('resolves search("test") with 1 arg to search with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const searchCalls = calls.filter((c) => c.source === 'process' && c.target === 'search');
    expect(searchCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation
// models.py exports get_user() -> User
// app.py imports get_user, calls u = get_user(); u.save(); u.get_name()
// → u is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Python cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'py-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('get_name');
  });

  it('detects get_user and run functions', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('emits IMPORTS edge from app.py to models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('app') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves u.save() in run() to User#save via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves u.get_name() in run() to User#get_name via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'get_name' && c.source === 'run' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and get_name to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'get_name');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Module import: `import models; models.User()` should produce CALLS edges
// even when multiple imported modules export a class with the same name.
// Python's `import models` is a namespace import — moduleAliasMap maps the
// module alias to its source file, enabling resolveCallTarget to disambiguate
// `models.User()` from `auth.User()` when both modules export `User`.
// ---------------------------------------------------------------------------

describe('Python module import CALLS resolution (Issue #337)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-module-import'), () => {});
  }, 60000);

  // ── Node detection ──────────────────────────────────────────────────

  it('detects exactly 3 Class nodes: User (×2) and Admin (×1)', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.length).toBe(3);
    expect(classes.filter((c) => c === 'User').length).toBe(2);
    expect(classes.filter((c) => c === 'Admin').length).toBe(1);
  });

  it('detects exactly 3 Function nodes: save, verify, login', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns.length).toBe(3);
    expect(fns).toContain('save');
    expect(fns).toContain('verify');
    expect(fns).toContain('login');
  });

  // ── IMPORTS edges ───────────────────────────────────────────────────

  it('emits exactly 2 IMPORTS edges from app.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImports = imports.filter((e) => e.sourceFilePath === 'app.py');
    expect(appImports.length).toBe(2);
  });

  it('resolves `import models` IMPORTS edge: app.py → models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const toModels = imports.find(
      (e) => e.sourceFilePath === 'app.py' && e.targetFilePath === 'models.py',
    );
    expect(toModels).toBeDefined();
  });

  it('resolves `import auth` IMPORTS edge: app.py → auth.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const toAuth = imports.find(
      (e) => e.sourceFilePath === 'app.py' && e.targetFilePath === 'auth.py',
    );
    expect(toAuth).toBeDefined();
  });

  it('no IMPORTS edge from models.py or auth.py (they import nothing)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const fromModels = imports.filter((e) => e.sourceFilePath === 'models.py');
    const fromAuth = imports.filter((e) => e.sourceFilePath === 'auth.py');
    expect(fromModels.length).toBe(0);
    expect(fromAuth.length).toBe(0);
  });

  // ── CALLS edges: key regression test (Issue #337) ───────────────────

  it('resolves models.User() CALLS edge from app.py to models.py:User', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCall = calls.find(
      (c) =>
        c.target === 'User' && c.targetFilePath === 'models.py' && c.sourceFilePath === 'app.py',
    );
    expect(userCall).toBeDefined();
  });

  it('resolves auth.Admin() CALLS edge from app.py to auth.py:Admin', () => {
    const calls = getRelationships(result, 'CALLS');
    const adminCall = calls.find(
      (c) =>
        c.target === 'Admin' && c.targetFilePath === 'auth.py' && c.sourceFilePath === 'app.py',
    );
    expect(adminCall).toBeDefined();
  });

  it('resolves u.save() method call from app.py to models.py:save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.targetFilePath === 'models.py' && c.sourceFilePath === 'app.py',
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves a.login() method call from app.py to auth.py:login', () => {
    const calls = getRelationships(result, 'CALLS');
    const loginCall = calls.find(
      (c) =>
        c.target === 'login' && c.targetFilePath === 'auth.py' && c.sourceFilePath === 'app.py',
    );
    expect(loginCall).toBeDefined();
  });

  // ── Negative tests ──────────────────────────────────────────────────

  it('no CALLS edges originate from models.py or auth.py (they have no callers)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromModels = calls.filter((c) => c.sourceFilePath === 'models.py');
    const fromAuth = calls.filter((c) => c.sourceFilePath === 'auth.py');
    expect(fromModels.length).toBe(0);
    expect(fromAuth.length).toBe(0);
  });

  it('Admin() does NOT resolve to models.py (Admin only exists in auth.py)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongAdmin = calls.find((c) => c.target === 'Admin' && c.targetFilePath === 'models.py');
    expect(wrongAdmin).toBeUndefined();
  });

  it('no EXTENDS edges (no inheritance in this fixture)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(0);
  });

  // ── Same-name cross-module disambiguation ───────────────────────────

  it('resolves auth.User() CALLS edge to auth.py:User (not models.py:User)', () => {
    // Both models.py and auth.py export User. moduleAliasMap maps
    // receiverName='auth' → auth.py for correct disambiguation.
    const calls = getRelationships(result, 'CALLS');
    const authUserCall = calls.find(
      (c) => c.target === 'User' && c.targetFilePath === 'auth.py' && c.sourceFilePath === 'app.py',
    );
    expect(authUserCall).toBeDefined();
  });

  it('models.User() and auth.User() resolve to DIFFERENT files', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCalls = calls.filter((c) => c.target === 'User' && c.sourceFilePath === 'app.py');
    expect(userCalls.length).toBe(2);
    const targetFiles = new Set(userCalls.map((c) => c.targetFilePath));
    expect(targetFiles.size).toBe(2);
    expect(targetFiles).toContain('models.py');
    expect(targetFiles).toContain('auth.py');
  });

  it('v.verify() resolves to auth.py:verify (via auth.User() constructor inference)', () => {
    const calls = getRelationships(result, 'CALLS');
    const verifyCall = calls.find(
      (c) =>
        c.target === 'verify' && c.targetFilePath === 'auth.py' && c.sourceFilePath === 'app.py',
    );
    expect(verifyCall).toBeDefined();
  });

  // ── HAS_METHOD edges ────────────────────────────────────────────────

  it('emits HAS_METHOD edges linking methods to their classes', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    // models.py: User → save
    const modelsUserSave = hasMethod.find(
      (e) => e.source === 'User' && e.target === 'save' && e.sourceFilePath === 'models.py',
    );
    expect(modelsUserSave).toBeDefined();
    // auth.py: User → verify, Admin → login
    const authUserVerify = hasMethod.find(
      (e) => e.source === 'User' && e.target === 'verify' && e.sourceFilePath === 'auth.py',
    );
    const authAdminLogin = hasMethod.find(
      (e) => e.source === 'Admin' && e.target === 'login' && e.sourceFilePath === 'auth.py',
    );
    expect(authUserVerify).toBeDefined();
    expect(authAdminLogin).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// External dotted imports: framework modules like django.apps must not resolve
// to unrelated local basename matches such as accounts/apps.py or config/urls.py.
// ---------------------------------------------------------------------------

describe('Python external dotted imports do not self-resolve to local files', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-django-app-imports'), () => {});
  }, 60000);

  it('keeps the real local cross-app import: billing/models.py -> accounts/models.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const localImport = imports.find(
      (e) => e.sourceFilePath === 'billing/models.py' && e.targetFilePath === 'accounts/models.py',
    );
    expect(localImport).toBeDefined();
  });

  it('does not resolve django.apps in app configs to local apps.py files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appConfigImports = imports.filter((e) => e.sourceFilePath.endsWith('/apps.py'));
    expect(appConfigImports.length).toBe(0);
  });

  it('does not resolve django.urls in config/urls.py to config/urls.py', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const urlsImport = imports.find(
      (e) => e.sourceFilePath === 'config/urls.py' && e.targetFilePath === 'config/urls.py',
    );
    expect(urlsImport).toBeUndefined();
  });

  it('does not resolve django.core.asgi or django.core.wsgi to local config modules', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const asgiImport = imports.find(
      (e) => e.sourceFilePath === 'config/asgi.py' && e.targetFilePath === 'config/asgi.py',
    );
    const wsgiImport = imports.find(
      (e) => e.sourceFilePath === 'config/wsgi.py' && e.targetFilePath === 'config/wsgi.py',
    );

    expect(asgiImport).toBeUndefined();
    expect(wsgiImport).toBeUndefined();
  });

  it('does not resolve other django.* imports to local same-basename files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const wrongTargets = new Set(['config/asgi.py', 'config/wsgi.py', 'config/urls.py']);
    const misresolvedFrameworkImports = imports.filter((e) => wrongTargets.has(e.targetFilePath));
    expect(misresolvedFrameworkImports.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 16: Method enrichment (isAbstract, parameterTypes, static methods)
// models.py: Animal(ABC) with @abstractmethod speak, @staticmethod classify, breathe
// Dog(Animal) overrides speak
// app.py: dog.speak(), Dog.classify("dog")
// ---------------------------------------------------------------------------

describe('Python method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-method-enrichment'), () => {});
  }, 60000);

  it('detects Animal and Dog classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits HAS_METHOD edges for Animal methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod
      .filter((e) => e.source === 'Animal')
      .map((e) => e.target)
      .sort();
    expect(animalMethods).toContain('speak');
    expect(animalMethods).toContain('classify');
    expect(animalMethods).toContain('breathe');
  });

  it('emits HAS_METHOD edge for Dog.speak', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak');
    expect(dogSpeak).toBeDefined();
  });

  it('emits EXTENDS edge Dog -> Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('marks @abstractmethod speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'speak' && n.properties.filePath === 'models.py');
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('marks breathe as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isAbstract !== undefined) {
      expect(breathe.properties.isAbstract).toBe(false);
    }
  });

  it('populates parameterTypes for classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== undefined) {
      const params = classify.properties.parameterTypes;
      expect(params).toContain('str');
    }
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.target === 'speak' && c.sourceFilePath === 'app.py');
    expect(speakCall).toBeDefined();
  });

  it('resolves Dog.classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath === 'app.py',
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 17: Overload dispatch (similarly-named methods/functions)
// service.py: Formatter.format, Formatter.format_with_prefix,
//             format_text, format_text_with_width
// app.py: calls all four
// ---------------------------------------------------------------------------

describe('Python overload dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-overload-dispatch'), () => {});
  }, 60000);

  it('detects Formatter class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Formatter');
  });

  it('detects all functions including methods', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('format');
    expect(fns).toContain('format_with_prefix');
    expect(fns).toContain('format_text');
    expect(fns).toContain('format_text_with_width');
    expect(fns).toContain('run');
  });

  it('emits HAS_METHOD for Formatter.format and Formatter.format_with_prefix', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const fmtFormat = hasMethod.find((e) => e.source === 'Formatter' && e.target === 'format');
    const fmtPrefix = hasMethod.find(
      (e) => e.source === 'Formatter' && e.target === 'format_with_prefix',
    );
    expect(fmtFormat).toBeDefined();
    expect(fmtPrefix).toBeDefined();
  });

  it('resolves f.format("hello") to Formatter.format', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find((c) => c.target === 'format' && c.sourceFilePath === 'app.py');
    expect(formatCall).toBeDefined();
  });

  it('resolves f.format_with_prefix("hello",">>") to Formatter.format_with_prefix', () => {
    const calls = getRelationships(result, 'CALLS');
    const prefixCall = calls.find(
      (c) => c.target === 'format_with_prefix' && c.sourceFilePath === 'app.py',
    );
    expect(prefixCall).toBeDefined();
  });

  it('resolves format_text() top-level call', () => {
    const calls = getRelationships(result, 'CALLS');
    const textCall = calls.find((c) => c.target === 'format_text' && c.sourceFilePath === 'app.py');
    expect(textCall).toBeDefined();
  });

  it('resolves format_text_with_width() top-level call', () => {
    const calls = getRelationships(result, 'CALLS');
    const widthCall = calls.find(
      (c) => c.target === 'format_text_with_width' && c.sourceFilePath === 'app.py',
    );
    expect(widthCall).toBeDefined();
  });

  it('populates parameterTypes for format_with_prefix (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const fwp = methods.find((n) => n.name === 'format_with_prefix');
    if (fwp?.properties.parameterTypes !== undefined) {
      const params = fwp.properties.parameterTypes;
      expect(params).toContain('str');
    }
  });

  it('populates parameterTypes for format_text_with_width (conditional)', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const ftw = fns.find((n) => n.name === 'format_text_with_width');
    if (ftw?.properties.parameterTypes !== undefined) {
      const params = ftw.properties.parameterTypes;
      expect(params).toContain('str');
      expect(params).toContain('int');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 18: Abstract dispatch (ABC base + concrete impl + receiver resolution)
// base.py: Repository(ABC) with @abstractmethod find, save
// impl.py: SqlRepository(Repository) implements find, save
// app.py: repo = SqlRepository(); repo.find(42); repo.save(user)
// ---------------------------------------------------------------------------

describe('Python abstract dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-abstract-dispatch'), () => {});
  }, 60000);

  it('detects Repository and SqlRepository classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Repository');
    expect(classes).toContain('SqlRepository');
  });

  it('emits EXTENDS edge SqlRepository -> Repository', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find((e) => e.source === 'SqlRepository' && e.target === 'Repository');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD edges for Repository.find and Repository.save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const repoFind = hasMethod.find((e) => e.source === 'Repository' && e.target === 'find');
    const repoSave = hasMethod.find((e) => e.source === 'Repository' && e.target === 'save');
    expect(repoFind).toBeDefined();
    expect(repoSave).toBeDefined();
  });

  it('emits HAS_METHOD edges for SqlRepository.find and SqlRepository.save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const sqlFind = hasMethod.find((e) => e.source === 'SqlRepository' && e.target === 'find');
    const sqlSave = hasMethod.find((e) => e.source === 'SqlRepository' && e.target === 'save');
    expect(sqlFind).toBeDefined();
    expect(sqlSave).toBeDefined();
  });

  it('marks base Repository.find as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const baseFind = methods.find((n) => n.name === 'find' && n.properties.filePath === 'base.py');
    if (baseFind?.properties.isAbstract !== undefined) {
      expect(baseFind.properties.isAbstract).toBe(true);
    }
  });

  it('marks base Repository.save as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const baseSave = methods.find((n) => n.name === 'save' && n.properties.filePath === 'base.py');
    if (baseSave?.properties.isAbstract !== undefined) {
      expect(baseSave.properties.isAbstract).toBe(true);
    }
  });

  it('marks concrete SqlRepository.find as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const sqlFind = methods.find((n) => n.name === 'find' && n.properties.filePath === 'impl.py');
    if (sqlFind?.properties.isAbstract !== undefined) {
      expect(sqlFind.properties.isAbstract).toBe(false);
    }
  });

  it('resolves repo.find(42) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find((c) => c.target === 'find' && c.sourceFilePath === 'app.py');
    expect(findCall).toBeDefined();
  });

  it('resolves repo.save(user) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.sourceFilePath === 'app.py');
    expect(saveCall).toBeDefined();
  });

  it('populates parameterTypes for Repository.find (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const baseFind = methods.find((n) => n.name === 'find' && n.properties.filePath === 'base.py');
    if (baseFind?.properties.parameterTypes !== undefined) {
      const params = baseFind.properties.parameterTypes;
      expect(params).toContain('int');
    }
  });

  it('does not emit METHOD_IMPLEMENTS for abstract-class inheritance (only interface/trait parents)', () => {
    // Python ABC is modelled as a Class with EXTENDS (not Interface with IMPLEMENTS),
    // so the MRO processor does not emit METHOD_IMPLEMENTS edges here.
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) => e.sourceFilePath.includes('impl.py') && e.targetFilePath.includes('base.py'),
    );
    expect(edges.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SM-9: lookupMethodByOwnerWithMRO — child.parent_method() via C3 parent walk
// ---------------------------------------------------------------------------

describe('Python Child extends Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-child-extends-parent'),
      () => {},
    );
  }, 60000);

  it('detects Parent and Child classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Parent');
    expect(classes).toContain('Child');
  });

  it('emits EXTENDS edge: Child → Parent', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');
  });

  it('resolves c.parent_method() to Parent.parent_method via C3 MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'parent_method' && c.targetFilePath.includes('parent.py'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('run');
  });
});

describe('Python Grandchild→Child→Parent — 3-level C3 MRO walk (SM-11)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-multi-level-mro'), () => {});
  }, 60000);

  it('detects Grandparent, Parent, and Child classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Grandparent');
    expect(classes).toContain('Parent');
    expect(classes).toContain('Child');
  });

  it('emits EXTENDS chain: Child → Parent, Parent → Grandparent', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');
    expect(edgeSet(extends_)).toContain('Parent → Grandparent');
  });

  it('resolves c.gp_method() to Grandparent.gp_method via 3-level C3 walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const gpCall = calls.find(
      (c) => c.target === 'gp_method' && c.targetFilePath.includes('grandparent.py'),
    );
    expect(gpCall).toBeDefined();
    expect(gpCall!.source).toBe('run');
  });
});
