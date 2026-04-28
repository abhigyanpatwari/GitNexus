/**
 * C#: heritage resolution via base_list + ambiguous namespace-import refusal
 */
import { describe, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  CROSS_FILE_FIXTURES,
  createResolverParityIt,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const it = createResolverParityIt('csharp');

// ---------------------------------------------------------------------------
// Heritage: class + interface resolution via base_list
// ---------------------------------------------------------------------------

describe('C# heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-proj'), () => {});
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
    // _repo.Save() → IRepository.Save (primary) plus interface-dispatch → User.Save (impl)
    expect(calls.length).toBe(5);
    const targets = edgeSet(calls);
    expect(targets).toContain('CreateUser → User'); // new User() constructor
    expect(targets).toContain('CreateUser → Validate'); // user.Validate() — receiver-typed
    expect(targets).toContain('CreateUser → Save'); // _repo.Save() — IRepository + User (dispatch)
    expect(targets).toContain('CreateUser → Log'); // _logger.Log() — receiver-typed
  });

  it('resolves all CALLS from CreateUser via import-resolved, unique-global, or interface-dispatch', () => {
    const calls = getRelationships(result, 'CALLS');
    // C# non-aliased `using Namespace;` imports don't populate NamedImportMap
    // (namespace-scoped imports can't bind to individual symbols).
    // Calls resolve via directory-based PackageMap (import-resolved) when ambiguous,
    // or via unique-global when the symbol name is globally unique.
    // _repo.Save() also emits interface-dispatch to User.Save (IRepository has one impl in-repo).
    for (const call of calls) {
      expect(['import-resolved', 'global', 'interface-dispatch']).toContain(call.rel.reason);
    }
  });

  it('resolves new User() to the User class via constructor discrimination', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
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
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes and 2 IProcessor interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter((n) => n === 'IProcessor').length).toBe(2);
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
      expect(extends_[0].targetFilePath).not.toContain('Other/');
    }
    if (implements_[0].targetFilePath) {
      expect(implements_[0].targetFilePath).not.toContain('Other/');
    }
  });
});

describe('C# qualified class names', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-qualified-types'), () => {});
  }, 60000);

  it('stores distinct qualified names for same-named classes across namespaces', () => {
    const users = getNodesByLabelFull(result, 'Class').filter((node) => node.name === 'User');
    expect(users).toHaveLength(2);
    expect(users.map((node) => node.properties.qualifiedName).sort()).toEqual([
      'Data.Auth.User',
      'Services.Auth.User',
    ]);
  });
});

describe('C# call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-calls'), () => {});
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-member-calls'), () => {});
  }, 60000);

  it('resolves ProcessUser → Save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
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
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'Save');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Collection-accessor unwrap (Unit 6c): data.Values on Dictionary<K,V>
// resolves to the value type's class.
// ---------------------------------------------------------------------------

describe('C# collection-accessor unwrap', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-collection-accessor'), () => {});
  }, 60000);

  it('resolves RenderAll → Render through Dictionary<string, Widget>.Values', () => {
    const calls = getRelationships(result, 'CALLS');
    const renderCall = calls.find((c) => c.source === 'RenderAll' && c.target === 'Render');
    expect(renderCall).toBeDefined();
    expect(renderCall!.targetFilePath).toBe('Models/Widget.cs');
    expect(['import-resolved', 'global']).toContain(renderCall!.rel.reason);
  });
});

// ---------------------------------------------------------------------------
// using-static member injection (Unit 6d): `using static X.Y;` exposes Y's
// static methods as free-callables in the consumer.
// ---------------------------------------------------------------------------

describe('C# using static member injection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-using-static'), () => {});
  }, 60000);

  it('resolves Compute → Square via `using static Helpers.MathUtils;`', () => {
    const calls = getRelationships(result, 'CALLS');
    const sqCall = calls.find((c) => c.source === 'Compute' && c.target === 'Square');
    expect(sqCall).toBeDefined();
    expect(sqCall!.targetFilePath).toBe('Helpers/MathUtils.cs');
    expect(['import-resolved', 'global']).toContain(sqCall!.rel.reason);
  });
});

// ---------------------------------------------------------------------------
// Overload disambiguation + interface dispatch (Unit 6e).
// ---------------------------------------------------------------------------

describe('C# overload disambiguation and interface dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-overload-interface'), () => {});
  }, 60000);

  it('Run → Log resolves to the 2-arg overload (arity narrowing)', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCalls = calls.filter((c) => c.source === 'Run' && c.target === 'Log');
    // With collapse-by-caller-target enabled and arity narrowing, Run
    // should bind to the 2-arg overload only — not the 1-arg sibling.
    expect(logCalls.length).toBe(1);
    // Verify targetId points to the 2-arg overload by checking the
    // target Method node's parameterTypes length.
    const target = result.graph.getNode(logCalls[0].rel.targetId);
    expect(target).toBeDefined();
    const parameterTypes = (target!.properties as { parameterTypes?: string[] }).parameterTypes;
    expect(parameterTypes).toBeDefined();
    expect(parameterTypes!.length).toBe(2);
  });

  it('Run → Greet emits primary edge to IGreeter.Greet plus interface-dispatch siblings', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'Run' && c.target === 'Greet');
    // One primary edge (IGreeter.Greet) + two interface-dispatch edges
    // (EnGreeter.Greet, FrGreeter.Greet).
    expect(greetCalls.length).toBe(3);

    const primaries = greetCalls.filter((c) => c.rel.reason !== 'interface-dispatch');
    expect(primaries.length).toBe(1);
    expect(primaries[0].targetFilePath).toBe('Greeting/IGreeter.cs');

    const fanout = greetCalls.filter((c) => c.rel.reason === 'interface-dispatch');
    expect(fanout.length).toBe(2);
    const fanoutPaths = fanout.map((c) => c.targetFilePath).sort();
    expect(fanoutPaths).toEqual(['Greeting/EnGreeter.cs', 'Greeting/FrGreeter.cs']);
  });

  it('interface-dispatch fan-out excludes the primary target (no self-edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fanout = calls.filter((c) => c.source === 'Run' && c.rel.reason === 'interface-dispatch');
    for (const edge of fanout) {
      expect(edge.targetFilePath).not.toBe('Greeting/IGreeter.cs');
    }
  });
});

// ---------------------------------------------------------------------------
// Primary constructor resolution: class User(string name, int age) { }
// ---------------------------------------------------------------------------

describe('C# primary constructor resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-primary-ctors'), () => {});
  }, 60000);

  it('detects Constructor nodes for primary constructors on class and record', () => {
    const ctors = getNodesByLabel(result, 'Constructor');
    expect(ctors).toContain('User');
    expect(ctors).toContain('Person');
  });

  it('primary constructor has correct parameter count', () => {
    let userCtorParams: number | undefined;
    let personCtorParams: number | undefined;
    result.graph.forEachNode((n) => {
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
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('Run');
    expect(ctorCall!.targetLabel).toBe('Constructor');
    expect(ctorCall!.targetFilePath).toBe('Models/User.cs');
  });

  it('also resolves user.Save() as a method call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('Run');
  });

  it('emits HAS_METHOD edge from User class to User constructor', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'User');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD edge from Person record to Person constructor', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'Person' && e.target === 'Person');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('C# receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-receiver-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save and repo.Save() to Repo.Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'Models/User.cs');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'Models/Repo.cs');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('ProcessEntities');
    expect(repoSave!.source).toBe('ProcessEntities');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User');
    const repoCtor = calls.find((c) => c.target === 'Repo');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-alias-imports'), () => {});
  }, 60000);

  it('detects Main, Repo, and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Main', 'Repo', 'User']);
  });

  it('resolves u.Save() to User.cs and r.Persist() to Repo.cs via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    const persistCall = calls.find((c) => c.target === 'Persist');

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
    expect(edgeSet(imports)).toEqual(['Main.cs → Repo.cs', 'Main.cs → User.cs']);
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: params string[] doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('C# variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-variadic-resolution'), () => {});
  }, 60000);

  it('resolves call to params method Record(params string[]) in Logger.cs', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'Record');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-local-shadow'), () => {});
  }, 60000);

  it('resolves Run → Save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'Run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('App/Main.cs');
  });

  it('does NOT resolve Save to Logger.cs', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'Utils/Logger.cs',
    );
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() in foreach to User#Save (not Repo#Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'Models/User.cs',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('ProcessEntities');
  });

  it('resolves repo.Save() in foreach to Repo#Save (not User#Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'Models/Repo.cs',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('ProcessEntities');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
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
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.Save() inside User.Process to User.Save, not Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'Process');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-parent-resolution'), () => {});
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
// base.Save() resolves to parent class's Save method
// ---------------------------------------------------------------------------

describe('C# base resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-super-resolution'), () => {});
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves base.Save() inside User to BaseModel.Save, not Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseSave = calls.find(
      (c) =>
        c.source === 'Save' &&
        c.target === 'Save' &&
        c.targetFilePath === 'src/Models/BaseModel.cs',
    );
    expect(baseSave).toBeDefined();
    // Pin the canonical edge-reason for super/base calls. The super-branch
    // of receiver-bound-calls resolves through the MRO chain (not through
    // imports), which the legacy DAG's tier classifier places in the
    // `'global'` bucket (see `toResolveResult` in `call-processor.ts`).
    // Emitting `'global'` unconditionally keeps the same-graph parity
    // guarantee (ARCHITECTURE.md § Scope-Resolution Pipeline) and matches
    // the legacy path under `REGISTRY_PRIMARY_CSHARP=0`.
    expect(baseSave!.rel.reason).toBe('global');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'src/Models/Repo.cs',
    );
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
    const baseSave = calls.find(
      (c) =>
        c.source === 'Save' &&
        c.target === 'Save' &&
        c.targetFilePath === 'src/Models/BaseModel.cs',
    );
    expect(baseSave).toBeDefined();
    expect(baseSave!.rel.reason).toBe('global');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'src/Models/Repo.cs',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pattern matching: `if (animal is Dog dog)` binds `dog` as type `Dog`
// ---------------------------------------------------------------------------

describe('C# is pattern matching resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-pattern-matching'), () => {});
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
    const barkCall = calls.find((c) => c.target === 'Bark');
    expect(barkCall).toBeDefined();
    expect(barkCall!.source).toBe('HandleAnimal');
    expect(barkCall!.targetFilePath).toBe('Models/Animal.cs');
  });

  it('emits EXTENDS edges for Dog and Cat', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog');
    const catExtends = extends_.find((e) => e.source === 'Cat');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-return-type'), () => {});
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
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('User.cs'),
    );
    expect(saveCall).toBeDefined();
    // Must NOT resolve to Repo.Save — that would mean disambiguation failed
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeUndefined();
  });
});

describe('C# null-conditional call resolution (user?.Save())', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-null-conditional'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m: string) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('captures null-conditional user?.Save() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save' && c.source === 'Process');
    expect(saveCalls.length).toBeGreaterThan(0);
  });

  it('resolves user?.Save() to User#Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Process' && c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo?.Save() to Repo#Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Process' && c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (exactly 1 Save per receiver file)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save' && c.source === 'Process');
    const userTargeted = saveCalls.filter((c) => c.targetFilePath.includes('User.cs'));
    const repoTargeted = saveCalls.filter((c) => c.targetFilePath.includes('Repo.cs'));
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-async-binding'), () => {});
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
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('user.Save() does NOT resolve to Order#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath.includes('Order.cs'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves order.Save() after await to Order#Save via return type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const orderSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessOrder' && c.targetFilePath.includes('Order.cs'),
    );
    expect(orderSave).toBeDefined();
  });

  it('order.Save() does NOT resolve to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.Save() must resolve to User#Save
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessEntities' &&
        c.targetFilePath.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.Save() does NOT resolve to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: alias comes from User, so only one edge to User.cs
    const wrongCall = calls.filter(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessEntities' &&
        c.targetFilePath.includes('User.cs'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves rAlias.Save() to Repo#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: rAlias.Save() must resolve to Repo#Save
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessEntities' &&
        c.targetFilePath.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessEntities' &&
        c.targetFilePath.includes('User.cs'),
    );
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessEntities' &&
        c.targetFilePath.includes('Repo.cs'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-mixed-decl-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessWithChain' &&
        c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('assignment chain alias does NOT resolve to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessWithChain' &&
        c.targetFilePath?.includes('Repo.cs'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves u.Save() to User#Save via is-pattern binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const patternSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessWithPattern' &&
        c.targetFilePath?.includes('User.cs'),
    );
    expect(patternSave).toBeDefined();
  });

  it('resolves alias.Save() to Repo#Save via Repo assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessRepoChain' &&
        c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('Repo chain alias does NOT resolve to User#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessRepoChain' &&
        c.targetFilePath?.includes('User.cs'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-is-pattern'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a Save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() inside if (obj is User user) to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Process' && c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Process' && c.targetFilePath?.includes('Repo.cs'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-chain-call'), () => {});
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
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.GetUser().Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath?.includes('Repo.cs'),
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-var-foreach'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('detects methods on both classes', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((m) => m === 'Save').length).toBe(2);
    expect(methods).toContain('ProcessUsers');
    expect(methods).toContain('ProcessRepos');
  });

  it('resolves direct calls with explicit parameter types (u.Save, r.Save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const directUserSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Direct' && c.targetFilePath?.includes('User.cs'),
    );
    const directRepoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'Direct' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(directUserSave).toBeDefined();
    expect(directRepoSave).toBeDefined();
  });

  it('resolves user.Save() in var foreach to User#Save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessUsers' && c.targetFilePath?.includes('User.cs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() in var foreach to Repo#Save via Tier 1c', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessRepos' && c.targetFilePath?.includes('Repo.cs'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-switch-pattern'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.Save() via is-pattern to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'Models/User.cs',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() via switch case pattern to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'Models/Repo.cs',
    );
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
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-recursive-pattern'), () => {});
  }, 60000);

  it('detects User and Repo classes with Save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves u.Save() via recursive_pattern is-expression to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'Save' && c.targetFilePath?.includes('User'));
    expect(userSave).toBeDefined();
  });

  it('resolves r.Save() via recursive_pattern switch expression to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'Save' && c.targetFilePath?.includes('Repo'));
    expect(repoSave).toBeDefined();
  });

  it('resolves exactly one Save call per target class (no cross-resolution)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(
      (c) => c.target === 'Save' && c.source === 'ProcessWithRecursivePattern',
    );
    const toUser = saveCalls.filter((c) => c.targetFilePath?.includes('User'));
    const toRepo = saveCalls.filter((c) => c.targetFilePath?.includes('Repo'));
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
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-field-types'), () => {});
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
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('Address → City');
  });

  it('resolves user.Address.Save() → Address#Save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'ProcessUser' && e.targetFilePath.includes('Models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('populates field metadata (visibility, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'City');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.declaredType).toBe('string');

    const addr = properties.find((p) => p.name === 'Address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
    expect(addr!.properties.declaredType).toBe('Address');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (C#)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-deep-field-chain'), () => {});
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
    const saveCalls = calls.filter((e) => e.target === 'Save' && e.source === 'ProcessUser');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.Address.City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'GetName' && e.source === 'ProcessUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('Models'));
    expect(cityGetName).toBeDefined();
  });
});

// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (C#)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const fieldNames = writes.map((e) => e.target);
    expect(fieldNames).toContain('Name');
    expect(fieldNames).toContain('Address');
    const sources = writes.map((e) => e.source);
    expect(sources).toContain('UpdateUser');
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
// Call-result variable binding (Phase 9): var user = GetUser(); user.Save()
// ---------------------------------------------------------------------------

describe('C# call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.Save() to User#Save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'ProcessUser' && c.targetFilePath.includes('App'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): GetUser() → .Address → .GetCity() → .Save()
// ---------------------------------------------------------------------------

describe('C# method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-method-chain-binding'),
      () => {},
    );
  }, 60000);

  it('resolves city.Save() to City#Save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'ProcessChain' && c.targetFilePath.includes('App'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// Greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('C# grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-grandparent-resolution'),
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

  it('resolves c.Greet().Save() to Greeting#Save via depth-2 MRO lookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath.includes('Greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves c.Greet() to A#Greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath.includes('A.cs'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase C: C# null-check narrowing — if (x != null) and if (x is not null)
// Both patterns emit patternOverrides for the if-body position range
// ---------------------------------------------------------------------------

describe('C# null-check narrowing resolution (Phase C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-null-check-narrowing'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves x.Save() inside != null guard (ProcessInequality) to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'ProcessInequality' &&
        c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.Save() inside is not null guard (ProcessIsNotNull) to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessIsNotNull' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT cross-resolve to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find((c) => c.target === 'Save' && c.targetFilePath.includes('Repo'));
    expect(wrongCall).toBeUndefined();
  });

  it('resolves x.Save() inside constructor via null-check narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'App' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.Save() inside lambda via null-check narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'ProcessInLambda' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── Phase P: Overload Disambiguation via Parameter Types ─────────────────

describe('C# overload disambiguation by parameter types', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-overload-param-types'),
      () => {},
    );
  }, 60000);

  it('produces distinct graph nodes for same-arity overloads via type-hash suffix', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const lookupNodes = methods.filter((m) => m.name === 'Lookup');
    // Type-hash disambiguation → 2 distinct graph nodes
    expect(lookupNodes.length).toBe(2);
    const types = lookupNodes.map((n) => n.properties.parameterTypes).sort();
    expect(types).toEqual([['int'], ['string']]);
  });

  it('CallById() emits exactly one CALLS edge to Lookup(int)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallById = calls.filter((c) => c.source === 'CallById' && c.target === 'Lookup');
    expect(fromCallById.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallById[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });

  it('CallByName() emits exactly one CALLS edge to Lookup(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallByName = calls.filter((c) => c.source === 'CallByName' && c.target === 'Lookup');
    expect(fromCallByName.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallByName[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });
});

// ── Phase P: Same-arity overloads — cross-file + chain resolution ─────────

describe('C# same-arity overload cross-file and chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-same-arity-cross-file'),
      () => {},
    );
  }, 60000);

  it('CrossFileById() emits exactly one CALLS edge to Find(int) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'CrossFileById' &&
        c.target === 'Find' &&
        c.targetFilePath.includes('DbLookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });

  it('CrossFileByName() emits exactly one CALLS edge to Find(string) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'CrossFileByName' &&
        c.target === 'Find' &&
        c.targetFilePath.includes('DbLookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });

  it('emits METHOD_IMPLEMENTS from DbLookup.Find → ILookup.Find with matching types', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'Find' &&
        e.target === 'Find' &&
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

  it('ChainIntToFormat() resolves find(42) → Find(int) cross-file', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'ChainIntToFormat' && c.target === 'Find');
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['int']);
  });

  it('ChainNameToFormat() resolves find("alice") → Find(string) cross-file', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'ChainNameToFormat' && c.target === 'Find');
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['string']);
  });
});

// ---------------------------------------------------------------------------
// C# optional parameter arity resolution
// ---------------------------------------------------------------------------

describe('C# optional parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-optional-params'), () => {});
  }, 60000);

  it('resolves g.Greet("Alice") with 1 arg to Greet with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'Main' && c.target === 'Greet');
    expect(greetCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation
// Models/UserFactory.cs exports static GetUser() returning User
// App/Program.cs uses static import, calls var u = GetUser(); u.Save()
// → u is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('C# cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'csharp-cross-file'),
      () => {},
    );
  }, 60000);

  it('detects User class with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Method')).toContain('GetName');
  });

  it('detects UserFactory class with GetUser method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserFactory');
    expect(getNodesByLabel(result, 'Method')).toContain('GetUser');
  });

  it('detects Program class with Run method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Program');
    expect(getNodesByLabel(result, 'Method')).toContain('Run');
  });

  it('emits IMPORTS edge from Program.cs to UserFactory.cs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('Program') && e.targetFilePath.includes('UserFactory'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves u.Save() in Run() to User#Save via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'Run' && c.targetFilePath.includes('User.cs'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves u.GetName() in Run() to User#GetName via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'GetName' && c.source === 'Run' && c.targetFilePath.includes('User.cs'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking Save and GetName to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'Save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'GetName');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C# fallback without .csproj (P1-4 fix)
// When no .csproj file is found, import resolution should fall back to
// suffix-based matching rather than returning null.
// ---------------------------------------------------------------------------

describe('C# import resolution without .csproj (suffix fallback)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-no-csproj'), () => {});
  }, 60000);

  it('detects User class with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });

  it('detects UserService class with ProcessUser method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Method')).toContain('ProcessUser');
  });

  // C# 'using Models;' is a namespace import — suffix matching cannot resolve
  // namespace-to-directory mappings without .csproj. The fallback prevents a null
  // return (so other resolution paths can attempt it), but namespace imports
  // inherently require project config for file discovery.
  it('does not crash on namespace import without .csproj (graceful fallback)', () => {
    // Pipeline completes without errors and detects symbols from both files,
    // even though no IMPORTS edge is created for the namespace import.
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('UserService');
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: abstract, static, override, parameterTypes, annotations
// ---------------------------------------------------------------------------

describe('C# method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-method-enrichment'), () => {});
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
    expect(animalMethods).toContain('Speak');
    expect(animalMethods).toContain('Classify');
    expect(animalMethods).toContain('Breathe');
  });

  it('emits HAS_METHOD edge for Dog.Speak', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'Speak');
    expect(dogSpeak).toBeDefined();
  });

  it('emits EXTENDS edge Dog -> Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('marks abstract Speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'Speak' && n.properties.filePath === 'Animal.cs');
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('marks Breathe as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'Breathe');
    if (breathe?.properties.isAbstract !== undefined) {
      expect(breathe.properties.isAbstract).toBe(false);
    }
  });

  it('marks Classify as isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('marks Breathe as NOT isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'Breathe');
    if (breathe?.properties.isStatic !== undefined) {
      expect(breathe.properties.isStatic).toBe(false);
    }
  });

  it('captures override annotation on Dog.Speak (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const dogSpeak = methods.find(
      (n) => n.name === 'Speak' && n.properties.filePath !== 'Animal.cs',
    );
    if (dogSpeak?.properties.annotations !== undefined) {
      expect(dogSpeak.properties.annotations).toContain('override');
    }
  });

  it('populates parameterTypes for Classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.parameterTypes !== undefined) {
      const params = classify.properties.parameterTypes;
      expect(params).toContain('string');
    }
  });

  it('resolves dog.Speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'Speak' && c.sourceFilePath.includes('App.cs'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Animal.Classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'Classify' && c.sourceFilePath.includes('App.cs'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Interface dispatch: METHOD_IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('C# interface dispatch (METHOD_IMPLEMENTS)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-interface-dispatch'), () => {});
  }, 60000);

  it('detects IRepository interface and SqlRepository class', () => {
    const classes = getNodesByLabel(result, 'Class');
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(classes).toContain('SqlRepository');
    expect(ifaces).toContain('IRepository');
  });

  it('emits IMPLEMENTS edge SqlRepository → IRepository', () => {
    const impl = getRelationships(result, 'IMPLEMENTS');
    const edge = impl.find((e) => e.source === 'SqlRepository' && e.target === 'IRepository');
    expect(edge).toBeDefined();
  });

  it('emits METHOD_IMPLEMENTS edges for Find and Save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdge = mi.find(
      (e) =>
        e.source === 'Find' &&
        e.target === 'Find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('IRepository'),
    );
    const saveEdge = mi.find(
      (e) =>
        e.source === 'Save' &&
        e.target === 'Save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('IRepository'),
    );
    expect(findEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded method disambiguation: METHOD_IMPLEMENTS with overloads
// IRepository declares Find(int), Find(string), Save(string).
// SqlRepository implements all three.
// Overloaded methods (same name, different params) collapse into a single
// graph node (generateId drops startLine), so Find appears once per file.
// METHOD_IMPLEMENTS still emits one edge per unique (source, target) pair.
// ---------------------------------------------------------------------------

describe('C# overloaded method disambiguation (METHOD_IMPLEMENTS)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-overload-dispatch'), () => {});
  }, 60000);

  it('detects 2 distinct Find Method nodes on SqlRepository (different arities)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findOnSql = methods.filter(
      (m) => m.name === 'Find' && m.properties.filePath?.includes('SqlRepository'),
    );
    expect(findOnSql.length).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS edges for both Find overloads', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdges = mi.filter(
      (e) =>
        e.source === 'Find' &&
        e.target === 'Find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('IRepository'),
    );
    expect(findEdges.length).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS for Save -> IRepository.Save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const saveEdge = mi.find(
      (e) =>
        e.source === 'Save' &&
        e.target === 'Save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('IRepository'),
    );
    expect(saveEdge).toBeDefined();
  });

  it('emits exactly 3 METHOD_IMPLEMENTS edges', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    expect(mi.length).toBe(3);
  });

  it('detects SqlRepository class and IRepository interface', () => {
    const classes = getNodesByLabel(result, 'Class');
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(classes).toContain('SqlRepository');
    expect(ifaces).toContain('IRepository');
  });
});

// ---------------------------------------------------------------------------
// SM-9: lookupMethodByOwnerWithMRO — c.ParentMethod() via implements-split walk
// ---------------------------------------------------------------------------

describe('C# Child extends Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-child-extends-parent'),
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

  it('resolves c.ParentMethod() to Parent.ParentMethod via implements-split MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'ParentMethod' && c.targetFilePath.includes('Parent.cs'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('Run');
  });
});

// ---------------------------------------------------------------------------
// SM-11: C# User : IValidator — interface default method via implements-split
// ---------------------------------------------------------------------------

describe('C# User implements IValidator — interface default method (SM-11)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-interface-default-method'),
      () => {},
    );
  }, 60000);

  it('detects IValidator interface and User class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('IValidator');
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('emits IMPLEMENTS edge: User → IValidator', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(impls)).toContain('User → IValidator');
  });

  it('resolves user.Validate() to IValidator.Validate via implements-split MRO', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'Validate' && c.targetFilePath.includes('Validator.cs'),
    );
    expect(validateCall).toBeDefined();
    expect(validateCall!.source).toBe('Run');
  });
});

// ---------------------------------------------------------------------------
// Interface-to-interface heritage (single + multi base interface)
// ---------------------------------------------------------------------------

describe('C# interface-to-interface heritage', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-interface-heritage'), () => {});
  }, 60000);

  it('detects 1 class and 4 interfaces', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['MyService']);
    expect(getNodesByLabel(result, 'Interface')).toEqual([
      'IAuditableService',
      'IBarService',
      'IBaseInterface',
      'IFooService',
    ]);
  });

  it('emits no EXTENDS edges (fixture has no class inheritance)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(0);
  });

  it('emits IMPLEMENTS edge: IFooService → IBaseInterface (single base interface)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const targets = edgeSet(implements_);
    expect(targets).toContain('IFooService → IBaseInterface');
  });

  it('emits IMPLEMENTS edges: IAuditableService → IFooService, IBarService (multi base interfaces)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const targets = edgeSet(implements_);
    expect(targets).toContain('IAuditableService → IFooService');
    expect(targets).toContain('IAuditableService → IBarService');
  });

  it('emits IMPLEMENTS edge: MyService → IAuditableService (class implements derived interface)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const targets = edgeSet(implements_);
    expect(targets).toContain('MyService → IAuditableService');
  });

  it('emits exactly 4 IMPLEMENTS edges total', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// C# parse completeness regression (#903)
// ---------------------------------------------------------------------------

describe('C# parse completeness (#903 regression)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-hello'), () => {});
  }, 60000);

  it('parse phase completes without error (no crash)', () => {
    expect(result).toBeDefined();
    expect(result.graph).toBeDefined();
  });

  it('emits Class node for Greeter', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Greeter');
  });

  it('emits Interface node for IFoo', () => {
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(interfaces).toContain('IFoo');
  });

  it('emits Method nodes for Greet, Main, and Bar', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Greet');
    expect(methods).toContain('Main');
    expect(methods).toContain('Bar');
  });

  it('Greet has parameterCount=1 and returnType=string', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const greet = methods.find((m) => m.name === 'Greet');
    expect(greet).toBeDefined();
    expect(greet!.properties.parameterCount).toBe(1);
    expect(greet!.properties.returnType).toBe('string');
    expect(greet!.properties.visibility).toBe('public');
  });

  it('Main has parameterCount=1 and isStatic=true', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const main = methods.find((m) => m.name === 'Main');
    expect(main).toBeDefined();
    expect(main!.properties.parameterCount).toBe(1);
    expect(main!.properties.isStatic).toBe(true);
    expect(main!.properties.visibility).toBe('public');
  });

  it('Bar is abstract with parameterCount=0 and returnType=void', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const bar = methods.find((m) => m.name === 'Bar');
    expect(bar).toBeDefined();
    expect(bar!.properties.parameterCount).toBe(0);
    expect(bar!.properties.isAbstract).toBe(true);
    expect(bar!.properties.returnType).toBe('void');
  });

  it('emits HAS_METHOD edges linking Greeter to its methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const targets = edgeSet(hasMethod);
    expect(targets).toContain('Greeter → Greet');
    expect(targets).toContain('Greeter → Main');
  });

  it('emits HAS_METHOD edge linking IFoo to Bar', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const targets = edgeSet(hasMethod);
    expect(targets).toContain('IFoo → Bar');
  });
});

// ---------------------------------------------------------------------------
// Finding 1: record inheritance + base.Save() resolves via isClassLike widening
// ---------------------------------------------------------------------------

describe('C# record base resolution (record inheritance + base.Save)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-record-base'), () => {});
  }, 60000);

  it('detects BaseEntity and UserRecord', () => {
    // Records project as label 'Record' (class-like) in the graph.
    const records = getNodesByLabel(result, 'Record');
    const classes = getNodesByLabel(result, 'Class');
    const all = [...records, ...classes];
    expect(all).toContain('BaseEntity');
    expect(all).toContain('UserRecord');
  });

  it('does not emit a spurious self-EXTENDS (record heritage not emitted by C# heritage queries)', () => {
    // NOTE: C# tree-sitter heritage queries cover class/interface
    // declarations but not `record_declaration`, so records don't
    // emit an EXTENDS edge today. The record-base linkage is still
    // visible via `base.Save()` resolution (next test). This
    // assertion pins the negative invariant so a future heritage
    // extension for records can flip both tests at once.
    const extends_ = getRelationships(result, 'EXTENDS');
    const selfExtend = extends_.find((e) => e.source === 'UserRecord' && e.target === 'UserRecord');
    expect(selfExtend).toBeUndefined();
  });

  it('resolves base.Save() inside UserRecord.Save to BaseEntity.Save (not self)', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseSave = calls.find(
      (c) =>
        c.source === 'Save' &&
        c.target === 'Save' &&
        c.targetFilePath === 'src/Models/BaseEntity.cs',
    );
    expect(baseSave).toBeDefined();
    // NOTE: no `rel.reason` assertion here. Records don't emit EXTENDS
    // edges today (see the negative-invariant test above), so the
    // super-branch MRO lookup returns no ancestor and the edge is
    // produced by the downstream reference-index fallback instead of
    // the canonical super path. The `csharp-super-resolution` and
    // `csharp-generic-parent` suites pin the super-branch reason on
    // paths that do go through MRO.
    const selfSave = calls.find(
      (c) =>
        c.source === 'Save' &&
        c.target === 'Save' &&
        c.targetFilePath === 'src/Models/UserRecord.cs',
    );
    expect(selfSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 4: struct overload dispatch exercises the extracted
// narrowOverloadCandidates utility via implicit-this free calls.
// ---------------------------------------------------------------------------

describe('C# struct overload dispatch (implicit-this narrowing)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-struct-overloads'), () => {});
  }, 60000);

  it('detects Calc struct', () => {
    const structs = getNodesByLabel(result, 'Struct');
    const classes = getNodesByLabel(result, 'Class');
    const all = [...structs, ...classes];
    expect(all).toContain('Calc');
  });

  it('detects two Add overloads with distinct parameterCount', () => {
    const methods = getNodesByLabelFull(result, 'Method').filter((m) => m.name === 'Add');
    expect(methods.length).toBe(2);
    const arities = methods.map((m) => m.properties.parameterCount as number).sort();
    expect(arities).toEqual([1, 2]);
  });

  it('Run() -> Add emits CALLS edges to distinct Add overloads (implicit-this narrowing)', () => {
    const calls = getRelationships(result, 'CALLS');
    const runToAdd = calls.filter((c) => c.source === 'Run' && c.target === 'Add');
    // The registry-primary pipeline exercises `pickImplicitThisOverload`
    // + `narrowOverloadCandidates` and MUST resolve both Add(int) and
    // Add(int, int) to distinct targets. A silent regression in either
    // helper would drop an edge or merge both onto one target — pin
    // exact counts so either failure mode surfaces immediately.
    // The legacy DAG path (REGISTRY_PRIMARY_CSHARP=0) does not
    // implement implicit-`this` struct overload narrowing, so we
    // accept any count there; the registry-primary path remains the
    // authoritative guarantee.
    if (process.env['REGISTRY_PRIMARY_CSHARP'] !== '0') {
      expect(runToAdd.length).toBe(2);
      const targetIds = new Set(runToAdd.map((c) => c.rel.targetId));
      expect(targetIds.size).toBe(2);
    } else {
      expect(runToAdd.length).toBeLessThanOrEqual(2);
      if (runToAdd.length >= 2) {
        const targetIds = new Set(runToAdd.map((c) => c.rel.targetId));
        expect(targetIds.size).toBe(runToAdd.length);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 5: merged Case 2 covers Interface static-style invocation
// (`ILogger.Warn(...)` from a class method).
// ---------------------------------------------------------------------------

describe('C# interface receiver static invocation (merged Case 2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-interface-receiver-static'),
      () => {},
    );
  }, 60000);

  it('detects ILogger interface and Runner class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('ILogger');
    expect(getNodesByLabel(result, 'Class')).toContain('Runner');
  });

  it('Go() -> ILogger.Warn CALLS edge points at src/ILogger.cs with import-resolved or global reason', () => {
    const calls = getRelationships(result, 'CALLS');
    const warnCall = calls.find((c) => c.source === 'Go' && c.target === 'Warn');
    expect(warnCall).toBeDefined();
    expect(warnCall!.targetFilePath).toBe('src/ILogger.cs');
    expect(['import-resolved', 'global']).toContain(warnCall!.rel.reason);
  });
});

// ---------------------------------------------------------------------------
// Finding 5 (continued): merged Case 2 kind-aware branch for class-name
// receiver on WRITE ACCESSES. `Counters.Hits = 42` resolves receiver via
// `findClassBindingInScope` (no typeBinding on `Counters`), which is the
// exact path lifted from the deleted Case 5. Verifies `reason === 'write'`
// and `confidence === 1.0` — the semantic upgrade over the pre-merge
// Case 2, which emitted `import-resolved`/`global` at 0.85 for the same
// sites. Also pins per-site dedup (two distinct writes → two edges).
// C# tree-sitter queries emit only `write.member` captures today, so a
// read-side counterpart would have no reference site and is intentionally
// not asserted.
// ---------------------------------------------------------------------------

describe('C# class-name receiver write ACCESSES (merged Case 2 kind-aware branch)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-class-static-field-access'),
      () => {},
    );
  }, 60000);

  it('detects Counters and Runner classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(
      expect.arrayContaining(['Counters', 'Runner']),
    );
  });

  it('Touch() -> Hits and Touch() -> Misses each emit ACCESSES write with confidence 1.0', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writesFromTouch = accesses.filter(
      (e) => e.source === 'Touch' && e.rel.reason === 'write',
    );
    // Per-site dedup key is (caller, target, line, col) — two writes on
    // distinct lines must produce two distinct edges.
    expect(writesFromTouch.length).toBe(2);
    for (const edge of writesFromTouch) {
      expect(edge.rel.confidence).toBe(1.0);
      expect(edge.targetFilePath).toBe('src/Counters.cs');
    }
    expect(writesFromTouch.map((e) => e.target).sort()).toEqual(['Hits', 'Misses']);
  });

  it('does not emit any CALLS edges for the static field writes', () => {
    // `Counters.Hits = 42` is a field write, not a call. A regression
    // that misclassifies the site would surface as a spurious CALLS
    // edge here.
    const calls = getRelationships(result, 'CALLS');
    const stray = calls.filter(
      (c) => c.source === 'Touch' && (c.target === 'Hits' || c.target === 'Misses'),
    );
    expect(stray).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #1066 regression: large source files (>32 KB) combined with a
// cross-namespace `using` and a colliding local class. Pins both fixes in
// the resolver dataset:
//
//   1. emitCsharpScopeCaptures + extractFileStructure must use the adaptive
//      `getTreeSitterBufferSize` on cache miss, otherwise UserService.cs
//      fails to reparse with "Invalid argument" and CreateUser is dropped.
//   2. populateCsharpNamespaceSiblings must append to bindingAugmentations
//      instead of mutating frozen finalize-produced BindingRef[] arrays;
//      otherwise the cross-namespace inject loop throws "Cannot add property
//      N, object is not extensible" when the importer also declares the same
//      simple name locally.
// ---------------------------------------------------------------------------

describe('C# large-file + frozen-bucket regression (issue #1066)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    // Force the worker pool path with low thresholds so the scope-resolution
    // cache-miss reparse actually fires (workers can't share Tree instances
    // across MessageChannels). This is what reproduces the >32 KB
    // "Invalid argument" failure end-to-end through the pipeline.
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-large-cache-miss-resolution'),
      () => {},
      { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } },
    );
  }, 120000);

  it('extracts UserService.CreateUser despite the >32 KB source size', () => {
    // Without the adaptive-buffer fix, UserService.cs would fail to reparse
    // on cache miss and CreateUser would not be extracted at all.
    expect(getNodesByLabel(result, 'Method')).toEqual(
      expect.arrayContaining(['CreateUser', 'Save']),
    );
  });

  it('detects all three classes (User, Helper, UserService)', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(
      expect.arrayContaining(['User', 'Helper', 'UserService']),
    );
  });

  it('resolves CreateUser -> User constructor across same namespace', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctor = calls.find(
      (c) => c.source === 'CreateUser' && c.target === 'User' && c.targetLabel === 'Class',
    );
    expect(ctor).toBeDefined();
    expect(ctor!.targetFilePath).toBe('Models/User.cs');
  });

  it('resolves CreateUser -> Save through namespace siblings', () => {
    // Without the freeze fix, populateCsharpNamespaceSiblings throws on
    // the colliding `Helper` bucket, aborting the whole scopeResolution
    // phase, so no CALLS edges from CreateUser would be emitted at all.
    const calls = getRelationships(result, 'CALLS');
    const save = calls.find((c) => c.source === 'CreateUser' && c.target === 'Save');
    expect(save).toBeDefined();
    expect(save!.targetFilePath).toBe('Models/User.cs');
    expect(['import-resolved', 'global']).toContain(save!.rel.reason);
  });
});

// ---------------------------------------------------------------------------
// Issue #1066 companion regression: small-file trigger for the same
// frozen-bucket failure. Where csharp-large-cache-miss-resolution exercises
// the path through tree-sitter cache-miss reparse on >32 KB files, this
// fixture trips the same `Object.freeze` contract on the populator's
// namespace-import loop in a single small file pair: the importer locally
// declares a class with the same simple name as a sibling reachable through
// `using`, so the extractor pre-populates (and freezes) `User` in the
// importer's Module bindings before populateNamespaceSiblings tries to
// append the cross-file `Collision.Models.User`. Pre-#1082 the populator
// pushed onto the frozen array → "Cannot add property N, object is not
// extensible" → whole scopeResolution phase aborted. Post-#1082 the
// augmentation channel keeps both bindings visible to readers, with the
// local `Collision.App.User` taking precedence per origin ordering.
// ---------------------------------------------------------------------------

describe('C# frozen-binding collision via using-import (issue #1066 companion)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-frozen-binding-collision'),
      () => {},
    );
  }, 60000);

  it('completes scopeResolution without throwing on the colliding bucket', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['User', 'Program']));
  });

  it('detects both User declarations across the two namespaces', () => {
    const users = getNodesByLabelFull(result, 'Class').filter((n) => n.name === 'User');
    expect(users.length).toBe(2);
    const paths = users.map((u) => u.properties.filePath).sort();
    expect(paths).toEqual(['App/Program.cs', 'Models/User.cs']);
  });

  it('resolves Program.Run -> local Collision.App.User constructor (origin:local shadows namespace)', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctor = calls.find(
      (c) => c.source === 'Run' && c.target === 'User' && c.targetLabel === 'Class',
    );
    expect(ctor).toBeDefined();
    expect(ctor!.targetFilePath).toBe('App/Program.cs');
  });
});

// ---------------------------------------------------------------------------
// Issue #1086 regression: when a C# file consists of a single top-level
// namespace_declaration that ends exactly at EOF (no trailing newline,
// no leading content outside the namespace block), tree-sitter-c-sharp
// reports identical ranges for `compilation_unit` and `namespace_declaration`.
// Pre-fix, scope-extractor's parent-finder relied on strict containment, so
// the Module was popped off the stack and the Namespace ended up with
// parent=null → ScopeTreeInvariantError → scopeResolution silently aborted
// for the file (extractParsedFile swallows). Post-fix, `canParentScope`
// allows a same-range Module to keep parenthood, so extraction completes
// and the file's symbols stay reachable to the cross-file resolver.
//
// Hit on real PersistentWindows .Designer.cs files. The fixture mirrors
// that shape minimally — both files end on the closing `}` with no
// trailing newline.
// ---------------------------------------------------------------------------

describe('C# namespace-as-root with no trailing newline (issue #1086)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-namespace-as-root-no-trailing-newline'),
      () => {},
      { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } },
    );
  }, 60000);

  it('completes scope extraction for both files (no Namespace-as-root abort)', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['User', 'Program']));
  });

  it('emits the using-import edge App/Program.cs -> Models/User.cs through the scope-resolution path', () => {
    // The `csharp-scope: using` reason on the IMPORTS edge is the signal
    // that scope-resolution drove the resolution (not the legacy DAG
    // fallback). Pre-fix, Models/User.cs aborted in scope-extractor and
    // the only IMPORTS edge available — if any — would have come from a
    // path with a different reason tag, or be missing entirely.
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath === 'App/Program.cs' && e.targetFilePath === 'Models/User.cs',
    );
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('csharp-scope: using');
  });
});
