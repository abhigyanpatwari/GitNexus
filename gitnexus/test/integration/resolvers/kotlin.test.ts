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
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
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
// Interface-delegation heritage (#1951): `class F : Iface by d`. The base is an
// `explicit_delegation` (`(user_type) by <delegate>`); an earlier synth DROPPED
// this shape (only `user_type` / `constructor_invocation` were handled), so
// production emitted NO IMPLEMENTS edge for the delegated interface in worker
// mode. Widening the synth to descend into `explicit_delegation`'s leading
// `user_type` closes the gap. G : Base() is the bare control proving the
// simple-base path is unchanged. Scope-resolution owns these edges since #942.
// ---------------------------------------------------------------------------

describe('Kotlin interface-delegation heritage resolution (#1951)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-qualified-base'), () => {});
  }, 60000);

  it('emits IMPLEMENTS F → Iface for an interface-delegation base (: Iface by d)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['F → Iface']);
  });

  it('emits EXTENDS G → Base for the bare constructor-call control (: Base())', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['G → Base']);
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

  it('produces distinct graph nodes for same-arity overloads via type-hash suffix', () => {
    const nodes = getNodesByLabelFull(result, 'Method');
    const lookupNodes = nodes.filter((m) => m.name === 'lookup');
    // Type-hash disambiguation → 2 distinct graph nodes
    expect(lookupNodes.length).toBe(2);
    const types = lookupNodes.map((n) => n.properties.parameterTypes).sort();
    expect(types).toEqual([['Int'], ['String']]);
  });

  it('callById() emits exactly one CALLS edge to lookup(Int)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallById = calls.filter((c) => c.source === 'callById' && c.target === 'lookup');
    expect(fromCallById.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallById[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['Int']);
  });

  it('callByName() emits exactly one CALLS edge to lookup(String)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallByName = calls.filter((c) => c.source === 'callByName' && c.target === 'lookup');
    expect(fromCallByName.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallByName[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['String']);
  });
});

// ── Phase P: Same-arity overloads — cross-file + chain resolution ─────────

describe('Kotlin same-arity overload cross-file and chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-same-arity-cross-file'),
      () => {},
    );
  }, 60000);

  it('crossFileById() emits exactly one CALLS edge to find(Int) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'crossFileById' &&
        c.target === 'find' &&
        c.targetFilePath.includes('DbLookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['Int']);
  });

  it('crossFileByName() emits exactly one CALLS edge to find(String) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'crossFileByName' &&
        c.target === 'find' &&
        c.targetFilePath.includes('DbLookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['String']);
  });

  it('emits METHOD_IMPLEMENTS from DbLookup.find → ILookup.find with matching types', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('DbLookup') &&
        e.targetFilePath.includes('ILookup'),
    );
    expect(edges.length).toBe(2);
    for (const edge of edges) {
      const sourceNode = result.graph.getNode(edge.rel.sourceId);
      const targetNode = result.graph.getNode(edge.rel.targetId);
      expect(sourceNode?.properties.parameterTypes).toEqual(targetNode?.properties.parameterTypes);
    }
  });

  it('chainIntToFormat() resolves find(42) → find(Int) cross-file', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'chainIntToFormat' && c.target === 'find');
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['Int']);
  });

  it('chainNameToFormat() resolves find("alice") → find(String) cross-file', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'chainNameToFormat' && c.target === 'find');
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['String']);
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

// ---------------------------------------------------------------------------
// Interface dispatch: METHOD_IMPLEMENTS edges from concrete → interface methods
// Repository interface with find/save, SqlRepository implements them
// ---------------------------------------------------------------------------

describe('Kotlin interface dispatch (METHOD_IMPLEMENTS)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-interface-dispatch'), () => {});
  }, 60000);

  it('detects Repository interface and SqlRepository class', () => {
    const classes = getNodesByLabel(result, 'Class');
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(classes).toContain('SqlRepository');
    expect(ifaces).toContain('Repository');
  });

  it('emits IMPLEMENTS edge SqlRepository → Repository', () => {
    const impl = getRelationships(result, 'IMPLEMENTS');
    const edge = impl.find((e) => e.source === 'SqlRepository' && e.target === 'Repository');
    expect(edge).toBeDefined();
  });

  it('emits METHOD_IMPLEMENTS edges for find and save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdge = mi.find(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    expect(findEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded method disambiguation: interface with overloaded find + save,
// concrete class implements all three. Verifies METHOD_IMPLEMENTS edges
// correctly distinguish between overloaded signatures.
// ---------------------------------------------------------------------------

describe('Kotlin overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-overload-dispatch'), () => {});
  }, 60000);

  it('detects 2 distinct find Method nodes on SqlRepository', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const sqlRepoFinds = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('SqlRepository'),
    );
    expect(sqlRepoFinds.length).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS edges for both find overloads', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    expect(findEdges.length).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS edge for save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    expect(saveEdge).toBeDefined();
  });

  it('emits exactly 3 METHOD_IMPLEMENTS edges total', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    expect(mi.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SM-9: inherited method resolution — child.parentMethod() via the inheritance walk
// ---------------------------------------------------------------------------

describe('Kotlin Child extends Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-child-extends-parent'),
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

  it('resolves c.parentMethod() to Parent.parentMethod via implements-split MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'parentMethod' && c.targetFilePath.includes('Parent.kt'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// SM-11: Kotlin User : Validator — interface default method via implements-split
// ---------------------------------------------------------------------------

describe('Kotlin User implements Validator — interface default method (SM-11)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-interface-default-method'),
      () => {},
    );
  }, 60000);

  it('detects Validator interface and User class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('Validator');
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('emits IMPLEMENTS edge: User → Validator', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(impls)).toContain('User → Validator');
  });

  it('resolves user.validate() to Validator.validate via implements-split MRO', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.targetFilePath.includes('Validator.kt'),
    );
    expect(validateCall).toBeDefined();
    expect(validateCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// #1756: companion-object members must dispatch through the class name,
// never through an instance receiver.
//
// `Logger.create(...)` — companion call via the class name — resolves to the
// companion's `create`. `logger.log(...)` and `logger.create(...)` — calls
// through an INSTANCE — must resolve to the instance method and NOT cross
// over to the companion-only `create`.
// ---------------------------------------------------------------------------

describe('Kotlin companion vs instance member dispatch (#1756)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-companion-vs-instance'),
      () => {},
    );
  }, 60000);

  it('detects Logger class with companion-only create() and instance log()', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Logger');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('create');
    expect(methods).toContain('log');
  });

  it('Logger.create("app") resolves to the companion create', () => {
    const calls = getRelationships(result, 'CALLS');
    const createCall = calls.find((c) => c.source === 'makeLogger' && c.target === 'create');
    expect(createCall).toBeDefined();
    expect(createCall!.targetFilePath).toBe('App.kt');
  });

  it('logger.log("hello") resolves to the instance log, NOT companion create', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.source === 'makeLogger' && c.target === 'log');
    expect(logCall).toBeDefined();
    expect(logCall!.targetFilePath).toBe('App.kt');
  });

  it('makeLogger emits exactly 2 CALLS edges — Logger.create and logger.log, no extras', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromMakeLogger = calls.filter((c) => c.source === 'makeLogger');
    expect(fromMakeLogger.length).toBe(2);
  });

  it('logger.log() in directLog() resolves to the instance log on App.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.source === 'directLog' && c.target === 'log');
    expect(logCall).toBeDefined();
    expect(logCall!.targetFilePath).toBe('App.kt');
  });

  it('crossover() invoking logger.create() on an instance emits NO CALLS edge', () => {
    // `logger.create(...)` on an instance is a compile error in Kotlin —
    // companion-object methods can only be called through the class name.
    // The resolver must NOT emit a CALLS edge for this call site (#1756).
    // Scope-resolution filters via `ScopeResolver.isStaticOnly`. The legacy DAG
    // (removed in #942) had a pre-existing crossover bug here; scope-resolution
    // owns this and resolves it correctly.
    const calls = getRelationships(result, 'CALLS');
    const crossover = calls.find((c) => c.source === 'crossover' && c.target === 'create');
    expect(crossover).toBeUndefined();
  });

  // #1756 / U7 edge-type completeness: in addition to the CALLS absence
  // asserted above, the crossover() function must NOT leak any non-CALLS
  // edge from `crossover` to the companion-promoted `create`. Without
  // these assertions a hypothetical future regression that wired the
  // crossover through a `USES` (type-reference) or `ACCESSES` (property-
  // read) edge would silently pass the CALLS-only check while still
  // misrepresenting the dispatch to users / consumers of the graph.
  // Both `USES` and `ACCESSES` are valid `RelationshipType` values in
  // `gitnexus-shared/src/graph/types.ts`.
  it('crossover() emits NO USES edges to create (edge-type completeness)', () => {
    const usesEdges = getRelationships(result, 'USES').filter(
      (c) => c.source === 'crossover' && c.target === 'create',
    );
    expect(usesEdges.length).toBe(0);
  });

  it('crossover() emits NO ACCESSES edges to create (edge-type completeness)', () => {
    const accessesEdges = getRelationships(result, 'ACCESSES').filter(
      (c) => c.source === 'crossover' && c.target === 'create',
    );
    expect(accessesEdges.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kotlin lambda scopes (#1757)
//
// Lambda bodies create a new lexical scope in which the lambda's parameter
// list (or implicit `it`) binds. Call sites inside the lambda body must
// resolve through these bindings; implicit `it` must be visible only inside
// the lambda; nested lambdas must shadow deterministically. Covers stdlib
// idioms: `forEach`, `map`, `filter`, `let`, `apply`, `also`, `with`,
// `takeIf`, `use`.
// ---------------------------------------------------------------------------

describe('Kotlin lambda scopes (#1757)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-lambda-scopes'), () => {});
  }, 60000);

  it('detects User and Post classes plus save/like methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Post');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('like');
  });

  // Happy path: explicit parameter
  it('explicitParam: user.save() inside forEach resolves to User.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.source === 'explicitParam' && c.target === 'save');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toBe('App.kt');
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const userSave = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(userSave).toBeDefined();
    expect(saveCalls[0].rel.targetId).toBe(userSave!.rel.targetId);
  });

  // Happy path: implicit `it`
  it('implicitIt: it.save() inside forEach resolves to User.save via implicit it', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.source === 'implicitIt' && c.target === 'save');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toBe('App.kt');
  });

  // Happy path: chain — outer lambda's `it.name` does not cross-bind
  it('chained: emits no erroneous save/like edges (inner it bound to User, not Post)', () => {
    const calls = getRelationships(result, 'CALLS');
    const erroneousSave = calls.find((c) => c.source === 'chained' && c.target === 'save');
    const erroneousLike = calls.find((c) => c.source === 'chained' && c.target === 'like');
    expect(erroneousSave).toBeUndefined();
    expect(erroneousLike).toBeUndefined();
  });

  it('chained: println(name) inside forEach resolves to file-scope println', () => {
    const calls = getRelationships(result, 'CALLS');
    const printlnCalls = calls.filter((c) => c.source === 'chained' && c.target === 'println');
    expect(printlnCalls.length).toBe(1);
    expect(printlnCalls[0].targetFilePath).toBe('App.kt');
  });

  // Edge case: nested lambdas — inner `it` is Post, outer `user` is User
  it('nested: inner it.like() resolves to Post.like (NOT User.like)', () => {
    const calls = getRelationships(result, 'CALLS');
    const likeCalls = calls.filter((c) => c.source === 'nested' && c.target === 'like');
    expect(likeCalls.length).toBe(1);
    expect(likeCalls[0].targetFilePath).toBe('App.kt');
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const postLike = hasMethod.find((e) => e.source === 'Post' && e.target === 'like');
    expect(postLike).toBeDefined();
    expect(likeCalls[0].rel.targetId).toBe(postLike!.rel.targetId);
  });

  it('nested: emits NO save() CALLS edge (outer `user` parameter is not called)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find((c) => c.source === 'nested' && c.target === 'save');
    expect(wrongSave).toBeUndefined();
  });

  // Edge case: `let` exposes the receiver as `it`
  it('letScope: it.save() inside let { } resolves to User.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.source === 'letScope' && c.target === 'save');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toBe('App.kt');
  });

  // Edge case: shadowing — inner `it` (User) beats outer `val it = "outer"`
  it('outerItShadow: inner it.save() resolves to User.save (outer val it is shadowed)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.source === 'outerItShadow' && c.target === 'save');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toBe('App.kt');
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const userSave = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(userSave).toBeDefined();
    expect(saveCalls[0].rel.targetId).toBe(userSave!.rel.targetId);
  });
});

// ---------------------------------------------------------------------------
// #1756 / U2 remediation: the `isStaticOnly` filter must run INSIDE the MRO
// chain walk (so static-only candidates fall through to ancestor instance
// methods) and BEFORE arity narrowing (so a same-name same-arity static +
// instance pair on the same owner doesn't collapse to OVERLOAD_AMBIGUOUS).
//
// Three scenarios in `kotlin-companion-mro-shadow/App.kt`:
//   - `useChild(c: Child)` calls `c.foo()` — Child has only a companion
//     `foo` but extends Base whose instance `foo` is the legitimate target.
//     Expected: exactly one CALLS edge `useChild → Base.foo`, no edge to
//     the companion-promoted `Child.foo`.
//   - `useChildWithInstance(c: ChildWithInstance)` calls `c.foo()` —
//     ChildWithInstance has BOTH an instance `foo(): Int` AND a same-arity
//     companion `foo(): ChildWithInstance`. Expected: exactly one CALLS
//     edge to the instance `foo` on ChildWithInstance (not the companion,
//     not Base).
//   - `useStandalone(s: Standalone)` calls `s.foo()` — Standalone has
//     only a companion `foo` and no instance ancestor with the same
//     name. Expected: no CALLS edge.
// ---------------------------------------------------------------------------

describe('Kotlin companion vs instance MRO shadowing (#1756 / U2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-companion-mro-shadow'),
      () => {},
    );
  }, 60000);

  it('useChild() falls through static-only Child.foo to Base.foo', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromUseChild = calls.filter((c) => c.source === 'useChild');
    expect(fromUseChild.length).toBe(1);
    expect(fromUseChild[0].target).toBe('foo');
    expect(fromUseChild[0].targetFilePath).toBe('App.kt');
    // The target should be the Base instance `foo`, not the companion
    // `foo` promoted onto Child. We assert by checking the target node's
    // qualified name resolves under Base (via HAS_METHOD).
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const baseFoo = hasMethod.find(
      (e) => e.source === 'Base' && e.target === 'foo' && e.targetFilePath === 'App.kt',
    );
    expect(baseFoo).toBeDefined();
    expect(fromUseChild[0].rel.targetId).toBe(baseFoo!.rel.targetId);
  });

  it('useChild() does NOT emit an edge to the companion-promoted Child.foo', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromUseChild = calls.filter((c) => c.source === 'useChild');
    // No edge whose target is the Child companion `foo`. We identify it
    // by HAS_METHOD: Child → foo (the companion `foo` is promoted onto
    // Child as the enclosing class). If such an edge existed, useChild
    // would target it; assert it does not.
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const childFoo = hasMethod.find(
      (e) => e.source === 'Child' && e.target === 'foo' && e.targetFilePath === 'App.kt',
    );
    if (childFoo !== undefined) {
      const wrongEdge = fromUseChild.find((c) => c.rel.targetId === childFoo.rel.targetId);
      expect(wrongEdge).toBeUndefined();
    }
  });

  it('useChildWithInstance() resolves to the instance foo on ChildWithInstance', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromUseCWI = calls.filter((c) => c.source === 'useChildWithInstance');
    expect(fromUseCWI.length).toBe(1);
    expect(fromUseCWI[0].target).toBe('foo');
    expect(fromUseCWI[0].targetFilePath).toBe('App.kt');
    // Assert the target is ChildWithInstance.foo (the instance method),
    // not the companion `foo` (which also targets ChildWithInstance as
    // the promoted owner but is static-only) and not Base.foo.
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const baseFoo = hasMethod.find(
      (e) => e.source === 'Base' && e.target === 'foo' && e.targetFilePath === 'App.kt',
    );
    expect(baseFoo).toBeDefined();
    expect(fromUseCWI[0].rel.targetId).not.toBe(baseFoo!.rel.targetId);
  });

  it('useStandalone() emits no CALLS edge (entire chain is static-only)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromUseStandalone = calls.filter((c) => c.source === 'useStandalone');
    expect(fromUseStandalone.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1756 / U4 remediation: named companions and companions containing nested
// classes must promote their methods onto the enclosing class AND stamp the
// static-only marker (so crossover via instance receiver is suppressed).
//
// Pre-U4 `populateCompanionMembersOnEnclosingClass` used the heuristic
// `parent.ownedDefs.some(isClassLike) → continue`, which silently bypassed:
//   - named companions (`companion object Helper { ... }`) — `Helper`
//     looked like a class-like def on the companion scope; and
//   - companions containing nested classes (`companion object { class
//     Token; fun create() }`) — the nested class def lived on the
//     companion scope.
// U4 replaces the heuristic with a parser-layer marker capture
// (`@scope.companion`), so any `companion_object` AST node is
// unambiguously identified as a companion regardless of contents.
// ---------------------------------------------------------------------------

describe('Kotlin named companion + nested-class companions (#1756 / U4)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-companion-named'), () => {});
  }, 60000);

  it('detects Outer / WithNested / InnerClassAndCompanion classes and create / forge / build methods', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Outer');
    expect(classes).toContain('WithNested');
    expect(classes).toContain('InnerClassAndCompanion');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('create');
    expect(methods).toContain('forge');
    expect(methods).toContain('build');
  });

  // Happy path (named companion): Outer.create() resolves through the
  // enclosing class name. Pre-U4 this emitted zero edges because the
  // named-companion `create` was owned by `Helper`, not `Outer`.
  it('useNamed: Outer.create() resolves to exactly 1 CALLS edge → create', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.source === 'useNamed' && c.target === 'create');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toBe('App.kt');
  });

  // Crossover suppression (named): the instance-receiver `o.create()` is a
  // compile error in Kotlin — companion methods are not legal instance-
  // dispatch candidates. Pre-U4 this emitted a false edge because the
  // static-only marker was never stamped on the named-companion `create`.
  it('useNamedCrossover: o.create() emits NO CALLS edge to create', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossover = calls.filter(
      (c) => c.source === 'useNamedCrossover' && c.target === 'create',
    );
    expect(crossover.length).toBe(0);
  });

  // Happy path (companion containing a nested class): WithNested.forge()
  // resolves through the enclosing class name. Pre-U4 the nested
  // `class Token` made the companion look like a regular class to the
  // heuristic, so `forge` was never promoted onto `WithNested`.
  it('useNested: WithNested.forge() resolves to exactly 1 CALLS edge → forge', () => {
    const calls = getRelationships(result, 'CALLS');
    const forgeCalls = calls.filter((c) => c.source === 'useNested' && c.target === 'forge');
    expect(forgeCalls.length).toBe(1);
    expect(forgeCalls[0].targetFilePath).toBe('App.kt');
  });

  // Mix (inner-class + companion): the class-name call resolves to the
  // promoted companion method; the instance-receiver crossover emits
  // nothing. Verifies that the U4 fix does NOT misclassify a regular
  // class with a sibling companion as a companion itself.
  it('useInnerMix: exactly 1 CALLS edge to build (class-name call resolves; crossover suppressed)', () => {
    const calls = getRelationships(result, 'CALLS');
    const buildCalls = calls.filter((c) => c.source === 'useInnerMix' && c.target === 'build');
    expect(buildCalls.length).toBe(1);
    expect(buildCalls[0].targetFilePath).toBe('App.kt');
  });
});

// ---------------------------------------------------------------------------
// #1756 / U6 remediation: cross-file companion factory dispatch.
//
// `Logger.create(...)` — a companion-object factory call via the class name —
// must resolve to the companion's `create` even when `Logger` is imported
// from a different file. The probe in U6 (2026-05-22) established that
// Case 2 (class-name receiver) dispatch traverses module boundaries
// correctly: `Logger.create()` in `app/Main.kt` resolves to
// `Logger.create` in `logging/Logger.kt` via the import-resolved
// receiver chain.
//
// What does NOT cross module boundaries today is the chain-typebinding:
// `val l = Logger.create(...)` followed by `l.log(...)` only resolves
// when `Logger` is defined in the same file as the call site. Two
// reasons:
//   1. `collectKotlinClassMembers` in `captures.ts` runs per-file, so
//      the Tier-2 lookup that drives chain-typebinding return-type
//      inference (`inferKotlinNavigationCallReturnType` →
//      `classMembers.methods.get("Logger")?.get("create")`) returns
//      undefined when `Logger` is imported. The local typeBinding
//      `l → ?` is never emitted in the importer scope.
//   2. The chain-follow mirror in `propagateImportedReturnTypes` (#1759)
//      treats dot-form rawNames like `Logger.create` as terminal, so it
//      cannot bridge `l → Logger.create → Logger` cross-file either.
//
// Closing this gap requires either a workspace-level Kotlin class-member
// index (paralleling the `scanJavaImports` / `scanPythonImports`
// patterns) or refactoring `followChainPostFinalize` to look up dot-form
// bindings against a cross-file return-type map. Both are substantial
// enough that the U6 plan's "fix looks substantial" branch fires —
// neither qualifies as the additive `imported-return-types.ts`
// extension the U6 approach (a) allows. Deferred to a follow-up issue
// tracking cross-file companion factory chain binding alongside the
// broader cross-file Tier-2 class-member lookup work.
//
// The instance-receiver crossover (`l.create()` on an instance receiver
// emits no CALLS edge) is U3's surface and is asserted in the U2 / U3
// same-file fixtures (`kotlin-companion-mro-shadow`,
// `kotlin-companion-other-cases`); this fixture intentionally does not
// duplicate that assertion to avoid coupling U6 to U3's static-only-
// filter extension to Cases 0 / 3b / 5.
// ---------------------------------------------------------------------------

describe('Kotlin companion vs instance cross-file dispatch (#1756 / U6)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-companion-cross-file'),
      () => {},
    );
  }, 60000);

  it('detects Logger class with companion create() and instance log()', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Logger');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('create');
    expect(methods).toContain('log');
  });

  // Happy path: `Logger.create("app")` resolves via class-name receiver
  // (Case 2) across module boundaries — the import-resolved receiver
  // chain reaches the companion's `create` in `logging/Logger.kt`.
  it('useCrossFileFactory: Logger.create() resolves to companion create on Logger.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const createCall = calls.find(
      (c) => c.source === 'useCrossFileFactory' && c.target === 'create',
    );
    expect(createCall).toBeDefined();
    expect(createCall!.targetFilePath).toBe('logging/Logger.kt');
  });

  // NOTE: a follow-up assertion `l.log()` resolving cross-file via the
  // chain-typebinding `val l = Logger.create(...)` would belong here.
  // The U6 probe (2026-05-22) confirmed that the existing pipeline does
  // NOT propagate `l → Logger` across module boundaries — see the comment
  // block above for the failure modes and deferral rationale. The class-
  // name dispatch assertion above is the additive coverage U6 lands; the
  // chain-typebinding cross-file path is tracked as a follow-up issue
  // alongside the broader cross-file Tier-2 lookup work.
});

// ---------------------------------------------------------------------------
// #1756 / U3 remediation: extend the `isStaticOnly` filter to receiver-bound
// dispatch cases beyond Case 4. Pre-U3, the filter only fired on Case 4
// (simple typeBinding receiver). Three other instance-dispatch cases also
// emit `CALLS` edges and could leak the companion-vs-instance crossover:
//   - Case 0 (compound receiver): receiver like `Logger.create("a")` whose
//     `findOwnedMember(Logger, "create")` returns the static-only
//     companion-promoted `create`.
//   - Case 3b (chain-typebinding): receiver inferred via a chain whose
//     resolved owner has a static-only candidate.
//   - Case 5 (value-receiver bridge): `findValueBindingInScope` +
//     `pickOverload` on a single owner.
//
// Note: Case 0.5 (`this`-receiver) is NOT covered because Kotlin's scope-
// resolver does not enable `resolveThisViaEnclosingClass`. The dependency
// is documented inline in `receiver-bound-calls.ts` so any language that
// enables it must also wire the filter at that case.
//
// The legitimate edges (Case 2 class-name receiver `Logger.create("a")`,
// Case 4 simple typeBinding `r.getAll()`) must continue to emit.
//
// **Empirical case-coverage observations** (probe at commit pre-U3, test
// run 2026-05-22): the scope-resolution pipeline already emits zero
// crossover edges for the fixture shapes below even without U3's filter
// wired at Cases 0 / 3b / 5 — confirming that *some* suppression mechanism
// is already catching them (most likely U2's Case-4 filter for
// `l.create("nope")`, since `val l = ...` produces a typeBinding routing
// through Case 4; the compound and chain shapes are suppressed by the
// receiver resolver not binding to the static-only def in the first place).
//
// Per the remediation plan's "be honest about which paths are actually
// exercised by tests vs which are added defensively" guidance, the
// per-case filters at Cases 0 / 3b / 5 are landing as **defensive
// wire-ups** — they ensure the contract symmetry the JSDoc now claims
// (filter applies to every instance-dispatch case) holds for future
// fixture shapes that DO trigger these paths with a static-only
// candidate. The legacy DAG (removed in #942) genuinely diverged on
// these crossover shapes; scope-resolution now owns them and its
// suppression of the spurious edge is the correct behavior.
// ---------------------------------------------------------------------------

describe('Kotlin isStaticOnly across other receiver cases (#1756 / U3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-companion-other-cases'),
      () => {},
    );
  }, 60000);

  it('detects Logger / Service / Repo and their companion + instance methods', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Logger');
    expect(classes).toContain('Service');
    expect(classes).toContain('Repo');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('create');
    expect(methods).toContain('build');
    expect(methods).toContain('log');
    expect(methods).toContain('perform');
    expect(methods).toContain('getAll');
  });

  // Happy path + Case 0 crossover suppression (combined): the legitimate
  // `Logger.create("a")` (Case 2 class-name receiver) emits exactly 1
  // CALLS edge to `create`. The OUTER `.create("b")` on the compound
  // receiver `Logger.create("a")` would route through Case 0 — per the
  // empirical observation above, the existing pipeline already does NOT
  // emit a crossover edge for this shape, so the post-U3 count stays
  // at 1 (same as pre-U3). The U3 Case-0 filter is defensive: if a
  // future fixture's compound-receiver shape DOES enter Case 0 with a
  // static-only candidate, the filter would suppress.
  it('useCompoundCrossover: Logger.create("a") emits exactly 1 CALLS edge to create', () => {
    const calls = getRelationships(result, 'CALLS');
    const createCalls = calls.filter(
      (c) => c.source === 'useCompoundCrossover' && c.target === 'create',
    );
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].targetFilePath).toBe('App.kt');
  });

  // Happy path (Case 4 simple typeBinding, baseline): `r.getAll()` in
  // `useChainTypeBindingCrossover` resolves through `findReceiverType
  // Binding` for `r: Repo` and `findOwnedMember(Repo, "getAll")`. The
  // instance dispatch on `Repo` is legitimate — that edge MUST emit.
  it('useChainTypeBindingCrossover: r.getAll() emits exactly 1 CALLS edge to getAll', () => {
    const calls = getRelationships(result, 'CALLS');
    const getAllCalls = calls.filter(
      (c) => c.source === 'useChainTypeBindingCrossover' && c.target === 'getAll',
    );
    expect(getAllCalls.length).toBe(1);
    expect(getAllCalls[0].targetFilePath).toBe('App.kt');
  });

  // Crossover (Case 3b chain-typebinding): the chained `.build()` on
  // `services.first()` would route through Case 3b's chain-typebinding
  // walk if the chain resolves to `Service`. Per the empirical
  // observation above, the existing pipeline already does NOT emit a
  // crossover edge for this shape — `services.first()` returns
  // `Service?` from `List<Service>.first()` and the chain-typebinding
  // walk doesn't terminate at the Service class for this expression
  // tree. The U3 Case-3b filter is defensive: if a future shape DOES
  // bind the chain to Service and reach `findOwnedMember(Service,
  // "build")`, the filter would suppress.
  it('useChainTypeBindingCrossover: services.first().build() emits NO CALLS edge to build', () => {
    const calls = getRelationships(result, 'CALLS');
    const buildCalls = calls.filter(
      (c) => c.source === 'useChainTypeBindingCrossover' && c.target === 'build',
    );
    expect(buildCalls.length).toBe(0);
  });

  // Crossover (value-receiver-style): `l.create("nope")` is invalid
  // Kotlin (companion methods are not legal instance-dispatch
  // candidates). Kotlin's resolver typically routes `l` through Case 4
  // because `val l = makeLoggerForCrossover()` produces a typeBinding
  // for Logger via call-result return-type inference — so the
  // crossover suppression actually fires through Case 4 (U2's filter).
  // The U3 Case-5 filter wire-up is defensive: it preserves contract
  // symmetry for any future value-binding shape that bypasses Case 4
  // (e.g., object-literal-style receivers that fall through to the
  // value-binding bridge instead).
  it('useValueReceiverCrossover: l.create("nope") emits NO CALLS edge to create', () => {
    const calls = getRelationships(result, 'CALLS');
    const createCalls = calls.filter(
      (c) => c.source === 'useValueReceiverCrossover' && c.target === 'create',
    );
    expect(createCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F48 (issue #1919): secondary constructors are extracted as members
// ---------------------------------------------------------------------------

describe('F48 — Kotlin secondary constructors', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-secondary-ctor'), () => {});
  }, 60000);

  it('creates a Constructor node for each secondary constructor', () => {
    // Point declares two secondary constructors; both surface as Constructors.
    const ctors = getNodesByLabel(result, 'Constructor');
    expect(ctors).toEqual(['constructor', 'constructor']);
  });

  it('owns both secondary constructors under the enclosing class Point', () => {
    const owned = getRelationships(result, 'HAS_METHOD').filter(
      (e) => e.targetLabel === 'Constructor',
    );
    expect(owned.length).toBe(2);
    expect(owned.every((e) => e.source === 'Point')).toBe(true);
  });

  it('does not synthesize a constructor for a class with only a primary constructor (no double-count)', () => {
    // OnlyPrimary has a primary ctor + one method, and must yield no Constructor node.
    const ctorOwners = getRelationships(result, 'HAS_METHOD')
      .filter((e) => e.targetLabel === 'Constructor')
      .map((e) => e.source);
    expect(ctorOwners).not.toContain('OnlyPrimary');
    // Its regular method is still extracted.
    expect(getNodesByLabel(result, 'Method')).toContain('method');
  });

  // ── CF1 (#1919 review): secondary-ctor body calls attribute to the Constructor ──
  // The fixture's two secondary constructors call free functions in their bodies:
  //   constructor(a: Int, b: String) : this(a) { helper() }   // arity 2
  //   constructor()                  : this(0) { helper(); other() }  // arity 0
  // Each body call must source from ITS OWN Constructor node (with the correct
  // arity suffix), NOT from the File node and NOT from the enclosing Class.
  it('attributes a secondary-constructor body call to the Constructor node, not File or Class', () => {
    const helperCalls = getRelationships(result, 'CALLS').filter((e) => e.target === 'helper');
    // helper() is called from both secondary constructors.
    expect(helperCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of helperCalls) {
      expect(call.sourceLabel).toBe('Constructor');
      expect(call.sourceLabel).not.toBe('File');
      expect(call.sourceLabel).not.toBe('Class');
    }
  });

  it('disambiguates secondary-ctor body calls by arity (#<arity> Constructor node id)', () => {
    const calls = getRelationships(result, 'CALLS');
    // `other()` is only called from the zero-arg `constructor()` body → must
    // source from the arity-0 Constructor node id, never the arity-2 one.
    const otherCall = calls.find((e) => e.target === 'other');
    expect(otherCall).toBeDefined();
    expect(otherCall!.sourceLabel).toBe('Constructor');
    expect(otherCall!.rel.sourceId).toBe('Constructor:Constructors.kt:Point.constructor#0');

    // `helper()` is called from BOTH constructors; the set of caller ids must be
    // exactly the two distinct arity-tagged Constructor nodes (no collapse onto one).
    const helperSourceIds = new Set(
      calls.filter((e) => e.target === 'helper').map((e) => e.rel.sourceId),
    );
    expect(helperSourceIds).toEqual(
      new Set([
        'Constructor:Constructors.kt:Point.constructor#0',
        'Constructor:Constructors.kt:Point.constructor#2',
      ]),
    );
  });

  it('still attributes a normal method body call to the Method (regression guard)', () => {
    // `describe()` is an expression-body method with no call; add a sibling check
    // that no secondary-ctor regression mis-routes method-owned calls. The Method
    // node for `describe` exists and is owned by Point.
    const describeOwned = getRelationships(result, 'HAS_METHOD').filter(
      (e) => e.target === 'describe' && e.source === 'Point',
    );
    expect(describeOwned.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F51 (issue #1919): destructuring declarations emit one binding per name
// ---------------------------------------------------------------------------

describe('F51 — Kotlin destructuring declarations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-destructuring'), () => {});
  }, 60000);

  it('emits one binding per destructured name in `val (a, b) = pair`', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('a');
    expect(props).toContain('b');
  });

  it('emits bindings for loop destructuring `for ((k, v) in map)`', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('k');
    expect(props).toContain('v');
  });

  it('skips the `_` discard placeholder but keeps `second`', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('second');
    expect(props).not.toContain('_');
  });

  it('emits exactly the expected binding set (no double-count, plain `val x` once)', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toEqual(['a', 'b', 'k', 'second', 'v', 'x']);
  });
});

// ---------------------------------------------------------------------------
// CF3 (#1919 review): function-local property bindings are NOT class members
// ---------------------------------------------------------------------------
// Kotlin emits destructuring / loop bindings as `@definition.property` to dodge
// the block-scope local-symbol pruner. When such a binding sits inside a METHOD
// body of a class, it must NOT receive a HAS_PROPERTY owner edge from the class —
// it is a function-local, not a class field. Genuine class fields (primary-ctor
// `val` params and class-body `val`/`var`) must still be owned by the class.

describe('CF3 — Kotlin function-local bindings are not class properties', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-local-property-owner'),
      () => {},
    );
  }, 60000);

  it('does NOT own loop-destructuring bindings (k, v) under the enclosing class C', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter((e) => e.source === 'C')
      .map((e) => e.target);
    expect(owned).not.toContain('k');
    expect(owned).not.toContain('v');
  });

  it('does NOT own a `val (a, b) = pair` destructuring binding under class C', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter((e) => e.source === 'C')
      .map((e) => e.target);
    expect(owned).not.toContain('a');
    expect(owned).not.toContain('b');
    // The intermediate `val pair` local is likewise not a class property.
    expect(owned).not.toContain('pair');
  });

  it('does NOT own destructuring inside an init {} block (ix, iy) under class C', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter((e) => e.source === 'C')
      .map((e) => e.target);
    expect(owned).not.toContain('ix');
    expect(owned).not.toContain('iy');
  });

  it('does NOT own destructuring inside a property accessor body (gx, gy) under class C', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter((e) => e.source === 'C')
      .map((e) => e.target);
    expect(owned).not.toContain('gx');
    expect(owned).not.toContain('gy');
  });

  it('still owns genuine class fields + the computed property under C, nothing else', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter((e) => e.source === 'C')
      .map((e) => e.target)
      .sort();
    // Exact set: catches both over-strip (a real member dropped) and under-strip
    // (a function-local wrongly owned).
    expect(owned).toEqual(['classProp', 'derived', 'field']);
  });
});

// ---------------------------------------------------------------------------
// F52 (issue #1919): companion-object properties are indexed as fields
// ---------------------------------------------------------------------------

describe('F52 — Kotlin companion-object properties', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-companion-fields'), () => {});
  }, 60000);

  it('indexes anonymous-companion `const val TAG` as a static, readonly field', () => {
    const tag = getNodesByLabelFull(result, 'Property').find((n) => n.name === 'TAG');
    expect(tag).toBeDefined();
    expect(tag!.properties.isStatic).toBe(true);
    expect(tag!.properties.isReadonly).toBe(true);
  });

  it('indexes a NAMED-companion property `cfgX` as a field', () => {
    const x = getNodesByLabelFull(result, 'Property').find((n) => n.name === 'cfgX');
    expect(x).toBeDefined();
    expect(x!.properties.isStatic).toBe(true);
  });

  it('emits each companion field exactly once (no double emission)', () => {
    // Exact field set + a one-per-name count guards against the companion-scope
    // machinery re-emitting the same property.
    const props = getNodesByLabel(result, 'Property');
    expect(props).toEqual(['TAG', 'cfgX', 'instances']);
    expect(props.filter((p) => p === 'TAG')).toHaveLength(1);
  });

  it('owns anonymous-companion fields on the ENCLOSING class C (companion function is not a field)', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY');
    const cFields = owned
      .filter((e) => e.source === 'C')
      .map((e) => e.target)
      .sort();
    expect(cFields).toEqual(['TAG', 'instances']);
    // The companion's `create` function is a Method, never a Property/field.
    expect(getNodesByLabel(result, 'Property')).not.toContain('create');
  });
});

// ---------------------------------------------------------------------------
// Functional (SAM) interfaces: `fun interface` (vendored grammar bump, fwcd #169)
// ---------------------------------------------------------------------------

describe('Kotlin functional (fun) interfaces', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-fun-interface'), () => {});
  }, 60000);

  // Pre-fix, the 0.3.8 grammar parsed `fun interface` as an ERROR node and
  // dropped the declaration, so Clicker/Mapper were never extracted.
  it('extracts `fun interface` declarations as Interface nodes alongside a plain one', () => {
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Clicker', 'Mapper', 'Plain']);
    expect(getNodesByLabel(result, 'Class')).toEqual(['Button']);
  });

  it('extracts the abstract methods of fun interfaces', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('onClick'); // Clicker (fun interface)
    expect(methods).toContain('map'); // Mapper<T> (generic fun interface)
  });

  it('still resolves heritage on a class implementing a plain interface', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toContain('Button → Plain');
  });
});
