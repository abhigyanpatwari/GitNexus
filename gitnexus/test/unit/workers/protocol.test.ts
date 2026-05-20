/**
 * Wire-format round-trip + error-path coverage for
 * `core/ingestion/workers/protocol.ts`.
 *
 * The body uses V8 structured-clone serialization (`node:v8`'s
 * `serialize` / `deserialize`) — bit-for-bit compatible with what
 * Node's `worker.postMessage` uses natively. Tests pin:
 *   - exact frame layout: tag (1) + length (4 LE) + V8-serialized body
 *   - round-trip for every message tag including non-JSON-safe types
 *     (Map, Set, Date, RegExp, BigInt, TypedArray, undefined values,
 *     circular refs) — this is the load-bearing distinction from the
 *     original JSON-based wire format that silently destroyed Maps
 *   - decode errors surface as ProtocolDecodeError (not generic Error)
 *     so the pool-side handler can route them through messageerror
 *     recovery distinctly from other failure classes
 *   - Uint8Array decode path: a Buffer sent via worker_threads
 *     postMessage arrives as a plain Uint8Array; decodeMessage must
 *     adopt it zero-copy.
 */
import { describe, it, expect } from 'vitest';
import { serialize as v8Serialize } from 'node:v8';
import {
  MessageTag,
  PROTOCOL_HEADER_BYTES,
  ProtocolDecodeError,
  encodeMessage,
  decodeMessage,
  type MessageTagValue,
} from '../../../src/core/ingestion/workers/protocol.js';

describe('worker IPC protocol — encodeMessage byte layout', () => {
  it('writes the tag as a single byte at offset 0', () => {
    const buf = encodeMessage(MessageTag.Ready, null);
    expect(buf.readUInt8(0)).toBe(MessageTag.Ready);
  });

  it('writes the body length as little-endian uint32 at offset 1', () => {
    const buf = encodeMessage(MessageTag.Progress, { filesProcessed: 42 });
    const declared = buf.readUInt32LE(1);
    expect(declared).toBe(buf.length - PROTOCOL_HEADER_BYTES);
  });

  it('encodes a null payload using V8 serialization (length matches v8.serialize(null))', () => {
    const buf = encodeMessage(MessageTag.SubBatchDone, null);
    const expectedBodyLength = v8Serialize(null).length;
    expect(buf.length).toBe(PROTOCOL_HEADER_BYTES + expectedBodyLength);
    expect(buf.readUInt32LE(1)).toBe(expectedBodyLength);
  });
});

describe('worker IPC protocol — round-trip per tag', () => {
  const cases: ReadonlyArray<{ tag: MessageTagValue; name: string; payload: unknown }> = [
    {
      tag: MessageTag.DispatchJob,
      name: 'DispatchJob',
      payload: { files: [{ path: 'a.ts', content: 'x' }] },
    },
    { tag: MessageTag.Result, name: 'Result', payload: { fileCount: 3, nodes: [{ id: 'n1' }] } },
    { tag: MessageTag.Progress, name: 'Progress', payload: { filesProcessed: 7 } },
    { tag: MessageTag.StartingFile, name: 'StartingFile', payload: { path: 'src/foo.ts' } },
    { tag: MessageTag.SubBatchDone, name: 'SubBatchDone', payload: null },
    { tag: MessageTag.Warning, name: 'Warning', payload: { message: 'unparseable file' } },
    { tag: MessageTag.Error, name: 'Error', payload: { error: 'native crash' } },
    { tag: MessageTag.Ready, name: 'Ready', payload: null },
  ];

  for (const { tag, name, payload } of cases) {
    it(`round-trips ${name} payload unchanged`, () => {
      const buf = encodeMessage(tag, payload);
      const decoded = decodeMessage(buf);
      expect(decoded.tag).toBe(tag);
      expect(decoded.payload).toEqual(payload ?? null);
    });
  }

  it('round-trips a non-ASCII path string (UTF-8 boundary)', () => {
    const buf = encodeMessage(MessageTag.StartingFile, { path: 'src/café.ts' });
    const decoded = decodeMessage(buf);
    expect((decoded.payload as { path: string }).path).toBe('src/café.ts');
  });

  it('round-trips a payload near the structured-clone sub-batch budget (8 MB)', () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const buf = encodeMessage(MessageTag.Warning, { message: big });
    const decoded = decodeMessage(buf);
    expect((decoded.payload as { message: string }).message.length).toBe(big.length);
  });
});

describe('worker IPC protocol — structured-clone type fidelity', () => {
  // The load-bearing reason for V8 serialization (not JSON): production
  // scope-resolution code keys data structures on Map / Set / Date /
  // RegExp / BigInt / TypedArray / undefined / circular refs
  // throughout. A JSON-based wire format silently destroyed all of
  // those, manifesting as 'X.typeBindings is not iterable' on large
  // worker-mode runs. These tests pin the full structured-clone
  // fidelity contract so a future "optimize" PR can't quietly swap
  // V8 back to JSON without failing tests.

  it('preserves Map instances (typeBindings shape in scope-resolution)', () => {
    const original = new Map<string, { kind: string; id: number }>([
      ['User', { kind: 'class', id: 1 }],
      ['save', { kind: 'method', id: 2 }],
    ]);
    const buf = encodeMessage(MessageTag.Result, { typeBindings: original });
    const decoded = decodeMessage(buf);
    const got = (decoded.payload as { typeBindings: Map<string, { kind: string; id: number }> })
      .typeBindings;
    expect(got).toBeInstanceOf(Map);
    expect(got.size).toBe(2);
    expect(got.get('User')).toEqual({ kind: 'class', id: 1 });
    expect(got.get('save')).toEqual({ kind: 'method', id: 2 });
  });

  it('preserves nested Maps inside arrays inside objects', () => {
    const payload = {
      scopes: [
        { id: 's1', bindings: new Map([['x', 1]]) },
        { id: 's2', bindings: new Map([['y', 2]]) },
      ],
    };
    const buf = encodeMessage(MessageTag.Result, payload);
    const decoded = decodeMessage(buf);
    const scopes = (
      decoded.payload as { scopes: Array<{ id: string; bindings: Map<string, number> }> }
    ).scopes;
    expect(scopes[0].bindings).toBeInstanceOf(Map);
    expect(scopes[0].bindings.get('x')).toBe(1);
    expect(scopes[1].bindings).toBeInstanceOf(Map);
    expect(scopes[1].bindings.get('y')).toBe(2);
  });

  it('preserves Set instances', () => {
    const original = new Set(['User', 'Admin', 'Guest']);
    const buf = encodeMessage(MessageTag.Result, { roles: original });
    const decoded = decodeMessage(buf);
    const got = (decoded.payload as { roles: Set<string> }).roles;
    expect(got).toBeInstanceOf(Set);
    expect(got.size).toBe(3);
    expect(got.has('User')).toBe(true);
    expect(got.has('Admin')).toBe(true);
  });

  it('preserves Date instances', () => {
    const now = new Date('2026-05-20T12:34:56.789Z');
    const buf = encodeMessage(MessageTag.Result, { generatedAt: now });
    const decoded = decodeMessage(buf);
    const got = (decoded.payload as { generatedAt: Date }).generatedAt;
    expect(got).toBeInstanceOf(Date);
    expect(got.getTime()).toBe(now.getTime());
  });

  it('preserves RegExp instances including flags', () => {
    const re = /foo(\d+)bar/gimsu;
    const buf = encodeMessage(MessageTag.Result, { pattern: re });
    const decoded = decodeMessage(buf);
    const got = (decoded.payload as { pattern: RegExp }).pattern;
    expect(got).toBeInstanceOf(RegExp);
    expect(got.source).toBe(re.source);
    expect(got.flags).toBe(re.flags);
  });

  it('preserves BigInt values', () => {
    const big = 9007199254740993n; // larger than Number.MAX_SAFE_INTEGER
    const buf = encodeMessage(MessageTag.Result, { id: big });
    const decoded = decodeMessage(buf);
    expect((decoded.payload as { id: bigint }).id).toBe(big);
  });

  it('preserves Uint8Array contents (TypedArray round-trip)', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xab, 0xcd]);
    const buf = encodeMessage(MessageTag.Result, { blob: bytes });
    const decoded = decodeMessage(buf);
    const got = (decoded.payload as { blob: Uint8Array }).blob;
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([0xff, 0x00, 0xab, 0xcd]);
  });

  it('preserves undefined values inside objects', () => {
    const buf = encodeMessage(MessageTag.Result, { defined: 1, missing: undefined });
    const decoded = decodeMessage(buf);
    const obj = decoded.payload as Record<string, unknown>;
    expect('missing' in obj).toBe(true);
    expect(obj.missing).toBeUndefined();
  });

  it('preserves circular object references', () => {
    type Cycle = { name: string; self?: Cycle };
    const node: Cycle = { name: 'root' };
    node.self = node;
    const buf = encodeMessage(MessageTag.Result, node);
    const decoded = decodeMessage(buf);
    const got = decoded.payload as Cycle;
    expect(got.name).toBe('root');
    expect(got.self).toBe(got); // identity preserved
  });
});

describe('worker IPC protocol — decode error paths', () => {
  it('throws ProtocolDecodeError when the buffer is smaller than the 5-byte header', () => {
    expect(() => decodeMessage(Buffer.from([0x01, 0x00]))).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError on a tag byte outside the valid range', () => {
    const validBody = v8Serialize(null);
    const buf = Buffer.alloc(PROTOCOL_HEADER_BYTES + validBody.length);
    buf.writeUInt8(0xff, 0); // not a defined tag
    buf.writeUInt32LE(validBody.length, 1);
    validBody.copy(buf, PROTOCOL_HEADER_BYTES);
    expect(() => decodeMessage(buf)).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError when the declared payload length exceeds the buffer', () => {
    const buf = Buffer.alloc(PROTOCOL_HEADER_BYTES + 4);
    buf.writeUInt8(MessageTag.Ready, 0);
    buf.writeUInt32LE(1000, 1);
    expect(() => decodeMessage(buf)).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError when payload bytes are not a valid V8 serialization frame', () => {
    const garbage = Buffer.from('not-v8-serialized', 'utf8');
    const buf = Buffer.alloc(PROTOCOL_HEADER_BYTES + garbage.length);
    buf.writeUInt8(MessageTag.Warning, 0);
    buf.writeUInt32LE(garbage.length, 1);
    garbage.copy(buf, PROTOCOL_HEADER_BYTES);
    expect(() => decodeMessage(buf)).toThrow(ProtocolDecodeError);
  });

  it('preserves the error class name so callers can route protocol violations distinctly', () => {
    try {
      decodeMessage(Buffer.alloc(2));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolDecodeError);
      expect((err as Error).name).toBe('ProtocolDecodeError');
    }
  });
});

describe('worker IPC protocol — Uint8Array decode path', () => {
  // Pins the U17 production fix: Node's worker_threads `postMessage`
  // structured-clones the payload, which strips the Buffer prototype, so
  // a frame sent as Buffer arrives on the receiver as a bare Uint8Array.
  // `decodeMessage` must accept a Uint8Array view zero-copy.
  it('decodes a Uint8Array view (no Buffer prototype) identically to the Buffer original', () => {
    const original = encodeMessage(MessageTag.Result, { fileCount: 5, paths: ['a.ts', 'b.ts'] });
    const stripped = new Uint8Array(original.buffer, original.byteOffset, original.byteLength);
    expect(Buffer.isBuffer(stripped)).toBe(false);
    expect(stripped).toBeInstanceOf(Uint8Array);

    const decoded = decodeMessage(stripped);
    expect(decoded.tag).toBe(MessageTag.Result);
    expect(decoded.payload).toEqual({ fileCount: 5, paths: ['a.ts', 'b.ts'] });
  });

  it('decodes a Uint8Array that views a slice of a larger ArrayBuffer (non-zero byteOffset)', () => {
    const original = encodeMessage(MessageTag.Progress, { filesProcessed: 11 });
    const padded = new Uint8Array(original.byteLength + 8);
    padded.set(original, 4);
    const view = new Uint8Array(padded.buffer, 4, original.byteLength);

    const decoded = decodeMessage(view);
    expect(decoded.tag).toBe(MessageTag.Progress);
    expect(decoded.payload).toEqual({ filesProcessed: 11 });
  });
});
