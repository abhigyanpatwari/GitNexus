import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ---------------------------------------------------------------------------
// Generic-base heritage (#1951): extends Box<T> already worked (value: identifier
// captures Base; type_args are a sibling), and `implements IFoo<T>` is resolved
// to its bare name IFoo. Scope-resolution (the single path since #942) owns
// these edges.
// ---------------------------------------------------------------------------

describe('TypeScript generic-base heritage resolution (#1951)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-generic-base'), () => {});
    },
    { timeout: 60000 },
  );

  it('emits EXTENDS Service → Box for a generic superclass (extends Box<string>)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['Service → Box']);
  });

  it('emits IMPLEMENTS Service → IFoo for a generic interface (implements IFoo<string>)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['Service → IFoo']);
  });
});

// ---------------------------------------------------------------------------
// Qualified (namespaced) bases (#1956 tri-review U2): `extends ns.Box<string>`
// + `implements ns.IFoo<string>` (qualified-generic, on Service) and `extends
// ns.Base` + `implements ns.IBar` (qualified non-generic, on Plain). extends
// uses a member_expression value; implements uses a nested_type_identifier
// (plain) or a generic_type wrapping one. Scope-resolution resolves these by
// their tail and owns these edges since #942.
// ---------------------------------------------------------------------------

describe('TypeScript qualified-base heritage resolution (#1956 U2)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-qualified-base'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('emits EXTENDS for qualified and qualified-generic superclasses', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['Plain → Base', 'Service → Box']);
  });

  it('emits IMPLEMENTS for qualified and qualified-generic interfaces', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['Plain → IBar', 'Service → IFoo']);
  });
});

// ---------------------------------------------------------------------------
// Heritage: class extends + implements interface
// ---------------------------------------------------------------------------

describe('TypeScript heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-ambiguous'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects exactly 3 classes and 1 interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual([
      'BaseService',
      'ConsoleLogger',
      'UserService',
    ]);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['ILogger']);
  });

  it('emits exactly 3 IMPORTS edges', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(3);
    expect(edgeSet(imports)).toEqual([
      'logger.ts → models.ts',
      'service.ts → logger.ts',
      'service.ts → models.ts',
    ]);
  });

  it('emits exactly 1 EXTENDS edge: UserService → BaseService', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserService');
    expect(extends_[0].target).toBe('BaseService');
  });

  it('emits exactly 2 IMPLEMENTS edges', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(implements_.length).toBe(2);
    expect(edgeSet(implements_)).toEqual(['ConsoleLogger → ILogger', 'UserService → ILogger']);
  });

  it('emits HAS_METHOD edges linking methods to classes', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    expect(hasMethod.length).toBe(5);
    expect(edgeSet(hasMethod)).toEqual([
      'BaseService → getName',
      'ConsoleLogger → log',
      'ILogger → log',
      'UserService → getUsers',
      'UserService → log',
    ]);
  });

  it('emits HAS_PROPERTY edge for class fields', () => {
    const hasProperty = getRelationships(result, 'HAS_PROPERTY');
    expect(hasProperty.length).toBe(1);
    expect(edgeSet(hasProperty)).toEqual(['BaseService → name']);
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
// Ambiguous: multiple definitions, imports disambiguate
// ---------------------------------------------------------------------------

describe('TypeScript ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-ambiguous'), () => {});
    },
    { timeout: 60000 },
  );

  it('UserService has exactly 1 EXTENDS + 1 IMPLEMENTS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'UserService');
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(
      (e) => e.source === 'UserService',
    );
    expect(extends_.length).toBe(1);
    expect(implements_.length).toBe(1);
  });

  it('ConsoleLogger has exactly 1 IMPLEMENTS and 0 EXTENDS', () => {
    const extends_ = getRelationships(result, 'EXTENDS').filter(
      (e) => e.source === 'ConsoleLogger',
    );
    const implements_ = getRelationships(result, 'IMPLEMENTS').filter(
      (e) => e.source === 'ConsoleLogger',
    );
    expect(extends_.length).toBe(0);
    expect(implements_.length).toBe(1);
    expect(implements_[0].target).toBe('ILogger');
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

describe('TypeScript call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-calls'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves run → writeAudit to src/one.ts via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('run');
    expect(calls[0].target).toBe('writeAudit');
    expect(calls[0].targetFilePath).toBe('src/one.ts');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Generic function call resolution: await fn<T>(args) creates CALLS edges
// ---------------------------------------------------------------------------

describe('TypeScript generic awaited call resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-generic-calls'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves authenticateUser → verifyToken via awaited generic call', () => {
    const calls = getRelationships(result, 'CALLS');
    const authCall = calls.find(
      (c) => c.source === 'authenticateUser' && c.target === 'verifyToken',
    );
    expect(authCall).toBeDefined();
    expect(authCall!.targetFilePath).toBe('src/token.ts');
  });

  it('resolves authenticateAdmin → verifyToken via awaited generic call', () => {
    const calls = getRelationships(result, 'CALLS');
    const adminCall = calls.find(
      (c) => c.source === 'authenticateAdmin' && c.target === 'verifyToken',
    );
    expect(adminCall).toBeDefined();
    expect(adminCall!.targetFilePath).toBe('src/token.ts');
  });

  it('resolves authenticateGuest → verify via awaited generic member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const guestCall = calls.find((c) => c.source === 'authenticateGuest' && c.target === 'verify');
    expect(guestCall).toBeDefined();
    expect(guestCall!.targetFilePath).toBe('src/service.ts');
  });

  it('verifyToken has exactly 2 incoming CALLS edges (both free-call callers resolved)', () => {
    const calls = getRelationships(result, 'CALLS');
    const incoming = calls.filter((c) => c.target === 'verifyToken');
    expect(incoming.length).toBe(2);
  });

  it('the awaited generic member call is not also a read of verify', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (a) => a.source === 'authenticateGuest',
    );
    expect(accesses.map((a) => a.target)).not.toContain('verify');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('TypeScript member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-member-calls'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves processUser → save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('src/user.ts');
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
// Constructor resolution: new Foo() resolves to Class/Constructor
// ---------------------------------------------------------------------------

describe('TypeScript constructor-call resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-constructor-calls'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('resolves new User() as a CALLS edge to the User class', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Class');
    expect(ctorCall!.targetFilePath).toBe('src/user.ts');
  });

  it('also resolves user.save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User class, save method, and processUser function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('processUser');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

describe('TypeScript receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-receiver-resolution'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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

    const userSave = saveCalls.find((c) => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'src/repo.ts');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scoped receiver resolution: same variable name in different functions
// resolves to different types via scope-aware TypeEnv
// ---------------------------------------------------------------------------

describe('TypeScript scoped receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-scoped-receiver'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves entity.save() in handleUser to User.save and in handleRepo to Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'src/user.ts');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'src/repo.ts');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Named import disambiguation: two files export same name, import resolves
// ---------------------------------------------------------------------------

describe('TypeScript named import disambiguation', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-named-imports'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves processInput → formatData to src/format-upper.ts via named import', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find((c) => c.target === 'formatData');
    expect(formatCall).toBeDefined();
    expect(formatCall!.source).toBe('processInput');
    expect(formatCall!.targetFilePath).toBe('src/format-upper.ts');
  });

  it('emits IMPORTS edge to format-upper.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find((e) => e.source === 'app.ts');
    expect(appImport).toBeDefined();
    expect(appImport!.targetFilePath).toBe('src/format-upper.ts');
  });
});

// ---------------------------------------------------------------------------
// Side-effect imports: `import './polyfill'` produces an IMPORTS edge but
// no local binding (side-effect imports count as module-reachability
// dependencies). The scope-resolution path emits no extra `BindingRef`s for
// the side-effect kind.
// ---------------------------------------------------------------------------

describe('TypeScript side-effect imports', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-side-effect-imports'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('emits IMPORTS edges for both side-effect imports + the named import', () => {
    const imports = getRelationships(result, 'IMPORTS').filter((e) => e.source === 'app.ts');
    const targets = imports.map((e) => e.targetFilePath).sort();
    expect(targets).toEqual(['src/greeter.ts', 'src/polyfill.ts', 'src/register.ts']);
  });

  it('does not synthesize local bindings for side-effect imports', () => {
    // A side-effect import binds no local name; nothing in `app.ts` should
    // try to call into `polyfill.ts` or `register.ts`. The only resolved
    // CALL edge from `main` is to `greet` in `greeter.ts`.
    const calls = getRelationships(result, 'CALLS').filter((c) => c.source === 'main');
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('greet');
    expect(calls[0].targetFilePath).toBe('src/greeter.ts');
  });
});

// ---------------------------------------------------------------------------
// Alias import resolution: import { User as U } resolves U → User
// ---------------------------------------------------------------------------

describe('TypeScript alias import resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-alias-imports'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes with their methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('persist');
  });

  it('resolves new U() to User class and new R() to Repo class via alias', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');

    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/models.ts');

    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/models.ts');
  });

  it('resolves u.save() and r.persist() as member calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const persistCall = calls.find((c) => c.target === 'persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');

    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
  });

  it('emits IMPORTS edge from app.ts to models.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find((e) => e.sourceFilePath === 'src/app.ts');
    expect(appImport).toBeDefined();
    expect(appImport!.targetFilePath).toBe('src/models.ts');
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: export { X } from './base' barrel pattern
// ---------------------------------------------------------------------------

describe('TypeScript re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-reexport-chain'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('resolves new User() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(userCtor!.source).toBe('main');
    expect(userCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves user.save() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
    expect(saveCall!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves new Repo() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(repoCtor).toBeDefined();
    expect(repoCtor!.source).toBe('main');
    expect(repoCtor!.targetFilePath).toBe('src/base.ts');
  });

  it('resolves repo.persist() through re-export chain to base.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const persistCall = calls.find((c) => c.target === 'persist');
    expect(persistCall).toBeDefined();
    expect(persistCall!.source).toBe('main');
    expect(persistCall!.targetFilePath).toBe('src/base.ts');
  });
});

// ---------------------------------------------------------------------------
// Re-export type chain: export type { X } from './base' barrel pattern
// ---------------------------------------------------------------------------

describe('TypeScript export type re-export chain resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-reexport-type'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  it('does not resolve runtime construction through a type-only re-export chain', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'main' && c.targetLabel === 'Class')).toEqual([]);
  });

  it('does not infer receiver types from invalid type-only construction', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'main')).toEqual([]);
  });

  it('resolves annotated parameter receivers through the type-only re-export chain', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.source === 'typed');
    expect(calls.map((c) => [c.target, c.targetFilePath]).sort()).toEqual([
      ['persist', 'src/base.ts'],
      ['save', 'src/base.ts'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('TypeScript local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-local-shadow'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves run → save to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/app.ts');
  });

  it('does NOT resolve save to utils.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToUtils = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'src/utils.ts',
    );
    expect(saveToUtils).toBeUndefined();
  });
});
