import { describe, it, expect } from 'vitest';
import {
  createRegistrationTable,
  CALLABLE_ONLY_LABELS,
  INERT_LABELS,
  DISPATCH_LABELS,
} from '../../../src/core/ingestion/model/registration-table.js';
import { createTypeRegistry } from '../../../src/core/ingestion/model/type-registry.js';
import { createMethodRegistry } from '../../../src/core/ingestion/model/method-registry.js';
import { createFieldRegistry } from '../../../src/core/ingestion/model/field-registry.js';
import { ALL_NODE_LABELS } from '../../../src/core/ingestion/model/index.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { makeDef as makeBaseDef } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDeps = () => ({
  types: createTypeRegistry(),
  methods: createMethodRegistry(),
  fields: createFieldRegistry(),
});

const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition =>
  makeBaseDef({ nodeId: 'node:test', type: 'Class', ...overrides });

// ---------------------------------------------------------------------------
// Basic factory + table shape
// ---------------------------------------------------------------------------

describe('createRegistrationTable', () => {
  it('returns a Map with one entry per DISPATCH_LABELS value', () => {
    const table = createRegistrationTable(makeDeps());
    expect(table.size).toBe(DISPATCH_LABELS.size);
    for (const label of DISPATCH_LABELS) {
      expect(table.has(label)).toBe(true);
    }
  });

  it('every DISPATCH_LABELS entry maps to a hook function', () => {
    const table = createRegistrationTable(makeDeps());
    for (const [, hook] of table) {
      expect(typeof hook).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// Kind taxonomy exhaustiveness
// ---------------------------------------------------------------------------

describe('NodeLabel taxonomy coverage', () => {
  // ALL_NODE_LABELS is imported from model/index.ts (re-exported from
  // semantic-model.ts) so that the production list and the test list
  // cannot drift. If the shared NodeLabel union gains a new member, add
  // it to the single list in semantic-model.ts AND to one of the
  // registration-table allowlists in the same commit.

  it('every NodeLabel appears in exactly one of DISPATCH / CALLABLE_ONLY / INERT', () => {
    for (const label of ALL_NODE_LABELS) {
      const inDispatch = DISPATCH_LABELS.has(label);
      const inCallableOnly = CALLABLE_ONLY_LABELS.has(label);
      const inInert = INERT_LABELS.has(label);
      const count = Number(inDispatch) + Number(inCallableOnly) + Number(inInert);
      expect(count, `label ${label} must be in exactly one category`).toBe(1);
    }
  });

  it('CALLABLE_ONLY_LABELS includes Function, Macro, Delegate', () => {
    expect(CALLABLE_ONLY_LABELS.has('Function')).toBe(true);
    expect(CALLABLE_ONLY_LABELS.has('Macro')).toBe(true);
    expect(CALLABLE_ONLY_LABELS.has('Delegate')).toBe(true);
  });

  it('DISPATCH_LABELS includes all 10 routed kinds', () => {
    const expected = [
      'Class',
      'Struct',
      'Interface',
      'Enum',
      'Record',
      'Trait',
      'Method',
      'Constructor',
      'Property',
      'Impl',
    ] as const;
    for (const label of expected) {
      expect(DISPATCH_LABELS.has(label)).toBe(true);
    }
    expect(DISPATCH_LABELS.size).toBe(expected.length);
  });

  it('INERT_LABELS includes metadata-only node kinds', () => {
    expect(INERT_LABELS.has('File')).toBe(true);
    expect(INERT_LABELS.has('Folder')).toBe(true);
    expect(INERT_LABELS.has('Namespace')).toBe(true);
    expect(INERT_LABELS.has('Variable')).toBe(true);
    expect(INERT_LABELS.has('Import')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavior group coverage — every label in a behavior group routes to the
// group's registry write, regardless of how hooks are implemented (shared
// closure, per-label closure, etc.). These tests survive an internal
// refactor to per-label closures for tracing/metrics — unlike
// reference-equality assertions on the hook functions themselves.
// ---------------------------------------------------------------------------

describe('class-like behavior group — all 6 labels route to types.registerClass', () => {
  const CLASS_LIKE_LABELS = ['Class', 'Struct', 'Interface', 'Enum', 'Record', 'Trait'] as const;

  for (const label of CLASS_LIKE_LABELS) {
    it(`${label} writes to types.registerClass`, () => {
      const deps = makeDeps();
      const table = createRegistrationTable(deps);
      const def = makeDef({
        nodeId: `${label.toLowerCase()}:User`,
        type: label,
        qualifiedName: `app.User`,
      });
      table.get(label)!('User', def);
      expect(deps.types.lookupClassByName('User')).toHaveLength(1);
    });
  }
});

describe('method-like behavior group — Method and Constructor route to methods.register', () => {
  for (const label of ['Method', 'Constructor'] as const) {
    it(`${label} writes to methods.register when ownerId is set`, () => {
      const deps = makeDeps();
      const table = createRegistrationTable(deps);
      const def = makeDef({
        nodeId: `${label.toLowerCase()}:save`,
        type: label,
        ownerId: 'class:User',
      });
      table.get(label)!('save', def);
      expect(deps.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe(
        `${label.toLowerCase()}:save`,
      );
    });
  }
});

describe('behavior group isolation', () => {
  it('class-like hooks never touch methods or fields', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({
      nodeId: 'class:User',
      type: 'Class',
      ownerId: 'unrelated',
    });
    table.get('Class')!('User', def);
    // No method or field registered — class hook is isolated to types.
    expect(deps.methods.lookupMethodByOwner('unrelated', 'User')).toBeUndefined();
    expect(deps.fields.lookupFieldByOwner('unrelated', 'User')).toBeUndefined();
  });

  it('Impl hooks write to types.registerImpl, never to types.registerClass', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'impl:User', type: 'Impl' });
    table.get('Impl')!('User', def);
    expect(deps.types.lookupImplByName('User')).toHaveLength(1);
    expect(deps.types.lookupClassByName('User')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end hook behavior with real registries
// ---------------------------------------------------------------------------

describe('hook behavior (real registries, no mocks)', () => {
  it('classLikeHook writes to types.registerClass', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'class:User', type: 'Class', qualifiedName: 'app.User' });
    table.get('Class')!('User', def);
    expect(deps.types.lookupClassByName('User')).toHaveLength(1);
    expect(deps.types.lookupClassByQualifiedName('app.User')).toHaveLength(1);
  });

  it('classLikeHook falls back to the simple name when qualifiedName is absent', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'class:User', type: 'Class' });
    table.get('Class')!('User', def);
    expect(deps.types.lookupClassByQualifiedName('User')).toHaveLength(1);
  });

  it('methodHook writes to methods.register when ownerId is set', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({
      nodeId: 'mtd:save',
      type: 'Method',
      ownerId: 'class:User',
    });
    table.get('Method')!('save', def);
    expect(deps.methods.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('mtd:save');
  });

  it('methodHook silently skips registration when ownerId is missing', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'mtd:free', type: 'Method' });
    table.get('Method')!('free', def);
    expect(deps.methods.lookupMethodByOwner('', 'free')).toBeUndefined();
  });

  it('propertyHook writes to fields.register when ownerId is set', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({
      nodeId: 'prop:name',
      type: 'Property',
      ownerId: 'class:User',
      declaredType: 'string',
    });
    table.get('Property')!('name', def);
    expect(deps.fields.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:name');
  });

  it('propertyHook silently skips registration when ownerId is missing', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'prop:orphan', type: 'Property' });
    table.get('Property')!('orphan', def);
    expect(deps.fields.lookupFieldByOwner('', 'orphan')).toBeUndefined();
  });

  it('implHook writes to types.registerImpl, NOT types.registerClass', () => {
    const deps = makeDeps();
    const table = createRegistrationTable(deps);
    const def = makeDef({ nodeId: 'impl:User', type: 'Impl' });
    table.get('Impl')!('User', def);
    expect(deps.types.lookupImplByName('User')).toHaveLength(1);
    // Critical: Impl must not pollute classByName — heritage resolution
    // would otherwise treat an Impl as a parent type candidate.
    expect(deps.types.lookupClassByName('User')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Factory-per-instance isolation
// ---------------------------------------------------------------------------

describe('factory-per-instance isolation', () => {
  it('two independent tables write to their own registries only', () => {
    const depsA = makeDeps();
    const depsB = makeDeps();
    const tableA = createRegistrationTable(depsA);
    const tableB = createRegistrationTable(depsB);

    tableA.get('Class')!('UserA', makeDef({ nodeId: 'class:UserA', type: 'Class' }));
    tableB.get('Class')!('UserB', makeDef({ nodeId: 'class:UserB', type: 'Class' }));

    expect(depsA.types.lookupClassByName('UserA')).toHaveLength(1);
    expect(depsA.types.lookupClassByName('UserB')).toHaveLength(0);
    expect(depsB.types.lookupClassByName('UserB')).toHaveLength(1);
    expect(depsB.types.lookupClassByName('UserA')).toHaveLength(0);
  });
});
