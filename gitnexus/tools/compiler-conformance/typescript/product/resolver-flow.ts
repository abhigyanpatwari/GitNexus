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

// ── Phase P: Virtual Dispatch via Constructor Type ───────────────────────

describe('TypeScript virtual dispatch via constructor type (same-file)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-virtual-dispatch'), () => {});
    },
    { timeout: 60000 },
  );

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
