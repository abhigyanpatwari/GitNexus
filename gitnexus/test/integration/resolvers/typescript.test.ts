/**
 * TypeScript: heritage resolution + ambiguous symbol disambiguation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  getResolutionOutcomes,
  runPipelineFromRepo,
  suppressionReasonsAt,
  useFixture,
  writeFixtureRepo,
  type OutcomeSite,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: class extends + implements interface
// ---------------------------------------------------------------------------

describe('TypeScript heritage resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-ambiguous'), () => {});
  }, 60000);

  it('detects exactly 3 classes and 1 interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual([
      'BaseService',
      'ConsoleLogger',
      'UserService',
    ]);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['ILogger']);
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
});

describe('TypeScript call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-calls'), () => {});
  }, 60000);

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

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-generic-calls'), () => {});
  }, 60000);

  it('the awaited generic member call is not also a read of verify', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (a) => a.source === 'authenticateGuest',
    );
    expect(accesses.map((a) => a.target)).not.toContain('verify');
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

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-side-effect-imports'),
      () => {},
    );
  }, 60000);

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
// Issue #2545 (+ #2551): an object literal has no scope boundary of its
// own, so a method's name auto-hoists past the literal into whatever
// lexically encloses it (e.g. Module scope for a top-level
// `export default { ... }`). A Cloudflare Worker's `fetch` handler
// shape is the reported case: an unrelated same-file call to the
// platform-global `fetch()` was matching that leaked binding instead
// of staying unresolved.
//
// #2551 caught a second manifestation of the same underlying bug during
// review: a SIBLING property within the same object literal (`handler`
// below) calling another sibling's name (`fetch`) as a bare identifier
// also incorrectly resolved to it. The first fix reused the `Block`
// scope kind, correct for a real lexical block (`if`/`for`/`while`,
// where a nested closure legitimately sees block-scoped bindings) but
// wrong for object literals, which have no such semantic -- sibling
// properties are never visible to each other as bare identifiers, only
// via property access. Fixed with a dedicated `Object` scope kind
// (`gitnexus-shared`'s `ScopeKind`): a hoist boundary only, whose own
// bindings scope-chain walkers (`scope-resolution/scope/walkers.ts`)
// never consult, while still traversing past it to the parent.
// ---------------------------------------------------------------------------

describe('TypeScript object-literal method scoping (#2545)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-object-literal-scope-'));
    writeFixtureRepo(repoDir, {
      'src/worker.ts': `export async function callExternal(): Promise<Response> {
  return fetch('https://example.com/api');
}

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response('ok');
  },
  handler: () => {
    return fetch('https://example.com/other');
  },
};
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('does not resolve the global fetch() call to the object-literal fetch method', () => {
    const calls = getRelationships(result, 'CALLS');
    const fetchCall = calls.find((c) => c.source === 'callExternal' && c.target === 'fetch');
    expect(fetchCall).toBeUndefined();
  });

  it("does not resolve a sibling arrow-property's fetch() call to its own sibling either (#2551)", () => {
    const calls = getRelationships(result, 'CALLS');
    const fetchFromHandler = calls.find(
      (c) => c.source === 'handler' && c.target === 'fetch' && c.rel.reason === 'local-call',
    );
    expect(fetchFromHandler).toBeUndefined();
  });

  it('still extracts the Worker fetch handler as a Method', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('fetch');
  });
});

// ---------------------------------------------------------------------------
// Issue #2545 fix regression: the isBuiltInName guard must not suppress a
// genuine cross-file import whose name happens to match a builtin
// (e.g. a `fetch` polyfill). Caught during review: the guard originally
// suppressed ANY same-name match with no local scope-chain binding,
// including real imports -- `hasGenuineLexicalBinding` only walks
// `Scope.bindings` (local declarations), never the imports channel.
// Fixed by scoping the guard to same-file matches only (the leak it
// targets is inherently same-file -- finalize's flat bucket is per-file).
// ---------------------------------------------------------------------------

describe('TypeScript builtin-name import still resolves (#2545 regression)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-builtin-import-'));
    writeFixtureRepo(repoDir, {
      'src/fetch-polyfill.ts': `export function fetch(url: string): Promise<Response> {
  return globalThis.fetch(url);
}
`,
      'src/app.ts': `import { fetch } from './fetch-polyfill';

export async function loadData(): Promise<Response> {
  return fetch('https://example.com/data');
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves loadData() to the imported fetch polyfill, not left unresolved', () => {
    const calls = getRelationships(result, 'CALLS');
    const fetchCall = calls.find((c) => c.source === 'loadData' && c.target === 'fetch');
    expect(fetchCall).toBeDefined();
    expect(fetchCall!.targetFilePath).toBe('src/fetch-polyfill.ts');
    expect(fetchCall!.rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// JavaScript constructor-inferred type resolution: const user = new User()
// ---------------------------------------------------------------------------

describe('JavaScript constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to src/user.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.js');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to src/repo.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.js');
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
// Parent class resolution: EXTENDS + IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('TypeScript parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes plus Serializable interface', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable']);
  });
});

// ---------------------------------------------------------------------------
// Cast/non-null constructor inference: new X() as T, new X()!
// ---------------------------------------------------------------------------

describe('TypeScript cast/non-null constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-cast-constructor-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via new User() as any', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Double-cast constructor inference: new X() as unknown as T
// ---------------------------------------------------------------------------

describe('TypeScript double-cast constructor inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-double-cast-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User.save via new User() as unknown as any', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.ts');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to Repo.save via new Repo() as unknown as object', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript return type inference via JSDoc @returns annotation
// ---------------------------------------------------------------------------

describe('JavaScript return type inference via JSDoc @returns annotation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via JSDoc @returns {User}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via JSDoc @returns {Repo}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves user.save() via JSDoc @param {User} in handleUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() via JSDoc @param {Repo} in handleRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript async return type inference via JSDoc @returns {Promise<User>}
// Verifies that wrapper generics (Promise) are unwrapped to the inner type.
// ---------------------------------------------------------------------------

describe('JavaScript async return type inference via JSDoc @returns {Promise<User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-async-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via @returns {Promise<User>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via @returns {Promise<Repo>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript qualified return type: @returns {Promise<models.User>}
// Verifies that dot-qualified names inside generics are not corrupted.
// ---------------------------------------------------------------------------

describe('JavaScript qualified return type via JSDoc @returns {Promise<models.User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'js-jsdoc-qualified-return-type'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save despite qualified return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// this.users member access iterable: for (const user of this.users)
// ---------------------------------------------------------------------------

describe('TypeScript member access iterable for-loop', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-member-access-for-loop'),
      () => {},
    );
  }, 60000);

  it('does not borrow a parameter type for a nonexistent receiver field', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'processMissingUsers' && c.target === 'save')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'field-types'), () => {});
  }, 60000);

  it('detects classes: Address, Config, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Config', 'User']);
  });

  it('detects Property nodes for typed fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(4);
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('Address → city');
    expect(edgeSet(propEdges)).toContain('Config → DEFAULT');
  });

  it('resolves user.address.save() → Address#save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
    expect(addressSave!.source).toBe('processUser');
  });

  it('emits ACCESSES read edge for user.address field access in chain', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    expect(addressReads.length).toBe(1);
    expect(addressReads[0].source).toBe('processUser');
    expect(addressReads[0].targetLabel).toBe('Property');
  });

  it('emits ACCESSES read edge for Config.DEFAULT field access in chain', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const defaultReads = accesses.filter((e) => e.target === 'DEFAULT' && e.rel.reason === 'read');
    expect(defaultReads.length).toBe(1);
    expect(defaultReads[0].source).toBe('validateConfig');
  });

  it('all ACCESSES edges have confidence 1.0 and reason read', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    for (const edge of accesses) {
      expect(edge.rel.confidence).toBe(1.0);
      expect(edge.rel.reason).toBe('read');
    }
  });

  it('populates field metadata (visibility, isStatic, isReadonly, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    expect(city!.properties.visibility).toBe('public');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.isReadonly).toBe(false);
    expect(city!.properties.declaredType).toBe('string');

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('public');
    expect(addr!.properties.isStatic).toBe(false);
    expect(addr!.properties.isReadonly).toBe(false);
    expect(addr!.properties.declaredType).toBe('Address');
  });

  it('marks Config.DEFAULT as static', () => {
    const properties = getNodesByLabelFull(result, 'Property');
    const def = properties.find((p) => p.name === 'DEFAULT');
    expect(def).toBeDefined();
    expect(def!.properties.isStatic).toBe(true);
    expect(def!.properties.declaredType).toBe('Config');
    expect(def!.properties.visibility).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Parameter properties and #private fields
// ---------------------------------------------------------------------------

describe('Field type resolution (TS parameter properties)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-param-property-fields'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('captures constructor parameter properties as Property nodes', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('name');
    expect(properties).toContain('address');
  });

  it('captures #private fields as Property nodes', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('#secret');
  });

  it('emits HAS_PROPERTY edges for parameter properties', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('User → address');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level: user.address.city.getName())
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-deep-field-chain'), () => {});
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
});

// ---------------------------------------------------------------------------
// Mixed chain resolution (field ↔ call interleaved)
// ---------------------------------------------------------------------------

describe('Mixed field+call chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-mixed-chain'), () => {});
  }, 60000);

  it('detects classes: Address, City, User, UserService', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User', 'UserService']);
  });

  it('detects Property node for Address.city field', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('city');
    expect(properties).toContain('address');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
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
// JavaScript call-result variable binding (Phase 9) via JSDoc @returns
// ---------------------------------------------------------------------------

describe('JavaScript call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding with JSDoc', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── Phase P: Virtual Dispatch via Constructor Type ───────────────────────

describe('TypeScript virtual dispatch via constructor type (same-file)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-virtual-dispatch'), () => {});
  }, 60000);

  it('resolves fetchBall() calls from run() — proves virtual dispatch override', () => {
    const calls = getRelationships(result, 'CALLS');
    const fetchCalls = calls.filter((c) => c.source === 'run' && c.target === 'fetchBall');
    // animal.fetchBall() only resolves if constructorTypeMap overrides
    // receiver from Animal → Dog. dog.fetchBall() resolves directly.
    // Both target same nodeId → 1 CALLS edge after dedup.
    expect(fetchCalls.length).toBe(1);
  });
});

// ── Phase P: Overload Disambiguation via inferLiteralType ────────────────

describe('TypeScript overload disambiguation via inferLiteralType', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-disambiguation'), () => {});
  }, 60000);

  it('detects lookup function with parameterTypes on graph node', () => {
    const functions = getNodesByLabelFull(result, 'Function');
    const lookupNodes = functions.filter((f) => f.name === 'lookup');
    // generateId collision → 1 graph node, first overload's parameterTypes wins
    expect(lookupNodes.length).toBeGreaterThanOrEqual(1);
    // At least one lookup node has parameterTypes set
    const withParamTypes = lookupNodes.filter((n) => n.properties.parameterTypes);
    expect(withParamTypes.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('TypeScript overload family call edges', () => {
  const bindings = new Map<number, { status: string; targetDefIds: readonly string[] }>();
  let optionalCallbackId: string | undefined;
  const result = useFixture(
    'ts-overload-family',
    {
      'index.ts': `export function pick(x: { key: number }): number;
export function pick(x: { key: string }): string;
export function pick(x: { key: string | number }) { return x.key; }
export function run(x: { key: string }) { return pick(x); }
export function repeat(x: { key: string }) { pick(x); pick(x); }
export function spread(xs: [{ key: string }]) { return pick(...xs); }
export function badArity() { return pick(); }
function mode(x: 'read'): void;
function mode(x: 'write'): void;
function mode(x: string) {}
export function badLiteral() { mode('other'); }
export function badSpread(xs: [{ key: string }]) { pick(1, 2, ...xs); }
class Client { send() {} }
class Other { stop() {} }
function connect(x: { key: number }): Client;
function connect(x: { key: string }): Client;
function connect(x: unknown) { return new Client(); }
export function sharedReturn(x: { key: string }) { const client = connect(x); client.send(); }
function choose(x: { key: number }): Other;
function choose(x: { key: string }): Client;
function choose(x: unknown) { return new Client(); }
export function uncertainReturn(x: { key: string }) { const client = choose(x); client.send(); }
function callback(cb: (x?: number) => void): void;
function callback(cb: (x: number) => void): void;
function callback(cb: unknown) {}
export function annotatedCallback() { callback((x: number) => { void x; }); }
export function contextualCallback() { callback(x => { void x; }); }`,
    },
    {
      workerPoolSize: 1,
      onScopeResolved({ parsedFiles, referenceBindings }) {
        for (const file of parsedFiles) {
          optionalCallbackId ??= file.localDefs.find(
            (def) =>
              def.qualifiedName === 'callback' &&
              def.declaredParameterTypes?.[0] === '(x?: number) => void',
          )?.nodeId;
          for (const site of file.referenceSites) {
            const binding = referenceBindings.get(site);
            if (site.kind === 'call' && binding) bindings.set(site.atRange.startLine, binding);
          }
        }
      },
    },
  );

  it('publishes one implementation edge per caller when the signature is uncertain', () => {
    const calls = getRelationships(result(), 'CALLS');
    expect(
      calls
        .filter((edge) => edge.target === 'pick')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['repeat', 'run', 'spread']);
    expect(bindings.get(6)?.status).toBe('unresolved');
    expect(bindings.get(6)?.targetDefIds).toHaveLength(2);
  });

  it('leaves a provably inapplicable call without a runtime edge', () => {
    const calls = getRelationships(result(), 'CALLS');
    expect(
      calls.filter((edge) => ['badArity', 'badLiteral', 'badSpread'].includes(edge.source)),
    ).toEqual([]);
    expect(bindings.get(7)?.status).toBe('blocked');
    expect(bindings.get(11)?.status).toBe('blocked');
    expect(bindings.get(12)?.status).toBe('blocked');
  });

  it('types the result only when every remaining signature returns the same class', () => {
    const calls = getRelationships(result(), 'CALLS');
    expect(calls.filter((edge) => edge.target === 'send').map((edge) => edge.source)).toEqual([
      'sharedReturn',
    ]);
  });

  it('uses contextual callback arity without treating an explicit parameter type as optional', () => {
    expect(optionalCallbackId).toBeDefined();
    const annotated = bindings.get(26);
    expect(annotated?.status).toBe('unresolved');
    expect(annotated?.targetDefIds).toHaveLength(2);
    expect(bindings.get(27)).toMatchObject({
      status: 'resolved',
      targetDefIds: [optionalCallbackId],
    });
    expect(
      getRelationships(result(), 'CALLS')
        .filter((edge) => edge.target === 'callback')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['annotatedCallback', 'contextualCallback']);
  });
});

// Overloaded method disambiguation: interface with overloaded find + save,
// concrete class implements all three. TypeScript overloads collapse to one
// implementation signature — expect the implementation body, not individual
// overload signatures.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-dispatch'), () => {});
  }, 60000);

  it('TypeScript overloads collapse — find has one METHOD_IMPLEMENTS edge from implementation body', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    // TS class overload signatures collapse to the implementation body's node ID.
    // Type-hash is intentionally skipped for TS because overload signatures are
    // declaration-only contracts, not true same-arity overloads like Java.
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdges.length).toBe(1);
  });
});

// ── Phase P: Same-arity overloads — cross-file + chain resolution ─────────

describe('TypeScript same-arity overload cross-file resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-same-arity-cross-file'), () => {});
  }, 60000);

  it('DbLookup.find overload signatures collapse to one node (type-hash skipped for TS)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('db-lookup'),
    );
    // TS overload signatures collapse to the implementation body — 1 node
    expect(findNodes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #1066 sibling regression for TypeScript: force worker-mode extraction
// so scope-resolution reparses on cache miss, then assert large ASCII and
// UTF-8-heavy source files still produce trailing call edges.
// ---------------------------------------------------------------------------

describe('TypeScript large-file cache-miss parser buffer regression', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-large-cache-'));
    writeFixtureRepo(repoDir, {
      'src/models.ts': `
export class User {
  save(): boolean {
    return true;
  }
}
`,
      'src/ascii-app.ts': `import { User } from './models';

// ${'x'.repeat(120 * 1024)}
export function createAsciiUser(): void {
  const user = new User();
  user.save();
}
`,
      'src/utf8-app.ts': `import { User } from './models';

// ${'漢'.repeat(120_000)}
export function createUtf8User(): void {
  const user = new User();
  user.save();
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('extracts trailing functions after large ASCII and UTF-8 padding', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual(
      expect.arrayContaining(['createAsciiUser', 'createUtf8User']),
    );
  });

  it('resolves constructor calls from both padded files to User', () => {
    const calls = getRelationships(result, 'CALLS');
    for (const source of ['createAsciiUser', 'createUtf8User']) {
      const ctor = calls.find(
        (c) => c.source === source && c.target === 'User' && c.targetLabel === 'Class',
      );
      expect(ctor).toBeDefined();
      expect(ctor!.targetFilePath).toBe('src/models.ts');
    }
  });

  it('resolves member calls from both padded files to User.save', () => {
    const calls = getRelationships(result, 'CALLS');
    for (const source of ['createAsciiUser', 'createUtf8User']) {
      const save = calls.find((c) => c.source === source && c.target === 'save');
      expect(save).toBeDefined();
      expect(save!.targetFilePath).toBe('src/models.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #1358: class-instance singleton (`export const x = new C()`)
// PR #1718 closed the object-literal-shorthand sub-case; this fixture covers
// the class-instance sub-case. Resolution chain: @type-binding.constructor
// (TS query) → propagateImportedReturnTypes (cross-file mirror) →
// receiver-bound Case 4 (simple typeBinding) → MRO walk.
// ---------------------------------------------------------------------------

describe('TypeScript class-instance singleton resolution (issue #1358 sub-case)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-class-instance-singleton'),
      () => {},
      { skipGraphPhases: true },
    );
  }, 60000);

  it('detects FooService class, getUser method, caller function, fooService Const', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('FooService');
    expect(getNodesByLabel(result, 'Method')).toContain('getUser');
    expect(getNodesByLabel(result, 'Function')).toContain('caller');
    expect(getNodesByLabel(result, 'Const')).toContain('fooService');
  });

  it('emits HAS_METHOD edge from FooService to getUser', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const fromClass = hasMethod.filter((e) => e.source === 'FooService').map((e) => e.target);
    expect(fromClass).toEqual(['getUser']);
  });

  it('resolves caller.fooService.getUser() to FooService.getUser via constructor-inferred typeBinding', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetFilePath: e.targetFilePath,
        reason: e.rel.reason,
        confidence: e.rel.confidence,
      }));

    expect(projected).toEqual([
      {
        targetFilePath: 'src/service.ts',
        reason: 'import-resolved',
        confidence: 0.85,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Issue #1358: factory-pattern singleton (`export const x = makeC()`)
// Tests the @type-binding.alias chain-follow path through
// propagateImportedReturnTypes (followChainPostFinalize) — fooService aliases
// makeFooService's return type, which the constructor seeds as FooService.
// ---------------------------------------------------------------------------

describe('TypeScript factory-pattern singleton resolution (issue #1358 sub-case)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-factory-singleton'),
      () => {},
      { skipGraphPhases: true },
    );
  }, 60000);

  it('detects FooService class, makeFooService function, fooService Const, caller function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('FooService');
    expect(getNodesByLabel(result, 'Function')).toContain('makeFooService');
    expect(getNodesByLabel(result, 'Function')).toContain('caller');
    expect(getNodesByLabel(result, 'Const')).toContain('fooService');
  });

  it('resolves caller.fooService.getUser() through the factory chain to FooService.getUser', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetFilePath: e.targetFilePath,
        reason: e.rel.reason,
        confidence: e.rel.confidence,
      }));

    expect(projected).toEqual([
      {
        targetFilePath: 'src/service.ts',
        reason: 'import-resolved',
        confidence: 0.85,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic-this contexts are never seeded from the lexically enclosing class
// (#2353 follow-up): an object-literal method's `this` is the literal, not
// the class instance — the compound resolver's literal-`this` head seed is
// restricted to initializer contexts and must not fire here.
// ---------------------------------------------------------------------------

describe('TS dynamic-this receiver seeding guard', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-dynamic-this-no-seed'), () => {});
  }, 60000);

  it('detects the App and Router classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['App', 'Router']);
  });

  it('emits no CALLS edge from the object-literal method to Router.go', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.target === 'go' && c.source === 'onClick')).toBe(false);
  });

  // Both sites on `this.route.go()` are lost for ONE reason: the object-literal
  // method owns `this` and gives it no type. The call's receiver is the chain
  // `this.route`, and the owned-receiver check was asked about that whole text
  // — which no scope owns — instead of its base `this`. So the call went on to
  // the compound fold and was filed as a generic `receiver-unresolved` drop,
  // or, when the read beside it (same start column) was handled first, as
  // nothing at all.
  it.each<readonly [OutcomeSite, readonly string[]]>([
    [['app.ts', 17, 6, 'route', 'read'], ['receiver-owned-but-unbound']],
    [['app.ts', 17, 6, 'go', 'call'], ['receiver-owned-but-unbound']],
  ])('records %j under its real reason', (site, reasons) => {
    expect(suppressionReasonsAt(result, site)).toEqual(reasons);
  });
});

// ---------------------------------------------------------------------------
// #2744 drop recorder — the site kind travels with the drop.
//
// Case 0's gate tests the RECEIVER's punctuation, not the site's kind, so a
// compound-receiver property write is recorded in the same bucket as a dropped
// method call. Anything measuring resolver gaps has to tell those apart, and
// the site kind is the only authoritative signal for it.
//
// Both negative cases use untyped receivers, so their drops do not depend on
// an unsupported expression shape. A typed write is the positive control.
// ---------------------------------------------------------------------------

describe('TypeScript receiver-unresolved drops carry their site kind (#2744)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-drop-site-kind-'));
    writeFixtureRepo(repoDir, {
      'models.ts': `export class User {
  name: string = '';
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  async getUserAsync(): Promise<User> {
    return new User();
  }
}
`,
      'main.ts': `import { Service } from './models';

export async function droppedCall(svc): Promise<void> {
  // An UNANNOTATED parameter. The chain mints fine, but the base has no type
  // binding to resolve against, so the site reaches the drop recorder.
  //
  // Third fixture for this case: \`!\` served until structural typing resolved
  // it, then the await-parenthesized form served until name-free step kinds
  // resolved that too. Both were shapes the resolver merely did not SUPPORT
  // yet, so each fix moved the goalposts. An untyped receiver carries no type
  // information at all, so no amount of resolver work can type it — which is
  // what makes it a stable choice rather than the next one to be fixed.
  svc.getUser().save();
}

export function droppedWrite(svc): void {
  // The unannotated receiver has no type proof, even though writes now
  // carry the same structural receiver chains as calls.
  svc!.getUser().name = 'x';
}

export function resolvedWrite(svc: Service | null): void {
  svc!.getUser().name = 'x';
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('tags a dropped method call as a call site', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(expect.objectContaining({ name: 'save', siteKind: 'call' }));
  });

  it('tags a dropped property write as a write site, so it is separable from calls', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(expect.objectContaining({ name: 'name', siteKind: 'write' }));
  });

  it('resolves the typed compound write while retaining the untyped write drop', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter((edge) => edge.target === 'name');
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({
      source: 'resolvedWrite',
      target: 'name',
      targetFilePath: 'models.ts',
      rel: { targetId: 'Property:models.ts:User.name' },
    });
  });

  // The origin travels with the drop too, and its value here is the whole
  // point: `svc` is an UNANNOTATED parameter, so the scope model records it
  // nowhere — no type binding, no value binding, no qualified name. A
  // classifier that read that silence as `external` published
  // `epistemic: 'exact'` over a call it had genuinely lost. `unknown` is the
  // honest answer and it counts toward the hedge exactly like `in-program`.
  it('does not call an untyped in-program receiver external', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(
      expect.objectContaining({ name: 'save', siteKind: 'call', receiverOrigin: 'unknown' }),
    );
    expect(drops).not.toContainEqual(
      expect.objectContaining({ name: 'save', receiverOrigin: 'external' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural receiver typing: receiver spellings the text cascade cannot parse
// now resolve by folding the captured chain.
//
// Both shapes below emitted NO edge and recorded NO drop before this work:
// Case 0's gate fired, `resolveCompoundReceiverClass` returned undefined, and a
// later case marked the site handled — which suppresses the drop record too, so
// the loss was invisible to the epistemic signal as well as to the graph.
// ---------------------------------------------------------------------------

describe('TypeScript structural receiver chains', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-receiver-chain-'));
    writeFixtureRepo(repoDir, {
      'models.ts': `export class Database {
  query(): void {}
}

export class Config {
  db: Database = new Database();
}

export function make(n: number): number {
  return n;
}

export class Address {
  persist(): void {}
}

export class User {
  address: Address = new Address();
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  getTyped<T>(): User {
    return new User();
  }
}
`,
      'main.ts': `import { Service, Config, make } from './models';

export function viaOptionalChain(svc: Service | null): void {
  svc?.getUser().save();
}

// A local that merely SHADOWS an imported class name. Its value is a number,
// so it has NO members — the fold must not type it as the class.
export function shadowsAClassName(): void {
  const Config = make(1);
  Config.db.query();
}

export function viaTypeArgs(svc: Service): void {
  svc.getTyped<User>().save();
}

export function viaNonNull(svc: Service | null): void {
  svc!.getUser().save();
}

// A mixed call/field chain behind a spelling the TEXT cascade cannot parse
// (optional chaining), so this discriminates the fold rather than re-testing
// the pre-existing cascade path.
export function viaMixedChain(svc: Service | null): void {
  svc?.getUser().address.persist();
}

// User has no member named missing, so the chain dies at its middle step.
export function brokenMiddleStep(svc: Service): void {
  svc.getUser().missing.persist();
}

export function alreadyWorked(svc: Service): void {
  svc.getUser().save();
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves an optional-chained receiver — svc?.getUser().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaOptionalChain' && c.target === 'save')).toMatchObject(
      {
        target: 'save',
        targetFilePath: 'models.ts',
      },
    );
  });

  it('resolves an explicit-type-argument receiver — svc.getTyped<User>().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaTypeArgs' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('resolves a non-null-asserted receiver — svc!.getUser().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaNonNull' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('resolves a mixed call/field chain through the fold', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaMixedChain' && c.target === 'persist')).toMatchObject(
      {
        target: 'persist',
        targetFilePath: 'models.ts',
      },
    );
  });

  it('keeps the shape that already resolved through the text cascade', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'alreadyWorked' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('does NOT fabricate an edge when a local shadows a class name', () => {
    // Regression: the fold resolved its base through the permissive
    // bare-identifier path, which falls through to a plain class-name lookup
    // even when a receiver typeBinding exists but names no class. A local
    // `const Config = make(1)` (a number) was therefore typed as the imported
    // `class Config`, emitting a confident `CALLS` edge to `Database.query`
    // that the text cascade never produced. A missing edge is recoverable; a
    // wrong one is not.
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'shadowsAClassName' && c.target === 'query')).toEqual(
      [],
    );
  });

  it('emits no CALLS edge when a middle step names no member of the previous class', () => {
    // A broken MIDDLE step must produce no edge, never a wrong one. `User` has no
    // member `missing`, so the chain cannot be typed past it and `persist` must
    // not bind to anything — in particular not to `Address.persist`, which a
    // field-walking fallback could otherwise reach.
    // `getUser` itself still resolves — only the tail past the broken step must not.
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'brokenMiddleStep' && c.target === 'persist')).toEqual(
      [],
    );
    expect(
      calls.filter((c) => c.source === 'brokenMiddleStep' && c.target === 'getUser'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Case 3b (chain-typebinding) interface dispatch (#2832). `const r = d.repo`
// binds `r` to the member expression `d.repo`, so the receiver is a bare name
// with a DOTTED typeBinding rawName — Case 3b's entry condition. Case 0 cannot
// take the site (`r` has no `.`/`(`, and no receiver chain is minted for a
// bare identifier), and Case 4 excludes itself on the dot. The fold lands on
// an Interface, so the implementations are reachable only via the fan-out.
// ---------------------------------------------------------------------------

describe('TypeScript chain-typed receiver folding to an interface (Case 3b, #2832)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ts-chain-interface-dispatch'),
      () => {},
    );
  }, 60000);

  const saveCalls = () =>
    getRelationships(result, 'CALLS').filter((e) => e.source === 'runSave' && e.target === 'save');
  const fanout = () => saveCalls().filter((e) => e.rel.reason === 'interface-dispatch');
  const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  it('emits the primary edge to the interface declaration', () => {
    const primary = saveCalls().filter((e) => e.rel.reason !== 'interface-dispatch');
    expect(primary.map((e) => basename(e.targetFilePath))).toEqual(['repository.ts']);
  });

  // A static member can never be reached through an instance-typed receiver —
  // TypeScript rejects `class C implements I { static save() {} }` as TS2420,
  // "Property 'save' is missing". ShadowRepo inherits the real SqlRepo.save and
  // adds a same-named static; only the inherited instance method is a dispatch
  // target. Before the guard this emitted an edge to the static one.
  it('never fans out to a static member', () => {
    const targets = fanout().map((e) => `${basename(e.targetFilePath)}`);
    expect(targets).not.toContain('shadow-repo.ts');
  });

  // Covers all three hierarchy shapes, now that TypeScript emits heritage for
  // interfaces and abstract classes too (#2842 review): a direct implementor
  // (sql-repo, mem-repo), a concrete class below an ABSTRACT intermediate
  // (hierarchy.ts DiskRepo, reachable only through BaseRepo), and an
  // implementor of an EXTENDING interface (hierarchy.ts ColdRepo, two hops from
  // the receiver's type). Exact-set, so a target appearing OR vanishing fails.
  // Two hierarchy.ts entries because that file holds two of the four targets.
  it('fans out through abstract intermediates and interface extension', () => {
    expect(
      fanout()
        .map((e) => basename(e.targetFilePath))
        .sort(),
    ).toEqual(['hierarchy.ts', 'hierarchy.ts', 'mem-repo.ts', 'sql-repo.ts']);
  });

  // The abstract declaration is bodiless: it must be WALKED THROUGH to reach
  // DiskRepo, never emitted to. tsc's own Go-to-Implementation behaves the same
  // way — the rule everywhere is "does it have a body?", not "is it in a class?".
  it('walks through the abstract declaration without targeting it', () => {
    const names = fanout()
      .filter((e) => basename(e.targetFilePath) === 'hierarchy.ts')
      .map((e) => e.target);
    expect(names).toEqual(['save', 'save']);
  });

  it('never targets the interface declaration in the fan-out', () => {
    expect(fanout().map((e) => basename(e.targetFilePath))).not.toContain('repository.ts');
  });

  // Stronger negative than the PlainCache case below: here an interface IS in
  // scope (SqlRepo implements Repo) and `save` is a name Repo declares, yet the
  // receiver's folded type is the concrete class, so nothing may fan out.
  //
  // This does NOT catch "member owner passed instead of folded type". The
  // reason is a property of TypeScript, not of the control: TS's MRO chain
  // never contains an implemented interface, so the walk cannot settle on an
  // interface declaration for a concrete receiver and the two values coincide.
  // (Not, as an earlier draft of this comment claimed, because an implementing
  // class always declares the member itself — `class C extends Base implements
  // I {}` is valid TS and inherits it.) The mutation IS expressible where a
  // concrete class inherits a `default` interface method — Java or Kotlin —
  // and is tracked for a follow-up fixture there.
  it('emits no fan-out when the chain folds to a concrete implementor', () => {
    const concrete = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'runConcrete' && e.target === 'save',
    );
    expect(concrete.map((e) => e.rel.reason).filter((r) => r === 'interface-dispatch')).toEqual([]);
    expect(concrete.map((e) => basename(e.targetFilePath))).toEqual(['sql-repo.ts']);
  });

  it('emits no fan-out when the chain folds to a concrete class', () => {
    const runCalls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'runCache' && e.target === 'run',
    );
    expect(runCalls.map((e) => e.rel.reason).filter((r) => r === 'interface-dispatch')).toEqual([]);
    expect(runCalls.map((e) => basename(e.targetFilePath))).toEqual(['plain-cache.ts']);
  });
});

// #3498: `ns.make()` takes `make`'s return annotation from the namespace's
// module. A class method of the same name hoists its return type to the module
// under that name, so the lookup must stay anchored on the module function and
// fail closed instead of typing the receiver as the method's return.
describe('TypeScript namespace factory result types (#3498)', () => {
  let result: PipelineResult;
  let repoDir: string;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-namespace-factory-'));
    writeFixtureRepo(repoDir, {
      'src/mod.ts': `export class C {
  m(): number {
    return 1;
  }
}

export class Other {
  m(): number {
    return 2;
  }
}

export function make(): C {
  return new C();
}
`,
      'src/hoist.ts': `import { C, Other } from './mod';

export function build(): C {
  return new C();
}

export class Builder {
  build(): Other {
    return new Other();
  }
}
`,
      'src/callers.ts': `import * as rp from './mod';
import * as hz from './hoist';

export function aliasCall() {
  const x = rp.make();
  return x.m();
}

export function inlineCall() {
  return rp.make().m();
}

export function hoistedCall() {
  const y = hz.build();
  return y.m();
}

export function hoistedInline() {
  return hz.build().m();
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 60000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it.each([
    { source: 'aliasCall', targets: ['Method:src/mod.ts:C.m#0'] },
    { source: 'inlineCall', targets: ['Method:src/mod.ts:C.m#0'] },
    { source: 'hoistedCall', targets: [] },
    { source: 'hoistedInline', targets: [] },
  ])('resolves m called from $source to $targets', ({ source, targets }) => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.source === source && edge.target === 'm')
        .map((edge) => edge.rel.targetId),
    ).toEqual(targets);
  });

  it('records the hoisted sites as dropped instead of an exact miss', () => {
    const dropped = getResolutionOutcomes(result)
      .filter((outcome) => outcome.kind === 'suppressed')
      .filter(
        (outcome) =>
          outcome.reason === 'receiver-unresolved' && outcome.filePath === 'src/callers.ts',
      )
      .map((outcome) => `${outcome.range.startLine}:${outcome.name}`)
      .sort();
    expect(dropped).toEqual(['15:m', '19:m']);
  });
});

describe('TypeScript ambient namespace export aliases', () => {
  const result = useFixture('ambient-namespace-exports', {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
      files: ['decl.d.ts', 'use.ts'],
    }),
    'decl.d.ts': `declare namespace API {
  class Internal { run(): number }
  class Private { hidden(): number }
  function local(): number;
  const notCallable: number;
  namespace Interior { function nestedCall(): number; }
  export {Interior as Nested, Internal as Public, Internal as Alternative, local as left, local as right, notCallable as numberValue};
  export type {Internal as TypeView};
}
declare namespace API { function merged(): number; }
declare namespace Other {
  class Internal { other(): number }
  export {Internal as Public};
}
`,
    'use.ts': `export function both() { return API.left() + API.right(); }
export function typed(a: API.Alternative, b: API.TypeView) { return a.run() + b.run(); }
export function constructed() { return new API.Public().run(); }
export function other(c: Other.Public) { return c.other(); }
export function mergedBody() { return API.merged(); }
export function nested() { return API.Nested.nestedCall(); }
// @ts-expect-error private declaration spelling
export function privateName() { return new API.Internal().run(); }
// @ts-expect-error unexported declaration
export function hidden() { return new API.Private().hidden(); }
// @ts-expect-error erased class alias
export function erased() { return new API.TypeView().run(); }
// @ts-expect-error private local function
export function privateFunction() { return API.local(); }
// @ts-expect-error non-callable namespace value
export function numberCall() { return API.numberValue(); }
`,
  });

  it('uses the published spelling and retains distinct calls to the same declaration', () => {
    const calls = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.sourceFilePath === 'use.ts')
      .map((edge) => [edge.source, edge.target])
      .sort();
    expect(calls).toEqual([
      ['both', 'local'],
      ['both', 'local'],
      ['constructed', 'Internal'],
      ['constructed', 'run'],
      ['mergedBody', 'merged'],
      ['nested', 'nestedCall'],
      ['other', 'other'],
      ['typed', 'run'],
      ['typed', 'run'],
    ]);
  });
});
