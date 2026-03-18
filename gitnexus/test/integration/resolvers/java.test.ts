/**
 * Java: class extends + implements multiple interfaces + ambiguous package disambiguation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: class extends + implements multiple interfaces
// ---------------------------------------------------------------------------

describe('Java heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-heritage'),
      () => {},
    );
  }, 60000);

  it('detects exactly 3 classes and 2 interfaces', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User', 'UserService']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable', 'Validatable']);
  });

  it('emits exactly 1 EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits exactly 2 IMPLEMENTS edges: User → Serializable, User → Validatable', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(2);
    expect(edgeSet(implements_)).toEqual([
      'User → Serializable',
      'User → Validatable',
    ]);
  });

  it('resolves exactly 4 IMPORTS edges', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(4);
    expect(edgeSet(imports)).toEqual([
      'User.java → Serializable.java',
      'User.java → Validatable.java',
      'UserService.java → Serializable.java',
      'UserService.java → User.java',
    ]);
  });

  it('does not emit EXTENDS edges to interfaces', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.some(e => e.target === 'Serializable')).toBe(false);
    expect(extends_.some(e => e.target === 'Validatable')).toBe(false);
  });

  it('emits exactly 2 CALLS edges', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(2);
    expect(edgeSet(calls)).toEqual([
      'processUser → save',
      'processUser → validate',
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
// Ambiguous: Handler + Processor in two packages, imports disambiguate
// ---------------------------------------------------------------------------

describe('Java ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes and 2 Processor interfaces', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    expect(classes).toContain('UserHandler');
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces.filter(n => n === 'Processor').length).toBe(2);
  });

  it('resolves EXTENDS to models/Handler (not other/Handler)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('models/Handler.java');
  });

  it('resolves IMPLEMENTS to models/Processor (not other/Processor)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(1);
    expect(implements_[0].source).toBe('UserHandler');
    expect(implements_[0].target).toBe('Processor');
    expect(implements_[0].targetFilePath).toBe('models/Processor.java');
  });

  it('import edges point to models/ not other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const targets = imports.map(e => e.target).sort();
    expect(targets).toContain('Handler.java');
    expect(targets).toContain('Processor.java');
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

describe('Java call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → writeAudit to util/OneArg.java via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('processUser');
    expect(calls[0].target).toBe('writeAudit');
    expect(calls[0].targetFilePath).toBe('util/OneArg.java');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Java member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/User.java');
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
// Constructor resolution: new Foo() resolves to Constructor/Class
// ---------------------------------------------------------------------------

describe('Java constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-constructor-calls'),
      () => {},
    );
  }, 60000);

  it('resolves new User() as a CALLS edge to the User constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    // Java has explicit constructor_declaration → Constructor node
    expect(ctorCall!.targetLabel).toBe('Constructor');
    expect(ctorCall!.targetFilePath).toBe('models/User.java');
  });

  it('also resolves user.save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User class, User constructor, save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Constructor')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('Java receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-receiver-resolution'),
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

    const userSave = saveCalls.find(c => c.targetFilePath === 'models/User.java');
    const repoSave = saveCalls.find(c => c.targetFilePath === 'models/Repo.java');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
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
// Named import disambiguation: two User classes, import resolves to correct one
// ---------------------------------------------------------------------------

describe('Java named import disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-named-imports'),
      () => {},
    );
  }, 60000);

  it('detects two User classes in different packages', () => {
    const users = getNodesByLabel(result, 'Class').filter(n => n === 'User');
    expect(users.length).toBe(2);
  });

  it('resolves user.save() to com/example/models/User.java via named import', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('run');
    expect(saveCall!.targetFilePath).toBe('com/example/models/User.java');
  });

  it('resolves new User() to com/example/models/User.java, not other/', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(c => c.target === 'User' && c.source === 'run');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.targetFilePath).toBe('com/example/models/User.java');
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: String... doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('Java variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-variadic-resolution'),
      () => {},
    );
  }, 60000);

  it('resolves 3-arg call to varargs method record(String...) in Logger.java', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(c => c.target === 'record');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('run');
    expect(logCall!.targetFilePath).toBe('com/example/util/Logger.java');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('Java local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/main/java/com/example/app/Main.java');
  });

  it('does NOT resolve save to Logger.java', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/main/java/com/example/utils/Logger.java');
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: var user = new User(); user.save()
// Java 10+ local variable type inference (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Java constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to models/User.java via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/User.java');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to models/Repo.java via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/Repo.java');
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
// For-each loop element typing: for (User user : users) user.save()
// Java: explicit type in enhanced_for_statement binds loop variable
// ---------------------------------------------------------------------------

describe('Java for-each loop element type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-foreach'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() in for-each to User#save (not Repo#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/User.java');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() in for-each to Repo#save (not User#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/Repo.java');
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
// this.save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('Java this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/models/User.java');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('Java parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-parent-resolution'),
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
// super.save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('Java super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'src/models/BaseModel.java');
    expect(superSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/models/Repo.java');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to generic parent class's save method
// ---------------------------------------------------------------------------

describe('Java generic parent super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-generic-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'src/models/BaseModel.java');
    expect(superSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/models/Repo.java');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Return type inference: var user = svc.getUser("alice"); user.save()
// Java's CONSTRUCTOR_BINDING_SCANNER handles `var` declarations with
// method_invocation values, enabling end-to-end return type inference.
// ---------------------------------------------------------------------------

describe('Java return type inference via explicit method return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and UserService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('detects save and getUser methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('getUser');
  });

  it('resolves user.save() to User#save via return type of getUser(): User', () => {
    // Java's CONSTRUCTOR_BINDING_SCANNER binds `var user = svc.getUser()` to the
    // return type of getUser (User), so the subsequent user.save() call resolves
    // to User#save rather than an unresolved target.
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models')
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: Java uses explicit type annotations (User user = findUser())
// Tests that regular typed receiver resolution works with competing save() methods
// when the variable is assigned from a factory method returning the same type.
// Note: Java Optional<User> stores just "Optional" in TypeEnv (generics stripped),
// so this test uses plain typed variables to validate receiver disambiguation.
// ---------------------------------------------------------------------------

describe('Java nullable receiver resolution (typed factory return)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-nullable-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/User.java');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to Repo.save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/Repo.java');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('user.save() does NOT resolve to Repo.save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save' && c.source === 'processEntities');
    // Each save() call should resolve to exactly one target file
    expect(saveCalls.filter(c => c.targetFilePath === 'models/User.java').length).toBe(1);
    expect(saveCalls.filter(c => c.targetFilePath === 'models/Repo.java').length).toBe(1);
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Java assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-assignment-chain'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.save() must resolve to User#save
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath.includes('User.java'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: alias comes from User, so only one edge to User.java
    const wrongCall = calls.filter(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath.includes('User.java'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves rAlias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: rAlias.save() must resolve to Repo#save
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath.includes('Repo.java'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath.includes('User.java'),
    );
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath.includes('Repo.java'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Java Optional<User> receiver resolution — extractSimpleTypeName unwraps
// Optional<User> to "User" via NULLABLE_WRAPPER_TYPES, enabling receiver
// disambiguation when the declaration type is Optional<T>.
// ---------------------------------------------------------------------------

describe('Java Optional<User> receiver resolution via wrapper unwrapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-optional-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User#save with Optional<User> in scope', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath?.includes('User.java'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo#save alongside Optional usage', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath?.includes('Repo.java'),
    );
    expect(repoSave).toBeDefined();
  });

  it('disambiguates user.save() and repo.save() to different files', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath?.includes('User.java'),
    );
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processEntities' && c.targetFilePath?.includes('Repo.java'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Chained method call resolution: svc.getUser().save()
// The receiver of save() is a method_invocation (getUser()), not a simple identifier.
// Resolution must walk the chain: getUser() returns User, so save() → User#save.
// ---------------------------------------------------------------------------

describe('Java chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-chain-call'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects save methods on both User and Repo', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('detects getUser method on UserService', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getUser');
  });

  it('resolves svc.getUser().save() to User#save, NOT Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'processUser' &&
      c.targetFilePath.includes('User.java'),
    );
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'processUser' &&
      c.targetFilePath.includes('Repo.java'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Java 16+ instanceof pattern variable: `if (obj instanceof User user)`
// Phase 5.2: extractPatternBinding on instanceof_expression binds user → User.
// Disambiguation: User.save vs Repo.save — only User.save should be called.
// ---------------------------------------------------------------------------

describe('Java instanceof pattern variable resolution (Phase 5.2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-instanceof-pattern'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() inside if (obj instanceof User user) to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process' &&
      c.targetFilePath.includes('User.java'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'process' &&
      c.targetFilePath.includes('Repo.java'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enum static method calls: Status.fromCode(200) should resolve via
// class-as-receiver with Enum type included in the filter.
// ---------------------------------------------------------------------------

describe('Java enum static method call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-enum-static-call'),
      () => {},
    );
  }, 60000);

  it('detects Status as an Enum and App as a Class', () => {
    expect(getNodesByLabel(result, 'Enum')).toContain('Status');
    expect(getNodesByLabel(result, 'Class')).toContain('App');
  });

  it('detects fromCode and label methods on Status', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('fromCode');
    expect(methods).toContain('label');
  });

  it('resolves Status.fromCode(200) to Status#fromCode via class-as-receiver', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCodeCall = calls.find(c =>
      c.target === 'fromCode' &&
      c.source === 'process' &&
      c.targetFilePath?.includes('Status.java'),
    );
    expect(fromCodeCall).toBeDefined();
  });

  it('resolves s.label() to Status#label', () => {
    const calls = getRelationships(result, 'CALLS');
    const labelCall = calls.find(c =>
      c.target === 'label' &&
      c.source === 'process' &&
      c.targetFilePath?.includes('Status.java'),
    );
    expect(labelCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Java 21+ switch pattern matching: switch (obj) { case User user -> user.save(); }
// ---------------------------------------------------------------------------

describe('Java switch pattern binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-switch-pattern'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() in switch case User to models/User.java', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processAny' && c.targetFilePath === 'models/User.java',
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in switch case Repo to models/Repo.java', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processAny' && c.targetFilePath === 'models/Repo.java',
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves user.save() in handleUser switch case User to models/User.java', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'handleUser' && c.targetFilePath === 'models/User.java',
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve handleUser switch case User to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'handleUser' && c.targetFilePath === 'models/Repo.java',
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Java Map .values() for-loop — method-aware type arg resolution
// ---------------------------------------------------------------------------

describe('Java Map .values() for-loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-map-keys-values'),
      () => {},
    );
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() via Map.values() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processValues' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'processValues' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves user.save() via List iteration to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processList' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Java enhanced for-loop with call_expression iterable: for (User user : getUsers())
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('Java foreach call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-foreach-call-expr'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in foreach over User.getUsers() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User.java'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in foreach over Repo.getRepos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo.java'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo.java'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('User.java'),
    );
    expect(wrongSave).toBeUndefined();
  });
});
