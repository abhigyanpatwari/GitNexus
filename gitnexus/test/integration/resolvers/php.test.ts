/**
 * PHP: PSR-4 imports, extends, implements, trait use, enums, calls + ambiguous disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: PSR-4 imports, extends, implements, trait use, enums, calls
// ---------------------------------------------------------------------------

describe('PHP heritage & import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-app'),
      () => {},
    );
  }, 60000);

  // --- Node detection ---

  it('detects 3 classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User', 'UserService']);
  });

  it('detects 2 interfaces', () => {
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Loggable', 'Repository']);
  });

  it('detects 2 traits', () => {
    expect(getNodesByLabel(result, 'Trait')).toEqual(['HasTimestamps', 'SoftDeletes']);
  });

  it('detects 1 enum (PHP 8.1)', () => {
    expect(getNodesByLabel(result, 'Enum')).toEqual(['UserRole']);
  });

  it('detects 8 namespaces across all files', () => {
    const ns = getNodesByLabel(result, 'Namespace');
    expect(ns.length).toBe(8);
  });

  // --- Heritage edges ---

  it('emits exactly 1 EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits 4 IMPLEMENTS edges: class→interface + class→trait', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual([
      'BaseModel → HasTimestamps',
      'BaseModel → Loggable',
      'User → SoftDeletes',
      'UserService → Repository',
    ]);
  });

  // --- Import (use-statement) resolution via PSR-4 ---

  it('resolves 6 IMPORTS edges via PSR-4 composer.json', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(edgeSet(imports)).toEqual([
      'BaseModel.php → HasTimestamps.php',
      'BaseModel.php → Loggable.php',
      'User.php → SoftDeletes.php',
      'UserService.php → Repository.php',
      'UserService.php → User.php',
      'UserService.php → UserRole.php',
    ]);
  });

  // --- Method/function call edges ---

  it('emits CALLS edges from createUser', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'createUser');
    const targets = calls.map(c => c.target).sort();
    expect(targets).toContain('save');
    expect(targets).toContain('touch');
    expect(targets).toContain('label');
  });

  it('emits CALLS edge: save → getId', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'save' && e.target === 'getId');
    expect(calls.length).toBe(1);
  });

  // --- Methods and properties ---

  it('detects methods on classes, interfaces, traits, and enums', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getId');
    expect(methods).toContain('log');
    expect(methods).toContain('touch');
    expect(methods).toContain('softDelete');
    expect(methods).toContain('restore');
    expect(methods).toContain('find');
    expect(methods).toContain('save');
    expect(methods).toContain('createUser');
    expect(methods).toContain('instance');
    expect(methods).toContain('label');
    expect(methods).toContain('__construct');
  });

  it('detects properties on classes and traits', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('id');
    expect(props).toContain('name');
    expect(props).toContain('email');
    expect(props).toContain('users');
    // $status defined in both HasTimestamps and SoftDeletes traits
    expect(props.filter(p => p === 'status').length).toBe(2);
  });

  // --- Property OVERRIDES exclusion ---

  it('does not emit OVERRIDES for property name collisions ($status in both traits)', () => {
    const overrides = getRelationships(result, 'OVERRIDES');
    // OVERRIDES should only target Method nodes, never Property nodes
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.label).not.toBe('Property');
    }
  });

  // --- MRO: OVERRIDES edge ---

  it('emits OVERRIDES edge for User overriding log (inherited from BaseModel)', () => {
    const overrides = getRelationships(result, 'OVERRIDES');
    expect(overrides.length).toBeGreaterThanOrEqual(1);
    const logOverride = overrides.find(e => e.source === 'User' && e.target === 'log');
    expect(logOverride).toBeDefined();
  });

  // --- All heritage edges point to real graph nodes ---

  it('all heritage edges point to real graph nodes (no synthetic)', () => {
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
// Ambiguous: Handler + Dispatchable, PSR-4 use-imports disambiguate
// ---------------------------------------------------------------------------

describe('PHP ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes and 2 Dispatchable interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter(n => n === 'Dispatchable').length).toBe(2);
  });

  it('resolves EXTENDS to app/Models/Handler.php (not app/Other/)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('app/Models/Handler.php');
  });

  it('resolves IMPLEMENTS to app/Models/Dispatchable.php (not app/Other/)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('UserHandler');
    expect(implements_[0].target).toBe('Dispatchable');
    expect(implements_[0].targetFilePath).toBe('app/Models/Dispatchable.php');
  });

  it('import edges point to app/Models/ not app/Other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    for (const imp of imports) {
      expect(imp.targetFilePath).toMatch(/^app\/Models\//);
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

describe('PHP call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-calls'),
      () => {},
    );
  }, 60000);

  it('resolves create_user → write_audit to app/Utils/OneArg/log.php via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('create_user');
    expect(calls[0].target).toBe('write_audit');
    expect(calls[0].targetFilePath).toBe('app/Utils/OneArg/log.php');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: $obj->method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('PHP member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');
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
// Constructor resolution: new User() resolves to Class node
// ---------------------------------------------------------------------------

describe('PHP constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-constructor-calls'),
      () => {},
    );
  }, 60000);

  it('resolves new User() as a CALLS edge to the User class', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('Models/User.php');
    expect(ctorCall!.rel.reason).toBe('import-resolved');
  });

  it('also resolves $user->save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User class, __construct method, and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('__construct');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed parameters disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('PHP receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() to User.save and $repo->save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'app/Models/User.php');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'app/Models/Repo.php');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: use App\Models\User as U resolves U → User
// ---------------------------------------------------------------------------

describe('PHP alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects Main, Repo, and User classes with save and persist methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves $u->save() to User.php and $r->persist() to Repo.php via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    const persistCall = calls.find(c => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('run');
    expect(saveCall!.targetLabel).toBe('Method');
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('run');
    expect(persistCall!.targetLabel).toBe('Method');
    expect(persistCall!.targetFilePath).toBe('app/Models/Repo.php');
  });

  it('emits exactly 2 IMPORTS edges via alias resolution', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(2);
    expect(edgeSet(imports)).toEqual([
      'Main.php → Repo.php',
      'Main.php → User.php',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Grouped import with alias: use App\Models\{User, Repo as R}
// ---------------------------------------------------------------------------

describe('PHP grouped import with alias', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-grouped-imports'),
      () => {},
    );
  }, 60000);

  it('detects Main, Repo, and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
  });

  it('resolves $r->persist() to Repo.php via grouped alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find(c => c.target === 'persist');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('run');
    expect(persistCall!.targetFilePath).toBe('app/Models/Repo.php');
  });

  it('resolves $u->save() to User.php via grouped import', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('run');
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');
  });

  it('resolves non-aliased User via NamedImportMap (not just the aliased Repo)', () => {
    // Both User (non-aliased) and R→Repo (aliased) should resolve through grouped import
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    const persistCall = calls.find(c => c.target === 'persist' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(persistCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');
    expect(persistCall!.targetFilePath).toBe('app/Models/Repo.php');
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: ...$args don't get filtered by arity
// ---------------------------------------------------------------------------

describe('PHP variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves run → Logger.record despite extra args (variadic)', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCall = calls.find(c => c.target === 'record');
    expect(recordCall).toBeDefined();
    expect(recordCall!.source).toBe('run');
    expect(recordCall!.targetFilePath).toBe('app/Utils/Logger.php');
  });

  it('detects Logger class and record method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Logger');
    expect(getNodesByLabel(result, 'Method')).toContain('record');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('PHP local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app/Services/Main.php');
  });

  it('does NOT resolve save to Logger.php', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'save' && c.targetFilePath === 'app/Utils/Logger.php');
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: $user = new User(); $user->save()
// PHP object_creation_expression (no typed local variable annotations)
// ---------------------------------------------------------------------------

describe('PHP constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() to app/Models/User.php via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'app/Models/User.php');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves $repo->save() to app/Models/Repo.php via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'app/Models/Repo.php');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// $this->save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('PHP $this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $this->save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('PHP parent class resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-parent-resolution'),
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
    for (const edge of [...getRelationships(result, 'EXTENDS'), ...getRelationships(result, 'IMPLEMENTS')]) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.properties.name).toBe(edge.target);
    }
  });
});

// ---------------------------------------------------------------------------
// parent::save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('PHP parent:: resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves parent::save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'app/Models/BaseModel.php');
    expect(parentSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'app/Models/Repo.php');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PHP 8.0+ constructor property promotion: __construct(private UserRepo $repo)
// ---------------------------------------------------------------------------

describe('PHP constructor property promotion resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-property-promotion'),
      () => {},
    );
  }, 60000);

  it('detects UserRepo and UserService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('resolves $repo->save() inside constructor via promoted parameter type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === '__construct');
    expect(saveCall).toBeDefined();
  });

  // NOTE: $this->repo->save() in other methods requires multi-step receiver resolution
  // (chained property access), which is a cross-language architectural feature not yet
  // implemented. The promoted parameter type IS extracted into the TypeEnv — it just
  // can't be accessed via $this->property chains yet.
});

// ---------------------------------------------------------------------------
// PHP 7.4+ typed class property resolution: private UserRepo $repo;
// ---------------------------------------------------------------------------

describe('PHP typed class property resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-typed-properties'),
      () => {},
    );
  }, 60000);

  it('detects UserRepo and UserService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('detects typed property $repo on UserService', () => {
    expect(getNodesByLabel(result, 'Property')).toContain('repo');
  });

  it('detects find and save methods on UserRepo', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('find');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves $repo->save() to UserRepo.php via parameter type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app/Models/UserRepo.php');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: $user = $this->getUser("alice"); $user->save()
// PHP's scanConstructorBinding captures assignment_expression with both
// function_call_expression and member_call_expression values, enabling
// return type inference for method calls on objects.
// ---------------------------------------------------------------------------

describe('PHP return type inference via member call', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User, UserService, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('detects save on both User and Repo, and getUser method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('getUser');
    // save exists on both User and Repo — disambiguation required
    expect(methods.filter((m: string) => m === 'save').length).toBe(2);
  });

  it('resolves $user->save() to User#save (not Repo#save) via return type of getUser(): User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User.php'),
    );
    expect(saveCall).toBeDefined();
    // Must NOT resolve to Repo.save — that would mean disambiguation failed
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo.php'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PHPDoc @return annotation: return type inference without native type hints
// ---------------------------------------------------------------------------

describe('PHP return type inference via PHPDoc @return annotation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-phpdoc-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves $user->save() to User#save via PHPDoc @return User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() to Repo#save via PHPDoc @return Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $user->save() via PHPDoc @param User $user in handleUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() via PHPDoc @param Repo $repo in handleRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PHPDoc @return with PHP 8+ attributes (#[Route]) between doc-comment and method
// ---------------------------------------------------------------------------

describe('PHP PHPDoc @return with attributes between comment and method', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-phpdoc-attribute-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves $user->save() to User#save despite #[Route] attribute between PHPDoc and method', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() to Repo#save despite #[Route] attribute between PHPDoc and method', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $user->save() via PHPDoc @param despite #[Validate] attribute', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() via PHPDoc @param despite #[Validate] attribute', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// $this->method() receiver disambiguation: two classes with same method name
// ---------------------------------------------------------------------------

describe('PHP $this->method() receiver disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-this-receiver-disambiguation'),
      () => {},
    );
  }, 60000);

  it('detects UserService and AdminService classes, both with getUser methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Class')).toContain('AdminService');
    const getUserMethods = getNodesByLabel(result, 'Method').filter(m => m === 'getUser');
    expect(getUserMethods.length).toBe(2);
  });

  it('resolves $user->save() in UserService to User#save via $this->getUser() disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() in AdminService to Repo#save via $this->getUser() disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processAdmin' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });
});
