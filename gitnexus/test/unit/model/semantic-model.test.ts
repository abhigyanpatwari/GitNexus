/**
 * Unit tests for SemanticModel factory and lifecycle.
 *
 * Focused on behaviors that are NOT covered by the transitive
 * ingestion-pipeline tests in symbol-table.test.ts:
 *
 *   1. model.symbols.clear() must cascade to the owner-scoped registries.
 *      Otherwise, any caller holding a SymbolTable reference that invokes
 *      .clear() directly leaves registries populated while file and
 *      callable indexes are empty — creating phantom-resolution state.
 *
 *   2. model.clear() must cascade to all four stores (types, methods,
 *      fields, rawSymbols). Regression guard for the existing cascade.
 *
 *   3. createSemanticModel() must construct successfully against the
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

describe('model.symbols.clear() cascade', () => {
  it('clears the type registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');

    expect(model.types.lookupClassByName('User')).toHaveLength(1);

    model.symbols.clear();

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

    model.symbols.clear();

    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
  });

  it('clears the method registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
    });

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeDefined();

    model.symbols.clear();

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
  });

  it('clears the file and callable indexes', () => {
    const model = createSemanticModel();
    model.symbols.add('src/utils.ts', 'format', 'fn:format', 'Function');

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(1);
    expect(model.symbols.getFiles()).toContain('src/utils.ts');

    model.symbols.clear();

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(0);
    expect(model.symbols.getFiles()).not.toContain('src/utils.ts');
  });

  it('is idempotent — calling twice leaves every store empty', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
    });

    model.symbols.clear();
    model.symbols.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(model.symbols.lookupCallableByName('User')).toHaveLength(0);
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
    expect(model.symbols.getFiles()).not.toContain('src/user.ts');
  });
});
