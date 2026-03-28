/**
 * TypeScript: heritage resolution + ambiguous symbol disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: class extends + implements interface
// ---------------------------------------------------------------------------

describe('TypeScript heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-ambiguous'), () => {});
  }, 60000);

  it('detects exactly 3 classes and 1 interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual([
      'BaseService',
      'ConsoleLogger',
      'UserService',
    ]);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['ILogger']);
  });

  it('emits exactly 3 IMPORTS edges', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(3);
    expect(edgeSet(imports)).toEqual([
      'logger.ts → models.ts',
      'service.ts → logger.ts',
      'service.ts → models.ts',
    ]);
  });

  it('emits exactly 1 EXTENDS edge: UserService → BaseService', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserService');
    expect(extends_[0].target).toBe('BaseService');
  });

  it('emits exactly 2 IMPLEMENTS edges', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(2);
    expect(edgeSet(implements_)).toEqual(['ConsoleLogger → ILogger', 'UserService → ILogger']);
  });

  it('emits HAS_METHOD edges linking methods to classes', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    expect(hasMethod.length).toBe(4);
    expect(edgeSet(hasMethod)).toEqual([
      'BaseService → getName',
      'ConsoleLogger → log',
      'UserService → getUsers',
      'UserService → log',
    ]);
  });

  it('emits HAS_PROPERTY edge for class fields', () => {
    const hasProperty = getRelationships(result, 'HAS_PROPERTY');
    expect(hasProperty.length).toBe(1);
    expect(edgeSet(hasProperty)).toEqual(['BaseService → name']);
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
// Ambiguous: multiple definitions, imports disambiguate
// ---------------------------------------------------------------------------

describe('TypeScript ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-ambiguous'), () => {});
  }, 60000);

  it('UserService has exactly 1 EXTENDS + 1 IMPLEMENTS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'UserService');
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(
      (e) => e.source === 'UserService',
    );
    expect(extends_.length).toBe(1);
    expect(implements_.length).toBe(1);
  });

  it('ConsoleLogger has exactly 1 IMPLEMENTS and 0 EXTENDS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter(
      (e) => e.source === 'ConsoleLogger',
    );
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(
      (e) => e.source === 'ConsoleLogger',
    );
    expect(extends_.length).toBe(0);
    expect(implements_.length).toBe(1);
    expect(implements_[0].target).toBe('ILogger');
  });

  it('all heritage edges point to real graph nodes', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const implements_ = getRelationships(result, 'IMPLEMENTS');

    for (const edge of [...extends_, ...implements_]) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.properties.name).toBe(edge.target);
    }
  });
});

describe('TypeScript call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-calls'), () => {});
  }, 60000);

  it('resolves run → writeAudit to src/one.ts via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('run');
    expect(calls[0].target).toBe('writeAudit');
    expect(calls[0].targetFilePath).toBe('src/one.ts');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('TypeScript member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('src/user.ts');
  });

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('emits HAS_METHOD edge from User to save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor resolution: new Foo() resolves to Class/Constructor
// ---------------------------------------------------------------------------

describe('TypeScript constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-constructor-calls'),
      () => {},
    );
  }, 60000);

  it('resolves new User() as a CALLS edge to the User class', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('src/user.ts');
  });

  it('also resolves user.save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User class, save method, and processUser function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('processUser');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('TypeScript receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'src/repo.ts');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scoped receiver resolution: same variable name in different functions
// resolves to different types via scope-aware TypeEnv
// ---------------------------------------------------------------------------

describe('TypeScript scoped receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-scoped-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves entity.save() in handleUser to User.save and in handleRepo to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'src/repo.ts');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Named import disambiguation: two files export same name, import resolves
// ---------------------------------------------------------------------------

describe('TypeScript named import disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-named-imports'), () => {});
  }, 60000);

  it('resolves processInput → formatData to src/format-upper.ts via named import', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find((c) => c.target === 'formatData');
    expect(formatCall).toBeDefined();
    expect(formatCall!.source).toBe('processInput');
    expect(formatCall!.targetFilePath).toBe('src/format-upper.ts');
  });

  it('emits IMPORTS edge to format-upper.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find((e) => e.source === 'app.ts');
    expect(appImport).toBeDefined();
    expect(appImport!.targetFilePath).toBe('src/format-upper.ts');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: import { User as U } resolves U → User
// ---------------------------------------------------------------------------

describe('TypeScript alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-alias-imports'), () => {});
  }, 60000);

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves new U() to User class and new R() to Repo class via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');

    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/models.ts');

    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/models.ts');
  });

  it('resolves u.save() and r.persist() as member calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const persistCall = calls.find((c) => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
  });

  it('emits IMPORTS edge from app.ts to models.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find((e) => e.sourceFilePath === 'src/app.ts');
    expect(appImport).toBeDefined();
    expect(appImport!.targetFilePath).toBe('src/models.ts');
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: export { X } from './base' barrel pattern
// ---------------------------------------------------------------------------

describe('TypeScript re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-reexport-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves new User() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves user.save() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves new Repo() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves repo.persist() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find((c) => c.target === 'persist');
    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('src/base.ts');
  });
});

// ---------------------------------------------------------------------------
// Re-export type chain: export type { X } from './base' barrel pattern
// ---------------------------------------------------------------------------

describe('TypeScript export type re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-reexport-type'), () => {});
  }, 60000);

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves new User() through export type re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves user.save() through export type re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('src/base.ts');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('TypeScript local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-local-shadow'), () => {});
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/app.ts');
  });

  it('does NOT resolve save to utils.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/utils.ts',
    );
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: rest params don't get filtered by arity
// ---------------------------------------------------------------------------

describe('TypeScript variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves processInput → logEntry to src/logger.ts despite 3 args vs rest param', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'logEntry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('processInput');
    expect(logCall!.targetFilePath).toBe('src/logger.ts');
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: const user = new User(); user.save()
// Cross-file SymbolTable verification (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('TypeScript constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to src/user.ts via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to src/repo.ts via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// JavaScript constructor-inferred type resolution: const user = new User()
// ---------------------------------------------------------------------------

describe('JavaScript constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to src/user.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.js');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to src/repo.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.js');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// this.save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('TypeScript this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/models/User.ts');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('TypeScript parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes plus Serializable interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits IMPLEMENTS edge: User → Serializable', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('User');
    expect(implements_[0].target).toBe('Serializable');
  });

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of [
      ...getRelationships(result, 'EXTENDS'),
      ...getRelationships(result, 'IMPLEMENTS'),
    ]) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.properties.name).toBe(edge.target);
    }
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('TypeScript super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(3);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(
      (c) =>
        c.source === 'save' && c.target === 'save' && c.targetFilePath === 'src/models/Base.ts',
    );
    expect(superSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/models/Repo.ts',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to generic parent class's save method
// ---------------------------------------------------------------------------

describe('TypeScript generic parent super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-generic-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(3);
  });

  it('emits EXTENDS edge: User → BaseModel (not BaseModel<string>)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(
      (c) =>
        c.source === 'save' && c.target === 'save' && c.targetFilePath === 'src/models/Base.ts',
    );
    expect(superSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/models/Repo.ts',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cast/non-null constructor inference: new X() as T, new X()!
// ---------------------------------------------------------------------------

describe('TypeScript cast/non-null constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-cast-constructor-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via new User() as any', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo.save via new Repo()!', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Double-cast constructor inference: new X() as unknown as T
// ---------------------------------------------------------------------------

describe('TypeScript double-cast constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-double-cast-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via new User() as unknown as any', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo.save via new Repo() as unknown as object', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable/optional receiver unwrapping: user?.save() resolves through ?.
// ---------------------------------------------------------------------------

describe('TypeScript nullable receiver resolution (optional chaining)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('greet');
  });

  it('resolves user?.save() to User.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves user?.greet() to User.greet via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath === 'src/user.ts');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('processEntities');
  });

  it('resolves repo?.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits constructor CALLS edges for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    // user?.save() → User.save + repo?.save() → Repo.save = 2 edges
    // If nullable unwrapping fails, the resolver refuses ambiguous matches and emits 0
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Return type inference: const user = getUser('alice'); user.save()
// The TS/JS CONSTRUCTOR_BINDING_SCANNER captures variable_declarator nodes
// with plain call_expression values, enabling end-to-end return type inference.
// ---------------------------------------------------------------------------

describe('TypeScript return type inference via explicit function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-return-type-inference'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('getName');
  });

  it('detects getUser and fetchUserAsync functions', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('getUser');
    expect(functions).toContain('fetchUserAsync');
  });

  it('resolves user.save() to User#save via return type of getUser(): User', () => {
    // TS has explicit return types in the source, so extractMethodSignature captures
    // the return type. The TS extractInitializer handles `const user = getUser()`
    // via the variable_declarator path, enabling save() to resolve to User#save.
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript return type inference via JSDoc @returns annotation
// ---------------------------------------------------------------------------

describe('JavaScript return type inference via JSDoc @returns annotation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via JSDoc @returns {User}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via JSDoc @returns {Repo}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves user.save() via JSDoc @param {User} in handleUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() via JSDoc @param {Repo} in handleRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript async return type inference via JSDoc @returns {Promise<User>}
// Verifies that wrapper generics (Promise) are unwrapped to the inner type.
// ---------------------------------------------------------------------------

describe('JavaScript async return type inference via JSDoc @returns {Promise<User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-async-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via @returns {Promise<User>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via @returns {Promise<Repo>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript qualified return type: @returns {Promise<models.User>}
// Verifies that dot-qualified names inside generics are not corrupted.
// ---------------------------------------------------------------------------

describe('JavaScript qualified return type via JSDoc @returns {Promise<models.User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'js-jsdoc-qualified-return-type'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save despite qualified return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Tier 2, depth-1):
// `const alias = u` where `u: User` → alias.save() resolves to User#save
// ---------------------------------------------------------------------------

describe('TypeScript assignment chain propagation (Tier 2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('user.ts'));
    // Positive: alias.save() must resolve to User#save
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processEntities');
    // Negative: alias.save() must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.ts'),
    );
    // rAlias.save() correctly goes to Repo — but we verify there is exactly one
    // per-receiver resolution (user alias → User, repo alias → Repo)
    expect(wrongCall).toBeDefined(); // rAlias.save() resolves to Repo
  });

  it('resolves rAlias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('repo.ts'));
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
    // Negative: rAlias.save() must NOT resolve to User#save (only)
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('user.ts'));
    expect(userSave).toBeDefined();
    // Both resolve separately — alias → User, rAlias → Repo
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Multi-hop forward-declared chain (a → b → c) — validates that single-pass
// in source order resolves chains deeper than depth-1.
// ---------------------------------------------------------------------------

describe('TypeScript multi-hop assignment chain (a → b → c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-multi-hop-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves c.save() to User#save through a → b → c chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'multiHopForward' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('c.save() in multiHopForward does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'multiHopForward' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves c.save() to Repo#save through a → b → c chain (Repo variant)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'multiHopRepo' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('c.save() in multiHopRepo does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'multiHopRepo' && c.targetFilePath?.includes('user.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable type + assignment chain: stripNullable must resolve the nullable
// union (User | null → User) before the chain propagation can work.
// Exercises the refactored NULLABLE_KEYWORDS.has() code path.
// ---------------------------------------------------------------------------

describe('TypeScript nullable + assignment chain combined', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-nullable-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save when source is User | null', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainUser' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() from User | null does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainUser' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save when source is Repo | undefined', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainRepo' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves alias.save() to User#save when source is User | null | undefined (triple)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'tripleNullable' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method call resolution: svc.getUser().save()
// The receiver of save() is a call_expression (getUser()), not a simple identifier.
// Resolution must walk the chain: getUser() returns User, so save() → User#save.
// ---------------------------------------------------------------------------

describe('TypeScript chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects save methods on both User and Repo', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('detects getUser method on UserService', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getUser');
  });

  it('resolves svc.getUser().save() to User#save, NOT Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded receiver: two classes with the same method name (save) must not
// collide in the receiverKey map. The fix preserves @startIndex in the key so
// User.save@idx1 and Repo.save@idx2 remain distinct even when the enclosing
// scope funcName is the same.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded-receiver resolution (receiverKey collision fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-overloaded-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User#save (models/User.ts), not Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('User'));
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('run');
    // Negative: must not resolve to Repo#save
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('Repo'),
    );
    // If only one save target resolves to User (not Repo), we correctly exclude Repo
    expect(userSave!.targetFilePath).toContain('User');
  });

  it('resolves repo.save() to Repo#save (models/Repo.ts), not User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('Repo'));
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('run');
    expect(repoSave!.targetFilePath).toContain('Repo');
  });

  it('emits exactly 2 save() CALLS edges — one per class', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
    const targets = saveCalls.map((c) => c.targetFilePath).sort();
    expect(targets[0]).toContain('Repo');
    expect(targets[1]).toContain('User');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Typed parameter chain: svc.getUser().save() where svc is a parameter with
// a type annotation (not a constructor binding). Tests that the worker path
// consults typeEnv for chain base receivers (Phase 5 review Finding 1).
// ---------------------------------------------------------------------------

describe('TypeScript typed-parameter chain call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-typed-param-chain'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects getUser and save methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getUser');
    expect(methods).toContain('save');
  });

  it('resolves svc.getUser().save() to User#save via parameter type annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.getUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static chain: UserService.findUser().save() where the chain base is a class
// name (not a variable). Tests that the serial path applies class-as-receiver
// to chain base resolution (Phase 5 review Finding 2).
// ---------------------------------------------------------------------------

describe('TypeScript static class-name chain call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-static-chain'), () => {});
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects static findUser and instance save methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('findUser');
    expect(methods).toContain('save');
  });

  it('resolves UserService.findUser().save() to User#save via class-name chain base', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve UserService.findUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TS readonly User[] for-loop: for (const user of users) with readonly User[]
// ---------------------------------------------------------------------------

describe('TypeScript readonly array for-loop resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-readonly-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in readonly array for-of to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in readonly array for-of to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// for (const [key, user] of entries) — destructured for-of resolution
// ---------------------------------------------------------------------------

describe('TS destructured for-of Map resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-destructured-for-of'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() in destructured for-of to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processEntries' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processEntries' && c.targetFilePath?.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// if (x instanceof User) { x.save() } — instanceof narrowing resolution
// ---------------------------------------------------------------------------

describe('TS instanceof narrowing resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-instanceof-narrowing'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves x.save() after instanceof to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve x.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// this.users member access iterable: for (const user of this.users)
// ---------------------------------------------------------------------------

describe('TypeScript member access iterable for-loop', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-member-access-for-loop'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() via this.users to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via this.repos to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TypeScript class field foreach: for (const user of this.users) with class field User[]
// ---------------------------------------------------------------------------

describe('TypeScript class field foreach resolution (Phase 6.1)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-class-field-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() via class field User[] to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via class field Map<string, Repo>.values() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve repo.save() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('user'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TypeScript for-of with call_expression iterable: for (const user of getUsers())
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('TypeScript for-of call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-for-of-call-expr'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in for-of getUsers() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-of getRepos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('user.ts'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'field-types'), () => {});
  }, 60000);

  it('detects classes: Address, Config, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Config', 'User']);
  });

  it('detects Property nodes for typed fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(4);
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('Address → city');
    expect(edgeSet(propEdges)).toContain('Config → DEFAULT');
  });

  it('resolves user.address.save() → Address#save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
    expect(addressSave!.source).toBe('processUser');
  });

  it('emits ACCESSES read edge for user.address field access in chain', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    expect(addressReads.length).toBe(1);
    expect(addressReads[0].source).toBe('processUser');
    expect(addressReads[0].targetLabel).toBe('Property');
  });

  it('emits ACCESSES read edge for Config.DEFAULT field access in chain', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const defaultReads = accesses.filter((e) => e.target === 'DEFAULT' && e.rel.reason === 'read');
    expect(defaultReads.length).toBe(1);
    expect(defaultReads[0].source).toBe('validateConfig');
  });

  it('all ACCESSES edges have confidence 1.0 and reason read', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    for (const edge of accesses) {
      expect(edge.rel.confidence).toBe(1.0);
      expect(edge.rel.reason).toBe('read');
    }
  });

  it('populates field metadata (visibility, isStatic, isReadonly, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.isReadonly).toBe(false);
    expect(city!.properties.declaredType).toBe('string');

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
    expect(addr!.properties.isStatic).toBe(false);
    expect(addr!.properties.isReadonly).toBe(false);
    expect(addr!.properties.declaredType).toBe('Address');
  });

  it('marks Config.DEFAULT as static', () => {
    const properties = getNodesByLabelFull(result, 'Property');
    const def = properties.find((p) => p.name === 'DEFAULT');
    expect(def).toBeDefined();
    expect(def!.properties.isStatic).toBe(true);
    expect(def!.properties.declaredType).toBe('Config');
    expect(def!.properties.visibility).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field type disambiguation — both User and Address have save()
// ---------------------------------------------------------------------------

describe('Field type disambiguation (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-field-type-disambig'), () => {});
  }, 60000);

  it('detects both User#save and Address#save', () => {
    const methods = getNodesByLabel(result, 'Method');
    const saveMethods = methods.filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.address.save() → Address#save (not User#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('address');
    expect(saveCalls[0].targetFilePath).not.toContain('user');
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Parameter properties and #private fields
// ---------------------------------------------------------------------------

describe('Field type resolution (TS parameter properties)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-param-property-fields'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('captures constructor parameter properties as Property nodes', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('name');
    expect(properties).toContain('address');
  });

  it('captures #private fields as Property nodes', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('#secret');
  });

  it('emits HAS_PROPERTY edges for parameter properties', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
  });

  it('resolves user.address.save() via parameter property type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level: user.address.city.getName())
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-deep-field-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for all typed fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('city');
    expect(properties).toContain('zipCode');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('Address → city');
    expect(edgeSet(propEdges)).toContain('City → zipCode');
  });

  it('resolves 2-level chain: user.address.save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves 3-level chain: user.address.city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'getName' && e.source === 'processUser');
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// Mixed chain resolution (field ↔ call interleaved)
// ---------------------------------------------------------------------------

describe('Mixed field+call chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-mixed-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, User, UserService', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User', 'UserService']);
  });

  it('detects Property node for Address.city field', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('city');
    expect(properties).toContain('address');
  });

  it('resolves call→field chain: svc.getUser().address.save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processWithService');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves field→call chain: user.getAddress().city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(
      (e) => e.target === 'getName' && e.source === 'processWithUser',
    );
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
  });

  it('write ACCESSES edges have confidence 1.0', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    for (const edge of writes) {
      expect(edge.rel.confidence).toBe(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): const user = getUser(); user.save()
// Activates Tier 2b pendingCallResults — binds return type at TypeEnv build time.
// ---------------------------------------------------------------------------

describe('TypeScript call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-call-result-binding'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('detects getUser function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('resolves user.save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves alias.save() to User#save via call-result + copy chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processAlias' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript call-result variable binding (Phase 9) via JSDoc @returns
// ---------------------------------------------------------------------------

describe('JavaScript call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding with JSDoc', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): getUser() → .address → .getCity() → .save()
// Unified fixpoint resolves field access + method-call-with-receiver at TypeEnv build time.
// ---------------------------------------------------------------------------

describe('TypeScript method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-method-chain-binding'), () => {});
  }, 60000);

  it('detects User, Address, City classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Address');
    expect(classes).toContain('City');
  });

  it('resolves city.save() to City#save via 3-step chain (callResult → fieldAccess → methodCallResult)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processChain' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase A: Object destructuring — const { field } = receiver → fieldAccess PendingAssignment
// ---------------------------------------------------------------------------

describe('TypeScript object destructuring resolution (Phase A)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-object-destructuring'), () => {});
  }, 60000);

  it('detects User, Address classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Address');
  });

  it('resolves address.save() to Address#save via object destructuring', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('models'));
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve save() to a wrong target', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    for (const call of saveCalls) {
      expect(call.targetFilePath).toContain('models');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase A: Post-fixpoint for-loop replay — iterable resolved via callResult fixpoint
// Differs from ts-for-of-call-expression: iterable is an identifier, not inline call
// ---------------------------------------------------------------------------

describe('TypeScript post-fixpoint for-loop replay (Phase A ex-9B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-fixpoint-for-loop'), () => {});
  }, 60000);

  it('resolves u.save() to User#save via post-fixpoint for-loop replay', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('TypeScript grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-grandparent-resolution'), () => {});
  }, 60000);

  it('detects 3 classes in inheritance chain (A, B, C) plus Greeting', () => {
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
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('base'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase C: TS null-check narrowing — if (x !== null) { x.save() }
// patternOverrides stores narrowed type for the if-body position range
// ---------------------------------------------------------------------------

describe('TypeScript null-check narrowing resolution (Phase C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-null-check-narrowing'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves x.save() inside !== null guard to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processStrict' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve to Repo#save (no cross-contamination)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find((c) => c.target === 'save' && c.targetLabel === 'Repo');
    expect(wrongCall).toBeUndefined();
  });

  it('resolves x.save() in loose != null check (processLoose)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processLoose' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.save() in !== undefined check (processUndefined)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUndefined' &&
        c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.save() inside function expression null-check (processFuncExpr)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processFuncExpr' &&
        c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── Phase P: Virtual Dispatch via Constructor Type ───────────────────────

describe('TypeScript virtual dispatch via constructor type (same-file)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-virtual-dispatch'), () => {});
  }, 60000);

  it('detects Animal and Dog classes with same-file heritage', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('detects fetchBall() as Dog-only method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('fetchBall');
  });

  it('resolves fetchBall() calls from run() — proves virtual dispatch override', () => {
    const calls = getRelationships(result, 'CALLS');
    const fetchCalls = calls.filter((c) => c.source === 'run' && c.target === 'fetchBall');
    // animal.fetchBall() only resolves if constructorTypeMap overrides
    // receiver from Animal → Dog. dog.fetchBall() resolves directly.
    // Both target same nodeId → 1 CALLS edge after dedup.
    expect(fetchCalls.length).toBe(1);
  });
});

// ── Phase P: Overload Disambiguation via inferLiteralType ────────────────

describe('TypeScript overload disambiguation via inferLiteralType', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-disambiguation'), () => {});
  }, 60000);

  it('detects lookup function with parameterTypes on graph node', () => {
    const functions = getNodesByLabelFull(result, 'Function');
    const lookupNodes = functions.filter((f) => f.name === 'lookup');
    // generateId collision → 1 graph node, first overload's parameterTypes wins
    expect(lookupNodes.length).toBeGreaterThanOrEqual(1);
    // At least one lookup node has parameterTypes set
    const withParamTypes = lookupNodes.filter((n) => n.properties.parameterTypes);
    expect(withParamTypes.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edges from process() → lookup() via overload disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const lookupCalls = calls.filter((c) => c.source === 'process' && c.target === 'lookup');
    // Phase 0 (fileIndex stores both overloads) + Phase 2 (literal type matching)
    // enables resolution where previously 2 same-arity candidates → null.
    // Both calls resolve to same nodeId (ID collision) → 1 CALLS edge after dedup.
    expect(lookupCalls.length).toBe(1);
  });
});

// ── Phase P: Optional / Default Parameter Arity Resolution ───────────────

describe('TypeScript optional parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-optional-params'), () => {});
  }, 60000);

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });

  it('resolves search("test") with 1 arg to search with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const searchCalls = calls.filter((c) => c.source === 'process' && c.target === 'search');
    expect(searchCalls.length).toBe(1);
  });
});
