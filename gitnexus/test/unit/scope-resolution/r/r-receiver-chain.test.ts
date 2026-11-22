/**
 * R chained receivers (`a$b$c()`).
 *
 * `emitRScopeCaptures` mints the chain R-locally, with the shared codec's `truncated` marker:
 * R never types through a chain (R6 fields and results have no declared type), so the marker's
 * only job is to make the shared fold refuse the chain and leave the site unresolved, with a
 * `receiver-unresolved` outcome. The shared comment on the fold calls the marker defence in
 * depth and says the producer never mints one; the last block pins that reliance, so an
 * upstream change that folds or refuses a truncated chain fails an R test.
 *
 * A chain with no variable base (`get_user()$save()`, `pkg::Cls$new()$m()`, `x[[1]]$f$m()`)
 * mints no site at all.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitRScopeCaptures } from '../../../../src/core/ingestion/languages/r/captures.js';
import {
  decodeReceiverChain,
  encodeReceiverChain,
} from '../../../../src/core/ingestion/utils/receiver-chain-codec.js';
import { foldReceiverChain } from '../../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';

/** The member-call matches of `source`, as `{receiver, name, chain}`. */
const memberCalls = (source: string) =>
  emitRScopeCaptures(source, 'a.R')
    .filter((m: CaptureMatch) => m['@reference.call.member'] !== undefined)
    .map((m) => ({
      receiver: m['@reference.receiver']?.text,
      name: m['@reference.name']?.text,
      chain: decodeReceiverChain(m['@reference.receiver-chain']?.text),
    }));

describe('a chain with a variable base is minted truncated', () => {
  it.each([
    ['a$b$c()', 'a$b', 'c', 'a', [{ kind: 'field', name: 'b' }]],
    ['Cls$new()$m()', 'Cls$new()', 'm', 'Cls', [{ kind: 'call', name: 'new' }]],
    [
      'a$b$c$d$m()',
      'a$b$c$d',
      'm',
      'a',
      [
        { kind: 'field', name: 'b' },
        { kind: 'field', name: 'c' },
        { kind: 'field', name: 'd' },
      ],
    ],
    [
      'a$b()$c$m()',
      'a$b()$c',
      'm',
      'a',
      [
        { kind: 'call', name: 'b' },
        { kind: 'field', name: 'c' },
      ],
    ],
    ['self$f$m()', 'self$f', 'm', 'self', [{ kind: 'field', name: 'f' }]],
    ['a@b$m()', 'a@b', 'm', 'a', [{ kind: 'field', name: 'b' }]],
  ])('%s', (text, receiver, name, base, steps) => {
    // The last member call is the outer one (`Cls$new()$m()` also holds the inner `Cls$new()`).
    const outer = memberCalls(`f <- function(a) {\n  ${text}\n}\n`).filter((c) => c.name === name);
    expect(outer).toHaveLength(1);
    expect(outer[0].receiver).toBe(receiver);
    expect(outer[0].chain).toEqual({ baseReceiverName: base, steps, truncated: true });
  });

  it('a plain receiver keeps its single site and gets no chain', () => {
    const calls = memberCalls('f <- function(u) u$save()\n');
    expect(calls).toEqual([{ receiver: 'u', name: 'save', chain: undefined }]);
  });

  it('one member-call site per call: the inner field step is not a call of its own', () => {
    expect(memberCalls('f <- function(a) a$b$c()\n').map((c) => c.name)).toEqual(['c']);
  });

  it('an inner call step keeps its own plain site (a$b() receiver a, no chain)', () => {
    const calls = memberCalls('f <- function(a) a$b()$m()\n');
    expect(calls.map((c) => [c.name, c.receiver, c.chain === undefined])).toEqual([
      ['b', 'a', true],
      ['m', 'a$b()', false],
    ]);
  });
});

describe('a chain with no variable base mints no site', () => {
  it.each([
    'get_user()$save()',
    'pkg::Cls$new()$m()',
    'pkg:::Cls$new()$m()',
    'x[[1]]$f$m()',
    'x[1]$f$m()',
    '(x)$f$m()',
    'g(x)$f$m()',
    'g(x)$m()',
    'a$b[[1]]$m()',
    'a$"b"$m()',
  ])('%s', (text) => {
    expect(memberCalls(`f <- function(x) {\n  ${text}\n}\n`)).toEqual([]);
  });

  it('a chain longer than the codec accepts mints no site', () => {
    const long = Array.from({ length: 40 }, (_, i) => `s${i}`).join('$');
    expect(memberCalls(`f <- function(a) a$${long}$m()\n`)).toEqual([]);
  });

  it('an unencodable name mints no site', () => {
    expect(memberCalls('f <- function(a) a$`b c`$m()\n')).toEqual([]);
  });
});

describe('the shared fold refuses a truncated chain (the reliance behind the marker)', () => {
  const wire = (truncated: boolean) => {
    const encoded = encodeReceiverChain(
      'a',
      [{ kind: 'field', name: 'b' }],
      truncated ? { truncated } : undefined,
    );
    const decoded = decodeReceiverChain(encoded);
    if (decoded === undefined) throw new Error(`chain did not round-trip: ${String(encoded)}`);
    return decoded;
  };

  it('decodes the marker', () => {
    expect(wire(true).truncated).toBe(true);
    expect(wire(false).truncated).toBe(false);
  });

  it('foldReceiverChain returns undefined for a truncated chain before reading any index', () => {
    // A complete chain reaches into the indexes and throws on these empty stand-ins; the
    // truncated one is refused first. If upstream stops refusing a truncated chain, this fails.
    const scopes = {} as never;
    const index = {} as never;
    expect(foldReceiverChain(wire(true), 'scope' as never, scopes, index)).toBeUndefined();
    expect(() => foldReceiverChain(wire(false), 'scope' as never, scopes, index)).toThrow();
  });
});
