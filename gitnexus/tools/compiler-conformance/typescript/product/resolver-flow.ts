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

// ---------------------------------------------------------------------------
// TypeScript class field foreach: for (const user of this.users) with class field User[]
// ---------------------------------------------------------------------------

describe('TypeScript class field foreach resolution (Phase 6.1)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-class-field-foreach'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() via class field User[] to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via class field Map<string, Repo>.values() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve repo.save() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('user'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TypeScript for-of with call_expression iterable: for (const user of getUsers())
// Phase 7.3: call_expression iterable resolution via ReturnTypeLookup
// ---------------------------------------------------------------------------

describe('TypeScript for-of call_expression iterable resolution (Phase 7.3)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-for-of-call-expr'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes with competing save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in for-of getUsers() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in for-of getRepos() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongSave).toBeUndefined();
  });

  it('does NOT resolve repo.save() to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('user.ts'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution (1-level)
// ---------------------------------------------------------------------------

describe('Field type resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'field-types'), () => {});
    },
    { timeout: 60000 },
  );

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
// Phase 8: Field type disambiguation — both User and Address have save()
// ---------------------------------------------------------------------------

describe('Field type disambiguation (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-field-type-disambig'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects both User#save and Address#save', () => {
    const methods = getNodesByLabel(result, 'Method');
    const saveMethods = methods.filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.address.save() → Address#save (not User#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('address');
    expect(saveCalls[0].targetFilePath).not.toContain('user');
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Parameter properties and #private fields
// ---------------------------------------------------------------------------

describe('Field type resolution (TS parameter properties)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-param-property-fields'), () => {});
    },
    { timeout: 60000 },
  );

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

  it('resolves user.address.save() via parameter property type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// Phase 8A: Deep field chain resolution (3-level: user.address.city.getName())
// ---------------------------------------------------------------------------

describe('Deep field chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-deep-field-chain'), () => {});
    },
    { timeout: 60000 },
  );

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
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves 3-level chain: user.address.city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter((e) => e.target === 'getName' && e.source === 'processUser');
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// Mixed chain resolution (field ↔ call interleaved)
// ---------------------------------------------------------------------------

describe('Mixed field+call chain resolution (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-mixed-chain'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects classes: Address, City, User, UserService', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'City', 'User', 'UserService']);
  });

  it('detects Property node for Address.city field', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('city');
    expect(properties).toContain('address');
  });

  it('resolves call→field chain: svc.getUser().address.save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'processWithService');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('models');
  });

  it('resolves field→call chain: user.getAddress().city.getName() → City#getName', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCalls = calls.filter(
      (e) => e.target === 'getName' && e.source === 'processWithUser',
    );
    expect(getNameCalls.length).toBe(1);
    expect(getNameCalls[0].targetFilePath).toContain('models');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (TypeScript)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-write-access'), () => {});
    },
    { timeout: 60000 },
  );

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
// Call-result variable binding (Phase 9): const user = getUser(); user.save()
// Activates Tier 2b pendingCallResults — binds return type at TypeEnv build time.
// ---------------------------------------------------------------------------

describe('TypeScript call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-call-result-binding'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('detects getUser function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('resolves user.save() to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves alias.save() to User#save via call-result + copy chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processAlias' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): getUser() → .address → .getCity() → .save()
// Unified fixpoint resolves field access + method-call-with-receiver at TypeEnv build time.
// ---------------------------------------------------------------------------

describe('TypeScript method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-method-chain-binding'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User, Address, City classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Address');
    expect(classes).toContain('City');
  });

  it('resolves city.save() to City#save via 3-step chain (callResult → fieldAccess → methodCallResult)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processChain' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase A: Object destructuring — const { field } = receiver → fieldAccess PendingAssignment
// ---------------------------------------------------------------------------

describe('TypeScript object destructuring resolution (Phase A)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-object-destructuring'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User, Address classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Address');
  });

  it('resolves address.save() to Address#save via object destructuring', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('models'));
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve save() to a wrong target', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    for (const call of saveCalls) {
      expect(call.targetFilePath).toContain('models');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase A: Post-fixpoint for-loop replay — iterable resolved via callResult fixpoint
// Differs from ts-for-of-call-expression: iterable is an identifier, not inline call
// ---------------------------------------------------------------------------

describe('TypeScript post-fixpoint for-loop replay (Phase A ex-9B)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-fixpoint-for-loop'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves u.save() to User#save via post-fixpoint for-loop replay', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet() is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('TypeScript grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'ts-grandparent-resolution'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects 3 classes in inheritance chain (A, B, C) plus Greeting', () => {
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
      (c) => c.target === 'save' && c.targetFilePath.includes('greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves c.greet() to A#greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('base'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase C: TS null-check narrowing — if (x !== null) { x.save() }
// patternOverrides stores narrowed type for the if-body position range
// ---------------------------------------------------------------------------

describe('TypeScript null-check narrowing resolution (Phase C)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-null-check-narrowing'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves x.save() inside !== null guard to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processStrict' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve to Repo#save (no cross-contamination)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find((c) => c.target === 'save' && c.targetLabel === 'Repo');
    expect(wrongCall).toBeUndefined();
  });

  it('resolves x.save() in loose != null check (processLoose)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processLoose' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.save() in !== undefined check (processUndefined)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUndefined' &&
        c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves x.save() inside function expression null-check (processFuncExpr)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processFuncExpr' &&
        c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ── Phase P: Virtual Dispatch via Constructor Type ───────────────────────

describe('TypeScript virtual dispatch via constructor type (same-file)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-virtual-dispatch'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects Animal and Dog classes with same-file heritage', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('detects fetchBall() as Dog-only method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('fetchBall');
  });

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

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'ts-overload-disambiguation'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects lookup function with parameterTypes on graph node', () => {
    const functions = getNodesByLabelFull(result, 'Function');
    const lookupNodes = functions.filter((f) => f.name === 'lookup');
    // generateId collision → 1 graph node, first overload's parameterTypes wins
    expect(lookupNodes.length).toBeGreaterThanOrEqual(1);
    // At least one lookup node has parameterTypes set
    const withParamTypes = lookupNodes.filter((n) => n.properties.parameterTypes);
    expect(withParamTypes.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edges from process() → lookup() via overload disambiguation', () => {
    const calls = getRelationships(result, 'CALLS');
    const lookupCalls = calls.filter((c) => c.source === 'process' && c.target === 'lookup');
    // Phase 0 (fileIndex stores both overloads) + Phase 2 (literal type matching)
    // enables resolution where previously 2 same-arity candidates → null.
    // Both calls resolve to same nodeId (ID collision) → 1 CALLS edge after dedup.
    expect(lookupCalls.length).toBe(1);
  });
});
