/**
 * U16 — Wire-format round-trip + error-path coverage for
 * `core/ingestion/workers/protocol.ts`.
 *
 * Module-only at this stage (U17 wires it into worker-pool.ts /
 * parse-worker.ts). The tests pin:
 *   - exact byte layout: tag (1) + length (4 LE) + UTF-8 JSON body
 *   - round-trip for every message tag
 *   - decode errors surface as ProtocolDecodeError (not generic Error)
 *     so U17's pool-side handler can route them through messageerror
 *     recovery distinctly from other failure classes
 *   - boundary cases: empty body, large body
 */
import { describe, it, expect } from 'vitest';
import {
  MessageTag,
  PROTOCOL_HEADER_BYTES,
  ProtocolDecodeError,
  encodeMessage,
  decodeMessage,
  type MessageTagValue,
} from '../../../src/core/ingestion/workers/protocol.js';

describe('worker IPC protocol — encodeMessage byte layout (U16)', () => {
  it('writes the tag as a single byte at offset 0', () => {
    const buf = encodeMessage(MessageTag.Ready, null);
    expect(buf.readUInt8(0)).toBe(MessageTag.Ready);
  });

  it('writes the payload length as little-endian uint32 at offset 1', () => {
    const buf = encodeMessage(MessageTag.Progress, { filesProcessed: 42 });
    // The JSON encoding of {"filesProcessed":42} is a fixed-width
    // ASCII string; the encoder uses Buffer.byteLength on the UTF-8
    // bytes, so reading it back via the same path is the load-bearing
    // assertion. Header length must equal payloadEnd - header.
    const declared = buf.readUInt32LE(1);
    expect(declared).toBe(buf.length - PROTOCOL_HEADER_BYTES);
  });

  it('encodes an empty/null payload as 5-byte header + 4-byte "null" body', () => {
    // JSON.stringify(null) === "null" (4 bytes). The header carries 4
    // as the length so decoders can advance the cursor consistently.
    const buf = encodeMessage(MessageTag.SubBatchDone, null);
    expect(buf.length).toBe(PROTOCOL_HEADER_BYTES + 4);
    expect(buf.readUInt32LE(1)).toBe(4);
    expect(buf.subarray(PROTOCOL_HEADER_BYTES).toString('utf8')).toBe('null');
  });
});

describe('worker IPC protocol — round-trip per tag (U16)', () => {
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
      // toEqual covers structural equality across nested objects/arrays —
      // payloads that mutated on the way through would surface as a
      // diff in the assertion, not a silent corruption.
      expect(decoded.payload).toEqual(payload ?? null);
    });
  }

  it('round-trips a non-ASCII path string (UTF-8 boundary)', () => {
    const buf = encodeMessage(MessageTag.StartingFile, { path: 'src/café.ts' });
    const decoded = decodeMessage(buf);
    expect((decoded.payload as { path: string }).path).toBe('src/café.ts');
  });

  it('round-trips a payload near the structured-clone sub-batch budget (8 MB)', () => {
    // The pool's existing sub-batch byte budget is 8 MB. Verify the
    // protocol does not impose a tighter limit by encoding/decoding a
    // ~9 MB JSON payload successfully.
    const big = 'x'.repeat(9 * 1024 * 1024);
    const buf = encodeMessage(MessageTag.Warning, { message: big });
    const decoded = decodeMessage(buf);
    expect((decoded.payload as { message: string }).message.length).toBe(big.length);
  });
});

describe('worker IPC protocol — decode error paths (U16)', () => {
  it('throws ProtocolDecodeError when the buffer is smaller than the 5-byte header', () => {
    expect(() => decodeMessage(Buffer.from([0x01, 0x00]))).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError on a tag byte outside the valid range', () => {
    const buf = Buffer.alloc(PROTOCOL_HEADER_BYTES + 4);
    buf.writeUInt8(0xff, 0); // not a defined tag
    buf.writeUInt32LE(4, 1);
    Buffer.from('null', 'utf8').copy(buf, PROTOCOL_HEADER_BYTES);
    expect(() => decodeMessage(buf)).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError when the declared payload length exceeds the buffer', () => {
    // Header claims a 1000-byte body but the buffer only has 4 actual
    // payload bytes — a truncated frame.
    const buf = Buffer.alloc(PROTOCOL_HEADER_BYTES + 4);
    buf.writeUInt8(MessageTag.Ready, 0);
    buf.writeUInt32LE(1000, 1);
    expect(() => decodeMessage(buf)).toThrow(ProtocolDecodeError);
  });

  it('throws ProtocolDecodeError when payload bytes are not valid JSON', () => {
    const garbage = Buffer.from('{not-json}', 'utf8');
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
