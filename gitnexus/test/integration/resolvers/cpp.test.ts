/**
 * C++: diamond inheritance + include-based imports + ambiguous #include disambiguation
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
    const overrides = getRelationships(result, 'OVERRIDES');
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
    expect(writes.length).toBe(2);
    const fieldNames = writes.map((e) => e.target);
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('address');
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

  it('detects lookup method with parameterTypes on graph node', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const lookupNodes = methods.filter((m) => m.name === 'lookup');
    expect(lookupNodes.length).toBe(1);
    expect(lookupNodes[0].properties.parameterTypes).toEqual(['int']);
  });

  it('emits CALLS edge from run() → lookup() via overload disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const lookupCalls = calls.filter((c) => c.source === 'run' && c.target === 'lookup');
    // Both lookup(42) and lookup("alice") resolve to same nodeId → 1 CALLS edge
    expect(lookupCalls.length).toBe(1);
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
