/**
 * Kotlin: data class extends + implements interfaces + ambiguous import disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: data class extends + implements interfaces (delegation specifiers)
// ---------------------------------------------------------------------------

describe('Kotlin heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-heritage'),
      () => {},
    );
  }, 60000);

  it('detects exactly 3 classes and 2 interfaces', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User', 'UserService']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable', 'Validatable']);
  });

  it('detects 6 functions (interface declarations + implementations + service)', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual([
      'processUser', 'save', 'serialize', 'serialize', 'validate', 'validate',
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
    expect(edgeSet(implements_)).toEqual([
      'User → Serializable',
      'User → Validatable',
    ]);
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
    expect(extends_.some(e => e.target === 'Serializable')).toBe(false);
    expect(extends_.some(e => e.target === 'Validatable')).toBe(false);
  });

  it('resolves ambiguous validate() call through non-aliased import with import-resolved reason', () => {
    const calls = getRelationships(result, 'CALLS');
    // validate is defined in both Validatable (interface) and User (override) → needs import scoping
    const validateCall = calls.find(c => c.target === 'validate');
    expect(validateCall).toBeDefined();
    expect(validateCall!.source).toBe('processUser');
    expect(validateCall!.rel.reason).toBe('import-resolved');
  });

  it('resolves unique save() call through non-aliased import', () => {
    const calls = getRelationships(result, 'CALLS');
    // save is unique globally (only in BaseModel) → resolves as unique-global
    const saveCall = calls.find(c => c.target === 'save');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes and 2 Runnable interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter(n => n === 'Runnable').length).toBe(2);
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
    for (const edge of [...getRelationships(result, 'EXTENDS'), ...getRelationships(result, 'IMPLEMENTS')]) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.properties.name).toBe(edge.target);
    }
  });
});

describe('Kotlin call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-calls'),
      () => {},
    );
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/User.kt');
  });

  it('detects User class and save function (Kotlin fns are Function nodes)', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    // Kotlin tree-sitter captures all function_declaration as Function, including class methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('Kotlin receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    // Kotlin tree-sitter captures all function_declaration as Function
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to User.save and repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'models/User.kt');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'models/Repo.kt');

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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    // Kotlin tree-sitter captures all function_declaration as Function, including class methods
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('persist');
  });

  it('resolves u.save() to models/Models.kt and r.persist() to models/Models.kt via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    const persistCall = calls.find(c => c.target === 'persist');

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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-constructor-calls'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method and main function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('main');
  });

  it('resolves import from app/App.kt to models/User.kt', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(e => e.source === 'App.kt' && e.targetFilePath === 'models/User.kt');
    expect(imp).toBeDefined();
  });

  it('emits HAS_METHOD from User class to save function', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'save');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('models/User.kt');
  });

  it('resolves user.save() as a method call to models/User.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves 3-arg call to vararg function logEntry(vararg String) in Logger.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(c => c.target === 'logEntry');
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
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/main/kotlin/app/Main.kt');
  });

  it('does NOT resolve save to Logger.kt', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/main/kotlin/utils/Logger.kt');
    expect(saveToUtils).toBeUndefined();
  });
});

