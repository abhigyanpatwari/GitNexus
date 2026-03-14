/**
 * C#: heritage resolution via base_list + ambiguous namespace-import refusal
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: class + interface resolution via base_list
// ---------------------------------------------------------------------------

describe('C# heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-proj'),
      () => {},
    );
  }, 60000);

  it('detects exactly 3 classes and 2 interfaces', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseEntity', 'User', 'UserService']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['ILogger', 'IRepository']);
  });

  it('emits exactly 1 EXTENDS edge: User → BaseEntity', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseEntity');
  });

  it('emits exactly 1 IMPLEMENTS edge: User → IRepository', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('User');
    expect(implements_[0].target).toBe('IRepository');
  });

  it('emits CALLS edges from CreateUser (constructor + member calls)', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(4);
    const targets = edgeSet(calls);
    expect(targets).toContain('CreateUser → User');      // new User() constructor
    expect(targets).toContain('CreateUser → Validate');   // user.Validate() — receiver-typed
    expect(targets).toContain('CreateUser → Save');       // _repo.Save() — receiver-typed
    expect(targets).toContain('CreateUser → Log');        // _logger.Log() — receiver-typed
  });

  it('resolves all CALLS from CreateUser via import-resolved or unique-global', () => {
    const calls = getRelationships(result, 'CALLS');
    // C# non-aliased `using Namespace;` imports don't populate NamedImportMap
    // (namespace-scoped imports can't bind to individual symbols).
    // Calls resolve via directory-based PackageMap (import-resolved) when ambiguous,
    // or via unique-global when the symbol name is globally unique.
    for (const call of calls) {
      expect(['import-resolved', 'global']).toContain(call.rel.reason);
    }
  });

  it('resolves new User() to the User class via constructor discrimination', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.targetLabel).toBe('Class');
  });

  it('detects 4 namespaces', () => {
    const ns = getNodesByLabel(result, 'Namespace');
    expect(ns.length).toBe(4);
  });

  it('detects properties on classes', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('Id');
    expect(props).toContain('Name');
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
// Ambiguous: using-namespace can't disambiguate same-named types
// ---------------------------------------------------------------------------

describe('C# ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes and 2 IProcessor interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter(n => n === 'IProcessor').length).toBe(2);
  });

  it('heritage targets are synthetic (correct refusal for ambiguous namespace import)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const implements_ = getRelationships(result, 'IMPLEMENTS');

    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('UserHandler');

    // The key invariant: no edge points to Other/
    if (extends_[0].targetFilePath) {
      expect(extends_[0].targetFilePath).not.toMatch(/Other\//);
    }
    if (implements_[0].targetFilePath) {
      expect(implements_[0].targetFilePath).not.toMatch(/Other\//);
    }
  });
});

describe('C# call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-calls'),
      () => {},
    );
  }, 60000);

  it('resolves CreateUser → WriteAudit to Utils/OneArg.cs via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('CreateUser');
    expect(calls[0].target).toBe('WriteAudit');
    expect(calls[0].targetFilePath).toBe('Utils/OneArg.cs');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.Method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('C# member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves ProcessUser → Save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('ProcessUser');
    expect(saveCall!.targetFilePath).toBe('Models/User.cs');
  });

  it('detects User class and Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });

  it('emits HAS_METHOD edge from User to Save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'Save');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Primary constructor resolution: class User(string name, int age) { }
// ---------------------------------------------------------------------------

describe('C# primary constructor resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-primary-ctors'),
      () => {},
    );
  }, 60000);

  it('detects Constructor nodes for primary constructors on class and record', () => {
    const ctors = getNodesByLabel(result, 'Constructor');
    expect(ctors).toContain('User');
    expect(ctors).toContain('Person');
  });

  it('primary constructor has correct parameter count', () => {
    let userCtorParams: number | undefined;
    let personCtorParams: number | undefined;
    result.graph.forEachNode(n => {
      if (n.label === 'Constructor' && n.properties.name === 'User') {
        userCtorParams = n.properties.parameterCount as number;
      }
      if (n.label === 'Constructor' && n.properties.name === 'Person') {
        personCtorParams = n.properties.parameterCount as number;
      }
    });
    expect(userCtorParams).toBe(2);
    expect(personCtorParams).toBe(2);
  });

  it('resolves new User(...) as a CALLS edge to the Constructor node', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('Run');
    expect(ctorCall!.targetLabel).toBe('Constructor');
    expect(ctorCall!.targetFilePath).toBe('Models/User.cs');
  });

  it('also resolves user.Save() as a method call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('Run');
  });

  it('emits HAS_METHOD edge from User class to User constructor', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'User');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD edge from Person record to Person constructor', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'Person' && e.target === 'Person');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('C# receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-receiver-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save and repo.Save() to Repo.Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find(c => c.targetFilePath === 'Models/User.cs');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'Models/Repo.cs');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('ProcessEntities');
    expect(repoSave!.source).toBe('ProcessEntities');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find(c => c.target === 'User');
    const repoCtor = calls.find(c => c.target === 'Repo');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: using U = Models.User resolves U → User
// ---------------------------------------------------------------------------

describe('C# alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-alias-imports'),
      () => {},
    );
  }, 60000);

  it('detects Main, Repo, and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
  });

  it('resolves u.Save() to User.cs and r.Persist() to Repo.cs via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save');
    const persistCall = calls.find(c => c.target === 'Persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('Run');
    expect(saveCall!.targetLabel).toBe('Method');
    expect(saveCall!.targetFilePath).toBe('Models/User.cs');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('Run');
    expect(persistCall!.targetLabel).toBe('Method');
    expect(persistCall!.targetFilePath).toBe('Models/Repo.cs');
  });

  it('emits exactly 2 IMPORTS edges via alias resolution', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(2);
    expect(edgeSet(imports)).toEqual([
      'Main.cs → Repo.cs',
      'Main.cs → User.cs',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: params string[] doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('C# variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves call to params method Record(params string[]) in Logger.cs', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(c => c.target === 'Record');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('Execute');
    expect(logCall!.targetFilePath).toBe('Utils/Logger.cs');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('C# local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves Run → Save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.source === 'Run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('App/Main.cs');
  });

  it('does NOT resolve Save to Logger.cs', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'Save' && c.targetFilePath === 'Utils/Logger.cs');
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// this.Save() resolves to enclosing class's own Save method
// ---------------------------------------------------------------------------

describe('C# this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.Save() inside User.Process to User.Save, not Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'Save' && c.source === 'Process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/Models/User.cs');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + IMPLEMENTS via base_list
// ---------------------------------------------------------------------------

describe('C# parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes plus ISerializable interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['ISerializable']);
  });

  it('emits EXTENDS edge: User → BaseModel (from base_list)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits IMPLEMENTS edge: User → ISerializable', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('User');
    expect(implements_[0].target).toBe('ISerializable');
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
// base.Save() resolves to parent class's Save method
// ---------------------------------------------------------------------------

describe('C# base resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves base.Save() inside User to BaseModel.Save, not Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseSave = calls.find(c => c.source === 'Save' && c.target === 'Save'
      && c.targetFilePath === 'src/Models/BaseModel.cs');
    expect(baseSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'src/Models/Repo.cs');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// base.Save() resolves to generic parent class's Save method
// ---------------------------------------------------------------------------

describe('C# generic parent base resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-generic-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves base.Save() inside User to BaseModel.Save, not Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseSave = calls.find(c => c.source === 'Save' && c.target === 'Save'
      && c.targetFilePath === 'src/Models/BaseModel.cs');
    expect(baseSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'src/Models/Repo.cs');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pattern matching: `if (animal is Dog dog)` binds `dog` as type `Dog`
// ---------------------------------------------------------------------------

describe('C# is pattern matching resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-pattern-matching'),
      () => {},
    );
  }, 60000);

  it('detects Animal, Dog, and Cat classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
    expect(classes).toContain('Cat');
  });

  it('detects Bark and Meow methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Bark');
    expect(methods).toContain('Meow');
  });

  it('resolves dog.Bark() to Dog.Bark via is-pattern type binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const barkCall = calls.find(c => c.target === 'Bark');
    expect(barkCall).toBeDefined();
    expect(barkCall!.source).toBe('HandleAnimal');
    expect(barkCall!.targetFilePath).toBe('Models/Animal.cs');
  });

  it('emits EXTENDS edges for Dog and Cat', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find(e => e.source === 'Dog');
    const catExtends = extends_.find(e => e.source === 'Cat');
    expect(dogExtends).toBeDefined();
    expect(dogExtends!.target).toBe('Animal');
    expect(catExtends).toBeDefined();
    expect(catExtends!.target).toBe('Animal');
  });
});
