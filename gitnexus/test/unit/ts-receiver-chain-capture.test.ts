/**
 * U5 — TypeScript emits `@reference.receiver-chain` for a receiver that is
 * itself an expression.
 *
 * Capture-level, not resolution-level: nothing consumes the field yet, so these
 * assert what is written, and that nothing extra is.
 */

import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../src/core/ingestion/languages/typescript/index.js';

/** The chain captures produced for a source, keyed by the member being called. */
function chainsFor(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of emitTsScopeCaptures(src, 'main.ts')) {
    const chain = match['@reference.receiver-chain'];
    const name = match['@reference.name'];
    if (chain === undefined || name === undefined) continue;
    out[name.text] = chain.text;
  }
  return out;
}

const MODELS = `class Address { save(): void {} }
class User { name = ''; address = new Address(); save(): void {} }
class Service {
  getUser(): User { return new User(); }
  getTyped<T>(): User { return new User(); }
}
declare const svc: Service;
declare const repos: User[];
`;

describe('TypeScript receiver-chain capture', () => {
  it('emits a chain for a plain call-chain receiver', () => {
    expect(chainsFor(`${MODELS}\nsvc.getUser().save();\n`)).toMatchObject({
      save: '2|svc|cgetUser',
    });
  });

  it('emits a mixed call/field chain base-first', () => {
    expect(chainsFor(`${MODELS}\nsvc.getUser().address.save();\n`)).toMatchObject({
      save: '2|svc|cgetUser|faddress',
    });
  });

  it('emits a chain for an optional-chained receiver — one of the shapes that resolves to nothing today', () => {
    expect(chainsFor(`${MODELS}\nsvc?.getUser().save();\n`)).toMatchObject({
      save: '2|svc|cgetUser',
    });
  });

  it('emits a chain for an explicit-type-argument receiver', () => {
    expect(chainsFor(`${MODELS}\nsvc.getTyped<User>().save();\n`)).toMatchObject({
      save: '2|svc|cgetTyped',
    });
  });

  it('emits no chain for a bare-name receiver — there is nothing to fold', () => {
    expect(chainsFor(`${MODELS}\nconst u = new User();\nu.save();\n`)).toEqual({});
  });

  it('emits no chain for a property read or write receiver (CALL_TAGS gate)', () => {
    // Without the gate these pay the walk and the bytes for a field no
    // call-site resolver reads.
    const chains = chainsFor(
      `${MODELS}\nsvc.getUser().name = 'x';\nconst n = svc.getUser().name;\n`,
    );
    expect(chains).not.toHaveProperty('name');
  });

  it('emits a plain string payload, so the capture stays structured-clone safe', () => {
    const chains = chainsFor(`${MODELS}\nsvc.getUser().save();\n`);
    expect(typeof chains.save).toBe('string');
  });

  it('emits NO chain past MAX_CHAIN_DEPTH rather than a truncated one', () => {
    // `extractMixedChain` reports no base receiver when it stops early, and a
    // partial chain is missing exactly the head that decides the final type —
    // encoding it would turn an untypeable receiver into a wrongly-typed one.
    const deep = `${MODELS}
class C5 { e(): C5 { return this; } f(): void {} }
declare const a: C5;
a.e().e().e().e().f();
`;
    expect(chainsFor(deep)).not.toHaveProperty('f');
  });
});
