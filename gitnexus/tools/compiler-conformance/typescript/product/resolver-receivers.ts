import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../support/fixture.js';

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

  beforeAll(
    async () => {
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
    },
    { timeout: 60000 },
  );

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

  beforeAll(
    async () => {
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
    },
    { timeout: 60000 },
  );

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
// Constructor-inferred type resolution: const user = new User(); user.save()
// Cross-file SymbolTable verification (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('TypeScript constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-constructor-type-inference'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-parent-resolution'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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
// super.save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('TypeScript super resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-super-resolution'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to generic parent class's save method
// ---------------------------------------------------------------------------

describe('TypeScript generic parent super resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-generic-parent-resolution'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('emits EXTENDS edge: User → BaseModel (not BaseModel<string>)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// Cast/non-null constructor inference: new X() as T, new X()!
// ---------------------------------------------------------------------------

describe('TypeScript cast/non-null constructor inference', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-cast-constructor-inference'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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

  it('resolves repo.save() to Repo.save via new Repo()!', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.ts');
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Double-cast constructor inference: new X() as unknown as T
// ---------------------------------------------------------------------------

describe('TypeScript double-cast constructor inference', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-double-cast-inference'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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
// Nullable/optional receiver unwrapping: user?.save() resolves through ?.
// ---------------------------------------------------------------------------

describe('TypeScript nullable receiver resolution (optional chaining)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-nullable-receiver'), () => {});
    },
    { timeout: 60000 },
  );

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    // user?.save() → User.save + repo?.save() → Repo.save = 2 edges
    // If nullable unwrapping fails, the resolver refuses ambiguous matches and emits 0
    expect(saveCalls.length).toBe(2);
  });
});
