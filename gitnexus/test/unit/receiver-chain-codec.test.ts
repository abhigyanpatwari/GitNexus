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
    expect(encoded).toBe('1|svc|cgetUser|faddress');
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
    expect(encoded).toBe('1|svc|cgetUser|~');
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
    ['wrong version', '2|svc|cgetUser'],
    ['no steps', '1|svc'],
    ['unknown kind sigil', '1|svc|xgetUser'],
    ['empty step name', '1|svc|c'],
    ['empty base', '1||cgetUser'],
    ['over depth', '1|svc|ca|cb|cc|cd'],
    ['truncation marker only', '1|svc|~'],
  ])('decodes %s as undefined rather than throwing', (_label, payload) => {
    expect(decodeReceiverChain(payload)).toBeUndefined();
    expect(isValidReceiverChain(payload)).toBe(false);
  });

  it('rejects an over-cap payload at decode, matching the emit-side refusal', () => {
    // Emit and load must agree. A bound applied only on load is a writer that
    // keeps minting what the reader keeps refusing — a permanent, unlogged
    // warm-cache-miss reparse loop.
    expect(isValidReceiverChain(`1|svc|c${'x'.repeat(MAX_RECEIVER_CHAIN_BYTES)}`)).toBe(false);
  });
});
