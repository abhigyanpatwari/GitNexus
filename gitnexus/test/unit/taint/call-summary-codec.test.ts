/**
 * PDG FU-C (U-C2) — the shared CALL_SUMMARY reason bitset codec.
 *
 * The wire format must round-trip BYTE-EXACT through the CSV persistence layer
 * (`escapeCSVField ∘ sanitizeUTF8`, csv-generator.ts) — that composition is
 * exercised here verbatim, including the un-escape a DB load performs. Malformed
 * input must produce a typed failure, never a throw; an unknown trailing segment
 * (a future out-param/exception fact) must decode without error (forward compat).
 */

import { describe, it, expect } from 'vitest';
import {
  CALL_SUMMARY_CODEC_VERSION,
  encodeCallSummary,
  decodeCallSummary,
} from '../../../src/core/ingestion/taint/call-summary-codec.js';
import { escapeCSVField, sanitizeUTF8 } from '../../../src/core/lbug/csv-generator.js';

/** Inverse of escapeCSVField — what a CSV/DB load applies to the stored cell. */
function unescapeCSVField(cell: string): string {
  expect(cell.startsWith('"') && cell.endsWith('"')).toBe(true);
  return cell.slice(1, -1).replace(/""/g, '"');
}

const roundTrip = (params: readonly number[]) => {
  const reason = encodeCallSummary(params);
  const decoded = decodeCallSummary(reason);
  expect(decoded).toMatchObject({ ok: true });
  return { reason, decoded };
};

describe('encodeCallSummary / decodeCallSummary round trip', () => {
  it('round-trips a single return-flowing formal index (formal 0 flows, 1 does not)', () => {
    const { decoded } = roundTrip([0]);
    expect(decoded).toMatchObject({
      ok: true,
      version: CALL_SUMMARY_CODEC_VERSION,
      returnFlowParams: [0],
    });
  });

  it('round-trips multiple non-contiguous return-flowing indices, sorted + deduped', () => {
    const { decoded } = roundTrip([5, 0, 5, 2]);
    expect(decoded).toMatchObject({ ok: true, returnFlowParams: [0, 2, 5] });
  });

  it('encodes an empty ascent as an explicit empty summary (r:0)', () => {
    const reason = encodeCallSummary([]);
    expect(reason).toBe(`${CALL_SUMMARY_CODEC_VERSION}|r:0`);
    expect(decodeCallSummary(reason)).toMatchObject({ ok: true, returnFlowParams: [] });
  });

  it('handles a high formal index beyond 32 bits (BigInt bitset, no overflow)', () => {
    const { decoded } = roundTrip([64]);
    expect(decoded).toMatchObject({ ok: true, returnFlowParams: [64] });
  });

  it('survives the CSV escape/sanitize/unescape persistence path byte-exact', () => {
    const reason = encodeCallSummary([0, 3, 7]);
    const persisted = escapeCSVField(sanitizeUTF8(reason));
    const loaded = unescapeCSVField(persisted);
    expect(loaded).toBe(reason);
    expect(decodeCallSummary(loaded)).toMatchObject({ ok: true, returnFlowParams: [0, 3, 7] });
  });

  it('ignores negative / non-integer indices on encode (defensive)', () => {
    const { decoded } = roundTrip([1, -1, 2.5, 3]);
    expect(decoded).toMatchObject({ ok: true, returnFlowParams: [1, 3] });
  });
});

describe('decodeCallSummary forward compatibility + typed failures', () => {
  it('accepts and ignores an unknown trailing segment (reserved future fact)', () => {
    const reason = `${CALL_SUMMARY_CODEC_VERSION}|r:5|o:deadbeef`;
    expect(decodeCallSummary(reason)).toMatchObject({ ok: true, returnFlowParams: [0, 2] });
  });

  it('rejects an unsupported version with a typed failure (no throw)', () => {
    expect(decodeCallSummary('9|r:1')).toMatchObject({ ok: false });
  });

  it('rejects a MULTI-DIGIT future version cleanly (parsed before the first `|`, not as one char)', () => {
    // A future writer emitting `12|…` must degrade to a clean unsupported-version
    // typed-failure — NOT mis-parse the version as '1' with a stray '2' segment.
    // The error names the FULL multi-digit token, proving it was not truncated to
    // a single char.
    expect(decodeCallSummary('12|r:1')).toMatchObject({
      ok: false,
      error: "unsupported call-summary version '12'",
    });
    // A 3-digit version likewise fails as a whole token (no `>9` truncation).
    expect(decodeCallSummary('123|r:5')).toMatchObject({
      ok: false,
      error: "unsupported call-summary version '123'",
    });
  });

  it('rejects an empty / non-string reason', () => {
    expect(decodeCallSummary('')).toMatchObject({ ok: false });
    expect(decodeCallSummary(undefined)).toMatchObject({ ok: false });
    expect(decodeCallSummary(42)).toMatchObject({ ok: false });
  });

  it('rejects a missing return segment', () => {
    expect(decodeCallSummary(`${CALL_SUMMARY_CODEC_VERSION}|o:ff`)).toMatchObject({ ok: false });
  });

  it('rejects a non-hex return payload', () => {
    expect(decodeCallSummary(`${CALL_SUMMARY_CODEC_VERSION}|r:xyz`)).toMatchObject({ ok: false });
  });

  it('rejects a body without the segment separator', () => {
    expect(decodeCallSummary(`${CALL_SUMMARY_CODEC_VERSION}r:1`)).toMatchObject({ ok: false });
  });
});
