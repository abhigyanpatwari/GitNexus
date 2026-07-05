/**
 * Unit tests for the reconciliation pass and parity validator that
 * bridge scope-resolution's post-`populateOwners` ownership view into
 * `SemanticModel` (Contract Invariant I9).
 *
 * The reconciliation pass is the load-bearing shim that lets scope-
 * resolution passes consume `SemanticModel` as the single authoritative
 * owner-keyed index even when the legacy parse phase emitted class-body
 * callables without `ownerId` (e.g. Python).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import {
  reconcileOwnership,
  validateOwnershipParity,
} from '../../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────

const mkFile = (filePath: string, localDefs: readonly SymbolDefinition[]): ParsedFile => ({
  filePath,
  moduleScope: `scope:${filePath}#module`,
  scopes: [],
  parsedImports: [],
  localDefs,
  referenceSites: [],
});

const mkMethod = (opts: {
  nodeId: string;
  filePath: string;
  name: string;
  ownerId?: string;
  type?: 'Method' | 'Function' | 'Constructor';
}): SymbolDefinition => ({
  nodeId: opts.nodeId,
  filePath: opts.filePath,
  type: opts.type ?? 'Method',
  qualifiedName: opts.ownerId ? `${opts.ownerId.replace('def:', '')}.${opts.name}` : opts.name,
  ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
});

const mkProperty = (opts: {
  nodeId: string;
  filePath: string;
  name: string;
  ownerId: string;
  type?: 'Property' | 'Variable';
}): SymbolDefinition => ({
  nodeId: opts.nodeId,
  filePath: opts.filePath,
  type: opts.type ?? 'Property',
  qualifiedName: `${opts.ownerId.replace('def:', '')}.${opts.name}`,
  ownerId: opts.ownerId,
});

// ─── reconcileOwnership ────────────────────────────────────────────────────

describe('reconcileOwnership', () => {
  it('registers a method with ownerId that the legacy extractor missed', () => {
    const model = createSemanticModel();
    const save = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [save]);

    const stats = reconcileOwnership([file], model);

    expect(stats.methodsRegistered).toBe(1);
    expect(stats.fieldsRegistered).toBe(0);
    expect(stats.skippedAlreadyPresent).toBe(0);
    expect(model.methods.lookupAllByOwner('def:User', 'save')).toHaveLength(1);
    expect(model.methods.lookupAllByOwner('def:User', 'save')[0]).toBe(save);
  });

  it('registers a property under FieldRegistry', () => {
    const model = createSemanticModel();
    const nameProp = mkProperty({
      nodeId: 'def:User.name',
      filePath: 'models.py',
      name: 'name',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [nameProp]);

    const stats = reconcileOwnership([file], model);

    expect(stats.fieldsRegistered).toBe(1);
    expect(stats.methodsRegistered).toBe(0);
    expect(model.fields.lookupFieldByOwner('def:User', 'name')).toBe(nameProp);
  });

  it('registers a Variable type as a field (Python class-body assignments)', () => {
    const model = createSemanticModel();
    const attr = mkProperty({
      nodeId: 'def:User.tag',
      filePath: 'models.py',
      name: 'tag',
      ownerId: 'def:User',
      type: 'Variable',
    });
    const file = mkFile('models.py', [attr]);

    reconcileOwnership([file], model);

    expect(model.fields.lookupFieldByOwner('def:User', 'tag')).toBe(attr);
  });

  it('registers Const and Static owned members into FieldRegistry', () => {
    const model = createSemanticModel();
    const maxConst = mkProperty({
      nodeId: 'def:User.MAX',
      filePath: 'models.py',
      name: 'MAX',
      ownerId: 'def:User',
      type: 'Const',
    });
    const counter = mkProperty({
      nodeId: 'def:User.counter',
      filePath: 'models.py',
      name: 'counter',
      ownerId: 'def:User',
      type: 'Static',
    });
    const file = mkFile('models.py', [maxConst, counter]);

    const stats = reconcileOwnership([file], model);

    expect(stats.fieldsRegistered).toBe(2);
    expect(model.fields.lookupAllByOwner('def:User', 'MAX')).toEqual([maxConst]);
    expect(model.fields.lookupAllByOwner('def:User', 'counter')).toEqual([counter]);
  });

  it('keeps distinct field-kind defs that share (ownerId, simpleName)', () => {
    const model = createSemanticModel();
    const legacyProp = mkProperty({
      nodeId: 'prop:User.name',
      filePath: 'models.py',
      name: 'name',
      ownerId: 'def:User',
      type: 'Property',
    });
    const reconciledVar = mkProperty({
      nodeId: 'def:User.name',
      filePath: 'models.py',
      name: 'name',
      ownerId: 'def:User',
      type: 'Variable',
    });
    const file = mkFile('models.py', [legacyProp, reconciledVar]);

    reconcileOwnership([file], model);

    expect(model.fields.lookupAllByOwner('def:User', 'name')).toEqual([legacyProp, reconciledVar]);
  });

  it('skips defs without ownerId (top-level functions)', () => {
    const model = createSemanticModel();
    const topLevel = mkMethod({
      nodeId: 'def:helper',
      filePath: 'utils.py',
      name: 'helper',
      type: 'Function',
    });
    const file = mkFile('utils.py', [topLevel]);

    const stats = reconcileOwnership([file], model);

    expect(stats.methodsRegistered).toBe(0);
    expect(model.methods.lookupAllByOwner('def:something', 'helper')).toEqual([]);
  });

  it('is idempotent — re-running skips defs already registered', () => {
    const model = createSemanticModel();
    const save = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [save]);

    const first = reconcileOwnership([file], model);
    const second = reconcileOwnership([file], model);

    expect(first.methodsRegistered).toBe(1);
    expect(second.methodsRegistered).toBe(0);
    expect(second.skippedAlreadyPresent).toBe(1);
    // Registry still contains exactly one entry, not two.
    expect(model.methods.lookupAllByOwner('def:User', 'save')).toHaveLength(1);
  });

  it('coexists with pre-registered defs (legacy extractor already set ownerId)', () => {
    const model = createSemanticModel();
    // Simulate the legacy path: register via SymbolTable.add, which
    // fans out to MethodRegistry via the dispatch table.
    const save = model.symbols.add('models.cs', 'save', 'def:User.save', 'Method', {
      ownerId: 'def:User',
      qualifiedName: 'User.save',
    });
    const file = mkFile('models.cs', [save]);

    const stats = reconcileOwnership([file], model);

    expect(stats.methodsRegistered).toBe(0);
    expect(stats.skippedAlreadyPresent).toBe(1);
    expect(model.methods.lookupAllByOwner('def:User', 'save')).toHaveLength(1);
  });

  it('preserves deleted-callable metadata when the worker def is already registered', () => {
    const model = createSemanticModel();
    model.symbols.add('models.cpp', 'touch', 'Method:models.cpp:Gadget.touch', 'Method', {
      ownerId: 'def:Gadget',
      qualifiedName: 'Gadget.touch',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['double'],
    });
    const deleted = {
      ...mkMethod({
        nodeId: 'def:models.cpp#3:2:Method:touch',
        filePath: 'models.cpp',
        name: 'touch',
        ownerId: 'def:Gadget',
      }),
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['double'],
      isDeleted: true,
    };

    const stats = reconcileOwnership([mkFile('models.cpp', [deleted])], model);
    const registered = model.methods.lookupAllByOwner('def:Gadget', 'touch');

    expect(stats.skippedAlreadyPresent).toBe(1);
    expect(registered).toHaveLength(1);
    expect(registered[0].isDeleted).toBe(true);
  });

  it('preserves deleted metadata for unowned free-function overloads', () => {
    const model = createSemanticModel();
    model.symbols.add('helpers.cpp', 'choose', 'Function:helpers.cpp:choose#int', 'Function', {
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['int'],
    });
    const deleted: SymbolDefinition = {
      nodeId: 'def:helpers.cpp#4:0:Function:choose',
      filePath: 'helpers.cpp',
      type: 'Function',
      qualifiedName: 'choose',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['int'],
      isDeleted: true,
    };

    const stats = reconcileOwnership([mkFile('helpers.cpp', [deleted])], model);
    const registered = model.symbols.lookupCallableByName('choose');

    expect(stats.skippedAlreadyPresent).toBe(1);
    expect(registered).toHaveLength(1);
    expect(registered[0].isDeleted).toBe(true);
  });

  it('registers nested class-like types (Class/Enum/Interface) into TypeRegistry by owner', () => {
    const model = createSemanticModel();
    const inner: SymbolDefinition = {
      nodeId: 'def:Outer.Inner',
      filePath: 'm.ts',
      type: 'Class',
      qualifiedName: 'Outer.Inner',
      ownerId: 'def:Outer',
    };
    const status: SymbolDefinition = {
      nodeId: 'def:Outer.Status',
      filePath: 'm.ts',
      type: 'Enum',
      qualifiedName: 'Outer.Status',
      ownerId: 'def:Outer',
    };
    const visitor: SymbolDefinition = {
      nodeId: 'def:Outer.Visitor',
      filePath: 'm.ts',
      type: 'Interface',
      qualifiedName: 'Outer.Visitor',
      ownerId: 'def:Outer',
    };
    const file = mkFile('m.ts', [inner, status, visitor]);

    const stats = reconcileOwnership([file], model);

    expect(stats.nestedTypesRegistered).toBe(3);
    expect(stats.methodsRegistered).toBe(0);
    expect(stats.fieldsRegistered).toBe(0);
    expect(model.types.lookupAllByOwner('def:Outer', 'Inner')).toEqual([inner]);
    expect(model.types.lookupAllByOwner('def:Outer', 'Status')).toEqual([status]);
    expect(model.types.lookupAllByOwner('def:Outer', 'Visitor')).toEqual([visitor]);
  });

  it('is idempotent for nested type registration', () => {
    const model = createSemanticModel();
    const inner: SymbolDefinition = {
      nodeId: 'def:Outer.Inner',
      filePath: 'm.ts',
      type: 'Class',
      qualifiedName: 'Outer.Inner',
      ownerId: 'def:Outer',
    };
    const file = mkFile('m.ts', [inner]);

    const first = reconcileOwnership([file], model);
    const second = reconcileOwnership([file], model);

    expect(first.nestedTypesRegistered).toBe(1);
    expect(second.nestedTypesRegistered).toBe(0);
    expect(second.skippedAlreadyPresent).toBe(1);
    expect(model.types.lookupAllByOwner('def:Outer', 'Inner')).toHaveLength(1);
  });

  it('registers multiple overloads under the same (owner, name)', () => {
    const model = createSemanticModel();
    const log1 = mkMethod({
      nodeId: 'def:Logger.log#1',
      filePath: 'log.cs',
      name: 'log',
      ownerId: 'def:Logger',
    });
    const log2 = mkMethod({
      nodeId: 'def:Logger.log#2',
      filePath: 'log.cs',
      name: 'log',
      ownerId: 'def:Logger',
    });
    const file = mkFile('log.cs', [log1, log2]);

    reconcileOwnership([file], model);

    const overloads = model.methods.lookupAllByOwner('def:Logger', 'log');
    expect(overloads).toHaveLength(2);
    expect(overloads.map((d) => d.nodeId).sort()).toEqual(['def:Logger.log#1', 'def:Logger.log#2']);
  });
});

// ─── validateOwnershipParity ───────────────────────────────────────────────

describe('validateOwnershipParity', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGate = process.env.VALIDATE_SEMANTIC_MODEL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalGate === undefined) delete process.env.VALIDATE_SEMANTIC_MODEL;
    else process.env.VALIDATE_SEMANTIC_MODEL = originalGate;
  });

  it('emits no warnings when reconciliation has populated all owner-keyed defs', () => {
    process.env.NODE_ENV = 'development';
    const model = createSemanticModel();
    const save = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [save]);
    reconcileOwnership([file], model);

    const onWarn = vi.fn();
    const mismatches = validateOwnershipParity([file], model, onWarn);

    expect(mismatches).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns when a def with ownerId is not registered in the model', () => {
    process.env.NODE_ENV = 'development';
    const model = createSemanticModel();
    const orphan = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [orphan]);
    // Intentionally skip reconciliation to simulate the drift.

    const onWarn = vi.fn();
    const mismatches = validateOwnershipParity([file], model, onWarn);

    expect(mismatches).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/semantic-model parity/);
    expect(onWarn.mock.calls[0][0]).toMatch(/MethodRegistry/);
  });

  it('is a no-op when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    const model = createSemanticModel();
    const orphan = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [orphan]);

    const onWarn = vi.fn();
    const mismatches = validateOwnershipParity([file], model, onWarn);

    expect(mismatches).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('is a no-op when VALIDATE_SEMANTIC_MODEL=0', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATE_SEMANTIC_MODEL = '0';
    const model = createSemanticModel();
    const orphan = mkMethod({
      nodeId: 'def:User.save',
      filePath: 'models.py',
      name: 'save',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [orphan]);

    const onWarn = vi.fn();
    validateOwnershipParity([file], model, onWarn);

    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns on missing Property just like missing Method', () => {
    process.env.NODE_ENV = 'development';
    const model = createSemanticModel();
    const orphan = mkProperty({
      nodeId: 'def:User.name',
      filePath: 'models.py',
      name: 'name',
      ownerId: 'def:User',
    });
    const file = mkFile('models.py', [orphan]);

    const onWarn = vi.fn();
    const mismatches = validateOwnershipParity([file], model, onWarn);

    expect(mismatches).toBe(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/FieldRegistry/);
  });
});
