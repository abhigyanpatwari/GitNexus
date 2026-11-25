import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ── Phase P: Optional / Default Parameter Arity Resolution ───────────────

describe('TypeScript optional parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-optional-params'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });

  it('resolves search("test") with 1 arg to search with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const searchCalls = calls.filter((c) => c.source === 'process' && c.target === 'search');
    expect(searchCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: abstract, static, parameterTypes, annotations
// ---------------------------------------------------------------------------

describe('TypeScript method enrichment', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-method-enrichment'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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
    expect(animalMethods).toContain('speak');
    expect(animalMethods).toContain('classify');
    expect(animalMethods).toContain('breathe');
  });

  it('emits HAS_METHOD edge for Dog.speak', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak');
    expect(dogSpeak).toBeDefined();
  });

  it('emits EXTENDS edge Dog -> Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('marks abstract speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'speak' && n.properties.filePath === 'animal.ts');
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('marks breathe as NOT isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isAbstract !== undefined) {
      expect(breathe.properties.isAbstract).toBe(false);
    }
  });

  it('marks classify as isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('marks breathe as NOT isStatic (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isStatic !== undefined) {
      expect(breathe.properties.isStatic).toBe(false);
    }
  });

  it('populates parameterTypes for classify (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== undefined) {
      const params = classify.properties.parameterTypes;
      expect(params).toContain('string');
    }
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'speak' && c.sourceFilePath.includes('app.ts'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Animal.classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath.includes('app.ts'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Interface dispatch: METHOD_IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe('TypeScript interface dispatch (METHOD_IMPLEMENTS)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-interface-dispatch'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

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

  it('emits METHOD_IMPLEMENTS edges for find and save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdge = mi.find(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded method disambiguation: interface with overloaded find + save,
// concrete class implements all three. TypeScript overloads collapse to one
// implementation signature — expect the implementation body, not individual
// overload signatures.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-dispatch'), () => {});
    },
    { timeout: 60000 },
  );

  it('emits METHOD_IMPLEMENTS edge for find', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdge = mi.find(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdge).toBeDefined();
  });

  it('emits METHOD_IMPLEMENTS edge for save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(saveEdge).toBeDefined();
  });

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

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-same-arity-cross-file'), () => {});
    },
    { timeout: 60000 },
  );

  it('DbLookup.find overload signatures collapse to one node (type-hash skipped for TS)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('db-lookup'),
    );
    // TS overload signatures collapse to the implementation body — 1 node
    expect(findNodes.length).toBe(1);
  });

  it('ILookup.find interface declarations collapse to one node (type-hash skipped for TS)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('ilookup'),
    );
    // Interface overloads also collapse — TS type-hash is skipped
    expect(findNodes.length).toBe(1);
  });

  it('emits METHOD_IMPLEMENTS from DbLookup.find → ILookup.find', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('db-lookup') &&
        e.targetFilePath.includes('ilookup'),
    );
    expect(edges.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SM-9: inherited method resolution — child.parentMethod() via first-wins walk
// ---------------------------------------------------------------------------

describe('TypeScript Child extends Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-child-extends-parent'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects Parent and Child classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Parent');
    expect(classes).toContain('Child');
  });

  it('emits EXTENDS edge: Child → Parent', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');
  });

  it('resolves c.parentMethod() to Parent.parentMethod via first-wins MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'parentMethod' && c.targetFilePath.includes('Parent.ts'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// PR #1657 finding #6: ambient base class — Step 2 MRO ancestor whose body
// is never parsed (declare class). Probes whether the owner-keyed lookup
// can still resolve inherited members on owners that reconcile-ownership
// skipped because they have no parsed body.
// ---------------------------------------------------------------------------

describe('TypeScript Derived extends declare class AmbientBase — ambient MRO ancestor', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-ambient-base-class'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects AmbientBase and Derived classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('AmbientBase');
    expect(classes).toContain('Derived');
  });

  it('emits EXTENDS edge: Derived → AmbientBase', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Derived → AmbientBase');
  });

  it('resolves d.ambientMethod() to AmbientBase.ambientMethod via MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const ambientCall = calls.find(
      (c) => c.target === 'ambientMethod' && c.targetFilePath.includes('ambient.ts'),
    );
    expect(ambientCall).toBeDefined();
    expect(ambientCall!.source).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// PR #1050: tsconfig path alias resolution under registry-primary path
// (Adversarial review Finding 1 — `@/services/user` must resolve via tsconfig
//  paths even when imports go through ScopeResolver.resolveImportTarget.)
// ---------------------------------------------------------------------------

describe('TypeScript tsconfig path alias resolution (registry-primary)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-tsconfig-aliases'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects UserService class in src/services/user.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('emits IMPORTS edge from app.ts to services/user.ts via @/ alias', () => {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (e) => e.sourceFilePath === 'src/app.ts',
    );
    expect(imports.map((e) => e.targetFilePath).sort()).toEqual(['src/services/user.ts']);
  });

  it('resolves new UserService() through alias to services/user.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctor = calls.find((c) => c.target === 'UserService' && c.targetLabel === 'Class');
    expect(ctor).toBeDefined();
    expect(ctor!.source).toBe('main');
    expect(ctor!.targetFilePath).toBe('src/services/user.ts');
  });

  it('resolves svc.save() through alias to services/user.ts', () => {
    const calls = getRelationships(result, 'CALLS');
    const save = calls.find((c) => c.target === 'save');
    expect(save).toBeDefined();
    expect(save!.source).toBe('main');
    expect(save!.targetFilePath).toBe('src/services/user.ts');
  });
});

// ---------------------------------------------------------------------------
// PR #1050: TSX files parsed with the TSX tree-sitter grammar (not TS).
// (Adversarial review Finding 2 — JSX must parse so component definitions
//  and imports are captured.)
// ---------------------------------------------------------------------------

describe('TypeScript TSX/JSX scope extraction (registry-primary)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-tsx-jsx'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects Button and App functions in .tsx files (JSX did not break parsing)', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('Button');
    expect(fns).toContain('App');
  });

  it('emits IMPORTS edge from App.tsx to Button.tsx', () => {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (e) => e.sourceFilePath === 'src/App.tsx',
    );
    expect(imports.map((e) => e.targetFilePath)).toContain('src/Button.tsx');
  });
});

// ---------------------------------------------------------------------------
// PR #1050: literal `import('./feature')` resolves to a target file.
// (Adversarial review Finding 3 — dynamic-resolved emits a real IMPORTS edge.)
// ---------------------------------------------------------------------------

describe('TypeScript literal dynamic import resolution (registry-primary)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-dynamic-import'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects Feature class in feature.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Feature');
  });

  it('emits IMPORTS edge from app.ts to feature.ts via `await import("./feature")`', () => {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (e) => e.sourceFilePath === 'src/app.ts',
    );
    // Literal dynamic-import resolution: the interpreter emits
    // `dynamic-resolved` and finalize pre-finalizes it as a file-level
    // terminal, linking literal `import('…')` calls to a target file.
    expect(imports.map((e) => e.targetFilePath)).toContain('src/feature.ts');
  });
});

// ---------------------------------------------------------------------------
// PR #1050: `export * as ns from './m'` namespace barrel re-export.
// (Adversarial review Finding 4 — barrel must expose `ns` as a binding so
//  `import { ns } from './barrel'` resolves through to the namespace target.)
// ---------------------------------------------------------------------------

describe('TypeScript namespace re-export barrel (registry-primary)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-reexport-namespace'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes in base.ts', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
  });

  // The synthetic Namespace `SymbolDefinition` lives in barrel.ts's
  // `localDefs` so `findExportByName` can satisfy a downstream
  // `import { Models } from './barrel'`. Unit coverage for the synthetic
  // capture lives in `typescript-captures.test.ts`. The graph-bridge does
  // not materialize a Namespace node for `export * as` — that's why this
  // suite asserts on the chain edges, not on a `Namespace` graph node.
  it('emits IMPORTS edges along the barrel chain: app.ts→barrel.ts and barrel.ts→base.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const fromApp = imports
      .filter((e) => e.sourceFilePath === 'src/app.ts')
      .map((e) => e.targetFilePath);
    const fromBarrel = imports
      .filter((e) => e.sourceFilePath === 'src/barrel.ts')
      .map((e) => e.targetFilePath);
    expect(fromApp).toContain('src/barrel.ts');
    expect(fromBarrel).toContain('src/base.ts');
  });
});
