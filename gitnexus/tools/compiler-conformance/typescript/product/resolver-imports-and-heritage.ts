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
