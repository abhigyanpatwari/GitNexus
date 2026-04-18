/**
 * Unit tests for FieldRegistry (SM-20).
 *
 * FieldRegistry is the simplest of the three owner-scoped registries —
 * one flat Map keyed on `ownerNodeId\0fieldName`. These tests pin the
 * basic register/lookup/clear contract and the owner-scope isolation.
 */

import { describe, it, expect } from 'vitest';
import { createFieldRegistry } from '../../../src/core/ingestion/model/field-registry.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { makeDef as makeBaseDef } from './helpers.js';

const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition =>
  makeBaseDef({ nodeId: 'prop:test', type: 'Property', ...overrides });

describe('FieldRegistry', () => {
  it('lookupFieldByOwner returns undefined when the registry is empty', () => {
    const reg = createFieldRegistry();
    expect(reg.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
  });

  it('register + lookup round-trips the exact def reference', () => {
    const reg = createFieldRegistry();
    const def = makeDef({ nodeId: 'prop:User.name', declaredType: 'string' });

    reg.register('class:User', 'name', def);

    expect(reg.lookupFieldByOwner('class:User', 'name')).toBe(def);
  });

  it('isolates fields by ownerNodeId — same field name on two classes does not collide', () => {
    const reg = createFieldRegistry();
    const userName = makeDef({ nodeId: 'prop:User.name' });
    const orderName = makeDef({ nodeId: 'prop:Order.name' });

    reg.register('class:User', 'name', userName);
    reg.register('class:Order', 'name', orderName);

    expect(reg.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:User.name');
    expect(reg.lookupFieldByOwner('class:Order', 'name')?.nodeId).toBe('prop:Order.name');
  });

  it('last-wins on duplicate (ownerNodeId, fieldName) — registry is flat, not an overload list', () => {
    const reg = createFieldRegistry();
    const first = makeDef({ nodeId: 'prop:User.name#first' });
    const second = makeDef({ nodeId: 'prop:User.name#second' });

    reg.register('class:User', 'name', first);
    reg.register('class:User', 'name', second);

    expect(reg.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:User.name#second');
  });

  it('clear() empties the registry', () => {
    const reg = createFieldRegistry();
    reg.register('class:User', 'name', makeDef());
    reg.register('class:Order', 'total', makeDef());

    reg.clear();

    expect(reg.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(reg.lookupFieldByOwner('class:Order', 'total')).toBeUndefined();
  });

  it('allows re-registration after clear', () => {
    const reg = createFieldRegistry();
    reg.register('class:User', 'name', makeDef({ nodeId: 'prop:first' }));
    reg.clear();
    reg.register('class:User', 'name', makeDef({ nodeId: 'prop:second' }));

    expect(reg.lookupFieldByOwner('class:User', 'name')?.nodeId).toBe('prop:second');
  });
});
