/**
 * Go: package imports + cross-package calls + ambiguous struct disambiguation
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
// Heritage: package imports + cross-package calls (exercises PackageMap)
// ---------------------------------------------------------------------------

describe('Go package import & call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-pkg'), () => {});
  }, 60000);

  it('detects exactly 2 structs and 1 interface', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Admin', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Repository']);
  });

  it('detects exactly 5 functions', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual([
      'Authenticate',
      'NewAdmin',
      'NewUser',
      'ValidateToken',
      'main',
    ]);
  });

  it('emits exactly 7 CALLS edges (5 function + 2 struct literal)', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(7);
    expect(edgeSet(calls)).toEqual([
      'Authenticate → NewUser',
      'NewAdmin → Admin',
      'NewAdmin → NewUser',
      'NewUser → User',
      'main → Authenticate',
      'main → NewAdmin',
      'main → NewUser',
    ]);
  });

  it('resolves exactly 7 IMPORTS edges across Go packages', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(7);
    expect(edgeSet(imports)).toEqual([
      'main.go → admin.go',
      'main.go → repository.go',
      'main.go → service.go',
      'main.go → user.go',
      'service.go → admin.go',
      'service.go → repository.go',
      'service.go → user.go',
    ]);
  });

  it('emits exactly 1 EXTENDS edge for struct embedding: Admin → User', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('Admin');
    expect(extends_[0].target).toBe('User');
  });

  it('does not emit IMPLEMENTS edges (Go uses structural typing)', () => {
    expect(getRelationships(result, 'IMPLEMENTS').length).toBe(0);
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
// Qualified / generic / pointer / interface embeds (#1951)
//
// An earlier inheritance synth (languages/go/captures.ts) emitted edges ONLY
// for a bare `type_identifier` struct embed, silently DROPPING the qualified
// (`pkg.Base`), pointer (`*pkg.Base`), qualified-generic (`pkg.Box[T]`) struct
// embeds and ALL interface embeds. The synth was widened so every base reduces
// to its bare simple name, struct bases resolve to EXTENDS and interface bases
// to IMPLEMENTS. The bare-name struct embed (T → Local) is the unchanged
// simple-base path, kept here as a regression guard. Scope-resolution owns
// these edges since #942.
// ---------------------------------------------------------------------------

describe('Go qualified-base embed resolution (#1951)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-qualified-base'), () => {});
  }, 60000);

  it('emits EXTENDS for qualified / pointer / generic / bare struct embeds (tail-resolved)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toEqual(['G → Box', 'P → Base', 'S → Base', 'T → Local']);
  });

  it('emits IMPLEMENTS for qualified and bare interface embeds (tail-resolved)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toEqual(['R → Reader', 'RLocal → LocalIface']);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous: Handler struct in two packages, package import disambiguates
// ---------------------------------------------------------------------------

describe('Go ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler structs in separate packages', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    const handlers = structs.filter((s) => s.startsWith('Handler@'));
    expect(handlers.length).toBe(2);
    expect(handlers.some((h) => h.includes('internal/models/'))).toBe(true);
    expect(handlers.some((h) => h.includes('internal/other/'))).toBe(true);
  });

  it('import resolves to internal/models/handler.go (not internal/other/)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const modelsImport = imports.find((e) => e.targetFilePath.includes('models'));
    expect(modelsImport).toBeDefined();
    expect(modelsImport!.targetFilePath).toBe('internal/models/handler.go');
  });

  it('no import edge to internal/other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    for (const imp of imports) {
      expect(imp.targetFilePath).not.toMatch(/internal\/other\//);
    }
  });
});

describe('Go call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-calls'), () => {});
  }, 60000);

  it('resolves main → WriteAudit to internal/onearg/log.go via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('main');
    expect(calls[0].target).toBe('WriteAudit');
    expect(calls[0].targetFilePath).toBe('internal/onearg/log.go');
    expect(calls[0].rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.Method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Go member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-member-calls'), () => {});
  }, 60000);

  it('resolves processUser → Save as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.targetFilePath).toBe('models/user.go');
  });

  it('detects User struct and Save method', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
  });
});

describe('Go receiver method free-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-receiver-method-free-call'),
      () => {},
      {},
    );
  }, 60000);

  it('resolves Caller -> callee when a receiver method calls a package-level function', () => {
    const calls = getRelationships(result, 'CALLS');
    const calleeCall = calls.find((c) => c.source === 'Caller' && c.target === 'callee');
    expect(calleeCall).toBeDefined();
    expect(calleeCall!.targetLabel).toBe('Function');
    expect(calleeCall!.targetFilePath).toBe('util.go');
  });
});

// ---------------------------------------------------------------------------
// Struct literal resolution: User{...} resolves to Struct node
// ---------------------------------------------------------------------------

describe('Go struct literal resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-struct-literals'), () => {});
  }, 60000);

  it('resolves User{...} as a CALLS edge to the User struct', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'User');
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.source).toBe('processUser');
    expect(ctorCall!.targetLabel).toBe('Struct');
    expect(ctorCall!.targetFilePath).toBe('user.go');
  });

  it('also resolves user.Save() as a member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
  });

  it('detects User struct, Save method, and processUser function', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Function')).toContain('processUser');
  });
});

// ---------------------------------------------------------------------------
// Receiver-constrained resolution: typed variables disambiguate same-named methods
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-assignment: user, repo := User{}, Repo{} — both sides captured in TypeEnv
// ---------------------------------------------------------------------------

describe('Go multi-assignment short var declaration', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-multi-assign'), () => {});
  }, 60000);

  it('detects User and Repo structs with their methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Repo', 'User']);
    expect(getNodesByLabel(result, 'Method')).toEqual(['Persist', 'Save']);
  });

  it('resolves both struct literals in multi-assignment: User{} and Repo{}', () => {
    const calls = getRelationships(result, 'CALLS');
    const structCalls = calls.filter((c) => c.targetLabel === 'Struct');
    expect(edgeSet(structCalls)).toEqual(['process → Repo', 'process → User']);
  });

  it('resolves user.Save() to User.Save and repo.Persist() to Repo.Persist via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save');
    const cloneCall = calls.find((c) => c.target === 'Persist');

    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
    expect(saveCall!.targetFilePath).toBe('models.go');

    expect(cloneCall).toBeDefined();
    expect(cloneCall!.source).toBe('process');
    expect(cloneCall!.targetFilePath).toBe('models.go');
  });
});

describe('Go receiver-constrained resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-receiver-resolution'), () => {});
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    const structs: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Struct') structs.push(n.properties.name);
    });
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save and repo.Save() to Repo.Save via receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);

    const userSave = saveCalls.find((c) => c.targetFilePath === 'models/user.go');
    const repoSave = saveCalls.find((c) => c.targetFilePath === 'models/repo.go');

    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
    expect(repoSave!.source).toBe('processEntities');
  });
});

describe('Go structural interface dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-structural-interface-dispatch'),
      () => {},
    );
  }, 60000);

  function owningTypeName(methodId: string): string {
    for (const rel of result.graph.iterRelationshipsByType('HAS_METHOD')) {
      if (rel.targetId !== methodId) continue;
      const owner = result.graph.getNode(rel.sourceId);
      return (owner?.properties.name ?? rel.sourceId) as string;
    }
    return '';
  }

  it('emits signature-checked structural IMPLEMENTS edges only for valid implementors', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS').filter((edge) =>
      (edge.rel.reason ?? '').startsWith('go-structural-implements'),
    );
    expect(edgeSet(implementsEdges)).toEqual([
      'File → ReadCloser',
      'File → Reader',
      'FileBase → Reader',
      'MemoryRepository → Repository',
      // ADDED in #2813, same deliberate reversal as the PointerOnlyThing pin
      // below: `func (p *PointerOnlyThing) Touch()` puts Touch in the method
      // set of *PointerOnlyThing, which is the type idiomatic Go stores in a
      // PointerOnly-typed field. This exact-set assertion was the second place
      // the #1966 value-only reading was encoded.
      'PointerOnlyThing → PointerOnly',
      'SqlRepository → Repository',
    ]);
    expect(implementsEdges.every((edge) => edge.rel.confidence === 0.85)).toBe(true);
  });

  it('feeds structural IMPLEMENTS into METHOD_IMPLEMENTS edges', () => {
    const methodEdges = getRelationships(result, 'METHOD_IMPLEMENTS').filter(
      (edge) => edge.target === 'Save',
    );
    const sourceOwners = methodEdges.map((edge) => owningTypeName(edge.rel.sourceId)).sort();
    expect(sourceOwners).toEqual(['MemoryRepository', 'SqlRepository']);
  });

  it('prefers the concrete local assignment over interface fan-out', () => {
    const saveCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'precise' && edge.target === 'Save',
    );
    const targetOwners = saveCalls.map((edge) => owningTypeName(edge.rel.targetId));
    expect(targetOwners).toEqual(['SqlRepository']);
  });

  it('fans out interface-typed receiver calls to all known implementors', () => {
    const saveCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'fallback' && edge.target === 'Save',
    );
    const dispatchTargets = saveCalls
      .filter((edge) => edge.rel.reason === 'interface-dispatch')
      .map((edge) => owningTypeName(edge.rel.targetId))
      .sort();
    expect(dispatchTargets).toEqual(['MemoryRepository', 'SqlRepository']);
  });

  it('includes embedded interface methods before emitting structural IMPLEMENTS edges', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implementsEdges)).toContain('File → ReadCloser');
    expect(edgeSet(implementsEdges)).not.toContain('CloseOnly → ReadCloser');
  });

  it('includes promoted embedded struct methods before emitting structural IMPLEMENTS edges', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implementsEdges)).toContain('File → Reader');
    expect(edgeSet(implementsEdges)).toContain('File → ReadCloser');
    expect(edgeSet(implementsEdges)).not.toContain('ShadowReadFile → Reader');
    expect(edgeSet(implementsEdges)).not.toContain('ShadowReadFile → ReadCloser');
  });

  // POLARITY DELIBERATELY REVERSED in #2813 (was: `.not.toContain`).
  //
  // #1966 read Go's method-set rule for the VALUE type `T`, where pointer-
  // receiver methods genuinely do not count. But GitNexus has one Struct node
  // per type and no separate `*T` node, so that reading left `*T` — the shape
  // idiomatic Go stores in an interface-typed field — unable to implement
  // anything. The cost was silence, not caution: calls through such a field
  // stopped at the interface declaration and `impact()` on the implementation
  // reported zero callers. See the rationale block in interface-impls.ts.
  it('emits IMPLEMENTS for a pointer-receiver-only implementor', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implementsEdges)).toContain('PointerOnlyThing → PointerOnly');
  });

  // The FORM is the exact fact, not a confidence hedge. `func (p *PointerOnlyThing)
  // Touch()` puts Touch in MS(*PointerOnlyThing) only, so `var x PointerOnly =
  // PointerOnlyThing{}` is a Go compile error while `&PointerOnlyThing{}` is fine.
  // Value-satisfying implementors keep the unsuffixed reason.
  it('records WHICH method set satisfies the interface', () => {
    const byPair = new Map(
      getRelationships(result, 'IMPLEMENTS').map((e) => [
        `${e.source} → ${e.target}`,
        e.rel.reason,
      ]),
    );
    expect(byPair.get('PointerOnlyThing → PointerOnly')).toBe('go-structural-implements-pointer');
    // SqlRepository/MemoryRepository use VALUE receivers, so the value type
    // itself implements and the reason stays unsuffixed.
    expect(byPair.get('SqlRepository → Repository')).toBe('go-structural-implements');
    expect(byPair.get('MemoryRepository → Repository')).toBe('go-structural-implements');
  });

  it('fans out embedded-interface receivers only to complete implementors', () => {
    const closeCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'fallbackReadCloser' && edge.target === 'Close',
    );
    const dispatchTargets = closeCalls
      .filter((edge) => edge.rel.reason === 'interface-dispatch')
      .map((edge) => owningTypeName(edge.rel.targetId))
      .sort();
    expect(dispatchTargets).toEqual(['File']);
  });
});

describe('Go cross-package structural interface dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-structural-interface-cross-package'),
      () => {},
    );
  }, 60000);

  function owningTypeName(methodId: string): string {
    for (const rel of result.graph.iterRelationshipsByType('HAS_METHOD')) {
      if (rel.targetId !== methodId) continue;
      const owner = result.graph.getNode(rel.sourceId);
      return (owner?.properties.name ?? rel.sourceId) as string;
    }
    return '';
  }

  it('matches local interface types against package-qualified implementation signatures', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS').filter((edge) =>
      (edge.rel.reason ?? '').startsWith('go-structural-implements'),
    );
    expect(edgeSet(implementsEdges)).toEqual([
      'File → ReadCloser',
      'File → Reader',
      'GoodStore → Saver',
    ]);
  });

  it('merges methods from package-qualified embedded interfaces before matching implementors', () => {
    const implementsEdges = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implementsEdges)).toContain('File → ReadCloser');
    expect(edgeSet(implementsEdges)).not.toContain('CloseOnly → ReadCloser');
  });

  it('fans out cross-package interface receivers only to valid implementors', () => {
    const saveCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'fallback' && edge.target === 'Save',
    );
    const dispatchTargets = saveCalls
      .filter((edge) => edge.rel.reason === 'interface-dispatch')
      .map((edge) => owningTypeName(edge.rel.targetId))
      .sort();
    expect(dispatchTargets).toEqual(['GoodStore']);
  });

  it('dispatches package-qualified embedded-interface receivers only to complete implementors', () => {
    const closeCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'fallbackReadCloser' && edge.target === 'Close',
    );
    const dispatchTargets = closeCalls
      .filter((edge) => edge.rel.reason === 'interface-dispatch')
      .map((edge) => owningTypeName(edge.rel.targetId))
      .sort();
    expect(dispatchTargets).toEqual(['File']);
  });
});

// ---------------------------------------------------------------------------
// Variadic resolution: ...interface{} doesn't get filtered by arity
// ---------------------------------------------------------------------------

describe('Go variadic call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-variadic-resolution'), () => {});
  }, 60000);

  it('resolves 3-arg call to variadic func Entry(...interface{}) in logger.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'Entry');
    expect(logCall).toBeDefined();
    expect(logCall!.source).toBe('main');
    expect(logCall!.targetFilePath).toBe('internal/logger/logger.go');
  });
});

// ---------------------------------------------------------------------------
// Local shadow: unqualified call resolves to local function, not imported package
// ---------------------------------------------------------------------------

describe('Go local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-local-shadow'), () => {});
  }, 60000);

  it('resolves Save("test") to local Save in main.go, not utils.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.source === 'main');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('cmd/main.go');
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: user := models.User{}; user.Save()
// Go composite literal constructor pattern (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Go constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    expect(getNodesByLabel(result, 'Struct')).toContain('Box');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.Save() to models/repo.go via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('resolves Box[models.User]{} as a generic composite-literal constructor call', () => {
    const calls = getRelationships(result, 'CALLS');
    const boxCtor = calls.find(
      (c) =>
        c.target === 'Box' &&
        c.source === 'processEntities' &&
        c.targetFilePath === 'models/user.go',
    );
    expect(boxCtor).toBeDefined();
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pointer-constructor-inferred type resolution: user := &models.User{...}; user.Save()
// Go address-of composite literal constructor pattern (no explicit type annotations)
// ---------------------------------------------------------------------------

describe('Go pointer-constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-pointer-constructor-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via &User{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process');
  });

  it('resolves repo.Save() to models/repo.go via &Repo{} pointer-constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process');
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parent resolution: struct embedding emits EXTENDS
// ---------------------------------------------------------------------------

describe('Go parent resolution (struct embedding)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-parent-resolution'), () => {});
  }, 60000);

  it('detects BaseModel and User structs', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['BaseModel', 'User']);
  });

  it('emits EXTENDS edge: User → BaseModel (struct embedding)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// Go new() builtin type inference: user := new(User); user.Save()
// ---------------------------------------------------------------------------

describe('Go new() builtin type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-new-builtin'), () => {});
  }, 60000);

  it('resolves user.Save() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.Greet() via new(User) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Go make() builtin type inference: sl := make([]User, 0); sl[0].Save()
// ---------------------------------------------------------------------------

describe('Go make() builtin type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-make-builtin'), () => {});
  }, 60000);

  it('resolves sl[0].Save() via make([]User, 0) slice inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves m["key"].Greet() via make(map[string]User) map inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Go type assertion inference: user := s.(User); user.Save()
// ---------------------------------------------------------------------------

describe('Go type assertion type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-type-assertion'), () => {});
  }, 60000);

  it('resolves user.Save() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'Save' && c.targetFilePath === 'models.go');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process');
  });

  it('resolves user.Greet() via type assertion s.(User)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'Greet' && c.targetFilePath === 'models.go');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('process');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: user := GetUser("alice"); user.Save()
// Go now has a CONSTRUCTOR_BINDING_SCANNER for short_var_declaration, so
// return type inference works end-to-end for `user := GetUser()`.
// ---------------------------------------------------------------------------

describe('Go return type inference via explicit function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-return-type-inference'), () => {});
  }, 60000);

  it('detects GetUser, GetRepo, and competing Save methods', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('GetUser');
    expect(allSymbols).toContain('GetRepo');
    const saveMethods = allSymbols.filter((s) => s === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via return type of GetUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go'),
    );
    expect(saveCall).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via return type of GetRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go'),
    );
    expect(saveCall).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves user.Save() via cross-package factory call models.NewUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processUserCrossPackage' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(saveCall).toBeDefined();
  });
});

describe('Go same-package factory return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-same-package-factory'), () => {});
  }, 60000);

  it('resolves user.Save() through same-package NewUser() return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'processUser' && c.targetFilePath === 'user.go',
    );
    expect(userSave).toBeDefined();
  });

  it('does not resolve user.Save() to Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'processUser' && c.targetFilePath === 'repo.go',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go multi-return factory inference: user, err := NewUser("alice"); user.Save()
// ---------------------------------------------------------------------------

describe('Go multi-return factory type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-multi-return-inference'), () => {});
  }, 60000);

  it('detects User and Repo structs with competing Save methods', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to models/user.go via multi-return inference (user, err := NewUser())', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('user.Save() does NOT resolve to models/repo.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('resolves repo.Save() to models/repo.go via blank discard (repo, _ := NewRepo())', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('repo.Save() does NOT resolve to models/user.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepo' && c.targetFilePath.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: var user *models.User = findUser(); user.Save()
// Go pointer types (*User) — extractSimpleTypeName strips pointer prefix.
// ---------------------------------------------------------------------------

describe('Go nullable receiver resolution (pointer types)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-nullable-receiver'), () => {});
  }, 60000);

  it('detects User and Repo structs, both with Save methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.Save() to User.Save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/user.go',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.Save() to Repo.Save via pointer receiver typing', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.targetFilePath === 'models/repo.go',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('user.Save() does NOT resolve to Repo.Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save' && c.source === 'processEntities');
    expect(saveCalls.filter((c) => c.targetFilePath === 'models/user.go').length).toBe(1);
    expect(saveCalls.filter((c) => c.targetFilePath === 'models/repo.go').length).toBe(1);
  });

  it('emits exactly 2 Save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'Save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Assignment chain propagation (Phase 4.3)
// ---------------------------------------------------------------------------

describe('Go assignment chain propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-assignment-chain'), () => {});
  }, 60000);

  it('detects User and Repo structs each with a Save method', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'Save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.Save() to User#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: alias.Save() must resolve to User#Save
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.Save() does NOT resolve to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    // Negative: alias comes from User, so only one edge to user.go
    const wrongCall = calls.filter(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(wrongCall.length).toBe(1);
  });

  it('resolves rAlias.Save() to Repo#Save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    // Positive: rAlias.Save() must resolve to Repo#Save
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('each alias resolves to its own struct, not the other', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('user.go'),
    );
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeDefined();
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });

  // --- var form assignment chain ---

  it('resolves var alias.Save() to User via var assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves var rAlias.Save() to Repo via var assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('var alias.Save() does NOT resolve to Repo (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSaves = calls.filter(
      (c) =>
        c.target === 'Save' &&
        c.source === 'processWithVar' &&
        c.targetFilePath.includes('user.go'),
    );
    expect(userSaves.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.GetUser().Save()
// Tests that Go chain call resolution correctly infers the intermediate
// receiver type from GetUser()'s return type and resolves Save() to User.
// ---------------------------------------------------------------------------

describe('Go chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo structs and UserService', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Struct')).toContain('Repo');
    expect(getNodesByLabel(result, 'Struct')).toContain('UserService');
  });

  it('detects GetUser and Save symbols', () => {
    const allSymbols = [
      ...getNodesByLabel(result, 'Function'),
      ...getNodesByLabel(result, 'Method'),
    ];
    expect(allSymbols).toContain('GetUser');
    expect(allSymbols).toContain('Save');
  });

  it('resolves svc.GetUser().Save() to User#Save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.GetUser().Save() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath?.includes('repo.go'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go map range: for _, user := range userMap where map[string]User
// ---------------------------------------------------------------------------

describe('Go map range type resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-map-range'), () => {});
  }, 60000);

  it('detects User and Repo structs with Save methods in separate files', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((m) => m === 'Save').length).toBe(2);
  });

  it('resolves user.Save() in map range to User#Save via map_type value', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processMap' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processMap' && c.targetFilePath?.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go for-loop with call_expression iterable: for _, user := range GetUsers()
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('Go for-loop call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-for-call-expr'), () => {});
  }, 60000);

  it('detects User and Repo structs with competing Save methods', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Repo');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((m) => m === 'Save').length).toBe(2);
  });

  it('resolves user.Save() in range GetUsers() to User#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUsers' && c.targetFilePath?.includes('user.go'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.Save() in range GetRepos() to Repo#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo.go'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.Save() to Repo#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo.go'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.Save() to User#Save (negative disambiguation)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processRepos' && c.targetFilePath?.includes('user.go'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-field-types'), () => {});
  }, 60000);

  it('detects structs: Address, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for Go struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('Name');
    expect(properties).toContain('City');
  });

  it('emits HAS_PROPERTY edges linking struct fields to structs', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('Address → City');
  });

  it('resolves user.Address.Save() → Address#Save via field type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'processUser' && e.targetFilePath.includes('models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('Property nodes contain expected field names', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'City');
    expect(city).toBeDefined();

    const name = properties.find((p) => p.name === 'Name');
    expect(name).toBeDefined();

    const addr = properties.find((p) => p.name === 'Address');
    expect(addr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level)
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-deep-field-chain'), () => {});
  }, 60000);

  it('detects structs: Address, City, User', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'City', 'User']);
  });

  it('detects Property nodes for Go struct fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('Address');
    expect(properties).toContain('City');
    expect(properties).toContain('ZipCode');
  });

  it('emits HAS_PROPERTY edges for nested type chain', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(5);
    expect(edgeSet(propEdges)).toContain('User → Name');
    expect(edgeSet(propEdges)).toContain('User → Address');
    expect(edgeSet(propEdges)).toContain('Address → City');
    expect(edgeSet(propEdges)).toContain('Address → Street');
    expect(edgeSet(propEdges)).toContain('City → ZipCode');
  });

  it('resolves 2-level chain: user.Address.Save() → Address#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save' && e.source === 'processUser');
    const addressSave = saveCalls.find((e) => e.targetFilePath.includes('models'));
    expect(addressSave).toBeDefined();
  });

  it('resolves 3-level chain: user.Address.City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'GetName' && e.source === 'processUser');
    const cityGetName = getNameCalls.find((e) => e.targetFilePath.includes('models'));
    expect(cityGetName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed field+call chain resolution (Go)
// ---------------------------------------------------------------------------

describe('Mixed field+call chain resolution (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-mixed-chain'), () => {});
  }, 60000);

  it('detects structs: Address, City, User, UserService', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'City', 'User', 'UserService']);
  });

  it('detects Property nodes for mixed-chain fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('City');
    expect(properties).toContain('Address');
  });

  it('resolves call→field chain: svc.GetUser().Address.Save() → Address#Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'Save' && e.source === 'processWithService');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves field→call chain: user.GetAddress().City.GetName() → City#GetName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(
      (e) => e.target === 'GetName' && e.source === 'processWithUser',
    );
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment statements
// ---------------------------------------------------------------------------

describe('Write access tracking (Go)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for field assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(2);
    const nameWrite = writes.find((e) => e.target === 'Name');
    const addressWrite = writes.find((e) => e.target === 'Address');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('updateUser');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('updateUser');
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): user := GetUser(); user.Save()
// ---------------------------------------------------------------------------

describe('Go call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.Save() to User#Save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): GetUser() → .Address → .GetCity() → .Save()
// ---------------------------------------------------------------------------

describe('Go method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-method-chain-binding'), () => {});
  }, 60000);

  it('resolves city.Save() to City#Save via 3-step chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'Save' && c.source === 'processChain' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Go inc_statement / dec_statement write access
// obj.Field++ and obj.Field-- emit ACCESSES write edges
// ---------------------------------------------------------------------------

describe('Go inc/dec write access tracking (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-inc-dec-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edge for Count++ in increment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const countInc = writes.find((e) => e.target === 'Count' && e.source === 'increment');
    expect(countInc).toBeDefined();
  });

  it('emits ACCESSES write edge for Total++ in increment', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const totalInc = writes.find((e) => e.target === 'Total' && e.source === 'increment');
    expect(totalInc).toBeDefined();
  });

  it('emits ACCESSES write edge for Count-- in decrement', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const countDec = writes.find((e) => e.target === 'Count' && e.source === 'decrement');
    expect(countDec).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation (via synthesized wildcard imports)
// models/user.go exports User struct with Save() and GetName() methods
// models/factory.go exports GetUser() -> User
// app/main.go imports models package, calls models.GetUser().Save()
// → user is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Go cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'go-cross-file'), () => {});
  }, 60000);

  it('detects User struct with Save and GetName methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('Save');
    expect(getNodesByLabel(result, 'Method')).toContain('GetName');
  });

  it('detects GetUser factory function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('GetUser');
  });

  it('emits IMPORTS edge from main.go to models package files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('main') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves user.Save() in main() to User#Save via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'Save' && c.source === 'main' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.GetName() in main() to User#GetName via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'GetName' && c.source === 'main' && c.targetFilePath.includes('models'),
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

describe('Go aliased package selector resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-aliased-package-import'), () => {});
  }, 60000);

  it('resolves util.Log() through an aliased package import', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find(
      (c) =>
        c.target === 'Log' && c.source === 'main' && c.targetFilePath === 'internal/util/log.go',
    );
    expect(logCall).toBeDefined();
  });
});

describe('Go method owner resolution across package files', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-split-method-owner'), () => {});
  }, 60000);

  it('resolves user.Save() to the method whose receiver type is declared in another package file', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'process' && c.targetFilePath === 'save.go',
    );
    expect(userSave).toBeDefined();
  });

  it('does not resolve user.Save() to Repo.Save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'Save' && c.source === 'process' && c.targetFilePath === 'repo.go',
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Go cmd/ helper files should NOT get entry-point multiplier (P0-1 fix)
// Only main.go files should get the 3.0 entry-point boost, not arbitrary
// .go files under cmd/ subdirectories.
// ---------------------------------------------------------------------------

describe('Go cmd/ helper files entry-point scoring', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-cmd-helper'), () => {});
  }, 60000);

  it('detects main function and Load function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('main');
    expect(getNodesByLabel(result, 'Function')).toContain('Load');
  });

  it('emits IMPORTS edge from main.go to config/config.go', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('main') && e.targetFilePath.includes('config'),
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: struct methods, interface methods, package-level funcs
// ---------------------------------------------------------------------------

describe('Go method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-method-enrichment'), () => {});
  }, 60000);

  it('detects Dog struct', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('Dog');
  });

  it('detects Speak method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('Speak');
  });

  it('detects Classify as static function', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });

  it('marks Speak as public (exported)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find((n) => n.name === 'Speak');
    if (speak?.properties.visibility !== undefined) {
      expect(speak.properties.visibility).toBe('public');
    }
  });

  it('populates parameterTypes for Classify', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'Classify');
    if (classify?.properties.parameterTypes !== undefined) {
      expect(classify.properties.parameterTypes).toContain('string');
    }
  });

  it('detects Animal interface', () => {
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(interfaces).toContain('Animal');
  });

  it('marks interface method Speak as isAbstract (conditional)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    // Interface method_elem Speak should be abstract
    const interfaceSpeak = methods.find(
      (m) => m.name === 'Speak' && m.properties.isAbstract === true,
    );
    if (interfaceSpeak) {
      expect(interfaceSpeak.properties.isAbstract).toBe(true);
    }
  });

  it('resolves dog.Speak() CALLS edge from app.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'Speak' && c.sourceFilePath.includes('app.go'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Classify() CALLS edge from app.go', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'Classify' && c.sourceFilePath.includes('app.go'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SM-9/SM-10: inherited method resolution — Go struct embedding
// ---------------------------------------------------------------------------

describe('Go Child embeds Parent — inherited method resolution (SM-9)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-child-extends-parent'), () => {});
  }, 60000);

  it('detects Parent and Child structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('Parent');
    expect(structs).toContain('Child');
  });

  it('emits EXTENDS edge: Child → Parent (struct embedding)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('Child → Parent');
  });

  it('resolves c.ParentMethod() to Parent.ParentMethod via first-wins MRO walk', () => {
    const calls = getRelationships(result, 'CALLS');
    const parentMethodCall = calls.find(
      (c) => c.target === 'ParentMethod' && c.targetFilePath.includes('parent.go'),
    );
    expect(parentMethodCall).toBeDefined();
    expect(parentMethodCall!.source).toBe('Run');
  });
});

// ---------------------------------------------------------------------------
// #2766: pointer-receiver base resolution
// ---------------------------------------------------------------------------

describe('Go pointer-receiver field chains (#2766)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-pointer-receiver-field-chain'),
      () => {},
    );
  }, 60000);

  const calls = (): string[] => edgeSet(getRelationships(result, 'CALLS'));
  /** ACCESSES rows with each target's KIND appended — `→ Work` alone cannot
   *  tell a func-typed field apart from the method that shadowed it. */
  const accesses = (): string[] =>
    getRelationships(result, 'ACCESSES').map((e) => `${e.source} → ${e.target}:${e.targetLabel}`);

  // The three rows that emitted nothing before the decoration fallback. All
  // three have a POINTER receiver, which bound as the literal `*Holder` and
  // matched no class, so receiver typing declined at the base.
  it('resolves an interface-typed cross-package field through a pointer receiver', () => {
    expect(calls()).toContain('RunInterface → DoWork');
  });

  it('resolves a concrete-typed cross-package field through a pointer receiver', () => {
    expect(calls()).toContain('RunConcrete → DoWork');
  });

  it('resolves a concrete cross-package field returning a value', () => {
    expect(calls()).toContain('RunCart → WithTx');
  });

  // Controls: these resolved BEFORE the fix. R11 requires they still resolve to
  // the same target, so a regression here means the fallback moved an edge
  // rather than adding one.
  it('keeps resolving a local-variable receiver', () => {
    expect(calls()).toContain('RunLocal → DoWork');
  });

  it('keeps resolving a value receiver', () => {
    expect(calls()).toContain('RunFromValueReceiver → DoWork');
  });

  // U8: the same-package field receiver that previously produced an ACCESSES
  // edge to the method and no CALLS edge. Typing the base is what emits CALLS;
  // the ACCESSES now correctly targets the PROPERTY being read instead.
  it('emits CALLS for a same-package field receiver, not ACCESSES alone', () => {
    expect(calls()).toContain('RunSamePackage → Work');
  });

  it('retargets the field ACCESSES to the property, not the method', () => {
    // Unlabeled on purpose: the negative must reject `→ Work` under ANY target
    // kind, which the kind-qualified rows below cannot express.
    const accessEdges = edgeSet(getRelationships(result, 'ACCESSES'));
    expect(accessEdges).toContain('RunSamePackage → dep');
    expect(accessEdges).not.toContain('RunSamePackage → Work');
  });

  // The assertion above used to pass by ACCIDENT: a pointer receiver's text
  // cascade failed for an unrelated reason, so the phantom never resolved. The
  // value-receiver twin proves the rule holds when the lookup SUCCEEDS — before
  // the callee read-site was dropped, this emitted `RunFromValueReceiver →
  // DoWork` as an ACCESSES edge duplicating its own CALLS edge.
  it('emits no method-targeted ACCESSES for a value receiver either', () => {
    const accessEdges = edgeSet(getRelationships(result, 'ACCESSES'));
    expect(accessEdges).toContain('RunFromValueReceiver → impl');
    expect(accessEdges).not.toContain('RunFromValueReceiver → DoWork');
  });

  // The invariant, stated once rather than per-fixture: a member call whose
  // callee resolves to a METHOD must not also emit a field read for it.
  // Asserted as the EXACT edge set INCLUDING each target's kind, so the two
  // failure directions are both caught on rows nobody wrote a targeted
  // assertion for: a new phantom (an ACCESSES to a Method at a call position)
  // fails here, and so does a deleted genuine read (a missing ACCESSES to a
  // Property). The kinds are load-bearing — `→ Work` alone cannot tell a
  // func-typed field apart from the method that shadowed it.
  it('emits exactly the expected ACCESSES set, target kinds included', () => {
    expect(accesses().sort()).toEqual([
      // #2782 review: callee position is a POSITION, not a verdict. Go
      // dispatches `c.OnEvent()` through a func-typed struct field with exactly
      // the same syntax as a method call, so the capture layer cannot decide
      // which it is — `call_expression` looks identical and the tail may be
      // declared in another package. Suppressing every callee-position read
      // deleted the only ACCESSES evidence for callback structs, hook structs
      // and hand-rolled mocks; this row is that evidence.
      'CallFuncField → OnEvent:Property',
      // A METHOD VALUE resolves to a Method just like the phantom does, and is
      // the reason the suppression cannot key on target kind alone.
      'MethodValue → DoWork:Method',
      // A plain (non-func) field read, never in callee position.
      'ReadPlainField → Label:Property',
      'RunCart → cart:Property',
      'RunConcrete → impl:Property',
      'RunFromValueReceiver → impl:Property',
      'RunInterface → thing:Property',
      'RunSamePackage → dep:Property',
    ]);
  });

  it('keeps CALLS for every field-receiver call', () => {
    expect(calls()).toContain('RunSamePackage → Work');
    expect(calls()).toContain('RunFromValueReceiver → DoWork');
  });

  // ---------------------------------------------------------------------
  // #2782 review: callee position is a POSITION, not a verdict
  // ---------------------------------------------------------------------
  // That the READS survive is asserted by the exact-set test above, row by
  // row. What that set cannot show is that keeping them did not cost the
  // CALLS edge those same sites must still emit — which is what remains here.

  it('still emits the call through the func-typed field', () => {
    expect(calls()).toContain('CallFuncField → OnEvent');
  });

  // The original defect, on a bare-name receiver whose lookup definitely
  // succeeds: CALLS only, and no ACCESSES duplicating it.
  it('emits CALLS but no duplicate ACCESSES for a real method call', () => {
    expect(calls()).toContain('RealMethodCall → DoWork');
    // Unlabeled: the duplicate must be absent under any target kind.
    expect(edgeSet(getRelationships(result, 'ACCESSES'))).not.toContain('RealMethodCall → DoWork');
  });

  // #2782 review finding 2: the fixture spans two packages and imports
  // `fixture/repository`, but carried no `go.mod` — so `resolveGoImportTarget`
  // matched NEITHER tier (tier 1 needs the module prefix; tier 2's ≥2-segment
  // suffix rule cannot match `fixture/repository` against `repository/`) and the
  // guard for this PR's headline fix exercised an import path no real Go repo
  // takes. With `module fixture` the go.mod tier resolves.
  it('resolves the cross-package import through the go.mod tier', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.map((e) => `${e.source} → ${e.target}`)).toContain('handler.go → repo.go');
  });
});

// ---------------------------------------------------------------------------
// #2813: calls through an interface-typed struct field must reach the
// IMPLEMENTATION, not stop at the interface declaration.
// ---------------------------------------------------------------------------
//
// Two stacked defects produced the reported symptom, and either alone is
// enough to reproduce it — which is why the pre-existing fixtures, uniformly
// value-receiver, could not observe it:
//
//   D1  `buildDetectionIndexes` skipped every POINTER-receiver method, so a
//       struct whose methods are all `func (r *T)` had an empty method set,
//       structurally satisfied nothing, and got no IMPLEMENTS edge. Go's rule
//       is that the method set of *T includes pointer-receiver methods, and
//       idiomatic Go stores *T in an interface-typed field.
//   D2  Case 0 (compound receiver) emitted its primary edge and short-circuited
//       without the interface-dispatch fan-out Case 4 performs. A struct-field
//       receiver `s.orderRepo` contains a dot, so it always takes Case 0; a
//       local or parameter receiver is a bare name and reaches Case 4.
//
// The fixture is deliberately pointer-receiver throughout, cross-package, and
// carries concrete-field controls in the same structs.
describe('Go interface-typed struct field dispatch (#2813)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-interface-field-dispatch'),
      () => {},
    );
  }, 120000);

  const calls = (): string[] => edgeSet(getRelationships(result, 'CALLS'));
  const implementsEdges = (): string[] => edgeSet(getRelationships(result, 'IMPLEMENTS'));
  /** CALLS rows carrying the emitting reason, so a fan-out edge is
   *  distinguishable from the primary edge to the interface declaration. */
  const callsWithReason = (): string[] =>
    getRelationships(result, 'CALLS').map((e) => `${e.source} → ${e.target}:${e.rel.reason}`);
  /** CALLS rows qualified by the target's FILE — `→ DeleteItem` alone cannot
   *  tell the interface declaration apart from the implementation, which is
   *  the entire distinction under test. */
  const callsToFile = (): string[] =>
    getRelationships(result, 'CALLS').map(
      (e) => `${e.source} → ${e.target}@${e.targetFilePath.split('/').slice(-1)[0]}`,
    );
  /** Both ENDS file-qualified. Required wherever two callers share a method
   *  name — `callsToFile()` alone cannot tell them apart, so a row asserting
   *  per-file behaviour must use this instead. */
  const callsFromFileToFile = (): string[] =>
    getRelationships(result, 'CALLS').map(
      (e) =>
        `${e.sourceFilePath.split('/').slice(-1)[0]}:${e.source} → ` +
        `${e.target}@${e.targetFilePath.split('/').slice(-1)[0]}`,
    );
  /** CALLS rows carrying the emitted confidence, so a change to the literal
   *  is caught rather than silently accepted. */
  const callsWithConfidence = (): string[] =>
    getRelationships(result, 'CALLS').map(
      (e) =>
        `${e.source} → ${e.target}@${e.targetFilePath.split('/').slice(-1)[0]}=${e.rel.confidence}`,
    );

  // D1: a pointer-receiver implementor must be discoverable at all.
  it('detects a pointer-receiver struct as an interface implementor', () => {
    expect(implementsEdges()).toContain('OrderRepo → OrderRepository');
  });

  it('detects every pointer-receiver implementor, not just the first', () => {
    expect(implementsEdges()).toContain('MockOrderRepo → OrderRepository');
  });

  // D2: the headline defect. Before the fix these were absent entirely.
  it('resolves an interface-typed field call to the implementation', () => {
    expect(callsToFile()).toContain('StartSession → DeleteItem@order_repo.go');
  });

  it('resolves an interface-typed field call from a handler to the implementation', () => {
    expect(callsToFile()).toContain('Delete → DeleteItem@order_repo.go');
  });

  it('fans out to every implementor, not only the first', () => {
    expect(callsToFile()).toContain('StartSession → DeleteItem@mock_repo.go');
  });

  it('emits the implementation edge with reason interface-dispatch', () => {
    expect(callsWithReason()).toContain('StartSession → DeleteItem:interface-dispatch');
  });

  // R11-style control: the fan-out must ADD edges, never MOVE them. If the
  // primary edge disappears, the fix relocated resolution instead of widening
  // it and every consumer of the interface node silently loses its callers.
  it('keeps the primary edge to the interface declaration', () => {
    expect(callsToFile()).toContain('StartSession → DeleteItem@interfaces.go');
  });

  // The epistemic half of #2813, pinned at its MECHANISM.
  //
  // The reporter's disqualifying complaint was that `impact()` returned
  // `impactedCount 0, epistemic "exact"` for a method reached only through an
  // interface field — byte-identical to a symbol that genuinely has no callers,
  // so a zero could not be trusted defensively. That verdict is produced by
  // `computeEpistemicBoundary`, which walks HERITAGE edges out of the queried
  // symbol; with no IMPLEMENTS/METHOD_IMPLEMENTS edge it found no boundary, and
  // the call sites were never *dropped* (they resolved, to the wrong node), so
  // neither of its two producers fired.
  //
  // These are the edges that make the hedge fire. Measured on this fixture
  // after the fix, `impact(OrderRepo.DeleteItem, upstream)` returns
  // impactedCount 3 with epistemic "lower-bound" and an interface-boundary
  // note, while the concrete `CartRepo.Get` still returns "exact" — so the
  // signal discriminates rather than hedging on everything. Asserting the edges
  // here keeps that mechanism from silently regressing without requiring the
  // resolver suite to reach into the MCP layer.
  it('emits METHOD_IMPLEMENTS from the implementation to the interface method', () => {
    const methodImpls = getRelationships(result, 'METHOD_IMPLEMENTS').map(
      (e) =>
        `${e.sourceFilePath.split('/').slice(-1)[0]}:${e.source} → ` +
        `${e.targetFilePath.split('/').slice(-1)[0]}:${e.target}`,
    );
    expect(methodImpls).toContain('order_repo.go:DeleteItem → interfaces.go:DeleteItem');
    expect(methodImpls).toContain('mock_repo.go:DeleteItem → interfaces.go:DeleteItem');
  });

  // Concrete-field control: resolved before #2813 and must be untouched.
  it('keeps resolving a concrete-typed field to its implementation', () => {
    expect(callsToFile()).toContain('GetPickQueue → LogAuditEventAsync@audit_repo.go');
  });

  // `AuditRepo` implements nothing, so it is never a key in the implementor
  // index — this row is satisfied by that map miss alone and would still pass
  // with the `ownerDef.type !== 'Interface'` gate deleted. Kept as a regression
  // test for the user-visible property, NOT as a control for the gate.
  it('does not fan out a concrete-typed field receiver that implements nothing', () => {
    expect(callsWithReason()).not.toContain('GetPickQueue → LogAuditEventAsync:interface-dispatch');
  });

  // The gate's real control. `OrderRepo` IS an implementor of `OrderRepository`,
  // so it IS a live participant in the dispatch index; a call through a
  // *concrete* `*OrderRepo` field must still resolve only to `OrderRepo` and
  // must not fan out to its sibling implementor `MockOrderRepo`. This is the
  // shape where the type gate does the work, so deleting the gate fails here.
  it('does not fan out a concrete field whose own type is an implementor', () => {
    expect(callsToFile()).toContain('Recount → UnsplitOrder@order_repo.go');
    expect(callsWithReason()).not.toContain('Recount → UnsplitOrder:interface-dispatch');
    expect(callsToFile()).not.toContain('Recount → UnsplitOrder@mock_repo.go');
  });

  // Negative control for structural detection: a partial match is not an
  // implementation. Without this, "everything implements everything" passes.
  it('does not treat a partial signature match as an implementation', () => {
    expect(implementsEdges()).not.toContain('OrderRepo → PartialRepository');
  });

  // Signature comparison is the ONLY remaining guard now that pointer-receiver
  // methods are admitted, so it needs a same-name/same-arity/different-type row
  // and not just the missing-method negative above.
  it('does not treat a same-name same-arity method with a different signature as an implementation', () => {
    expect(implementsEdges()).not.toContain('WrongSigRepo → OrderRepository');
  });

  // The fan-out emits at the same confidence as the primary edge it hangs off.
  // Without this row the 0.85 literal can be changed with nothing failing —
  // the sibling IMPLEMENTS block already pins its own confidence.
  it('emits dispatch edges at the same confidence as the primary edge', () => {
    expect(callsWithConfidence()).toContain('StartSession → DeleteItem@order_repo.go=0.85');
    expect(callsWithConfidence()).toContain('StartSession → DeleteItem@interfaces.go=0.85');
  });

  // Bounds the cross product. Two implementors x the call sites below is the
  // whole fan-out for this interface, so a future cap, collapse or dedup change
  // becomes visible here instead of silently multiplying or truncating edges.
  it('emits exactly one dispatch edge per implementor per call site', () => {
    const deleteItemDispatch = getRelationships(result, 'CALLS').filter(
      (e) => e.target === 'DeleteItem' && e.rel.reason === 'interface-dispatch',
    );
    // 3 call sites on DeleteItem (pick_service StartSession, wave_service
    // Release, handlers Delete) x 2 implementors (OrderRepo, MockOrderRepo).
    expect(deleteItemDispatch.length).toBe(6);
    const targets = [...new Set(deleteItemDispatch.map((e) => e.targetFilePath.split('/').pop()))];
    expect(targets.sort()).toEqual(['mock_repo.go', 'order_repo.go']);
  });

  // The issue reported these two files behaving differently at scale despite
  // declaring the same field shape; both must resolve here.
  //
  // The SOURCE is file-qualified on purpose. Two methods in this fixture are
  // named `Queue` (services/wave_service.go and handlers/picking.go), and
  // `callsToFile()` qualifies only the target — so a bare `'Queue → …'` row is
  // satisfied by EITHER of them and cannot detect one file resolving while the
  // other does not. That per-file divergence is the exact #2813 symptom this
  // row exists to catch, so it has to name both sides.
  it('resolves the same field shape identically across two service files', () => {
    expect(callsFromFileToFile()).toContain('wave_service.go:Release → DeleteItem@order_repo.go');
    expect(callsFromFileToFile()).toContain('wave_service.go:Queue → GetPickQueue@order_repo.go');
    expect(callsFromFileToFile()).toContain(
      'pick_service.go:StartSession → DeleteItem@order_repo.go',
    );
    expect(callsFromFileToFile()).toContain('picking.go:Queue → GetPickQueue@order_repo.go');
  });
});

// ---------------------------------------------------------------------------
// #2837 — grouped `type (...)` declarations collapse N types into ONE Class
// scope.
//
// `languages/go/query.ts` captures `@scope.class` on the `type_declaration`,
// not on the `type_spec`. An idiomatic grouped declaration is therefore a
// SINGLE capture owning every struct in the block, and
// `buildWorkspaceResolutionIndex` keeps only the FIRST class-like def per Class
// scope (`workspace-index.ts:156-164`). Every struct after the first has no
// `classScopeByDefId` entry, so `typeOfMemberOnClass` cannot find its fields,
// the Case 0 compound-receiver fold declines, and every field-receiver call
// site in that file emits ZERO edges — silently, and independently of file
// size. That is the per-file split #2837 reported and #2829 could not explain.
//
// Not caught before because ZERO of this repo's 115 Go fixture files used a
// grouped `type (...)` block, including #2829's own fixture.
describe('Go grouped type declaration scoping (#2837)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'go-grouped-type-decl'), () => {});
  }, 120000);

  /** Both ends file-qualified: three services declare a method named `Release`,
   *  so a target-only row cannot tell which file resolved. */
  const callsFromFileToFile = (): string[] =>
    getRelationships(result, 'CALLS').map(
      (e) =>
        `${e.sourceFilePath.split('/').slice(-1)[0]}:${e.source} → ` +
        `${e.target}@${e.targetFilePath.split('/').slice(-1)[0]}`,
    );
  const implementsEdges = (): string[] => edgeSet(getRelationships(result, 'IMPLEMENTS'));

  // Control: the plain declaration resolves today and must keep resolving.
  it('resolves a field receiver whose struct is declared plainly', () => {
    expect(callsFromFileToFile()).toContain('wave_service.go:Release → DeleteItem@order_repo.go');
  });

  // The headline defect: identical field shape, declared SECOND in a grouped
  // block, currently emits nothing at all.
  it('resolves a field receiver whose struct is declared second in a grouped block', () => {
    expect(callsFromFileToFile()).toContain('pick_service.go:Release → DeleteItem@order_repo.go');
  });

  // Order control. If only the first-declared struct resolves, the fix is
  // order-luck rather than a fix.
  it('resolves a field receiver whose struct is declared first in a grouped block', () => {
    expect(callsFromFileToFile()).toContain('sort_service.go:Release → DeleteItem@order_repo.go');
  });

  // Equality, not mere presence: a one-sided fix fails here.
  it('emits the same field-receiver edges for plain and grouped declarations', () => {
    const rows = callsFromFileToFile();
    const forFile = (f: string): string[] =>
      rows
        .filter((r) => r.startsWith(`${f}:`))
        .map((r) => r.slice(f.length + 1))
        .sort();
    expect(forFile('pick_service.go')).toEqual(forFile('wave_service.go'));
    expect(forFile('sort_service.go')).toEqual(forFile('wave_service.go'));
  });

  // The field-binding-collision half. While the grouped structs share ONE Class
  // scope they also share one name-keyed `typeBindings` map, so `orderRepo`
  // declared by `Decoy` as `*LocalThing` can type `PickService.orderRepo`.
  // A fix that only made `workspace-index` map every class-like def would leave
  // this map shared and would fail this row — which is why it is not the fix.
  it('does not type a grouped struct field from a sibling struct of the same name', () => {
    expect(callsFromFileToFile()).not.toContain(
      'pick_service.go:Release → DeleteItem@pick_service.go',
    );
  });

  // Grouped INTERFACE declarations collapse the same way. This row is also what
  // discriminates the `tree-sitter-queries.ts` half of the fix: with only
  // `languages/go/query.ts` re-anchored, MetricSink has a scope but still no
  // graph NODE, so its implementor edge cannot exist.
  it('detects implementors of both interfaces in a grouped interface block', () => {
    expect(implementsEdges()).toContain('AuditWriter → AuditSink');
    expect(implementsEdges()).toContain('MetricWriter → MetricSink');
  });

  // The node-level symptom, asserted directly for STRUCTS rather than only
  // inferred from the interface row above. Before the fix the whole grouped
  // block collapsed to one node and `PickService` was absent from the inventory
  // entirely — `impact("PickService")` would have returned a clean, wrong zero.
  it('emits a graph node for every struct in a grouped block', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('WaveService'); // plain — control
    expect(structs).toContain('Decoy'); // grouped, first
    expect(structs).toContain('PickService'); // grouped, second
    expect(structs).toContain('SortService'); // grouped, first (reverse-order file)
    expect(structs).toContain('SortDecoy'); // grouped, second (reverse-order file)
  });
});
