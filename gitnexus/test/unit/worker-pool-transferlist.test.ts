/**
 * U19 — Zero-copy transferList dispatch builder.
 *
 * `worker-pool.ts`'s `buildDispatchMessage` is the U19 boundary between the
 * pool's generic `dispatch<T>(items)` and the parse-worker-specific
 * postMessage payload shape. For items shaped as `{path, content: string}[]`
 * (the parse-worker contract), file contents are hoisted OUT of the JSON
 * envelope into separately-allocated `Uint8Array`s whose ArrayBuffers go
 * into the `transferList` for zero-copy ownership transfer. For any other
 * shape, the builder falls back to the legacy `encodeMessage` path with
 * the full payload inside a single JSON-encoded protocol frame.
 *
 * These tests pin the contract:
 *   - parse-worker shape produces hybrid envelope + transferList
 *   - non-parse shape stays on the legacy single-Uint8Array path
 *   - content bytes round-trip byte-for-byte through encode+decode
 *   - each content buffer is independently allocated (not shared via
 *     Node's `Buffer.poolSize` slab) so transferring one cannot detach
 *     another
 *   - empty items array returns the legacy path (no shape inference on
 *     zero elements)
 */
import { describe, it, expect } from 'vitest';
import {
  buildDispatchMessage,
  // Internal type — re-export not needed; just exercise observable behaviour.
} from '../../src/core/ingestion/workers/worker-pool.js';
import { decodeMessage } from '../../src/core/ingestion/workers/protocol.js';

describe('worker pool — buildDispatchMessage (U19)', () => {
  it('parse-worker shape returns hybrid envelope + transferList of one buffer per file', () => {
    const items = [
      { path: 'a.ts', content: 'export const A = 1;' },
      { path: 'b.ts', content: 'export const B = 2;' },
    ];
    const { message, transferList } = buildDispatchMessage(items);

    // Hybrid shape: not a bare Uint8Array.
    expect(message).not.toBeInstanceOf(Uint8Array);
    expect(message).toEqual(
      expect.objectContaining({
        envelope: expect.any(Uint8Array),
        contents: expect.any(Array),
      }),
    );
    const hybrid = message as { envelope: Uint8Array; contents: Uint8Array[] };
    expect(hybrid.contents).toHaveLength(2);
    expect(hybrid.contents[0]).toBeInstanceOf(Uint8Array);
    expect(hybrid.contents[1]).toBeInstanceOf(Uint8Array);

    // transferList carries one ArrayBuffer per file, in the same order
    // as `contents`. Identity check is the strict contract — transferring
    // a different ArrayBuffer reference would no-op the ownership swap.
    expect(transferList).toHaveLength(2);
    expect(transferList?.[0]).toBe(hybrid.contents[0].buffer);
    expect(transferList?.[1]).toBe(hybrid.contents[1].buffer);
  });

  it('envelope decodes to {type:"sub-batch", files:[{path, byteLength}]} metadata with NO content field', () => {
    const items = [{ path: 'src/foo.ts', content: 'hello world' }];
    const { message } = buildDispatchMessage(items);
    const { envelope } = message as { envelope: Uint8Array };
    const decoded = decodeMessage(envelope).payload as {
      type: string;
      files: Array<{ path: string; byteLength: number; content?: unknown }>;
    };

    expect(decoded.type).toBe('sub-batch');
    expect(decoded.files).toHaveLength(1);
    expect(decoded.files[0].path).toBe('src/foo.ts');
    expect(decoded.files[0].byteLength).toBe(11); // 'hello world' = 11 UTF-8 bytes
    // Content must NOT appear in the JSON envelope — that's the whole
    // point of the hybrid shape. If a future refactor accidentally
    // duplicates content into both envelope and transferList, this
    // assertion catches it.
    expect('content' in decoded.files[0]).toBe(false);
  });

  it('content bytes round-trip byte-for-byte through TextDecoder', () => {
    // Mix ASCII, multi-byte UTF-8 (café = c-a-f-é where é is 2 bytes),
    // and an emoji (4 UTF-8 bytes) to cover the encoder boundaries.
    const items = [
      { path: 'a.ts', content: 'plain ASCII' },
      { path: 'b.ts', content: 'café au lait' },
      { path: 'c.ts', content: 'rocket: 🚀 emoji' },
    ];
    const { message } = buildDispatchMessage(items);
    const { contents } = message as { contents: Uint8Array[] };
    const decoder = new TextDecoder('utf-8');
    expect(decoder.decode(contents[0])).toBe('plain ASCII');
    expect(decoder.decode(contents[1])).toBe('café au lait');
    expect(decoder.decode(contents[2])).toBe('rocket: 🚀 emoji');
  });

  it('each content buffer owns a dedicated ArrayBuffer (no shared Buffer pool slab)', () => {
    // Pin the transfer-safety contract: TextEncoder allocates each
    // Uint8Array on its own ArrayBuffer, so transferring one cannot
    // detach the backing of another. If a future refactor swaps to
    // `Buffer.from(str, 'utf8')` (which carves from `Buffer.poolSize`
    // slabs for small strings), small files would share an
    // ArrayBuffer and transferList would detach unrelated content.
    // This test allocates many small files — the slab would normally
    // batch them — and verifies each ArrayBuffer is distinct.
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.ts`,
      content: `tiny ${i}`,
    }));
    const { message } = buildDispatchMessage(items);
    const { contents } = message as { contents: Uint8Array[] };
    const buffers = new Set(contents.map((c) => c.buffer));
    expect(buffers.size).toBe(8);
    // Each content's view covers the entire ArrayBuffer (no offset).
    for (const c of contents) {
      expect(c.byteOffset).toBe(0);
      expect(c.byteLength).toBe(c.buffer.byteLength);
    }
  });

  it('non-parse-worker shape falls back to the legacy single-frame path with no transferList', () => {
    // Items lacking a string `content` field don't match the
    // parse-worker shape detector and must round-trip through the
    // existing encodeMessage path unchanged.
    const items = [{ id: 1, payload: 'arbitrary' }];
    const { message, transferList } = buildDispatchMessage(items);
    expect(message).toBeInstanceOf(Uint8Array);
    expect(transferList).toBeUndefined();

    // The whole input array is embedded inside the JSON envelope on
    // this path, so a decode recovers it verbatim under `files`.
    const decoded = decodeMessage(message as Uint8Array).payload as {
      type: string;
      files: typeof items;
    };
    expect(decoded.type).toBe('sub-batch');
    expect(decoded.files).toEqual(items);
  });

  it('empty items array falls back to the legacy path (no shape inference on zero elements)', () => {
    // The shape detector requires at least one element so empty
    // dispatches don't get false-positively routed through the
    // transferList builder.
    const { message, transferList } = buildDispatchMessage([]);
    expect(message).toBeInstanceOf(Uint8Array);
    expect(transferList).toBeUndefined();
  });

  it('mixed-shape items (some missing content) fall back to the legacy path', () => {
    // Strict shape detection: every element must have a string content.
    // A single non-conforming element disqualifies the transfer path —
    // safer than partially transferring some and embedding others.
    const items = [{ path: 'a.ts', content: 'ok' }, { path: 'b.ts' /* no content */ }];
    const { message, transferList } = buildDispatchMessage(items);
    expect(message).toBeInstanceOf(Uint8Array);
    expect(transferList).toBeUndefined();
  });
});
