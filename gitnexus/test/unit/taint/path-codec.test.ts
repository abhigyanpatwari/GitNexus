/**
 * U4 (#2083 M3) — the shared taint-path reason codec (plan KTD6).
 *
 * The wire format must round-trip BYTE-EXACT through the CSV persistence
 * layer (`escapeCSVField ∘ sanitizeUTF8`, csv-generator.ts) — that
 * composition is exercised here verbatim, including the un-escape a DB load
 * performs. Truncation (hop cap, byte cap, unencodable hop) must decode as
 * "path incomplete", never as an error; malformed input must produce a typed
 * failure, never a throw.
 */

import { describe, it, expect } from 'vitest';
import {
  TAINT_PATH_CODEC_VERSION,
  TAINT_REASON_MAX_BYTES,
  TAINT_PATH_TRUNCATION_MARKER,
  encodeTaintPath,
  decodeTaintPath,
  type TaintPathHopInput,
} from '../../../src/core/ingestion/taint/path-codec.js';
import { escapeCSVField, sanitizeUTF8 } from '../../../src/core/lbug/csv-generator.js';

/** Inverse of escapeCSVField — what a CSV/DB load applies to the stored cell. */
function unescapeCSVField(cell: string): string {
  expect(cell.startsWith('"') && cell.endsWith('"')).toBe(true);
  return cell.slice(1, -1).replace(/""/g, '"');
}

const roundTrip = (hops: readonly TaintPathHopInput[]) => {
  const { reason } = encodeTaintPath(hops);
  const decoded = decodeTaintPath(reason);
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error}`);
  return { reason, decoded };
};

describe('encodeTaintPath / decodeTaintPath round trip', () => {
  it('round-trips an ordered multi-hop path with variables, lines, and viaCall', () => {
    const hops: TaintPathHopInput[] = [
      { name: 'req', line: 3 },
      { name: 'cmd', line: 4, viaCall: true },
      { name: 'cmd', line: 7 },
    ];
    const { reason, decoded } = roundTrip(hops);
    expect(reason).toBe('1|req:3|cmd:4:c|cmd:7');
    expect(decoded.version).toBe(TAINT_PATH_CODEC_VERSION);
    expect(decoded.truncated).toBe(false);
    expect(decoded.hops).toEqual([
      { variable: 'req', line: 3, viaCall: false },
      { variable: 'cmd', line: 4, viaCall: true },
      { variable: 'cmd', line: 7, viaCall: false },
    ]);
  });

  it('round-trips the empty path (version prefix only)', () => {
    const { reason, decoded } = roundTrip([]);
    expect(reason).toBe('1');
    expect(decoded.hops).toEqual([]);
    expect(decoded.truncated).toBe(false);
  });

  it('round-trips identifier-charset names: $, _, #, digits, case', () => {
    const names = ['$jq', '_private', '#3', 'CONST_99', 'aB$_#z', 'x'];
    const hops = names.map((name, i) => ({ name, line: i + 1, viaCall: i % 2 === 0 }));
    const { decoded } = roundTrip(hops);
    expect(decoded.hops.map((h) => h.variable)).toEqual(names);
  });

  it('fuzz-ish sweep: random identifier-charset names of varied length survive', () => {
    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$#';
    // Deterministic LCG so a failure is reproducible.
    let seed = 0xc0ffee;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 200; trial++) {
      const hops: TaintPathHopInput[] = [];
      const count = (next() % 8) + 1;
      for (let i = 0; i < count; i++) {
        const len = (next() % 24) + 1;
        let name = '';
        for (let j = 0; j < len; j++) name += CHARSET[next() % CHARSET.length];
        hops.push({ name, line: next() % 100000, viaCall: next() % 2 === 0 });
      }
      const { reason, decoded } = roundTrip(hops);
      expect(decoded.truncated).toBe(false);
      expect(decoded.hops).toEqual(
        hops.map((h) => ({ variable: h.name, line: h.line, viaCall: h.viaCall === true })),
      );
      // The whole wire string is printable ASCII (the CSV-survival invariant).
      expect(/^[\x20-\x7e]+$/.test(reason)).toBe(true);
    }
  });
});

describe('kind header (;<kind> — U6, the only persisted channel for sinkKind)', () => {
  it('round-trips a kind header with hops', () => {
    const { reason } = encodeTaintPath(
      [
        { name: 'req', line: 3 },
        { name: 'cmd', line: 4 },
      ],
      { kind: 'command-injection' },
    );
    expect(reason).toBe('1;command-injection|req:3|cmd:4');
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.kind).toBe('command-injection');
      expect(decoded.hops.map((h) => h.variable)).toEqual(['req', 'cmd']);
    }
  });

  it('round-trips a kind header on the hop-less path', () => {
    const { reason } = encodeTaintPath([], { kind: 'xss' });
    expect(reason).toBe('1;xss');
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.kind).toBe('xss');
      expect(decoded.hops).toEqual([]);
    }
  });

  it('kind + truncation marker coexist; the header is never sacrificed to the byte cap', () => {
    const { reason, truncated } = encodeTaintPath([{ name: 'longVariableName', line: 12345 }], {
      kind: 'sql-injection',
      maxBytes: 8, // far below the header size — floor lifts it, hops drop
    });
    expect(truncated).toBe(true);
    expect(reason).toBe(`1;sql-injection|${TAINT_PATH_TRUNCATION_MARKER}`);
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.kind).toBe('sql-injection');
      expect(decoded.truncated).toBe(true);
      expect(decoded.hops).toEqual([]);
    }
  });

  it('a kind outside [a-z0-9-] is dropped (header omitted), never corrupted into the wire', () => {
    for (const bad of ['Command-Injection', 'a;b', 'k|x', 'café', '']) {
      const { reason } = encodeTaintPath([{ name: 'x', line: 1 }], { kind: bad });
      expect(reason).toBe('1|x:1');
      const decoded = decodeTaintPath(reason);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.kind).toBeUndefined();
    }
  });

  it('a header-less version-1 string still decodes (kind undefined)', () => {
    const decoded = decodeTaintPath('1|a:1');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.kind).toBeUndefined();
  });

  it('the kind header survives the CSV persistence transform byte-exact', () => {
    const { reason } = encodeTaintPath([{ name: 'req', line: 2 }], { kind: 'path-traversal' });
    const loaded = unescapeCSVField(escapeCSVField(sanitizeUTF8(reason)));
    expect(loaded).toBe(reason);
    const decoded = decodeTaintPath(loaded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.kind).toBe('path-traversal');
  });

  it('fails typed on a malformed kind header', () => {
    for (const bad of ['1;|a:1', '1;BAD|a:1', '1;', '1;a;b|x:1']) {
      const decoded = decodeTaintPath(bad);
      expect(decoded.ok, bad).toBe(false);
    }
  });
});

describe('CSV persistence composition (escapeCSVField ∘ sanitizeUTF8)', () => {
  it('the encoding survives the exact persistence transform byte-exact', () => {
    const hops: TaintPathHopInput[] = [
      { name: 'req', line: 12 },
      { name: '$tmp_2', line: 13, viaCall: true },
      { name: '#7', line: 99 },
    ];
    const { reason } = encodeTaintPath(hops);
    // csv-generator applies sanitizeUTF8 INSIDE escapeCSVField; compose both
    // explicitly anyway so the test pins each layer.
    const stored = escapeCSVField(sanitizeUTF8(reason));
    const loaded = unescapeCSVField(stored);
    expect(loaded).toBe(reason); // byte-exact
    const decoded = decodeTaintPath(loaded);
    expect(decoded.ok).toBe(true);
  });

  it('a truncated encoding also survives the persistence transform', () => {
    const { reason, truncated } = encodeTaintPath([{ name: 'x', line: 1 }], { truncated: true });
    expect(truncated).toBe(true);
    const loaded = unescapeCSVField(escapeCSVField(sanitizeUTF8(reason)));
    expect(loaded).toBe(reason);
  });
});

describe('truncation', () => {
  it('caller-flagged truncation (hop cap upstream) emits the marker; decode reports path-incomplete', () => {
    const { reason, truncated } = encodeTaintPath([{ name: 'a', line: 1 }], { truncated: true });
    expect(truncated).toBe(true);
    expect(reason).toBe(`1|a:1|${TAINT_PATH_TRUNCATION_MARKER}`);
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.truncated).toBe(true); // informational — NOT an error
      expect(decoded.hops).toEqual([{ variable: 'a', line: 1, viaCall: false }]);
    }
  });

  it('byte-cap overflow drops TRAILING hops (source-side prefix kept) and sets the marker', () => {
    const hops: TaintPathHopInput[] = [];
    for (let i = 0; i < 1000; i++) hops.push({ name: `variable_${i}`, line: i });
    const { reason, truncated } = encodeTaintPath(hops);
    expect(truncated).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(TAINT_REASON_MAX_BYTES);
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.truncated).toBe(true);
      expect(decoded.hops.length).toBeGreaterThan(0);
      expect(decoded.hops.length).toBeLessThan(hops.length);
      // Prefix discipline: hop k decodes hop k of the input, in order.
      decoded.hops.forEach((h, i) => {
        expect(h.variable).toBe(`variable_${i}`);
        expect(h.line).toBe(i);
      });
    }
  });

  it('a tiny maxBytes still yields a well-formed (possibly hop-less) truncated path', () => {
    const { reason, truncated } = encodeTaintPath([{ name: 'longVariableName', line: 123 }], {
      maxBytes: 8,
    });
    expect(truncated).toBe(true);
    expect(reason).toBe(`1|${TAINT_PATH_TRUNCATION_MARKER}`);
    const decoded = decodeTaintPath(reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.hops).toEqual([]);
      expect(decoded.truncated).toBe(true);
    }
  });

  it('an unencodable hop name stops encoding at that hop and marks truncation (defend, never corrupt)', () => {
    const cases = ['a|b', 'a:b', 'café', 'name~x', '', 'a b'];
    for (const bad of cases) {
      const { reason, truncated } = encodeTaintPath([
        { name: 'ok1', line: 1 },
        { name: bad, line: 2 },
        { name: 'ok2', line: 3 }, // dropped too — prefix discipline
      ]);
      expect(truncated).toBe(true);
      const decoded = decodeTaintPath(reason);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.truncated).toBe(true);
        expect(decoded.hops).toEqual([{ variable: 'ok1', line: 1, viaCall: false }]);
      }
    }
  });

  it('a non-integer or negative line is unencodable the same way', () => {
    for (const line of [1.5, -1, NaN, Infinity]) {
      const { truncated, reason } = encodeTaintPath([{ name: 'x', line }]);
      expect(truncated).toBe(true);
      const decoded = decodeTaintPath(reason);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.hops).toEqual([]);
    }
  });
});

describe('typed parse failures (never a throw)', () => {
  const failing: Array<[string, unknown]> = [
    ['empty string', ''],
    ['non-string', 42],
    ['undefined', undefined],
    ['unknown version', '2|a:1'],
    ['missing separator after version', '1a:1'],
    ['hop with no line', '1|a'],
    ['hop with too many fields', '1|a:1:c:d'],
    ['non-numeric line', '1|a:x'],
    ['negative line', '1|a:-1'],
    ['invalid variable charset', '1|a b:1'],
    ['empty variable', '1|:1'],
    ['uppercase flag (reserved charset is lowercase)', '1|a:1:C'],
    ['marker not trailing', `1|${TAINT_PATH_TRUNCATION_MARKER}|a:1`],
    ['empty hop segment', '1|a:1||b:2'],
  ];
  for (const [label, input] of failing) {
    it(`fails typed on ${label}`, () => {
      const decoded = decodeTaintPath(input);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.length).toBeGreaterThan(0);
    });
  }

  it('accepts unknown RESERVED lowercase flag letters (forward compatibility)', () => {
    const decoded = decodeTaintPath('1|a:1:cz');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.hops[0]).toEqual({ variable: 'a', line: 1, viaCall: true });
  });
});
