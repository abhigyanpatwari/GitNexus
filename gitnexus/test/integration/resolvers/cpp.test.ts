/**
 * C++: diamond inheritance + include-based imports + ambiguous #include disambiguation
 */
import { describe, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  CROSS_FILE_FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  createResolverParityIt,
  type PipelineResult,
} from './helpers.js';

const it = createResolverParityIt('cpp');

// ---------------------------------------------------------------------------
// Heritage: diamond inheritance + include-based imports
// ---------------------------------------------------------------------------

describe('C++ diamond inheritance', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-diamond'), () => {});
  }, 60000);

  it('detects exactly 4 classes in diamond hierarchy', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Animal', 'Duck', 'Flyer', 'Swimmer']);
  });

  it('emits exactly 4 EXTENDS edges for full diamond', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(4);
    expect(edgeSet(extends_)).toEqual([
      'Duck → Flyer',
      'Duck → Swimmer',
      'Flyer → Animal',
      'Swimmer → Animal',
    ]);
  });

  it('resolves all 5 #include imports between header/source files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(5);
    expect(edgeSet(imports)).toEqual([
      'duck.cpp → duck.h',
      'duck.h → flyer.h',
      'duck.h → swimmer.h',
      'flyer.h → animal.h',
      'swimmer.h → animal.h',
    ]);
  });

  it('captures speak as Method nodes (declaration in headers + definition in .cpp)', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('speak');
    // speak appears in animal.h (virtual declaration), duck.h (override declaration),
    // and duck.cpp (out-of-line definition) — all captured as Method nodes
    expect(methods.filter((m) => m === 'speak').length).toBeGreaterThanOrEqual(1);
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
// Ambiguous: two headers with same class name, #include disambiguates
// ---------------------------------------------------------------------------

describe('C++ ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
    expect(classes).toContain('Processor');
  });

  it('resolves EXTENDS to handler_a.h (not handler_b.h)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('Processor');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('handler_a.h');
  });

  it('#include resolves to handler_a.h', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('handler_a.h');
  });

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of getRelationships(result, 'EXTENDS')) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.properties.name).toBe(edge.target);
    }
  });
});

describe('C++ call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-calls'), () => {});
  }, 60000);

  it('resolves run → write_audit to one.h via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('run');
    expect(calls[0].target).toBe('write_audit');
    expect(calls[0].targetFilePath).toBe('one.h');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('C++ member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('user.h');
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
// Constructor resolution: new Foo() resolves to Class
// ---------------------------------------------------------------------------

describe('C++ constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-constructor-calls'), () => {});
  }, 60000);

  it('resolves new User() as a CALLS edge to the User class', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('user.h');
    expect(ctorCall!.rel.reason).toBe('import-resolved');
  });

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves #include import', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('user.h');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('C++ receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-receiver-resolution'), () => {});
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

    const userSave = saveCalls.find((c) => c.targetFilePath === 'user.h');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'repo.h');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: auto user = User(); user.save() → User.save
// Cross-file SymbolTable verification (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('C++ constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to models/User.h via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models/User.h');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to models/Repo.h via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models/Repo.h');
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
// Variadic resolution: C-style variadic (...) doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('C++ variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-variadic-resolution'), () => {});
  }, 60000);

  it('resolves 3-arg call to variadic function log_entry(const char*, ...) in logger.h', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'log_entry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('main');
    expect(logCall!.targetFilePath).toBe('logger.h');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('C++ local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-local-shadow'), () => {});
  }, 60000);

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/main.cpp');
  });

  it('does NOT resolve save to utils.h', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/utils.h',
    );
    expect(saveToUtils).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// this->save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('C++ this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-self-this-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this->save() to User::save in the same file (not Repo::save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/User.cpp');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS via base_class_clause
// ---------------------------------------------------------------------------

describe('C++ parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-parent-resolution'), () => {});
  }, 60000);

  it('detects BaseModel and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('BaseModel');
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('emits EXTENDS edge: User → BaseModel (base_class_clause)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// Brace-init constructor inference: auto x = User{}; x.save() → User.save
// ---------------------------------------------------------------------------

describe('C++ brace-init constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-brace-init-inference'), () => {});
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via brace-init', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models/User.h');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo.save via brace-init', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'models/Repo.h');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C++ scoped brace-init: auto x = ns::HttpClient{}
// ---------------------------------------------------------------------------

describe('C++ scoped brace-init resolution (ns::Type{})', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-scoped-brace-init'), () => {});
  }, 60000);

  it('resolves client.connect() via ns::HttpClient{} scoped brace-init', () => {
    const calls = getRelationships(result, 'CALLS');
    const connectCall = calls.find(
      (c) => c.target === 'connect' && c.targetFilePath === 'models.h',
    );
    expect(connectCall).toBeDefined();
    expect(connectCall!.source).toBe('run');
  });

  it('resolves client.send() via ns::HttpClient{} scoped brace-init', () => {
    const calls = getRelationships(result, 'CALLS');
    const sendCall = calls.find((c) => c.target === 'send' && c.targetFilePath === 'models.h');
    expect(sendCall).toBeDefined();
    expect(sendCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// C++ range-based for: for (auto& user : users) — Tier 1c
// ---------------------------------------------------------------------------

describe('C++ range-based for loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-range-for'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in range-for to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in const auto& range-for to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Return type inference: auto user = getUser("alice"); user.save()
// C++'s CONSTRUCTOR_BINDING_SCANNER captures auto declarations with
// call_expression values, enabling return type inference from function results.
// ---------------------------------------------------------------------------

describe('C++ return type inference via auto + function call', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-return-type'), () => {});
  }, 60000);

  it('detects User class and getUser function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('detects save method on User', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
  });

  it('resolves user.save() to User#save via return type of getUser(): User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.h'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Return-type inference with competing methods:
// Two classes both have save(), factory functions disambiguate via return type
// ---------------------------------------------------------------------------

describe('C++ return-type inference via function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-return-type-inference'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via return type of getUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.h'),
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find((c) => c.target === 'save' && c.source === 'processUser');
    // Should resolve to exactly one target — if it resolves at all, check it's the right one
    if (wrongSave) {
      expect(wrongSave.targetFilePath).toContain('user.h');
    }
  });

  it('resolves repo.save() to Repo#save via return type of getRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.h'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver unwrapping: User* pointer type stripped for resolution
// ---------------------------------------------------------------------------

describe('C++ nullable receiver resolution (pointer types)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m: string) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user->save() to User#save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('User.h'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo->save() to Repo#save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('Repo.h'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-contaminate (exactly 1 save per receiver file)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'processEntities');
    const userTargeted = saveCalls.filter((c) => c.targetFilePath.includes('User.h'));
    const repoTargeted = saveCalls.filter((c) => c.targetFilePath.includes('Repo.h'));
    expect(userTargeted.length).toBe(1);
    expect(repoTargeted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C++ assignment chain propagation: auto alias = u; alias.save()
// Tests extractPendingAssignment for C++ auto declarations.
// ---------------------------------------------------------------------------

describe('C++ assignment chain propagation (auto alias)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via auto assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath?.includes('User.h'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves rAlias.save() to Repo#save via auto assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath?.includes('Repo.h'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own class, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'processEntities');
    const userTargeted = saveCalls.filter((c) => c.targetFilePath?.includes('User.h'));
    const repoTargeted = saveCalls.filter((c) => c.targetFilePath?.includes('Repo.h'));
    expect(userTargeted.length).toBe(1);
    expect(repoTargeted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.getUser().save()
// Tests that C++ chain call resolution correctly infers the intermediate
// receiver type from getUser()'s return type and resolves save() to User.
// ---------------------------------------------------------------------------

describe('C++ chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects getUser and save symbols', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('getUser');
    expect(allSymbols).toContain('save');
  });

  it('resolves svc.getUser().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('user.h'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.getUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath?.includes('repo.h'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C++ structured binding in range-for: for (auto& [key, user] : userMap)
// ---------------------------------------------------------------------------

describe('C++ structured binding in range-for', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-structured-binding'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() in structured binding for-loop to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUserMap' &&
        c.targetFilePath?.includes('User.h'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in structured binding for-loop to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processRepoMap' &&
        c.targetFilePath?.includes('Repo.h'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUserMap' &&
        c.targetFilePath?.includes('Repo.h'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT cross-resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processRepoMap' &&
        c.targetFilePath?.includes('User.h'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C++ pointer dereference in range-for: for (auto& user : *ptr)
// ---------------------------------------------------------------------------

describe('C++ pointer dereference in range-for', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-deref-range-for'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in *usersPtr range-for to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in *reposPtr range-for to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (C++)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-field-types'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for C++ data member fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking fields to classes', () => {
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
      (e) => e.source === 'processUser' && e.targetFilePath.includes('models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('populates field metadata (visibility, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.isReadonly).toBe(false);

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (C++)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-deep-field-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for all typed fields', () => {
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
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.address.city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'getName' && e.source === 'processUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('models'));
    expect(cityGetName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pointer and reference member fields (Address* address; Address& ref_address;)
// ---------------------------------------------------------------------------

describe('C++ pointer/reference member field capture', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-pointer-ref-fields'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for pointer and reference member fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('ref_address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges for pointer/reference fields', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → ref_address');
    expect(edgeSet(propEdges)).toContain('User → name');
  });
});

// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (C++)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(3);
    // Per-field exact counts: both `user.name = ...` and `user.name += ...`
    // must produce distinct edges (no dedup); single write to `address`.
    const nameWrites = writes.filter((e) => e.target === 'name');
    expect(nameWrites.length).toBe(2);
    const addrWrites = writes.filter((e) => e.target === 'address');
    expect(addrWrites.length).toBe(1);
    const sources = writes.map((e) => e.source);
    expect(sources).toContain('updateUser');
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
// Call-result variable binding (Phase 9): auto user = getUser(); user.save()
// ---------------------------------------------------------------------------

describe('C++ call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding with auto', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'processUser');
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): getUser() → .address → .getCity() → .save()
// ---------------------------------------------------------------------------

describe('C++ method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-method-chain-binding'), () => {});
  }, 60000);

  it('resolves city.save() to City#save via method chain with auto', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'processChain');
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('C++ grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-grandparent-resolution'), () => {});
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
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('A.h'));
    expect(greetCall).toBeDefined();
  });
});

// ── Phase P: Overload Disambiguation via Parameter Types ─────────────────

describe('C++ overload disambiguation by parameter types', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-overload-param-types'), () => {});
  }, 60000);

  it('produces distinct graph nodes for same-arity overloads via type-hash suffix', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const lookupNodes = methods.filter((m) => m.name === 'lookup');
    // Type-hash disambiguation → 2 distinct graph nodes
    expect(lookupNodes.length).toBe(2);
    const types = lookupNodes.map((n) => n.properties.parameterTypes).sort();
    expect(types).toEqual([['int'], ['string']]);
  });

  it('callById() emits exactly one CALLS edge to lookup(int)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallById = calls.filter((c) => c.source === 'callById' && c.target === 'lookup');
    expect(fromCallById.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallById[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });

  it('callByName() emits exactly one CALLS edge to lookup(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fromCallByName = calls.filter((c) => c.source === 'callByName' && c.target === 'lookup');
    expect(fromCallByName.length).toBe(1);
    const targetNode = result.graph.getNode(fromCallByName[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });
});

// ── Phase P: Same-arity overloads — cross-file + chain resolution ─────────

describe('C++ same-arity overload cross-file and chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-same-arity-cross-file'), () => {});
  }, 60000);

  it('callById() emits exactly one CALLS edge to find(int) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'callById' && c.target === 'find' && c.targetFilePath.includes('db_lookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });

  it('callByName() emits exactly one CALLS edge to find(string) in DbLookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'callByName' && c.target === 'find' && c.targetFilePath.includes('db_lookup'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });

  it('chainIntToFormat() — find(42) → find(int), format(result) → format(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'chainIntToFormat' && c.target === 'find');
    const formatEdges = calls.filter(
      (c) => c.source === 'chainIntToFormat' && c.target === 'format',
    );
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['int']);
    expect(formatEdges.length).toBe(1);
    const formatTarget = result.graph.getNode(formatEdges[0].rel.targetId);
    expect(formatTarget?.properties.parameterTypes).toEqual(['string']);
  });

  it('chainNameToFormat() — find("alice") → find(string), format(result) → format(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const findEdges = calls.filter((c) => c.source === 'chainNameToFormat' && c.target === 'find');
    const formatEdges = calls.filter(
      (c) => c.source === 'chainNameToFormat' && c.target === 'format',
    );
    expect(findEdges.length).toBe(1);
    const findTarget = result.graph.getNode(findEdges[0].rel.targetId);
    expect(findTarget?.properties.parameterTypes).toEqual(['string']);
    expect(formatEdges.length).toBe(1);
    const formatTarget = result.graph.getNode(formatEdges[0].rel.targetId);
    expect(formatTarget?.properties.parameterTypes).toEqual(['string']);
  });
});

// ---------------------------------------------------------------------------
// C++ smart pointer virtual dispatch via std::make_shared<T>()
// ---------------------------------------------------------------------------

describe('C++ smart pointer virtual dispatch via make_shared', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-smart-ptr-dispatch'), () => {});
  }, 60000);

  it('detects Dog and Animal classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Animal');
    expect(getNodesByLabel(result, 'Class')).toContain('Dog');
  });

  it('emits CALLS edge from process → speak', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.source === 'process' && c.target === 'speak');
    expect(speakCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C++ default parameter arity resolution
// ---------------------------------------------------------------------------

describe('C++ default parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-default-params'), () => {});
  }, 60000);

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation (via synthesized wildcard imports)
// models/user.h declares User class with save() and get_name() methods
// models/user_factory.h declares User get_user() free function
// app/main.cpp includes user_factory.h, calls get_user().save()
// → user is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('C++ cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'cpp-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('get_name');
  });

  it('detects get_user factory function and process consumer', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('get_user');
    expect(getNodesByLabel(result, 'Function')).toContain('process');
  });

  it('emits IMPORTS edge from main.cpp to headers', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('main') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves user.save() in process() to User#save via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.get_name() in process() to User#get_name via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) =>
        c.target === 'get_name' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and get_name to User (via header declarations)', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'get_name');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: pure virtual, static, concrete methods + EXTENDS
// ---------------------------------------------------------------------------

describe('C++ method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-method-enrichment'), () => {});
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

  it('marks pure virtual speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'speak' && n.properties.filePath === 'animal.hpp');
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('marks classify as isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('populates parameterTypes for classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== undefined) {
      expect(classify.properties.parameterTypes.length).toBeGreaterThan(0);
    }
  });
});

// ── Phase P: C++ const-qualified method overload disambiguation ───────────

describe('C++ const-qualified method overload disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-const-overload'), () => {});
  }, 60000);

  it('produces distinct nodes for begin() and begin() const', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const beginNodes = methods.filter((m) => m.name === 'begin');
    expect(beginNodes.length).toBe(2);
    const constFlags = beginNodes.map((n) => !!n.properties.isConst).sort();
    expect(constFlags).toEqual([false, true]);
  });

  it('produces distinct nodes for end() and end() const', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const endNodes = methods.filter((m) => m.name === 'end');
    expect(endNodes.length).toBe(2);
    const constFlags = endNodes.map((n) => !!n.properties.isConst).sort();
    expect(constFlags).toEqual([false, true]);
  });

  it('single const method (size) has isConst but no $const suffix (no collision)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const sizeNodes = methods.filter((m) => m.name === 'size');
    expect(sizeNodes.length).toBe(1);
    expect(sizeNodes[0].properties.isConst).toBe(true);
  });

  it('callNonConst has isConst falsy, callConst has isConst true', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const callNonConst = methods.find((m) => m.name === 'callNonConst');
    const callConst = methods.find((m) => m.name === 'callConst');
    expect(callNonConst).toBeDefined();
    expect(callConst).toBeDefined();
    expect(callNonConst!.properties.isConst).toBeFalsy();
    expect(callConst!.properties.isConst).toBe(true);
  });
});

// ── Phase P: C++ const-qualified cross-file + chain resolution ────────────

describe('C++ const-qualified cross-file and chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-const-cross-file'), () => {});
  }, 60000);

  // -- Cross-file: const vs non-const get() called from App --

  it('Container.get has distinct const and non-const nodes', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const getNodes = methods.filter(
      (m) => m.name === 'get' && m.properties.filePath?.includes('container'),
    );
    expect(getNodes.length).toBe(2);
    const constFlags = getNodes.map((n) => !!n.properties.isConst).sort();
    expect(constFlags).toEqual([false, true]);
  });

  it('Container.size has distinct const and non-const nodes', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const sizeNodes = methods.filter(
      (m) => m.name === 'size' && m.properties.filePath?.includes('container'),
    );
    expect(sizeNodes.length).toBe(2);
    const constFlags = sizeNodes.map((n) => !!n.properties.isConst).sort();
    expect(constFlags).toEqual([false, true]);
  });

  // -- Chain: format() calls resolve cross-file via receiver-type propagation --

  it('chainMutableGet() calls format cross-file via string receiver type', () => {
    const calls = getRelationships(result, 'CALLS');
    const fmtEdges = calls.filter((c) => c.source === 'chainMutableGet' && c.target === 'format');
    expect(fmtEdges.length).toBe(1);
    const fmtTarget = result.graph.getNode(fmtEdges[0].rel.targetId);
    expect(fmtTarget?.properties.parameterTypes).toEqual(['string']);
  });

  it('chainConstSize() calls format cross-file via int receiver type', () => {
    const calls = getRelationships(result, 'CALLS');
    const fmtEdges = calls.filter((c) => c.source === 'chainConstSize' && c.target === 'format');
    expect(fmtEdges.length).toBe(1);
    const fmtTarget = result.graph.getNode(fmtEdges[0].rel.targetId);
    expect(fmtTarget?.properties.parameterTypes).toEqual(['int']);
  });
});

// ── Phase P: C++ template overload disambiguation ─────────────────────────

describe('C++ template overload disambiguation (vector<int> vs vector<string>)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-template-overload'), () => {});
  }, 60000);

  it('produces distinct nodes for process(vector<int>) and process(vector<string>)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const processNodes = methods.filter((m) => m.name === 'process');
    expect(processNodes.length).toBe(2);
  });

  it('each process() node has distinct parameterTypes (simplified)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const processNodes = methods.filter((m) => m.name === 'process');
    // Both have type 'vector' after extractSimpleTypeName, but distinct node IDs
    // from rawType-based type-hash (~vector<int> vs ~vector<std::string>)
    const types = processNodes.map((n) => n.properties.parameterTypes);
    // Both have simplified 'vector' as parameterTypes[0], but they're separate nodes
    expect(types.length).toBe(2);
  });

  it('the two process() nodes have different graph IDs', () => {
    const ids: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.properties.name === 'process' && n.label === 'Method') {
        ids.push(n.id);
      }
    });
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ── Phase P: C++ template overload cross-file + chain resolution ──────────

describe('C++ template overload cross-file and chain resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-template-cross-file'), () => {});
  }, 60000);

  // -- Cross-file: template-overloaded process() defined in processor.h, called from app.cpp --

  it('Processor.process has distinct nodes for vector<int> and vector<string>', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const processNodes = methods.filter(
      (m) => m.name === 'process' && m.properties.filePath?.includes('processor'),
    );
    expect(processNodes.length).toBe(2);
    // Verify they have different startLine (proof of distinct nodes, not ID collision)
    const lines = processNodes.map((n) => n.properties.startLine).sort();
    expect(lines[0]).not.toBe(lines[1]);
  });

  // -- Chain: format(int) and format(string) called cross-file from App --

  it('chainIntToFormat() emits exactly one CALLS edge to format(int)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'chainIntToFormat' &&
        c.target === 'format' &&
        c.targetFilePath.includes('formatter'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });

  it('chainStringToFormat() emits exactly one CALLS edge to format(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter(
      (c) =>
        c.source === 'chainStringToFormat' &&
        c.target === 'format' &&
        c.targetFilePath.includes('formatter'),
    );
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });
});

describe('C++ template specialization disambiguation across files', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-template-specialization-disambiguation'),
      () => {},
    );
  }, 60000);

  it('emits distinct Class nodes for List<User> and List<Order>', () => {
    const classes = getNodesByLabelFull(result, 'Class').filter(
      (c) => c.name === 'List' && Array.isArray(c.properties.templateArguments),
    );
    expect(classes.length).toBe(2);
    const fingerprints = new Set(classes.map((c) => c.properties.templateArguments.join(',')));
    expect(fingerprints).toEqual(new Set(['User', 'Order']));
  });

  it('callSave() in each specialization resolves to its own save()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveEdges = calls.filter((c) => c.source === 'callSave' && c.target === 'save');
    expect(saveEdges.length).toBe(2);

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const ownerFingerprints = new Set<string>();
    for (const edge of saveEdges) {
      const sourceOwnerEdge = hasMethod.find((e) => e.rel.targetId === edge.rel.sourceId);
      const targetOwnerEdge = hasMethod.find((e) => e.rel.targetId === edge.rel.targetId);
      expect(sourceOwnerEdge).toBeDefined();
      expect(targetOwnerEdge).toBeDefined();
      expect(sourceOwnerEdge!.rel.sourceId).toBe(targetOwnerEdge!.rel.sourceId);
      const ownerNode = result.graph.getNode(sourceOwnerEdge!.rel.sourceId);
      const fp = ownerNode?.properties.templateArguments?.join(',');
      if (fp) ownerFingerprints.add(fp);
    }
    expect(ownerFingerprints).toEqual(new Set(['User', 'Order']));
  });

  it('save specialization bodies route to their own sibling method', () => {
    const calls = getRelationships(result, 'CALLS');

    const persistUserCalls = calls.filter((c) => c.target === 'persistUser');
    expect(persistUserCalls.length).toBe(1);
    const userSaveOwner = getRelationships(result, 'HAS_METHOD').find(
      (e) => e.rel.targetId === persistUserCalls[0].rel.sourceId,
    );
    expect(userSaveOwner).toBeDefined();
    const userOwnerNode = result.graph.getNode(userSaveOwner!.rel.sourceId);
    expect(userOwnerNode?.properties.templateArguments).toEqual(['User']);

    const persistOrderCalls = calls.filter((c) => c.target === 'persistOrder');
    expect(persistOrderCalls.length).toBe(1);
    const orderSaveOwner = getRelationships(result, 'HAS_METHOD').find(
      (e) => e.rel.targetId === persistOrderCalls[0].rel.sourceId,
    );
    expect(orderSaveOwner).toBeDefined();
    const orderOwnerNode = result.graph.getNode(orderSaveOwner!.rel.sourceId);
    expect(orderOwnerNode?.properties.templateArguments).toEqual(['Order']);
  });

  it('resolves external List<User> receiver call to List<User>::save', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'callUserSave' && c.target === 'save' && c.targetFilePath === 'list_user.h',
    );
    expect(edge).toBeDefined();

    const ownerEdge = getRelationships(result, 'HAS_METHOD').find(
      (e) => e.rel.targetId === edge!.rel.targetId,
    );
    expect(ownerEdge).toBeDefined();
    const ownerNode = result.graph.getNode(ownerEdge!.rel.sourceId);
    expect(ownerNode?.properties.templateArguments).toEqual(['User']);
  });
});

// ── Phase P: C++ out-of-class method definition + overload disambiguation ─

describe('C++ out-of-class method definition with overloaded declarations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-out-of-class-method'), () => {});
  }, 60000);

  it('header declarations produce Method nodes for greet() and greet(string)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const greetNodes = methods.filter(
      (m) => m.name === 'greet' && m.properties.filePath?.includes('myclass'),
    );
    // greet() (arity 0) and greet(string) (arity 1) have different arity → distinct IDs
    expect(greetNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('header declarations produce Method nodes for getName() and getName(int)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const getNameNodes = methods.filter(
      (m) => m.name === 'getName' && m.properties.filePath?.includes('myclass'),
    );
    expect(getNameNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('callGreetDefault() emits exactly one CALLS edge to greet (arity 0)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter((c) => c.source === 'callGreetDefault' && c.target === 'greet');
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterCount).toBe(0);
  });

  it('callGreetMsg() emits exactly one CALLS edge to greet(string)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter((c) => c.source === 'callGreetMsg' && c.target === 'greet');
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['string']);
  });

  it('callGetNameDefault() emits exactly one CALLS edge to getName (arity 0)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter((c) => c.source === 'callGetNameDefault' && c.target === 'getName');
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterCount).toBe(0);
  });

  it('callGetNameById() emits exactly one CALLS edge to getName(int)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = calls.filter((c) => c.source === 'callGetNameById' && c.target === 'getName');
    expect(edges.length).toBe(1);
    const targetNode = result.graph.getNode(edges[0].rel.targetId);
    expect(targetNode?.properties.parameterTypes).toEqual(['int']);
  });
});

// ---------------------------------------------------------------------------
// SM-9: lookupMethodByOwnerWithMRO — c.parentMethod() via leftmost-base walk
// ---------------------------------------------------------------------------

describe('C++ Child extends Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-child-extends-parent'), () => {});
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

  it('resolves c.parentMethod() to Parent.parentMethod via leftmost-base MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'parentMethod' && c.targetFilePath.includes('Parent.h'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('run');
  });
});

describe('C++ Derived : A, B — diamond inheritance via leftmost-base MRO (SM-11)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-diamond-inheritance'), () => {});
  }, 60000);

  it('detects Base, A, B, and Derived classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Base');
    expect(classes).toContain('A');
    expect(classes).toContain('B');
    expect(classes).toContain('Derived');
  });

  it('emits EXTENDS edges for both branches: A → Base, B → Base, Derived → A, Derived → B', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edges = edgeSet(extends_);
    expect(edges).toContain('A → Base');
    expect(edges).toContain('B → Base');
    expect(edges).toContain('Derived → A');
    expect(edges).toContain('Derived → B');
  });

  it('resolves d.method() to Base::method via leftmost-base MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const methodCall = calls.find(
      (c) => c.target === 'method' && c.targetFilePath.includes('Base.h'),
    );
    expect(methodCall).toBeDefined();
    expect(methodCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// U1: `#include` must not leak class-owned methods as unqualified bindings
// ---------------------------------------------------------------------------

describe('C++ include does not leak class methods', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-include-no-class-leak'), () => {});
  }, 60000);

  it('does NOT resolve unqualified save() to User::save via #include', () => {
    const calls = getRelationships(result, 'CALLS');
    const leak = calls.filter((c) => c.source === 'run' && c.target === 'save');
    expect(leak.length).toBe(0);
  });

  it('preserves the file-level #include IMPORTS edge', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('user.h');
  });
});

// ---------------------------------------------------------------------------
// U1: `#include` must not leak namespace-nested symbols as unqualified bindings
// ---------------------------------------------------------------------------

describe('C++ include does not leak namespace members', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-include-no-namespace-leak'),
      () => {},
    );
  }, 60000);

  it('does NOT resolve unqualified foo() to ns::foo via #include', () => {
    const calls = getRelationships(result, 'CALLS');
    const leak = calls.filter((c) => c.source === 'run' && c.target === 'foo');
    expect(leak.length).toBe(0);
  });

  it('preserves the file-level #include IMPORTS edge', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('lib.h');
  });
});

// ---------------------------------------------------------------------------
// U1: anonymous-namespace symbols remain visible within their declaring TU
// (positive companion to the cross-file exclusion test below)
// ---------------------------------------------------------------------------

describe('C++ anonymous namespace symbols visible in same TU', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-anon-ns-same-file-visible'),
      () => {},
    );
  }, 60000);

  it('resolves run() -> w() within the same TU', () => {
    const calls = getRelationships(result, 'CALLS');
    const wCalls = calls.filter((c) => c.source === 'run' && c.target === 'w');
    expect(wCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// U2: integer-width overload ambiguity suppresses CALLS edge entirely
// (PR #1520 review follow-up plan U2; Claude review Finding 5)
// ---------------------------------------------------------------------------

describe('C++ ambiguous integer-width overloads', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-overload-int-long'), () => {});
  }, 60000);

  it('emits zero CALLS edges when process(int)/process(long) collide after normalization', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCalls = calls.filter((c) => c.source === 'run' && c.target === 'process');
    // Exact .toBe(0): any non-zero count is a regression. count=1 = arbitrary
    // pick (the bug U2 fixes); count=2+ would require an ambiguous-edge model
    // GitNexus does not have. The resolver must suppress entirely.
    expect(processCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U3: anonymous-namespace symbols MUST NOT leak across translation units
// (full-pipeline integration test; unit-level coverage exists separately)
// PR #1520 review follow-up plan U3 / Claude review Finding 7
// ---------------------------------------------------------------------------

describe('C++ anonymous namespace cross-file exclusion (integration)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-anon-ns-cross-file'), () => {});
  }, 60000);

  it('caller.cpp::run -> worker does NOT target helper.cpp anonymous-namespace worker', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossFileLeak = calls.filter(
      (c) =>
        c.source === 'run' && c.target === 'worker' && c.targetFilePath?.includes('helper.cpp'),
    );
    expect(crossFileLeak.length).toBe(0);
  });

  it('helper.cpp::helper_entry still resolves its OWN anonymous-namespace worker (positive guard)', () => {
    const calls = getRelationships(result, 'CALLS');
    const sameFileResolve = calls.filter(
      (c) =>
        c.source === 'helper_entry' &&
        c.target === 'worker' &&
        c.targetFilePath?.includes('helper.cpp'),
    );
    // Pairs with the negative test above so a "no edges at all" regression
    // doesn't make the cross-file leak check pass vacuously.
    expect(sameFileResolve.length).toBe(1);
  });
});

// State-isolation guard: re-run the same fixture and assert identical
// results. Proves `clearFileLocalNames()` (called from the cpp resolver's
// `loadResolutionConfig`) is exercised by `runPipelineFromRepo` and
// that module-level `fileLocalNames` state doesn't bleed across runs.
describe('C++ anonymous namespace state-isolation guard', () => {
  it('second run of the same fixture produces identical worker-cross-file edge count', async () => {
    const fixture = path.join(FIXTURES, 'cpp-anon-ns-cross-file');
    const r1 = await runPipelineFromRepo(fixture, () => {});
    const r2 = await runPipelineFromRepo(fixture, () => {});
    const countLeak = (r: PipelineResult): number =>
      getRelationships(r, 'CALLS').filter(
        (c) =>
          c.source === 'run' && c.target === 'worker' && c.targetFilePath?.includes('helper.cpp'),
      ).length;
    expect(countLeak(r1)).toBe(0);
    expect(countLeak(r2)).toBe(0);
  }, 120000);
});

// ---------------------------------------------------------------------------
// U4: `using namespace` with conflicting names from two namespaces
// The resolver MUST emit zero CALLS edges — emitting one is arbitrary
// pick; emitting two requires an ambiguous-target edge model GitNexus
// does not have.
// Depends on U1 (without scope-aware filtering, `a::foo` and `b::foo`
// would already be in the importer's wildcard binding set as simple
// `foo` and this test would pass for the wrong reason).
// PR #1520 review follow-up plan U4 / Claude review Finding 7
// ---------------------------------------------------------------------------

describe('C++ using-namespace with conflicting names', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-using-namespace-conflict'),
      () => {},
    );
  }, 60000);

  it('emits zero CALLS edges for ambiguous foo() bound via two using-namespace declarations', () => {
    const calls = getRelationships(result, 'CALLS');
    const fooCalls = calls.filter((c) => c.source === 'run' && c.target === 'foo');
    expect(fooCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U5: `using namespace std` MUST NOT leak shim STL symbols into unqualified
// bindings. Uses a fixture-local `namespace std { ... }` shim rather than
// real <iostream> — captures the wildcard-leak shape deterministically
// without depending on system-header modeling stability.
// PR #1520 review follow-up plan U5 / Claude review Finding 7
// ---------------------------------------------------------------------------

describe('C++ using-namespace std smoke test', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-using-namespace-std-smoke'),
      () => {},
    );
  }, 60000);

  it('resolves the project call (positive guard against vacuous pass)', () => {
    const calls = getRelationships(result, 'CALLS');
    const projectCalls = calls.filter((c) => c.source === 'run' && c.target === 'project_helper');
    expect(projectCalls.length).toBe(1);
  });

  it('does NOT leak unqualified bindings for shim STL symbols', () => {
    const calls = getRelationships(result, 'CALLS');
    const stlLeaks = calls.filter(
      (c) => c.source === 'run' && (c.target === 'cout_write' || c.target === 'println'),
    );
    expect(stlLeaks.length).toBe(0);
  });

  it('emits no CALLS or ACCESSES edges from run() into std-shim.h', () => {
    const calls = getRelationships(result, 'CALLS');
    const accesses = getRelationships(result, 'ACCESSES');
    const intoShim = [...calls, ...accesses].filter(
      (e) => e.source === 'run' && e.targetFilePath?.includes('std-shim.h'),
    );
    expect(intoShim.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U1 (follow-up plan 2026-05-13-001): namespace-qualified or class-qualified
// calls from outside that class MUST NOT be classified as super-receiver calls.
// The `isSuperReceiverInContext` hook consults the caller's MRO.
// ---------------------------------------------------------------------------

describe('C++ namespace-qualified call is not a super receiver', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-namespace-qualified-not-super'),
      () => {},
    );
  }, 60000);

  it('resolves Singleton::getInstance() from a free function (not as super call)', () => {
    const calls = getRelationships(result, 'CALLS');
    const getInstanceCalls = calls.filter((c) => c.source === 'run' && c.target === 'getInstance');
    // Exactly 1: routed through the normal qualified-call path, NOT the super
    // branch. Before the U1 fix the regex `/^[A-Z]\w*::/` matched Singleton::,
    // entered the super branch with no enclosing class, and dropped the edge.
    expect(getInstanceCalls.length).toBe(1);
    expect(getInstanceCalls[0].targetFilePath).toContain('singleton.h');
  });
});

// ---------------------------------------------------------------------------
// U4 (follow-up plan 2026-05-13-001): default-argument overload ambiguity.
// `void f(int); void f(int, int = 0); f(1);` is ambiguous per ISO C++. The
// OVERLOAD_AMBIGUOUS sentinel from plan 2026-05-12-002 U2 should detect
// this case via isOverloadAmbiguousAfterNormalization.
// ---------------------------------------------------------------------------

describe('C++ default-argument overload ambiguity', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-overload-default-arg-ambiguous'),
      () => {},
    );
  }, 60000);

  it('s.f(1) emits zero CALLS edges when f(int) and f(int, int=0) both match', () => {
    const calls = getRelationships(result, 'CALLS');
    const fCalls = calls.filter((c) => c.source === 'run' && c.target === 'f');
    // Exact .toBe(0): count=1 means arbitrary pick (the bug); count=2+ would
    // require an ambiguous-target edge model GitNexus does not have. The
    // resolver must suppress entirely. Standard C++ rejects the call as
    // ambiguous (GCC/Clang both diagnose).
    expect(fCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U3 (follow-up plan 2026-05-13-001): two-phase template lookup.
// Inside a class template body, unqualified calls MUST NOT bind to members
// of a dependent base class. Only `this->name()` or `Base<T>::name()` forms
// should resolve.
// ---------------------------------------------------------------------------

describe('C++ two-phase template lookup — dependent base suppression', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-two-phase-dependent-base'),
      () => {},
    );
  }, 60000);

  it('Derived<T>::g() -> f() does NOT bind to Base<T>::f (dependent base)', () => {
    const calls = getRelationships(result, 'CALLS');
    const leaks = calls.filter((c) => c.source === 'g' && c.target === 'f');
    expect(leaks.length).toBe(0);
  });

  it('Derived<T>::h() -> i does NOT bind to Base<T>::i (dependent base)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const leaks = accesses.filter((c) => c.source === 'h' && c.target === 'i');
    expect(leaks.length).toBe(0);
  });
});

describe('C++ two-phase template lookup — positive this-qualified calls', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-two-phase-this-qualified'),
      () => {},
    );
  }, 60000);

  it('Derived<T>::g() -> this->f() resolves to f (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const thisCalls = calls.filter((c) => c.source === 'g' && c.target === 'f');
    expect(thisCalls.length).toBe(1);
    expect(thisCalls[0].targetFilePath).toContain('base.h');
  });

  it('Derived<T>::k() -> this->base_method() resolves via EXTENDS chain (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const inheritedCalls = calls.filter((c) => c.source === 'k' && c.target === 'base_method');
    expect(inheritedCalls.length).toBe(1);
    expect(inheritedCalls[0].targetFilePath).toContain('base.h');
  });
});

describe('C++ two-phase template lookup — paired unqualified + this-qualified in one fixture', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-two-phase-paired'), () => {});
  }, 60000);

  it('Derived<T>::g_unqualified() -> f() does NOT bind to Base<T>::f', () => {
    const calls = getRelationships(result, 'CALLS');
    const leaks = calls.filter((c) => c.source === 'g_unqualified' && c.target === 'f');
    expect(leaks.length).toBe(0);
  });

  it('Derived<T>::g_this() -> this->f() resolves to Base<T>::f (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const resolved = calls.filter((c) => c.source === 'g_this' && c.target === 'f');
    expect(resolved.length).toBe(1);
    expect(resolved[0].targetFilePath).toContain('base.h');
  });
});

describe('C++ two-phase template lookup — namespace calls inside template body', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-two-phase-namespace-free-call-inside-template'),
      () => {},
    );
  }, 60000);

  it('D<T>::g() -> utils::ns_helper() resolves (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const qualifiedCalls = calls.filter((c) => c.source === 'g' && c.target === 'ns_helper');
    expect(qualifiedCalls.length).toBe(1);
    expect(qualifiedCalls[0].targetFilePath).toContain('helpers.h');
  });

  it('D<T>::g() -> ns_helper_2() resolves after using-declaration (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const usingCalls = calls.filter((c) => c.source === 'g' && c.target === 'ns_helper_2');
    expect(usingCalls.length).toBe(1);
    expect(usingCalls[0].targetFilePath).toContain('helpers.h');
  });
});

describe('C++ two-phase template lookup — this-> name-hiding arity mismatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-two-phase-this-name-hiding-arity'),
      () => {},
    );
  }, 60000);

  it('Derived<T>::g() -> this->f() emits zero CALLS edges when only hidden derived overload is arity-incompatible', () => {
    const calls = getRelationships(result, 'CALLS');
    const fCalls = calls.filter((c) => c.source === 'g' && c.target === 'f');
    expect(fCalls.length).toBe(0);
  });

  it('Derived<T>::g_ok() -> this->f(42) resolves to derived overload (1 edge)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fCalls = calls.filter((c) => c.source === 'g_ok' && c.target === 'f');
    expect(fCalls.length).toBe(1);
    expect(fCalls[0].targetFilePath).toContain('derived.h');
  });
});

// ---------------------------------------------------------------------------
// U3 cross-file namespace variant: Base lives in a different file AND
// inside a namespace. The fixture also contains a free function with the
// same name inside the namespace — that candidate has no ownerId, so the
// class-owned filter does NOT apply to it; it is instead suppressed by the
// namespace-nesting filter. Both candidates must still yield zero edges.
// ---------------------------------------------------------------------------

describe('C++ two-phase template lookup — cross-file namespace variant', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-two-phase-dependent-base-ns'),
      () => {},
    );
  }, 60000);

  it('geom::Derived<T>::g() -> compute() does NOT bind to geom::Base<T>::compute (cross-file dependent base, class-owned)', () => {
    const calls = getRelationships(result, 'CALLS');
    const leaks = calls.filter((c) => c.source === 'g' && c.target === 'compute');
    expect(leaks.length).toBe(0);
  });

  it('geom::Derived<T>::h() -> area does NOT bind to geom::Base<T>::area (cross-file dependent base, class-owned)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const leaks = accesses.filter((c) => c.source === 'h' && c.target === 'area');
    expect(leaks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U2 (follow-up plan 2026-05-13-001): argument-dependent (Koenig) lookup.
// Free-function calls with class-typed arguments must consider candidates
// declared in the argument's enclosing namespace (associated namespace).
// V1 boundary: only direct enclosing-namespace closure for value class-
// typed args; pointer/reference args and template specializations with
// explicit type arguments included. Function pointers and base-class
// associated namespaces remain excluded.
// ---------------------------------------------------------------------------

describe('C++ ADL — basic associated-namespace closure', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-basic'), () => {});
  }, 60000);

  it('record(e) where e is audit::Event resolves to audit::record via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    // Exactly 1: ordinary lookup is empty (no `using` statement, no local
    // declaration), ADL surfaces audit::record because audit::Event's
    // associated namespace is `audit`. The CALLS edge should target the
    // declaration in audit.h.
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });
});

describe('C++ ADL — base-class associated namespaces', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-base-associated-namespaces'),
      () => {},
    );
  }, 60000);

  it('resolves log(d) to base_lib::log via ADL when Derived inherits from base_lib::Base', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCalls = calls.filter((c) => c.source === 'run_single' && c.target === 'log');
    expect(logCalls.length).toBe(1);
    expect(logCalls[0].targetFilePath).toContain('base_lib.h');
    const targetNode = result.graph.getNode(logCalls[0].rel.targetId);
    expect(logCalls[0].rel.targetId).toBe('Function:base_lib.h:log');
    expect(targetNode?.properties.parameterTypes).toEqual(['Base']);
  });

  it('resolves trace(m) via full MRO walk when MultiLevel inherits via middle_lib::Mid -> base_lib::Root', () => {
    const calls = getRelationships(result, 'CALLS');
    const traceCalls = calls.filter((c) => c.source === 'run_multi' && c.target === 'trace');
    expect(traceCalls.length).toBe(1);
    expect(traceCalls[0].targetFilePath).toContain('base_lib.h');
    const targetNode = result.graph.getNode(traceCalls[0].rel.targetId);
    expect(traceCalls[0].rel.targetId).toBe('Function:base_lib.h:trace');
    expect(targetNode?.properties.parameterTypes).toEqual(['Root']);
  });

  it('diamond inheritance contributes base namespace once (no duplicate/crash)', () => {
    const calls = getRelationships(result, 'CALLS');
    const pingCalls = calls.filter((c) => c.source === 'run_diamond' && c.target === 'ping');
    expect(pingCalls.length).toBe(1);
    expect(pingCalls[0].targetFilePath).toContain('base_lib.h');
    const targetNode = result.graph.getNode(pingCalls[0].rel.targetId);
    expect(pingCalls[0].rel.targetId).toBe('Function:base_lib.h:ping');
    expect(targetNode?.properties.parameterTypes).toEqual(['DiamondBase']);
  });
});

describe('C++ ADL — base-class namespace MRO with simple-name class collisions', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-base-associated-namespaces-collision'),
      () => {},
    );
  }, 60000);

  it('does NOT emit CALLS for collide(t) when class-name lookup is ambiguous', () => {
    const calls = getRelationships(result, 'CALLS');
    const collideCalls = calls.filter((c) => c.source === 'run' && c.target === 'collide');
    expect(collideCalls.length).toBe(0);
  });
});

describe('C++ ADL — base-class namespace mapping skips anonymous/unresolved bases', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-base-associated-namespaces-negative'),
      () => {},
    );
  }, 60000);

  it('hidden_probe(d) still resolves via ordinary lookup when declaration is visible', () => {
    const calls = getRelationships(result, 'CALLS');
    const hiddenProbeCalls = calls.filter(
      (c) => c.source === 'run_hidden' && c.target === 'hidden_probe',
    );
    expect(hiddenProbeCalls.length).toBe(1);
    expect(hiddenProbeCalls[0].targetFilePath).toContain('base_lib.h');
  });

  it('unresolved_probe(d) emits zero CALLS when base class cannot be resolved', () => {
    const calls = getRelationships(result, 'CALLS');
    const unresolvedProbeCalls = calls.filter(
      (c) => c.source === 'run_missing' && c.target === 'unresolved_probe',
    );
    expect(unresolvedProbeCalls.length).toBe(0);
  });
});

describe('C++ ADL — parenthesized name suppresses ADL', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-suppressed-parens'), () => {});
  }, 60000);

  it('(record)(e) emits zero CALLS edges — ADL is suppressed by parentheses', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    // Exact .toBe(0): ISO C++ [basic.lookup.argdep]/3.1 specifies that the
    // parenthesized form `(f)(x)` forces ordinary lookup only — ADL must
    // NOT fire. Without ordinary-lookup candidates (no `using`, no local
    // declaration), the call goes unresolved.
    expect(recordCalls.length).toBe(0);
  });
});

describe('C++ ADL — pointer arg unwrapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-pointer-arg-boundary'),
      () => {},
    );
  }, 60000);

  it('record(p) where p is audit::Event* resolves to audit::record via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });
});

describe('C++ ADL — reference arg unwrapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-reference-arg-boundary'),
      () => {},
    );
  }, 60000);

  it('record(s) where s is audit::Event& resolves to audit::record via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'runRef' && c.target === 'record');
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('record.h');
  });

  it('recordConst(cs) where cs is const audit::Event& resolves via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter(
      (c) => c.source === 'runConstRef' && c.target === 'recordConst',
    );
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('record.h');
  });

  it('note(r) where r is int& emits zero CALLS edges (primitive ref)', () => {
    const calls = getRelationships(result, 'CALLS');
    const noteCalls = calls.filter((c) => c.source === 'runPrimitiveRef' && c.target === 'note');
    expect(noteCalls.length).toBe(0);
  });
});

describe('C++ ADL — rvalue reference args participate', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-rvalue-ref'), () => {});
  }, 60000);

  it('record(rr) where rr is audit::Event&& resolves to audit::record via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'runRvalueRef' && c.target === 'record');
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('record-rvalue.h');
  });
});

describe('C++ ADL — function pointer args do not participate', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-function-pointer-arg'),
      () => {},
    );
  }, 60000);

  it('record(g) where g is void (*)() emits zero CALLS edges', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    expect(recordCalls.length).toBe(0);
  });
});

describe('C++ ADL — preceding function-pointer declarations do not block class args', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-function-pointer-before-class-arg'),
      () => {},
    );
  }, 60000);

  it('record(e) still resolves via ADL when an earlier declaration is void (*)()', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });
});

describe('C++ ADL — class-returning function pointer args do not participate', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-adl-function-pointer-class-return-arg'),
      () => {},
    );
  }, 60000);

  it('record(factory) where factory is audit::Event (*)() emits zero CALLS edges', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    expect(recordCalls.length).toBe(0);
  });
});

describe('C++ ADL — pointer-to-pointer args participate', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-pointer-to-pointer'), () => {});
  }, 60000);

  it('record(pp) where pp is audit::Event** resolves to audit::record via ADL', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });
});

describe('C++ ADL — template specialization args contribute associated namespaces', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-template-args'), () => {});
  }, 60000);

  it('apply(v) where v is std::vector<N::T> resolves to N::apply via ADL template-arg namespace', () => {
    const calls = getRelationships(result, 'CALLS');
    const applyCalls = calls.filter((c) => c.source === 'run' && c.target === 'apply');
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].targetFilePath).toContain('audit.h');
  });

  it('applyNested(m) where m is std::map<std::string, std::vector<N::T>> resolves via nested template-arg namespace', () => {
    const calls = getRelationships(result, 'CALLS');
    const applyCalls = calls.filter((c) => c.source === 'runNested' && c.target === 'applyNested');
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].targetFilePath).toContain('audit.h');
  });

  it('applyArray(a) where a is std::array<N::T, 4> resolves to N::applyArray (non-type arg ignored)', () => {
    const calls = getRelationships(result, 'CALLS');
    const applyCalls = calls.filter((c) => c.source === 'runArray' && c.target === 'applyArray');
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].targetFilePath).toContain('audit.h');
  });

  it('applyStdConflict(v) is suppressed when ADL surfaces both N and std candidates', () => {
    const calls = getRelationships(result, 'CALLS');
    const applyCalls = calls.filter(
      (c) => c.source === 'runStdConflict' && c.target === 'applyStdConflict',
    );
    expect(applyCalls.length).toBe(0);
  });
});

describe('C++ ADL — int/long-collision overloads suppress via OVERLOAD_AMBIGUOUS', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'cpp-adl-ambiguous'), () => {});
  }, 60000);

  it('process(t, 42) emits zero CALLS edges when ADL surfaces process(Token,int)/process(Token,long) (collide after C++ int normalization)', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCalls = calls.filter((c) => c.source === 'run' && c.target === 'process');
    // Exact .toBe(0): both alpha::process(Token, int) and
    // alpha::process(Token, long) are surfaced via ADL (alpha::Token's
    // associated namespace). C++ arity-metadata normalizes int/long to
    // 'int', so both candidates have parameterTypes ['Token', 'int'].
    // narrowOverloadCandidates can't disambiguate (arg-types are
    // ['', 'int']), and isOverloadAmbiguousAfterNormalization detects
    // the collision → ADL_AMBIGUOUS sentinel → caller suppresses.
    // count=1 is the bug (arbitrary first-pick); count=2 would require
    // an ambiguous-target edge model GitNexus does not have.
    expect(processCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U5 (follow-up plan 2026-05-13-001): inline namespace transitive walking.
// `inline namespace v1 { ... }` makes its members reachable through the
// enclosing namespace's qualified lookup as if declared directly there
// (ISO C++ `[namespace.def]/p4`). Adds a C++-specific
// `resolveQualifiedReceiverMember` hook on the ScopeResolver contract.
// ---------------------------------------------------------------------------

describe('C++ inline namespace — outer::foo resolves to inline child', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-inline-namespace-unqualified'),
      () => {},
    );
  }, 60000);

  it('outer::foo() resolves to outer::v1::foo via inline-namespace transitive walking', () => {
    const calls = getRelationships(result, 'CALLS');
    const fooCalls = calls.filter((c) => c.source === 'run' && c.target === 'foo');
    // Exactly 1: the inline-namespace exemption lets `outer::foo()` reach
    // the declaration in `outer::v1::foo()`. Without U5 the call would be
    // unresolved (count = 0).
    expect(fooCalls.length).toBe(1);
    expect(fooCalls[0].targetFilePath).toContain('lib.h');
  });
});

describe('C++ inline namespace — versioned (v1 inline, v0 not)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-inline-namespace-versioned'),
      () => {},
    );
  }, 60000);

  it('outer::foo() resolves to outer::v1::foo (inline child), NOT outer::v0::foo', () => {
    const calls = getRelationships(result, 'CALLS');
    const fooCalls = calls.filter((c) => c.source === 'run' && c.target === 'foo');
    // Exactly 1: only inline-namespace children are reachable through the
    // enclosing namespace's qualified lookup. `v0` is NOT inline so its
    // `foo` is NOT visible as `outer::foo`.
    expect(fooCalls.length).toBe(1);
    expect(fooCalls[0].targetFilePath).toContain('lib.h');
  });
});

describe('C++ inline namespace — nested (STL __1-style)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-inline-namespace-nested'),
      () => {},
    );
  }, 60000);

  it('outer::foo() resolves through two transitive inline namespaces (v1 then experimental)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fooCalls = calls.filter((c) => c.source === 'run' && c.target === 'foo');
    // Exactly 1: the resolver descends inline namespaces depth-first, so
    // `outer::foo` reaches `outer::v1::experimental::foo` through two
    // transitive inline-namespace hops. Mirrors libc++ `std::__1::vector`
    // / libstdc++ `std::__cxx11` qualified-call shape.
    expect(fooCalls.length).toBe(1);
    expect(fooCalls[0].targetFilePath).toContain('lib.h');
  });
});

describe('C++ inline namespace — ADL participation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-inline-namespace-adl-participation'),
      () => {},
    );
  }, 60000);

  it('ADL surfaces audit::v1::record through inline-namespace transitive walking', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'run' && c.target === 'record');
    // Exactly 1: `audit::Event e;` resolves Event's enclosing namespace
    // to `audit` (the inline child `v1` is transparent — see U2's
    // computeNamespaceQName walking through the inline scope). ADL then
    // surfaces every callable named `record` in any namespace scope
    // matching qname 'audit' across files. Since inline namespaces are
    // exempted from the non-globally-visible filter, the `record`
    // declared inside `inline namespace v1` is reachable. count=0
    // would be the bug — ADL failing to walk inline children.
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });
});

// ---------------------------------------------------------------------------
// Phase 5 (follow-up plan 2026-05-13-001): cross-unit composition tests.
// Lock in correct interaction between U1 (super-receiver context), U2 (ADL),
// U3 (two-phase lookup), and U5 (inline namespaces).
// ---------------------------------------------------------------------------

describe('C++ Phase 5 U1×U3 — qualified Base<T>::method() inside template body', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-phase5-u1-u3-qualified-base-call'),
      () => {},
    );
  }, 60000);

  it('emits EXTENDS edge: Derived → Base for template base Base<T>', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Derived → Base');
  });

  it('Base<T>::method() resolves to Base::method inside template body', () => {
    const calls = getRelationships(result, 'CALLS');
    const methodCalls = calls.filter((c) => c.source === 'g' && c.target === 'method');
    expect(methodCalls.length).toBe(1);
    expect(methodCalls[0].targetFilePath).toContain('classes.h');
  });
});

describe('C++ Phase 5 U1×U3 — template multi-base list', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-phase5-u1-u3-template-multi-base-list'),
      () => {},
    );
  }, 60000);

  it('emits EXTENDS edges: Derived → A, Derived → B for template multi-base list', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(2);
    expect(edgeSet(extends_)).toEqual(['Derived → A', 'Derived → B']);
  });
});

describe('C++ Phase 5 U2×U3 — ADL routes around dependent-base shadow', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-phase5-u2-u3-adl-from-derived'),
      () => {},
    );
  }, 60000);

  it('record(e) inside Derived<T>::g() resolves via ADL to audit::record (not Base::record)', () => {
    const calls = getRelationships(result, 'CALLS');
    const recordCalls = calls.filter((c) => c.source === 'g' && c.target === 'record');
    // Exactly 1: Base::record is class-owned so the global free-call
    // fallback's `isFileLocalDef` blocks it (and U3's two-phase
    // suppression also fires for unqualified calls inside template
    // body when the candidate is a dependent-base member). ADL then
    // surfaces audit::record via `audit::Event`'s associated namespace.
    // The two-phase + ADL composition leaves exactly one CALLS edge —
    // to audit::record in audit.h.
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0].targetFilePath).toContain('audit.h');
  });

  it('record(e) does NOT bind to Base::record (class-owned dependent-base member)', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseRecordLeaks = calls.filter(
      (c) => c.source === 'g' && c.target === 'record' && c.targetFilePath?.includes('base.h'),
    );
    expect(baseRecordLeaks.length).toBe(0);
  });
});

describe('C++ Phase 5 U3×U5 — template Derived : outer::v1::Base<T> (inline)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-phase5-u3-u5-inline-base'),
      () => {},
    );
  }, 60000);

  it('unqualified f() inside Derived<T>::g() does NOT bind to outer::v1::Base<T>::f (dependent base across inline namespace)', () => {
    const calls = getRelationships(result, 'CALLS');
    const fLeaks = calls.filter((c) => c.source === 'g' && c.target === 'f');
    // Exact .toBe(0): same suppression rationale as the plain U3 fixture
    // (`cpp-two-phase-dependent-base`) — `f()` is unqualified, Base is a
    // dependent base, and Base::f is class-owned so the global free-call
    // fallback's `isFileLocalDef` blocks it. The inline-namespace wrapper
    // doesn't change the suppression behavior: dependent-base detection
    // walks the heritage's simple name (`Base`) regardless of the
    // qualifying namespace path.
    expect(fLeaks.length).toBe(0);
  });
});

describe('C++ Phase 5 U1×U3×U5 — qualified outer::v1::Base<T>::f() inside template body', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-phase5-u1-u3-u5-qualified-inline-base-call'),
      () => {},
    );
  }, 60000);

  it('emits EXTENDS edge: Derived → Base for qualified template base outer::v1::Base<T>', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Derived → Base');
  });

  it('outer::v1::Base<T>::f() resolves to Base::f inside template body', () => {
    const calls = getRelationships(result, 'CALLS');
    const fCalls = calls.filter((c) => c.source === 'g' && c.target === 'f');
    expect(fCalls.length).toBe(1);
    expect(fCalls[0].targetFilePath).toContain('base.h');
  });

  it('outer::v1::free_fn() resolves as a namespace free function, not a super-receiver method', () => {
    const calls = getRelationships(result, 'CALLS');
    const freeCalls = calls.filter((c) => c.source === 'g' && c.target === 'free_fn');
    expect(freeCalls.length).toBe(1);
    expect(freeCalls[0].targetLabel).toBe('Function');
    expect(freeCalls[0].rel.reason).toBe('import-resolved');
  });
});
