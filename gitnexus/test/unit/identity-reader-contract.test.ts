import { describe, expectTypeOf, it } from 'vitest';
import type { forEachQueryRow } from '../../src/core/lbug/lbug-adapter.js';
import type { reconcileGraphNodeIdentities } from '../../src/core/incremental/write-reconciliation.js';

type CursorVisitor = Parameters<typeof forEachQueryRow>[1];
type IdentityReader = Parameters<typeof reconcileGraphNodeIdentities>[1];
type IdentityVisitor = Parameters<IdentityReader>[1];

describe('identity reader synchronous visitor contract', () => {
  it('accepts synchronous visitors and rejects async visitors at both boundaries', () => {
    expectTypeOf<() => undefined>().toExtend<CursorVisitor>();
    expectTypeOf<() => undefined>().toExtend<IdentityVisitor>();
    expectTypeOf<() => Promise<void>>().not.toExtend<CursorVisitor>();
    expectTypeOf<() => Promise<void>>().not.toExtend<IdentityVisitor>();
  });
});
