/**
 * TypeScript: heritage resolution + ambiguous symbol disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: class extends + implements interface
// ---------------------------------------------------------------------------

describe('TypeScript heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects exactly 3 classes and 1 interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseService', 'ConsoleLogger', 'UserService']);
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
    expect(edgeSet(implements_)).toEqual([
      'ConsoleLogger → ILogger',
      'UserService → ILogger',
    ]);
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-ambiguous'),
      () => {},
    );
  }, 60000);

  it('UserService has exactly 1 EXTENDS + 1 IMPLEMENTS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter(e => e.source === 'UserService');
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(e => e.source === 'UserService');
    expect(extends_.length).toBe(1);
    expect(implements_.length).toBe(1);
  });

  it('ConsoleLogger has exactly 1 IMPLEMENTS and 0 EXTENDS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter(e => e.source === 'ConsoleLogger');
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(e => e.source === 'ConsoleLogger');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-calls'),
      () => {},
    );
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
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
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'save');
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
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('src/user.ts');
  });

  it('also resolves user.save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
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
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'src/repo.ts');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find(c => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find(c => c.target === 'Repo' && c.targetLabel === 'Class');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-scoped-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves entity.save() in handleUser to User.save and in handleRepo to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'src/repo.ts');

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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-named-imports'),
      () => {},
    );
  }, 60000);

  it('resolves processInput → formatData to src/format-upper.ts via named import', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find(c => c.target === 'formatData');
    expect(formatCall).toBeDefined();
    expect(formatCall!.source).toBe('processInput');
    expect(formatCall!.targetFilePath).toBe('src/format-upper.ts');
  });

  it('emits IMPORTS edge to format-upper.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find(e => e.source === 'app.ts');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves new U() to User class and new R() to Repo class via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find(c => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find(c => c.target === 'Repo' && c.targetLabel === 'Class');

    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/models.ts');

    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/models.ts');
  });

  it('resolves u.save() and r.persist() as member calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    const persistCall = calls.find(c => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
  });

  it('emits IMPORTS edge from app.ts to models.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find(e => e.sourceFilePath === 'src/app.ts');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-reexport-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves new User() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find(c => c.target === 'User' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves user.save() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves new Repo() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoCtor = calls.find(c => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves repo.persist() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find(c => c.target === 'persist');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-reexport-type'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves new User() through export type re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find(c => c.target === 'User' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves user.save() through export type re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/app.ts');
  });

  it('does NOT resolve save to utils.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/utils.ts');
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
    const logCall = calls.find(c => c.target === 'logEntry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('processInput');
    expect(logCall!.targetFilePath).toBe('src/logger.ts');
  });
});

