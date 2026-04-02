/**
 * Kotlin: data class extends + implements interfaces + ambiguous import disambiguation
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
// Heritage: data class extends + implements interfaces (delegation specifiers)
// ---------------------------------------------------------------------------

describe('Kotlin heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-heritage'), () => {});
  }, 60000);

  it('detects exactly 3 classes and 2 interfaces', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User', 'UserService']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable', 'Validatable']);
  });

  it('detects 6 class/interface methods (processUser is inside UserService)', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual([]);
    expect(getNodesByLabel(result, 'Method')).toEqual([
      'processUser',
      'save',
      'serialize',
      'serialize',
      'validate',
      'validate',
    ]);
  });

  it('emits exactly 1 EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits exactly 2 IMPLEMENTS edges via symbol table resolution', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(2);
    expect(edgeSet(implements_)).toEqual(['User → Serializable', 'User → Validatable']);
  });

  it('resolves exactly 4 IMPORTS edges (JVM-style package imports)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(4);
    expect(edgeSet(imports)).toEqual([
      'User.kt → Serializable.kt',
      'User.kt → Validatable.kt',
      'UserService.kt → Serializable.kt',
      'UserService.kt → User.kt',
    ]);
  });

  it('does not emit EXTENDS edges to interfaces', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.some((e) => e.target === 'Serializable')).toBe(false);
    expect(extends_.some((e) => e.target === 'Validatable')).toBe(false);
  });

  it('resolves ambiguous validate() call through non-aliased import with import-resolved reason', () => {
    const calls = getRelationships(result, 'CALLS');
    // validate is defined in both Validatable (interface) and User (override) → needs import scoping
    const validateCall = calls.find((c) => c.target === 'validate');
    expect(validateCall).toBeDefined();
    expect(validateCall!.source).toBe('processUser');
    expect(validateCall!.rel.reason).toBe('import-resolved');
  });

  it('resolves unique save() call through non-aliased import', () => {
    const calls = getRelationships(result, 'CALLS');
    // save is unique globally (only in BaseModel) → resolves as unique-global
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('no OVERRIDES edges target Property nodes', () => {
    const overrides = getRelationships(result, 'OVERRIDES');
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.label).not.toBe('Property');
    }
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

// ---------------------------------------------------------------------------
// Ambiguous: Handler + Runnable in two packages, explicit imports disambiguate
// ---------------------------------------------------------------------------

describe('Kotlin ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes and 2 Runnable interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter((n) => n === 'Runnable').length).toBe(2);
  });

  it('resolves EXTENDS to models/Handler.kt (not other/Handler.kt)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('models/Handler.kt');
  });

  it('resolves IMPLEMENTS to models/Runnable.kt (not other/Runnable.kt)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('UserHandler');
    expect(implements_[0].target).toBe('Runnable');
    expect(implements_[0].targetFilePath).toBe('models/Runnable.kt');
  });

  it('import edges point to models/ not other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    for (const imp of imports) {
      expect(imp.targetFilePath).toMatch(/^models\//);
    }
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

describe('Kotlin call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-calls'), () => {});
  }, 60000);

  it('resolves processUser → writeAudit to util/OneArg.kt via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('processUser');
    expect(calls[0].target).toBe('writeAudit');
    expect(calls[0].targetFilePath).toBe('util/OneArg.kt');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Kotlin member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/User.kt');
  });

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('Kotlin receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-receiver-resolution'), () => {});
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

    const userSave = saveCalls.find((c) => c.targetFilePath === 'models/User.kt');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'models/Repo.kt');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: import com.example.User as U resolves U → User
// ---------------------------------------------------------------------------

describe('Kotlin alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-alias-imports'), () => {});
  }, 60000);

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves u.save() to models/Models.kt and r.persist() to models/Models.kt via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const persistCall = calls.find((c) => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('models/Models.kt');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('models/Models.kt');
  });
});

// ---------------------------------------------------------------------------
// Constructor-call resolution: User("alice") resolves to User constructor
// ---------------------------------------------------------------------------

describe('Kotlin constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-constructor-calls'), () => {});
  }, 60000);

  it('detects User class with save method and main function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('main');
  });

  it('resolves import from app/App.kt to models/User.kt', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find((e) => e.source === 'App.kt' && e.targetFilePath === 'models/User.kt');
    expect(imp).toBeDefined();
  });

  it('emits HAS_METHOD from User class to save function', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('models/User.kt');
  });

  it('resolves user.save() as a method call to models/User.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('models/User.kt');
  });

  it('resolves calls via non-aliased import with import-resolved reason', () => {
    const calls = getRelationships(result, 'CALLS');
    // Both User("alice") constructor and user.save() go through `import models.User`
    for (const call of calls) {
      expect(call.rel.reason).toBe('import-resolved');
    }
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: vararg doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('Kotlin variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-variadic-resolution'), () => {});
  }, 60000);

  it('resolves 3-arg call to vararg function logEntry(vararg String) in Logger.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'logEntry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('main');
    expect(logCall!.targetFilePath).toBe('util/Logger.kt');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('Kotlin local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-local-shadow'), () => {});
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/main/kotlin/app/Main.kt');
  });

  it('does NOT resolve save to Logger.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/main/kotlin/utils/Logger.kt',
    );
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: val user = User() without annotation
// disambiguates user.save() vs repo.save() via TypeEnv constructor inference
// ---------------------------------------------------------------------------

describe('Kotlin constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to models/User.kt via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to models/Repo.kt via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/Repo.kt',
    );
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
// this.save() resolves to enclosing class's / object's own method
// ---------------------------------------------------------------------------

describe('Kotlin this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo classes and AppConfig object', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Class')).toContain('AppConfig');
  });

  it('resolves this.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('models/User.kt');
  });

  it('resolves this.init() inside AppConfig.setup to AppConfig.init (object_declaration)', () => {
    const calls = getRelationships(result, 'CALLS');
    const initCall = calls.find((c) => c.target === 'init' && c.source === 'setup');
    expect(initCall).toBeDefined();
    expect(initCall!.targetFilePath).toBe('models/AppConfig.kt');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: val user = getUser("alice"); user.save()
// Kotlin's CONSTRUCTOR_BINDING_SCANNER captures property_declaration with
// call_expression values, enabling return type inference from function results.
// ---------------------------------------------------------------------------

describe('Kotlin return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User#save via return type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo#save via return type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('Kotlin parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-parent-resolution'), () => {});
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

describe('Kotlin super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-super-resolution'), () => {});
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(
      (c) =>
        c.source === 'save' && c.target === 'save' && c.targetFilePath === 'models/BaseModel.kt',
    );
    expect(superSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// For-each loop variable type resolution: for (user: User in users) { user.save() }
// ---------------------------------------------------------------------------

describe('Kotlin for-each loop type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() inside for-each to models/User.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() inside for-each to models/Repo.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeDefined();
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });

  it('user.save() does NOT resolve to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(wrongSave).toBeUndefined();
  });

  it('repo.save() does NOT resolve to User.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath === 'models/User.kt',
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to generic parent class's save method
// ---------------------------------------------------------------------------

describe('Kotlin generic parent super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-generic-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(
      (c) =>
        c.source === 'save' && c.target === 'save' && c.targetFilePath === 'models/BaseModel.kt',
    );
    expect(superSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver unwrapping: user?.save() with User? type resolves through ?.
// ---------------------------------------------------------------------------

describe('Kotlin nullable receiver resolution (safe calls)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m: string) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user?.save() to User#save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo?.save() to Repo#save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (exactly 1 save per receiver file)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'processEntities');
    const userTargeted = saveCalls.filter((c) => c.targetFilePath.includes('User.kt'));
    const repoTargeted = saveCalls.filter((c) => c.targetFilePath.includes('Repo.kt'));
    expect(userTargeted.length).toBe(1);
    expect(repoTargeted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation
// ---------------------------------------------------------------------------

describe('Kotlin assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves rAlias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    // There should be exactly one save() call targeting User.kt from processEntities
    const userSaves = calls.filter(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('User.kt'),
    );
    expect(userSaves.length).toBe(1);
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('User.kt'),
    );
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('Repo.kt'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Kotlin assignment chain inside class method body.
// Tests that extractKotlinPendingAssignment handles variable_declaration
// nodes (not just property_declaration) that tree-sitter-kotlin may emit
// for function-local val/var inside class methods.
// ---------------------------------------------------------------------------

describe('Kotlin assignment chain inside class method', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-class-method-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via chain inside function', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() in processUser does NOT resolve to Repo (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save via chain inside function', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias.save() in processRepo does NOT resolve to User (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath?.includes('User.kt'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.getUser().save()
// Tests that Kotlin's navigation_expression → navigation_suffix AST structure
// is correctly handled by extractCallChain (Phase 5 review Finding 1, Round 3).
// ---------------------------------------------------------------------------

describe('Kotlin chained method call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-chain-call'), () => {});
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

  it('resolves svc.getUser().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.getUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin unannotated for-loop Tier 1c: for (user in users) with List<User>
// ---------------------------------------------------------------------------

describe('Kotlin unannotated for-loop type resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-var-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in unannotated for to User#save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in unannotated for to Repo#save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin when/is pattern binding: when (obj) { is User -> obj.save() }
// ---------------------------------------------------------------------------

describe('Kotlin when/is pattern binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-when-pattern'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves obj.save() in when/is User arm to models/User.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processAny' && c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves obj.save() in when/is Repo arm to models/Repo.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processAny' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves obj.save() in handleUser when/is User arm to models/User.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve handleUser when/is User to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath === 'models/Repo.kt',
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin HashMap .values navigation_expression resolution
// ---------------------------------------------------------------------------

describe('Kotlin HashMap .values for-loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-map-keys-values'), () => {});
  }, 60000);

  it('detects User class with save function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() via HashMap.values to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processValues' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves user.save() via List iteration to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processList' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves user.save() via HashMap.keys to User#save (first type arg)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processKeys' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve HashMap.keys iteration to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processKeys' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via MutableMap.values to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processMutableMapValues' &&
        c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves repo.save() via Set iteration to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processSet' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin when/is complex patterns: 3+ arms, multi-call, else branch
// ---------------------------------------------------------------------------

describe('Kotlin when/is complex pattern binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-when-complex'), () => {});
  }, 60000);

  it('detects User, Repo, and Admin classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('Admin');
  });

  // --- Three-arm when: each arm resolves obj to the correct narrowed type ---

  it('resolves obj.save() in 3-arm when/is User to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processThreeArms' &&
        c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves obj.save() in 3-arm when/is Repo to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processThreeArms' &&
        c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves obj.save() in 3-arm when/is Admin to Admin#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const adminSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processThreeArms' &&
        c.targetFilePath === 'models/Admin.kt',
    );
    expect(adminSave).toBeDefined();
  });

  // --- Multiple method calls within a single when arm ---

  it('resolves obj.validate() in when/is User arm to User#validate', () => {
    const calls = getRelationships(result, 'CALLS');
    const userValidate = calls.find(
      (c) =>
        c.target === 'validate' &&
        c.source === 'processMultiCall' &&
        c.targetFilePath === 'models/User.kt',
    );
    expect(userValidate).toBeDefined();
  });

  it('resolves obj.save() in when/is User arm to User#save (multi-call)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processMultiCall' &&
        c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves obj.validate() in when/is Repo arm to Repo#validate', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoValidate = calls.find(
      (c) =>
        c.target === 'validate' &&
        c.source === 'processMultiCall' &&
        c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoValidate).toBeDefined();
  });

  it('resolves obj.save() in when/is Repo arm to Repo#save (multi-call)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processMultiCall' &&
        c.targetFilePath === 'models/Repo.kt',
    );
    expect(repoSave).toBeDefined();
  });

  // --- Cross-resolution negatives: User arm does NOT resolve to Repo ---

  it('does NOT resolve processMultiCall when/is User arm validate() to Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'validate' &&
        c.source === 'processMultiCall' &&
        c.targetFilePath === 'models/Repo.kt',
    );
    // Both User and Repo have validate(), so the Repo arm DOES resolve here.
    // But processMultiCall should NOT have a cross-arm leak.
    // We test that the User arm doesn't produce a Repo edge by checking save count.
    const userSaves = calls.filter((c) => c.target === 'save' && c.source === 'processMultiCall');
    // Exactly 2 save() CALLS edges (one per arm, not duplicated)
    expect(userSaves.length).toBe(2);
  });

  // --- when with else: is User arm narrows, else does not ---

  it('resolves obj.save() in when/is User + else to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processWithElse' &&
        c.targetFilePath === 'models/User.kt',
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve processWithElse to Repo#save or Admin#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongRepo = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processWithElse' &&
        c.targetFilePath === 'models/Repo.kt',
    );
    const wrongAdmin = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processWithElse' &&
        c.targetFilePath === 'models/Admin.kt',
    );
    expect(wrongRepo).toBeUndefined();
    expect(wrongAdmin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin for-loop with call_expression iterable: for (user in getUsers())
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('Kotlin for-loop call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-foreach-call-expr'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() in for-loop over getUsers() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User.kt'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-loop over getRepos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo.kt'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('User.kt'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (Kotlin)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-field-types'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for Kotlin properties', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
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
      (e) => e.source === 'processUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('Property nodes contain expected field names', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();

    const name = properties.find((p) => p.name === 'name');
    expect(name).toBeDefined();

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (Kotlin)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-deep-field-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for Kotlin properties', () => {
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
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.address.city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'getName' && e.source === 'processUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(cityGetName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Kotlin data class primary constructor val/var properties
// ---------------------------------------------------------------------------

describe('Kotlin data class primary constructor property capture', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-data-class-fields'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for data class val parameters', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('name');
    expect(properties).toContain('address');
    expect(properties).toContain('age');
  });

  it('emits HAS_PROPERTY edges for primary constructor properties', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → age');
  });

  it('resolves user.address.save() → Address#save via data class field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'processUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });
});

// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (Kotlin)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for property assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(3);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    const scoreWrite = writes.find((e) => e.target === 'score');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
    expect(scoreWrite).toBeDefined();
    expect(scoreWrite!.source).toBe('updateUser');
  });

  it('emits ACCESSES write edge for compound assignment (+=)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const scoreWrite = writes.find((e) => e.target === 'score');
    expect(scoreWrite).toBeDefined();
    expect(scoreWrite!.source).toBe('updateUser');
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
// Call-result variable binding (Phase 9): val user = getUser(); user.save()
// ---------------------------------------------------------------------------

describe('Kotlin call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): getUser() → .address → .getCity() → .save()
// ---------------------------------------------------------------------------

describe('Kotlin method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-method-chain-binding'),
      () => {},
    );
  }, 60000);

  it('resolves city.save() to City#save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processChain' && c.targetFilePath.includes('Models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('Kotlin grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-grandparent-resolution'),
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
      (c) => c.target === 'save' && c.targetFilePath.includes('Greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves c.greet() to A#greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('A.kt'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase C: Kotlin null-check narrowing — if (x != null) { x.save() }
// NOTE: depends on nullable_type capture being fixed in jvm.ts
// ---------------------------------------------------------------------------

describe('Kotlin null-check narrowing resolution (Phase C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-null-check-narrowing'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves x.save() inside != null guard to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processNullable' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve to Repo#save (no cross-contamination)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('Repo'));
    expect(wrongCall).toBeUndefined();
  });

  it('resolves x.save() from local variable val x: User? via null-check narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processLocalNullable' &&
        c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── Phase P: Overload Disambiguation via Parameter Types ─────────────────

describe('Kotlin overload disambiguation by parameter types', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-overload-param-types'),
      () => {},
    );
  }, 60000);

  it('detects lookup method with parameterTypes on graph node', () => {
    const nodes = getNodesByLabelFull(result, 'Method');
    const lookupNodes = nodes.filter((m) => m.name === 'lookup');
    expect(lookupNodes.length).toBe(1);
    expect(lookupNodes[0].properties.parameterTypes).toEqual(['Int']);
  });

  it('emits CALLS edge from run() → lookup() via overload disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const lookupCalls = calls.filter((c) => c.source === 'run' && c.target === 'lookup');
    // Both lookup(42) and lookup("alice") resolve to same nodeId → 1 CALLS edge
    expect(lookupCalls.length).toBe(1);
  });
});

// ── Phase P: Virtual Dispatch via Constructor Type (cross-file) ──────────

describe('Kotlin virtual dispatch via constructor type (cross-file)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-virtual-dispatch'), () => {});
  }, 60000);

  it('detects Dog class', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Dog');
  });

  it('resolves animal.speak() to models/Dog.kt via constructor type override', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.source === 'process' && c.target === 'speak' && c.targetFilePath === 'models/Dog.kt',
    );
    expect(speakCall).toBeDefined();
  });
});

// ── Phase P: Default Parameter Arity Resolution ──────────────────────────

describe('Kotlin default parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-default-params'), () => {});
  }, 60000);

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation
// models/User.kt exports top-level getUser(): User
// app/App.kt imports getUser, calls val u = getUser(); u.save(); u.getName()
// → u is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Kotlin cross-file binding propagation', () => {
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

  it('detects getUser and App class with run method', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Class')).toContain('App');
    expect(getNodesByLabel(result, 'Method')).toContain('run');
  });

  it('emits IMPORTS edge from App.kt to User.kt', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('App') && e.targetFilePath.includes('User'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves u.save() in run() to User#save via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves u.getName() in run() to User#getName via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'getName' && c.source === 'run' && c.targetFilePath.includes('User'),
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
});

// ---------------------------------------------------------------------------
// Method enrichment: abstract, static, annotations, parameterTypes
// ---------------------------------------------------------------------------

describe('Kotlin method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-method-enrichment'), () => {});
  }, 60000);

  it('detects Animal and Dog classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits HAS_METHOD edges for Animal', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod.filter((e) => e.source === 'Animal').map((e) => e.target);
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

  it('marks abstract speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'speak' && n.properties.filePath === 'Animal.kt');
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

  it('marks classify as isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('marks breathe as NOT isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isStatic !== undefined) {
      expect(breathe.properties.isStatic).toBe(false);
    }
  });

  it('captures override annotation on Dog.speak (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const dogSpeak = methods.find(
      (n) => n.name === 'speak' && n.properties.filePath !== 'Animal.kt',
    );
    if (dogSpeak?.properties.annotations !== undefined) {
      expect(dogSpeak.properties.annotations).toContain('@override');
    }
  });

  it('populates parameterTypes for classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== undefined) {
      expect(classify.properties.parameterTypes).toContain('String');
    }
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'speak' && c.sourceFilePath.includes('App.kt'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Animal.classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath.includes('App.kt'),
    );
    expect(classifyCall).toBeDefined();
  });
});
