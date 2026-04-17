/**
 * Unit tests for SemanticModel factory and lifecycle.
 *
 * Focused on behaviors that are NOT covered by the transitive
 * ingestion-pipeline tests in symbol-table.test.ts:
 *
 *   1. model.clear() must cascade to all four stores (types, methods,
 *      fields, rawSymbols). Post-A2 (plan 006 Unit 7), this is the only
 *      path that resets the leaf AND the registries. External consumers
 *      hold a SymbolTableReader which has no `clear()` method, so the
 *      phantom-resolution failure mode is statically impossible.
 *
 *   2. createSemanticModel() must construct successfully against the
 *      real ALL_NODE_LABELS and current registration-table allowlists.
 *      A failure here means the dev-time exhaustiveness guard is
 *      flagging real drift that needs a registration-table fix.
 */

import { describe, it, expect } from 'vitest';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';

describe('createSemanticModel', () => {
  it('constructs successfully — no drift between ALL_NODE_LABELS and the registration-table allowlists', () => {
    expect(() => createSemanticModel()).not.toThrow();
  });
});

describe('model.clear() cascade (A2 / Unit 7)', () => {
  it('clears the type registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');

    expect(model.types.lookupClassByName('User')).toHaveLength(1);

    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
  });

  it('clears the field registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
      declaredType: 'string',
    });

    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeDefined();

    model.clear();

    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
  });

  it('clears the method registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
    });

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeDefined();

    model.clear();

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
  });

  it('clears the file and callable indexes', () => {
    const model = createSemanticModel();
    model.symbols.add('src/utils.ts', 'format', 'fn:format', 'Function');

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(1);
    expect(Array.from(model.symbols.getFiles())).toContain('src/utils.ts');

    model.clear();

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(0);
    expect(Array.from(model.symbols.getFiles())).not.toContain('src/utils.ts');
  });

  it('is idempotent — calling twice leaves every store empty', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
    });

    model.clear();
    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(model.symbols.lookupCallableByName('User')).toHaveLength(0);
  });

  it('post-A2: model.symbols exposes no clear() method', () => {
    // Static guarantee enforced by the SymbolTableReader interface — this
    // runtime assertion documents the contract.
    const model = createSemanticModel();
    expect('clear' in model.symbols).toBe(false);
  });
});

describe('model.clear() cascade', () => {
  it('clears every store — types, methods, fields, symbols', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
    });
    model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
    });

    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
    expect(model.symbols.lookupCallableByName('User')).toHaveLength(0);
    expect(Array.from(model.symbols.getFiles())).not.toContain('src/user.ts');
  });
});
