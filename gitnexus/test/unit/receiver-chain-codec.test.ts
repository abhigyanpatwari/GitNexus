/**
 * Receiver-chain wire format. The emitter, the resolver fold and the untrusted
 * store boundary all read this format, so a decode that accepts something the
 * encoder cannot mint — or vice versa — is a silent divergence between what is
 * written and what is trusted.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_RECEIVER_CHAIN_BYTES,
  decodeReceiverChain,
  encodeReceiverChain,
  isValidReceiverChain,
} from '../../src/core/ingestion/utils/receiver-chain-codec.js';
import { MAX_CHAIN_DEPTH } from '../../src/core/ingestion/utils/call-analysis.js';

describe('receiver-chain codec', () => {
  it('round-trips a mixed call/field chain base-first', () => {
    const encoded = encodeReceiverChain('svc', [
      { kind: 'call', name: 'getUser' },
      { kind: 'field', name: 'address' },
    ]);
    expect(encoded).toBe('2|svc|cgetUser|faddress');
    expect(decodeReceiverChain(encoded)).toEqual({
      baseReceiverName: 'svc',
      steps: [
        { kind: 'call', name: 'getUser' },
        { kind: 'field', name: 'address' },
      ],
      truncated: false,
    });
  });

  it('stays well under the U7 per-site byte threshold for a realistic chain', () => {
    // The gate is <= 48 serialized bytes per emitting site, set so an object
    // encoding fails and this one passes.
    expect(encodeReceiverChain('svc', [{ kind: 'call', name: 'getUser' }])!.length).toBeLessThan(
      48,
    );
  });

  it('needs no escaping for a member whose name starts with a kind sigil', () => {
    expect(
      decodeReceiverChain(encodeReceiverChain('a', [{ kind: 'call', name: 'count' }])),
    ).toEqual({
      baseReceiverName: 'a',
      steps: [{ kind: 'call', name: 'count' }],
      truncated: false,
    });
    expect(
      decodeReceiverChain(encodeReceiverChain('a', [{ kind: 'field', name: 'field' }])),
    ).toEqual({
      baseReceiverName: 'a',
      steps: [{ kind: 'field', name: 'field' }],
      truncated: false,
    });
  });

  it('marks a truncated chain, because its missing tail is what decides the type', () => {
    const encoded = encodeReceiverChain('svc', [{ kind: 'call', name: 'getUser' }], {
      truncated: true,
    });
    expect(encoded).toBe('2|svc|cgetUser|~');
    expect(decodeReceiverChain(encoded)).toMatchObject({ truncated: true });
  });

  it('refuses to mint an empty chain — there is nothing to fold', () => {
    expect(encodeReceiverChain('svc', [])).toBeUndefined();
  });

  it('refuses to mint beyond MAX_CHAIN_DEPTH rather than silently dropping a step', () => {
    const steps = Array.from({ length: MAX_CHAIN_DEPTH + 1 }, (_unused, i) => ({
      kind: 'call' as const,
      name: `m${i}`,
    }));
    expect(encodeReceiverChain('svc', steps)).toBeUndefined();
  });

  it('refuses to mint a name carrying a structural character, instead of escaping it', () => {
    expect(encodeReceiverChain('sv|c', [{ kind: 'call', name: 'getUser' }])).toBeUndefined();
    expect(encodeReceiverChain('svc', [{ kind: 'call', name: 'get~User' }])).toBeUndefined();
    expect(encodeReceiverChain('svc', [{ kind: 'call', name: 'get User' }])).toBeUndefined();
  });

  it('refuses to mint over the byte cap', () => {
    const huge = 'x'.repeat(MAX_RECEIVER_CHAIN_BYTES);
    expect(encodeReceiverChain('svc', [{ kind: 'call', name: huge }])).toBeUndefined();
  });

  it.each([
    ['not a string', 42],
    ['undefined', undefined],
    ['empty', ''],
    ['no version', 'svc|cgetUser'],
    ['unknown future version', '3|svc|cgetUser'],
    ['superseded v1 payload', '1|svc|cgetUser'],
    ['no steps', '2|svc'],
    ['unknown kind sigil', '2|svc|xgetUser'],
    ['empty step name', '2|svc|c'],
    ['empty base', '1||cgetUser'],
    ['over depth', '2|svc|ca|cb|cc|cd'],
    ['truncation marker only', '2|svc|~'],
  ])('decodes %s as undefined rather than throwing', (_label, payload) => {
    expect(decodeReceiverChain(payload)).toBeUndefined();
    expect(isValidReceiverChain(payload)).toBe(false);
  });

  it('refuses to mint a name carrying a zero-width character', () => {
    // `\s` does not match these, so without an explicit class they encode and
    // persist cleanly and then match no binding at resolution time — a silent,
    // unexplained miss, and a trojan-source vector.
    for (const invisible of ['\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\uFEFF']) {
      expect(
        encodeReceiverChain('svc', [{ kind: 'call', name: `get${invisible}User` }]),
      ).toBeUndefined();
      expect(
        encodeReceiverChain(`sv${invisible}c`, [{ kind: 'call', name: 'getUser' }]),
      ).toBeUndefined();
    }
  });

  it('round-trips a chain of exactly MAX_CHAIN_DEPTH steps', () => {
    // The refusal at MAX_CHAIN_DEPTH + 1 is pinned above; pin the boundary that
    // must still WORK, so a future off-by-one narrowing is caught too.
    const steps = Array.from({ length: MAX_CHAIN_DEPTH }, (_unused, i) => ({
      kind: 'call' as const,
      name: `m${i}`,
    }));
    expect(decodeReceiverChain(encodeReceiverChain('svc', steps))).toMatchObject({
      baseReceiverName: 'svc',
      truncated: false,
    });
    expect(decodeReceiverChain(encodeReceiverChain('svc', steps))?.steps).toHaveLength(
      MAX_CHAIN_DEPTH,
    );
  });

  it('survives adversarial payloads without throwing', () => {
    // The "total function" claim was previously verified by reading only.
    for (const hostile of [
      '|'.repeat(512),
      '1|' + '|'.repeat(400),
      '2|svc|c\u0000name',
      '2|svc|c\uD800',
      `2|svc|c${'x'.repeat(MAX_RECEIVER_CHAIN_BYTES)}`,
      '1|'.repeat(300),
      {},
      [],
      null,
    ]) {
      expect(() => decodeReceiverChain(hostile)).not.toThrow();
    }
  });

  it('rejects an over-cap payload at decode, matching the emit-side refusal', () => {
    // Emit and load must agree. A bound applied only on load is a writer that
    // keeps minting what the reader keeps refusing — a permanent, unlogged
    // warm-cache-miss reparse loop.
    expect(isValidReceiverChain(`2|svc|c${'x'.repeat(MAX_RECEIVER_CHAIN_BYTES)}`)).toBe(false);
  });
});

describe('codec v2 — name-free step kinds', () => {
  it('round-trips an await step', () => {
    const encoded = encodeReceiverChain('svc', [
      { kind: 'call', name: 'getUserAsync' },
      { kind: 'await' },
    ]);
    expect(encoded).toBe('2|svc|cgetUserAsync|a');
    expect(decodeReceiverChain(encoded)).toMatchObject({
      baseReceiverName: 'svc',
      steps: [{ kind: 'call', name: 'getUserAsync' }, { kind: 'await' }],
      truncated: false,
    });
  });

  it('round-trips an index step', () => {
    const encoded = encodeReceiverChain('repos', [{ kind: 'index' }]);
    expect(encoded).toBe('2|repos|i');
    expect(decodeReceiverChain(encoded)).toMatchObject({
      baseReceiverName: 'repos',
      steps: [{ kind: 'index' }],
    });
  });

  it('decodes a chain mixing named and name-free steps', () => {
    const encoded = encodeReceiverChain('svc', [
      { kind: 'index' },
      { kind: 'field', name: 'address' },
    ]);
    expect(decodeReceiverChain(encoded)).toMatchObject({
      steps: [{ kind: 'index' }, { kind: 'field', name: 'address' }],
    });
  });

  // The guard that keeps the name-free exemption from widening: a name-free
  // sigil must be EXACTLY the sigil, so a corrupt payload cannot smuggle a
  // trailing tail through the branch that skips the non-empty-name check.
  it('refuses a name-free sigil carrying a trailing tail', () => {
    expect(decodeReceiverChain('2|svc|await')).toBeUndefined();
    expect(decodeReceiverChain('2|repos|i0')).toBeUndefined();
  });

  // An empty-name call or field is still malformed — it does NOT become an
  // await or index just because those kinds are name-free.
  it('still refuses an empty-name call or field segment', () => {
    expect(decodeReceiverChain('2|svc|c')).toBeUndefined();
    expect(decodeReceiverChain('2|svc|f')).toBeUndefined();
  });

  // The whole reason the version moved: a v1 payload decoded under v2 rules
  // would be a chain missing whichever hop v1 could not express, which reads as
  // a complete-but-different chain and types the receiver against the wrong
  // member. Refusing is the correct, lossy-but-safe outcome.
  it('refuses a v1 payload outright', () => {
    expect(decodeReceiverChain('1|svc|cgetUser|faddress')).toBeUndefined();
  });

  it('emits the v2 prefix for an ordinary named chain', () => {
    expect(encodeReceiverChain('svc', [{ kind: 'call', name: 'getUser' }])).toBe('2|svc|cgetUser');
  });
});
