/** Independently compressed, runtime-checked facts and scope sections for one file. */
import * as zlib from 'node:zlib';
import {
  encodeV8CacheBuffer,
  inspectV8CacheBuffer,
  decodeV8CacheBuffer,
  type V8CacheHit,
} from './v8-sidecar.js';

// Bound corrupt input before allocating/decompressing. Larger valid results use
// the uncached fallback; they never turn an optional cache into a parse failure.
export const MAX_FILE_RESULT_SECTION_BYTES = 128 * 1024 * 1024;
export type FileResultSection = 'facts' | 'scopes';
export interface EncodedFileResult {
  key: string;
  path: string;
  facts: Uint8Array;
  scopes: Uint8Array;
  cacheable: boolean;
}
const HEADER = 5;

export function encodeFileResultSection(
  key: string,
  filePath: string,
  section: FileResultSection,
  value: unknown,
  codec: 'zstd' | 'gzip' = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'gzip',
): Buffer | undefined {
  // The envelope's line-based listing cannot bind these paths. Let the worker
  // deliver its raw result instead of sending an envelope that cannot decode.
  if (/[\r\n\0]/.test(filePath)) return undefined;
  const raw = encodeV8CacheBuffer(value, [filePath, key, section]);
  if (!raw || raw.length > MAX_FILE_RESULT_SECTION_BYTES) return undefined;
  const body =
    codec === 'zstd'
      ? zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })
      : zlib.gzipSync(raw, { level: 1 });
  if (body.length > MAX_FILE_RESULT_SECTION_BYTES) return undefined;
  const header = Buffer.alloc(HEADER);
  header[0] = codec === 'zstd' ? 1 : 2;
  header.writeUInt32LE(raw.length, 1);
  return Buffer.concat([header, body]);
}

function unpack(bytes: Uint8Array): Buffer | undefined {
  try {
    if (bytes.length < HEADER || bytes.length > MAX_FILE_RESULT_SECTION_BYTES + HEADER)
      return undefined;
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = data.readUInt32LE(1);
    if (length === 0 || length > MAX_FILE_RESULT_SECTION_BYTES) return undefined;
    // Avoid growing and concatenating 16 KiB output chunks for typical file
    // results. One spare byte avoids a second allocation when output exactly
    // fills the buffer. Cap the allocation even for an untrusted length header.
    const opts = {
      maxOutputLength: length,
      chunkSize: Math.max(64, Math.min(length + 1, 64 * 1024)),
    };
    const raw =
      data[0] === 1 && typeof zlib.zstdDecompressSync === 'function'
        ? zlib.zstdDecompressSync(data.subarray(HEADER), opts)
        : data[0] === 2
          ? zlib.gunzipSync(data.subarray(HEADER), opts)
          : undefined;
    return raw?.length === length ? raw : undefined;
  } catch {
    return undefined;
  }
}

function boundEnvelope(
  bytes: Uint8Array,
  key: string,
  filePath: string,
  section: FileResultSection,
): Buffer | undefined {
  const raw = unpack(bytes);
  const paths = raw && inspectV8CacheBuffer(raw)?.paths;
  return paths?.length === 3 && paths[0] === filePath && paths[1] === key && paths[2] === section
    ? raw
    : undefined;
}

/** Validate scope coverage without constructing its object graph on the parse thread. */
export function inspectFileResultSection(
  bytes: Uint8Array,
  key: string,
  filePath: string,
  section: FileResultSection,
): boolean {
  return boundEnvelope(bytes, key, filePath, section) !== undefined;
}

export function decodeFileResultSection(
  bytes: Uint8Array,
  key: string,
  filePath: string,
  section: FileResultSection,
  internPool?: Map<string, string>,
): V8CacheHit | undefined {
  const raw = unpack(bytes);
  // Authenticate and bind once, before deserializing; inspection-only callers
  // still avoid constructing the graph entirely.
  return raw ? decodeV8CacheBuffer(raw, internPool, [filePath, key, section]) : undefined;
}
