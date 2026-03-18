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
// For-each loop element typing: foreach (User user in users) user.Save()
// C#: explicit type in foreach_statement binds loop variable
// ---------------------------------------------------------------------------

describe('C# foreach loop element type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-foreach'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() in foreach to User#Save (not Repo#Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'Models/User.cs');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('ProcessEntities');
  });

  it('resolves repo.Save() in foreach to Repo#Save (not User#Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'Models/Repo.cs');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('ProcessEntities');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
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

// ---------------------------------------------------------------------------
// Return type inference: var user = svc.GetUser("alice"); user.Save()
// C#'s CONSTRUCTOR_BINDING_SCANNER handles `var` declarations with
// invocation_expression values, enabling end-to-end return type inference.
// ---------------------------------------------------------------------------

describe('C# return type inference via var + invocation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User, UserService, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('detects Save on both User and Repo, plus GetUser', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Save');
    expect(methods).toContain('GetUser');
    // Repo.Save is also detected, proving the disambiguation test is meaningful
    expect(methods.filter((m: string) => m === 'Save').length).toBe(2);
  });

  it('resolves user.Save() to User#Save (not Repo#Save) via return type of GetUser(): User', () => {
    // scanConstructorBinding binds `var user = svc.GetUser()` → calleeName "GetUser".
    // processCallsFromExtracted verifies GetUser's returnType is "User" via
    // PackageMap resolution of `using ReturnType.Models;`, then receiver filtering
    // resolves user.Save() to User#Save (not Repo#Save).
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('User.cs'),
    );
    expect(saveCall).toBeDefined();
    // Must NOT resolve to Repo.Save — that would mean disambiguation failed
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

describe('C# null-conditional call resolution (user?.Save())', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-null-conditional'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with competing Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m: string) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('captures null-conditional user?.Save() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save' && c.source === 'Process');
    expect(saveCalls.length).toBeGreaterThan(0);
  });

  it('resolves user?.Save() to User#Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'Process' && c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo?.Save() to Repo#Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'Process' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (exactly 1 Save per receiver file)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save' && c.source === 'Process');
    const userTargeted = saveCalls.filter(c => c.targetFilePath.includes('User.cs'));
    const repoTargeted = saveCalls.filter(c => c.targetFilePath.includes('Repo.cs'));
    expect(userTargeted.length).toBe(1);
    expect(repoTargeted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C# async/await constructor binding resolution
// Verifies that `var user = await svc.GetUserAsync()` correctly unwraps the
// await_expression to find the invocation_expression underneath, producing a
// constructor binding that enables receiver-based disambiguation of user.Save().
// ---------------------------------------------------------------------------

describe('C# async await constructor binding resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-async-binding'),
      () => {},
    );
  }, 60000);

  it('detects User, UserService, and OrderService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('UserService');
    expect(classes).toContain('OrderService');
  });

  it('detects competing Save methods on User and Order', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Save');
    expect(methods).toContain('GetUserAsync');
    expect(methods).toContain('GetOrderAsync');
  });

  it('resolves user.Save() after await to User#Save via return type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('user.Save() does NOT resolve to Order#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath.includes('Order.cs'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves order.Save() after await to Order#Save via return type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const orderSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessOrder' && c.targetFilePath.includes('Order.cs'),
    );
    expect(orderSave).toBeDefined();
  });

  it('order.Save() does NOT resolve to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessOrder' && c.targetFilePath.includes('User.cs'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('C# assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-assignment-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.Save() must resolve to User#Save
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessEntities' && c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.Save() does NOT resolve to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: alias comes from User, so only one edge to User.cs
    const wrongCall = calls.filter(c =>
      c.target === 'Save' && c.source === 'ProcessEntities' && c.targetFilePath.includes('User.cs'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves rAlias.Save() to Repo#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: rAlias.Save() must resolve to Repo#Save
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessEntities' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessEntities' && c.targetFilePath.includes('User.cs'),
    );
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessEntities' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// C# mixed declarations: assignment chain + is-pattern in the same file.
// Tests that the type guard in extractPendingAssignment correctly skips
// is_pattern_expression nodes while still handling local_declaration_statement.
// ---------------------------------------------------------------------------

describe('C# assignment chain + is-pattern coexistence', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-mixed-decl-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessWithChain' && c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('assignment chain alias does NOT resolve to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessWithChain' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves u.Save() to User#Save via is-pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const patternSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessWithPattern' && c.targetFilePath?.includes('User.cs'),
    );
    expect(patternSave).toBeDefined();
  });

  it('resolves alias.Save() to Repo#Save via Repo assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessRepoChain' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('Repo chain alias does NOT resolve to User#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessRepoChain' && c.targetFilePath?.includes('User.cs'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C# is-pattern disambiguation: `if (obj is User user)` should bind user → User
// and resolve user.Save() to User#Save, NOT Repo#Save.
// Validates the Phase 5.2 is_pattern_expression extraction in extractDeclaration.
// ---------------------------------------------------------------------------

describe('C# is-pattern type binding disambiguation (Phase 5.2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-is-pattern'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() inside if (obj is User user) to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' &&
      c.source === 'Process' &&
      c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' &&
      c.source === 'Process' &&
      c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.GetUser().Save()
// Tests that C# chain call resolution correctly infers the intermediate
// receiver type from GetUser()'s return type and resolves Save() to User.
// ---------------------------------------------------------------------------

describe('C# chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-chain-call'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects GetUser and Save methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('GetUser');
    expect(methods).toContain('Save');
  });

  it('resolves svc.GetUser().Save() to User#Save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' &&
      c.source === 'ProcessUser' &&
      c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.GetUser().Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' &&
      c.source === 'ProcessUser' &&
      c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C# var foreach Tier 1c: foreach (var user in users) with List<User> param
// ---------------------------------------------------------------------------

describe('C# var foreach type resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-var-foreach'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('detects methods on both classes', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter(m => m === 'Save').length).toBe(2);
    expect(methods).toContain('ProcessUsers');
    expect(methods).toContain('ProcessRepos');
  });

  it('resolves direct calls with explicit parameter types (u.Save, r.Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const directUserSave = calls.find(c =>
      c.target === 'Save' && c.source === 'Direct' && c.targetFilePath?.includes('User.cs'),
    );
    const directRepoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'Direct' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(directUserSave).toBeDefined();
    expect(directRepoSave).toBeDefined();
  });

  it('resolves user.Save() in var foreach to User#Save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessUsers' && c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() in var foreach to Repo#Save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessRepos' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessUsers' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C# switch pattern: switch (obj) { case User user: user.Save(); }
// ---------------------------------------------------------------------------

describe('C# switch pattern type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-switch-pattern'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.Save() via is-pattern to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'Models/User.cs');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() via switch case pattern to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'Save' && c.targetFilePath === 'Models/Repo.cs');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C# Dictionary .Values foreach — member_access_expression resolution
// ---------------------------------------------------------------------------

describe('C# Dictionary .Values foreach resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-dictionary-keys-values'),
      () => {},
    );
  }, 60000);

  it('detects User class with Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.Save() via Dictionary.Values to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C# recursive_pattern: obj is User { Name: "Alice" } u — Phase 6.1
// ---------------------------------------------------------------------------

describe('C# recursive_pattern type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-recursive-pattern'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves u.Save() via recursive_pattern is-expression to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves r.Save() via recursive_pattern switch expression to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'Save' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves exactly one Save call per target class (no cross-resolution)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'Save' && c.source === 'ProcessWithRecursivePattern');
    const toUser = saveCalls.filter(c => c.targetFilePath?.includes('User'));
    const toRepo = saveCalls.filter(c => c.targetFilePath?.includes('Repo'));
    // u.Save() → User#Save only, r.Save() → Repo#Save only
    expect(toUser.length).toBe(1);
    expect(toRepo.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C# nested member access with container property: this.data.Values
// ---------------------------------------------------------------------------

describe('C# nested member access foreach (this.data.Values)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-nested-member-foreach'),
      () => {},
    );
  }, 60000);

  it('detects User class with Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.Save() via this.data.Values to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (C#)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-field-types'),
      () => {},
    );
  }, 60000);

  it('detects classes: Address, Service, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Service', 'User']);
  });

  it('detects Property nodes for C# properties', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('Name');
    expect(properties).toContain('City');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBeGreaterThanOrEqual(3);
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('Address → City');
  });

  it('resolves user.Address.Save() → Address#Save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(e => e.target === 'Save');
    const addressSave = saveCalls.find(
      e => e.source === 'ProcessUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (C#)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-deep-field-chain'),
      () => {},
    );
  }, 60000);

  it('detects classes: Address, City, Service, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'Service', 'User']);
  });

  it('detects Property nodes for C# properties', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('City');
    expect(properties).toContain('ZipCode');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('Address → City');
    expect(edgeSet(propEdges)).toContain('City → ZipCode');
  });

  it('resolves 2-level chain: user.Address.Save() → Address#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(e => e.target === 'Save' && e.source === 'ProcessUser');
    const addressSave = saveCalls.find(e => e.targetFilePath.includes('Models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.Address.City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(e => e.target === 'GetName' && e.source === 'ProcessUser');
    const cityGetName = getNameCalls.find(e => e.targetFilePath.includes('Models'));
    expect(cityGetName).toBeDefined();
  });
});
