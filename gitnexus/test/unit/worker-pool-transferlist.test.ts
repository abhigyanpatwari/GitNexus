/**
 * `buildDispatchMessage` — zero-copy transferList contract.
 *
 * `worker-pool.ts`'s `buildDispatchMessage` is the boundary between the
 * pool's generic `dispatch<T>(items)` and the parse-worker-specific
 * postMessage payload shape. For items shaped as `{path, content: string}[]`
 * (the parse-worker contract), each file's content is encoded to a
 * `Uint8Array` via `TextEncoder` so its underlying `ArrayBuffer` can be
 * transferred zero-copy via `transferList`. For any other shape, the
 * items array is passed through as the `files` field with no transfer.
 *
 * Tests pin:
 *   - parse-worker shape produces `{type:'sub-batch', files:[{path, content: Uint8Array}]}`
 *     + transferList of every content.buffer in input order
 *   - non-parse shape stays as `{type:'sub-batch', files: items}` (no transfer)
 *   - content bytes round-trip byte-for-byte through `TextDecoder`
 *   - each content buffer owns a dedicated `ArrayBuffer` (no shared
 *     `Buffer.poolSize` slab) so transferring one cannot detach another
 *   - empty / mixed-shape inputs fall back to the no-transfer path
 */
import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildDispatchMessage } from '../../src/core/ingestion/workers/worker-pool.js';

describe('worker pool — buildDispatchMessage', () => {
  it('parse-worker shape produces a POJO sub-batch + transferList of one buffer per file', () => {
    const items = [
      {
        path: 'a.ts',
        content: 'export const A = 1;',
        language: SupportedLanguages.TypeScript,
      },
      {
        path: 'b.ts',
        content: 'export const B = 2;',
        language: SupportedLanguages.TypeScript,
      },
    ];
    const { message, transferList } = buildDispatchMessage(items);

    const msg = message as {
      type: 'sub-batch';
      files: Array<{ path: string; content: Uint8Array; language: SupportedLanguages }>;
    };
    expect(msg.type).toBe('sub-batch');
    expect(msg.files).toHaveLength(2);
    expect(msg.files[0].path).toBe('a.ts');
    expect(msg.files[0].language).toBe(SupportedLanguages.TypeScript);
    expect(msg.files[0].content).toBeInstanceOf(Uint8Array);
    expect(msg.files[1].path).toBe('b.ts');
    expect(msg.files[1].language).toBe(SupportedLanguages.TypeScript);
    expect(msg.files[1].content).toBeInstanceOf(Uint8Array);

    // transferList carries one ArrayBuffer per file, in input order.
    // Identity check is the strict contract — transferring a different
    // ArrayBuffer reference would no-op the ownership swap.
    expect(transferList).toHaveLength(2);
    expect(transferList?.[0]).toBe(msg.files[0].content.buffer);
    expect(transferList?.[1]).toBe(msg.files[1].content.buffer);
  });

  it('content bytes round-trip byte-for-byte through TextDecoder', () => {
    // Mix ASCII, multi-byte UTF-8 (café = c-a-f-é where é is 2 bytes),
    // and an emoji (4 UTF-8 bytes) to cover the encoder boundaries.
    const items = [
      { path: 'a.ts', content: 'plain ASCII', language: SupportedLanguages.TypeScript },
      { path: 'b.ts', content: 'café au lait', language: SupportedLanguages.TypeScript },
      { path: 'c.ts', content: 'rocket: 🚀 emoji', language: SupportedLanguages.TypeScript },
    ];
    const { message } = buildDispatchMessage(items);
    const files = (message as { files: Array<{ content: Uint8Array }> }).files;
    const decoder = new TextDecoder('utf-8');
    expect(decoder.decode(files[0].content)).toBe('plain ASCII');
    expect(decoder.decode(files[1].content)).toBe('café au lait');
    expect(decoder.decode(files[2].content)).toBe('rocket: 🚀 emoji');
  });

  it('each content buffer owns a dedicated ArrayBuffer (no shared Buffer pool slab)', () => {
    // Pin the transfer-safety contract: TextEncoder allocates each
    // Uint8Array on its own ArrayBuffer, so transferring one cannot
    // detach the backing of another. If a future refactor swaps to
    // `Buffer.from(str, 'utf8')` (which carves from `Buffer.poolSize`
    // slabs for small strings), small files would share an
    // ArrayBuffer and transferList would detach unrelated content.
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.ts`,
      content: `tiny ${i}`,
      language: SupportedLanguages.TypeScript,
    }));
    const { message } = buildDispatchMessage(items);
    const files = (message as { files: Array<{ content: Uint8Array }> }).files;
    const buffers = new Set(files.map((f) => f.content.buffer));
    expect(buffers.size).toBe(8);
    // Each content's view covers the entire ArrayBuffer (no offset).
    for (const f of files) {
      expect(f.content.byteOffset).toBe(0);
      expect(f.content.byteLength).toBe(f.content.buffer.byteLength);
    }
  });

  it('non-parse-worker shape falls back to a no-transfer pass-through', () => {
    // Items lacking a string `content` field don't match the
    // parse-worker shape detector and ride through as the `files`
    // array of the sub-batch POJO without any encoding or
    // transferList.
    const items = [{ id: 1, payload: 'arbitrary' }];
    const { message, transferList } = buildDispatchMessage(items);
    expect(message).toEqual({ type: 'sub-batch', files: items });
    expect(transferList).toBeUndefined();
  });

  it('empty items array falls back to the no-transfer path', () => {
    const { message, transferList } = buildDispatchMessage([]);
    expect(message).toEqual({ type: 'sub-batch', files: [] });
    expect(transferList).toBeUndefined();
  });

  it('mixed-shape items (some missing content) fall back to the no-transfer path', () => {
    // Strict shape detection: every element must have a string content.
    // A single non-conforming element disqualifies the transfer path —
    // safer than partially transferring some and embedding others.
    const items = [
      { path: 'a.ts', content: 'ok', language: SupportedLanguages.TypeScript },
      { path: 'b.ts', language: SupportedLanguages.TypeScript /* no content */ },
    ];
    const { message, transferList } = buildDispatchMessage(items);
    expect(message).toEqual({ type: 'sub-batch', files: items });
    expect(transferList).toBeUndefined();
  });
});
