/**
 * PHP: PSR-4 imports, extends, implements, trait use, enums, calls + ambiguous disambiguation
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
// Heritage: PSR-4 imports, extends, implements, trait use, enums, calls
// ---------------------------------------------------------------------------

describe('PHP heritage & import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-app'), () => {});
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
    const calls = getRelationships(result, 'CALLS').filter((e) => e.source === 'createUser');
    const targets = calls.map((c) => c.target).sort();
    expect(targets).toContain('save');
    expect(targets).toContain('touch');
    expect(targets).toContain('label');
  });

  it('emits CALLS edge: save → getId', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'save' && e.target === 'getId',
    );
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
    expect(props.filter((p) => p === 'status').length).toBe(2);
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
    expect(overrides.length).toBe(1);
    const logOverride = overrides.find((e) => e.source === 'User' && e.target === 'log');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes and 2 Dispatchable interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter((n) => n === 'Dispatchable').length).toBe(2);
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

describe('PHP call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-calls'), () => {});
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
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
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor resolution: new User() resolves to Class node
// ---------------------------------------------------------------------------

describe('PHP constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-constructor-calls'), () => {});
  }, 60000);

  it('resolves new User() as a CALLS edge to the User class', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('Models/User.php');
    expect(ctorCall!.rel.reason).toBe('import-resolved');
  });

  it('also resolves $user->save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-receiver-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() to User.save and $repo->save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'app/Models/User.php');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'app/Models/Repo.php');

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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-alias-imports'), () => {});
  }, 60000);

  it('detects Main, Repo, and User classes with save and persist methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves $u->save() to User.php and $r->persist() to Repo.php via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const persistCall = calls.find((c) => c.target === 'persist');

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
    expect(edgeSet(imports)).toEqual(['Main.php → Repo.php', 'Main.php → User.php']);
  });
});

// ---------------------------------------------------------------------------
// Grouped import with alias: use App\Models\{User, Repo as R}
// ---------------------------------------------------------------------------

describe('PHP grouped import with alias', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-grouped-imports'), () => {});
  }, 60000);

  it('detects Main, Repo, and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
  });

  it('resolves $r->persist() to Repo.php via grouped alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find((c) => c.target === 'persist');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('run');
    expect(persistCall!.targetFilePath).toBe('app/Models/Repo.php');
  });

  it('resolves $u->save() to User.php via grouped import', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('run');
    expect(saveCall!.targetFilePath).toBe('app/Models/User.php');
  });

  it('resolves non-aliased User via NamedImportMap (not just the aliased Repo)', () => {
    // Both User (non-aliased) and R→Repo (aliased) should resolve through grouped import
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    const persistCall = calls.find((c) => c.target === 'persist' && c.source === 'run');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-variadic-resolution'), () => {});
  }, 60000);

  it('resolves run → Logger.record despite extra args (variadic)', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCall = calls.find((c) => c.target === 'record');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-local-shadow'), () => {});
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('app/Services/Main.php');
  });

  it('does NOT resolve save to Logger.php', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'app/Utils/Logger.php',
    );
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
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() to app/Models/User.php via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'app/Models/User.php',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves $repo->save() to app/Models/Repo.php via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'app/Models/Repo.php',
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
// $this->save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('PHP $this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-self-this-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $this->save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-parent-resolution'), () => {});
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
// parent::save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('PHP parent:: resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-super-resolution'), () => {});
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves parent::save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentSave = calls.find(
      (c) =>
        c.source === 'save' &&
        c.target === 'save' &&
        c.targetFilePath === 'app/Models/BaseModel.php',
    );
    expect(parentSave).toBeDefined();
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'app/Models/Repo.php',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PHP 8.0+ constructor property promotion: __construct(private UserRepo $repo)
// ---------------------------------------------------------------------------

describe('PHP constructor property promotion resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-property-promotion'), () => {});
  }, 60000);

  it('detects UserRepo and UserService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('resolves $repo->save() inside constructor via promoted parameter type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === '__construct');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-typed-properties'), () => {});
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
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-return-type'), () => {});
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
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User.php'),
    );
    expect(saveCall).toBeDefined();
    // Must NOT resolve to Repo.save — that would mean disambiguation failed
    const repoSave = calls.find(
      (c) =>
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-phpdoc-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves $user->save() to User#save via PHPDoc @return User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUser' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() to Repo#save via PHPDoc @return Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processRepo' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $user->save() via PHPDoc @param User $user in handleUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() via PHPDoc @param Repo $repo in handleRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
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
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUser' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() to Repo#save despite #[Route] attribute between PHPDoc and method', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processRepo' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $user->save() via PHPDoc @param despite #[Validate] attribute', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() via PHPDoc @param despite #[Validate] attribute', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
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
    const getUserMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'getUser');
    expect(getUserMethods.length).toBe(2);
  });

  it('resolves $user->save() in UserService to User#save via $this->getUser() disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUser' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $repo->save() in AdminService to Repo#save via $this->getUser() disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processAdmin' &&
        c.targetFilePath.includes('Models.php'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver unwrapping: ?User type hint stripped to User for resolution
// ---------------------------------------------------------------------------

describe('PHP nullable receiver resolution (?Type hint)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m: string) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() to User#save via nullable param type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('User.php'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves $repo->save() to Repo#save via nullable param type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('Repo.php'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (exactly 1 save per receiver file)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'process');
    const userTargeted = saveCalls.filter((c) => c.targetFilePath.includes('User.php'));
    const repoTargeted = saveCalls.filter((c) => c.targetFilePath.includes('Repo.php'));
    expect(userTargeted.length).toBe(1);
    expect(repoTargeted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation
// ---------------------------------------------------------------------------

describe('PHP assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias->save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('User.php'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves rAlias->save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('Repo.php'),
    );
    expect(repoSave).toBeDefined();
  });

  it('alias->save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    // There should be exactly one save() call targeting User.php from process
    const userSaves = calls.filter(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('User.php'),
    );
    expect(userSaves.length).toBe(1);
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('User.php'),
    );
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('Repo.php'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// PHP foreach ($users as $user) — Tier 1c
// ---------------------------------------------------------------------------

describe('PHP foreach loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-foreach-loop'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves $user->save() in foreach to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve $user->save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PHP foreach with PHPDoc generic Collection<User> — element type extraction
// Bug fix: normalizePhpType('Collection<User>') must yield 'User', not 'Collection'
// ---------------------------------------------------------------------------

describe('PHP foreach with PHPDoc generic Collection<User>', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-foreach-generic'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves $user->save() in foreach with Collection<User> PHPDoc to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processCollection' &&
        c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve Collection<User> foreach to Repo#save (false binding regression)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processCollection' &&
        c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('User[] array-style PHPDoc still resolves correctly (regression check)', () => {
    const calls = getRelationships(result, 'CALLS');
    const arraySave = calls.find((c) => c.target === 'save' && c.source === 'processArray');
    expect(arraySave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PHP foreach ($this->users as $user) — member access key mismatch fix
// Bug fix: member_access_expression.name returns 'users' but scopeEnv stores '$users'
// ---------------------------------------------------------------------------

describe('PHP foreach with $this->property member access', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-foreach-member-access'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves $user->save() in foreach($this->users) to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processMembers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve $this->users foreach to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processMembers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PHP foreach with call_expression iterable: foreach (getUsers() as $user)
// Phase 7.3: function_call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('PHP foreach call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-foreach-call-expr'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves $user->save() in foreach over getUsers() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves $repo->save() in foreach over getRepos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve $user->save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve $repo->save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('User'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (PHP)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-field-types'), () => {});
  }, 60000);

  it('detects classes: Address, Service, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Service', 'User']);
  });

  it('detects Property nodes for PHP properties', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
  });

  it('resolves $user->address->save() → Address#save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'processUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('populates field metadata (visibility, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.declaredType).toBe('string');

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
    expect(addr!.properties.declaredType).toBe('Address');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (PHP)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-deep-field-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, Service, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'Service', 'User']);
  });

  it('detects Property nodes for PHP properties', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('city');
    expect(properties).toContain('zipCode');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(5);
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('Address → city');
    expect(edgeSet(propEdges)).toContain('Address → street');
    expect(edgeSet(propEdges)).toContain('City → zipCode');
  });

  it('resolves 2-level chain: $user->address->save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: $user->address->city->getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'getName' && e.source === 'processUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(cityGetName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PHP 8.0+ constructor promotion as property declarations
// ---------------------------------------------------------------------------

describe('PHP constructor promotion property capture', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-constructor-promotion-fields'),
      () => {},
    );
  }, 60000);

  it('detects classes: Address, Service, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Service', 'User']);
  });

  it('detects Property nodes for promoted constructor parameters', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('name');
    expect(properties).toContain('address');
  });

  it('emits HAS_PROPERTY edges for promoted parameters', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
  });

  it('resolves $user->address->save() → Address#save via promoted field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'processUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PHP default parameter arity resolution
// ---------------------------------------------------------------------------

describe('PHP default parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-default-params'), () => {});
  }, 60000);

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });
});

// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (PHP)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(3);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    const countWrite = writes.find((e) => e.target === 'count');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
    expect(countWrite).toBeDefined();
    expect(countWrite!.source).toBe('updateUser');
  });

  it('emits ACCESSES write edge for static property assignment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const countWrite = writes.find((e) => e.target === 'count');
    expect(countWrite).toBeDefined();
    expect(countWrite!.source).toBe('updateUser');
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
// Call-result variable binding (Phase 9): $user = getUser(); $user->save()
// ---------------------------------------------------------------------------

describe('PHP call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-call-result-binding'), () => {});
  }, 60000);

  it('resolves $user->save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('App'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): getUser() → ->getCity() → ->save()
// ---------------------------------------------------------------------------

describe('PHP method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-method-chain-binding'), () => {});
  }, 60000);

  it('resolves $city->save() to City#save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'processChain' && c.targetFilePath.includes('App'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('PHP grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-grandparent-resolution'), () => {});
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

  it('resolves $c->greet()->save() to Greeting#save via depth-2 MRO lookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.targetFilePath.includes('Greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $c->greet() to A#greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('A.php'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation
// Models/UserFactory.php exports function getUser(): User
// Main.php imports getUser via use function, calls $u = getUser(); $u->save()
// → $u is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('PHP cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'php-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser function and Main class with run method', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Class')).toContain('Main');
    expect(getNodesByLabel(result, 'Method')).toContain('run');
  });

  it('emits IMPORTS edge from Main.php to UserFactory.php', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('Main') && e.targetFilePath.includes('UserFactory'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves $u->save() in run() to User#save via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User.php'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves $u->getName() in run() to User#getName via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'getName' && c.source === 'run' && c.targetFilePath.includes('User.php'),
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
// PHP use function / use const filtering (P0-3 fix)
// Verifies that `use function` and `use const` declarations do NOT produce
// class-type namedImportMap entries, while regular `use` class imports still work.
// ---------------------------------------------------------------------------

describe('PHP use function / use const filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-use-function-const'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects Calculator class with process method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Calculator');
    expect(getNodesByLabel(result, 'Method')).toContain('process');
  });

  it('detects formatName as a standalone function (not a class)', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('formatName');
    // formatName should NOT appear as a Class
    expect(getNodesByLabel(result, 'Class')).not.toContain('formatName');
  });

  it('emits IMPORTS edge from Calculator.php to User.php (class import)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('Calculator') && e.targetFilePath.includes('User'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves $user->save() to User#save via class import binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 16: Method enrichment (isAbstract, isFinal, parameterTypes, static/member calls)
// Animal (abstract): abstract speak(), static classify(), final breathe()
// Dog extends Animal: overrides speak()
// app.php: $dog->speak(), Dog::classify("dog")
// ---------------------------------------------------------------------------

describe('PHP method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-method-enrichment'), () => {});
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

  it('marks abstract speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find(
      (n) => n.name === 'speak' && n.properties.filePath?.includes('Animal'),
    );
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('marks breathe as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isAbstract !== undefined) {
      expect(breathe.properties.isAbstract).toBe(false);
    }
  });

  it('marks breathe as isFinal (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isFinal !== undefined) {
      expect(breathe.properties.isFinal).toBe(true);
    }
  });

  it('populates parameterTypes for classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== undefined) {
      const params = classify.properties.parameterTypes;
      expect(params).toContain('string');
    }
  });

  it('resolves $dog->speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.target === 'speak' && c.sourceFilePath?.includes('app'));
    expect(speakCall).toBeDefined();
  });

  it('resolves Dog::classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath?.includes('app'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 17: Overload dispatch (PHP functions with distinct names)
// format_text(string), format_text_padded(string, int)
// app.php: calls both via use function imports
// ---------------------------------------------------------------------------

describe('PHP overload dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-overload-dispatch'), () => {});
  }, 60000);

  it('detects all functions', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('format_text');
    expect(fns).toContain('format_text_padded');
    expect(fns).toContain('run');
  });

  it('resolves format_text("  hi  ") CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const textCall = calls.find(
      (c) => c.target === 'format_text' && c.sourceFilePath?.includes('app'),
    );
    expect(textCall).toBeDefined();
  });

  it('resolves format_text_padded("hi", 20) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const paddedCall = calls.find(
      (c) => c.target === 'format_text_padded' && c.sourceFilePath?.includes('app'),
    );
    expect(paddedCall).toBeDefined();
  });

  it('populates parameterTypes for format_text_padded (conditional)', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const ftp = fns.find((n) => n.name === 'format_text_padded');
    if (ftp?.properties.parameterTypes !== undefined) {
      const params = ftp.properties.parameterTypes;
      expect(params).toContain('string');
      expect(params).toContain('int');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 18: Abstract dispatch (interface + concrete implementation)
// Repository interface: find(int), save(array)
// SqlRepository implements Repository
// app.php: $repo = new SqlRepository(); $repo->find(42); $repo->save($user)
// ---------------------------------------------------------------------------

describe('PHP abstract dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'php-abstract-dispatch'), () => {});
  }, 60000);

  it('detects Repository interface and SqlRepository class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('Repository');
    expect(getNodesByLabel(result, 'Class')).toContain('SqlRepository');
  });

  it('emits IMPLEMENTS edge SqlRepository -> Repository', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'SqlRepository' && e.target === 'Repository');
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

  it('marks interface Repository.find as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const baseFind = methods.find(
      (n) => n.name === 'find' && n.properties.filePath?.includes('Contracts/Repository'),
    );
    if (baseFind?.properties.isAbstract !== undefined) {
      expect(baseFind.properties.isAbstract).toBe(true);
    }
  });

  it('marks interface Repository.save as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const baseSave = methods.find(
      (n) => n.name === 'save' && n.properties.filePath?.includes('Contracts/Repository'),
    );
    if (baseSave?.properties.isAbstract !== undefined) {
      expect(baseSave.properties.isAbstract).toBe(true);
    }
  });

  it('marks concrete SqlRepository.find as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const sqlFind = methods.find(
      (n) => n.name === 'find' && n.properties.filePath?.includes('SqlRepository'),
    );
    if (sqlFind?.properties.isAbstract !== undefined) {
      expect(sqlFind.properties.isAbstract).toBe(false);
    }
  });

  it('resolves $repo->find(42) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find((c) => c.target === 'find' && c.sourceFilePath?.includes('app'));
    expect(findCall).toBeDefined();
  });

  it('resolves $repo->save($user) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.sourceFilePath?.includes('app'));
    expect(saveCall).toBeDefined();
  });

  it('populates parameterTypes for Repository.find (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const baseFind = methods.find(
      (n) => n.name === 'find' && n.properties.filePath?.includes('Repository'),
    );
    if (baseFind?.properties.parameterTypes !== undefined) {
      const params = baseFind.properties.parameterTypes;
      expect(params).toContain('int');
    }
  });
});
