/**
 * Optional V8 binary sidecar beside a canonical JSON cache shard (#3089).
 *
 * JSON remains authoritative. The sidecar is a best-effort warm-load shortcut:
 * missing, corrupt, or size-mismatched files are a cache miss into JSON.parse —
 * never an analyze failure.
 *
 * Compatibility: Node major and `process.versions.v8` are recorded in the
 * envelope for diagnostics only. They are not a read gate. GitNexus does not
 * predict serialization compatibility from those stamps. Read path: validate
 * our envelope → `v8.deserialize` → on failure fall back to JSON. That avoids
 * exact-version invalidation on upgrades without introducing false misses for
 * newer-writer/older-reader combinations that V8 may actually be able to
 * deserialize.
 *
 * Binding: `jsonBytes` from `stat` of the JSON file (no body hash on the hot
 * path). Persist helpers MUST unlink the sidecar before overwriting JSON so a
 * same-size rewrite cannot keep a stale graph. Atomic tmp+rename publish means
 * a crash mid-write cannot leave a truncated sidecar at the final path.
 */
import { promises as fs, statSync, unlinkSync } from 'node:fs';
import v8 from 'node:v8';
import { logger } from '../core/logger.js';
import { writeFileAtomicBytes, writeFileAtomicBytesSync } from './fs-atomic.js';

const MAGIC = Buffer.from('GNXV8SC1', 'ascii');
/** Sidecar envelope version — independent of PARSE_CACHE_VERSION / SCHEMA_BUMP. */
export const V8_SIDECAR_FORMAT = 1;
const U32 = 4;
const U16 = 2;
const U64 = 8;
const MAGIC_LEN = 8;
const FIXED_PREFIX = MAGIC_LEN + U32 + U16 + U16; // magic + format + nodeMajor + v8len

export const v8SidecarPath = (jsonPath: string): string => `${jsonPath}.v8`;

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

const nodeMajor = (): number => Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

const internString = (value: string, pool: Map<string, string>): string => {
  const hit = pool.get(value);
  if (hit !== undefined) return hit;
  pool.set(value, value);
  return value;
};

/**
 * Collapse duplicate strings in a live deserialized graph into `pool`, mutating
 * in place so object identity (shared `SymbolDefinition`s, Maps) is preserved.
 * Required after `v8.deserialize` of ParsedFile shards: V8 does not recreate
 * the JSON reviver's cross-shard string intern, and skipping it regresses
 * retained heap (~+59% measured vs interned JSON).
 */
export const internGraphStrings = (root: unknown, pool: Map<string, string>): unknown => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return internString(value, pool);
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value];
      value.clear();
      for (const [k, v] of entries) value.set(walk(k), walk(v));
      return value;
    }
    if (value instanceof Set) {
      const entries = [...value];
      value.clear();
      for (const v of entries) value.add(walk(v));
      return value;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      rec[key] = walk(rec[key]);
    }
    return value;
  };
  return walk(root);
};

const encodeSidecar = (jsonBytes: number, payload: Buffer): Buffer => {
  const v8ver = Buffer.from(process.versions.v8, 'utf8');
  const header = Buffer.allocUnsafe(FIXED_PREFIX + v8ver.length + U64 + U32);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(V8_SIDECAR_FORMAT, MAGIC_LEN);
  header.writeUInt16LE(nodeMajor(), MAGIC_LEN + U32);
  header.writeUInt16LE(v8ver.length, MAGIC_LEN + U32 + U16);
  v8ver.copy(header, FIXED_PREFIX);
  header.writeBigUInt64LE(BigInt(jsonBytes), FIXED_PREFIX + v8ver.length);
  header.writeUInt32LE(payload.byteLength, FIXED_PREFIX + v8ver.length + U64);
  return Buffer.concat([header, payload]);
};

const decodeSidecar = (
  buf: Buffer,
):
  | {
      jsonBytes: number;
      payload: Buffer;
      recordedNodeMajor: number;
      recordedV8: string;
    }
  | undefined => {
  if (buf.byteLength < FIXED_PREFIX + U64 + U32) return undefined;
  if (!buf.subarray(0, MAGIC_LEN).equals(MAGIC)) return undefined;
  if (buf.readUInt32LE(MAGIC_LEN) !== V8_SIDECAR_FORMAT) return undefined;
  const recordedNodeMajor = buf.readUInt16LE(MAGIC_LEN + U32);
  const v8len = buf.readUInt16LE(MAGIC_LEN + U32 + U16);
  const v8off = FIXED_PREFIX;
  if (buf.byteLength < v8off + v8len + U64 + U32) return undefined;
  const recordedV8 = buf.subarray(v8off, v8off + v8len).toString('utf8');
  const jsonBytes = Number(buf.readBigUInt64LE(v8off + v8len));
  const payloadBytes = buf.readUInt32LE(v8off + v8len + U64);
  const payloadOff = v8off + v8len + U64 + U32;
  if (jsonBytes > Number.MAX_SAFE_INTEGER) return undefined;
  if (buf.byteLength !== payloadOff + payloadBytes) return undefined;
  return { jsonBytes, payload: buf.subarray(payloadOff), recordedNodeMajor, recordedV8 };
};

const warnSidecar = (err: unknown, jsonPath: string, msg: string): void => {
  logger.warn({ err, jsonPath }, msg);
};

const ignoreMissingUnlink = (err: unknown, jsonPath: string): void => {
  if (isEnoent(err)) return;
  warnSidecar(err, jsonPath, 'v8 sidecar: failed to drop leftover; JSON remains authoritative');
};

export const dropV8Sidecar = async (jsonPath: string): Promise<void> => {
  try {
    await fs.unlink(v8SidecarPath(jsonPath));
  } catch (err) {
    ignoreMissingUnlink(err, jsonPath);
  }
};

export const dropV8SidecarSync = (jsonPath: string): void => {
  try {
    unlinkSync(v8SidecarPath(jsonPath));
  } catch (err) {
    ignoreMissingUnlink(err, jsonPath);
  }
};

const jsonFileSize = (jsonPath: string): number | undefined => {
  try {
    return statSync(jsonPath).size;
  } catch {
    return undefined;
  }
};

const writeEnvelope = (
  jsonPath: string,
  graph: unknown,
  jsonBytes: number,
): Buffer | undefined => {
  if (!Number.isSafeInteger(jsonBytes) || jsonBytes < 0 || jsonBytes > 0xffff_ffff) {
    return undefined;
  }
  let payload: Buffer;
  try {
    payload = v8.serialize(graph);
  } catch (err) {
    warnSidecar(err, jsonPath, 'v8 sidecar: serialize failed; JSON remains authoritative');
    return undefined;
  }
  if (payload.byteLength > 0xffff_ffff) return undefined;
  return encodeSidecar(jsonBytes, payload);
};

export const writeV8SidecarBestEffort = async (
  jsonPath: string,
  graph: unknown,
  jsonBytes: number,
): Promise<void> => {
  const dest = v8SidecarPath(jsonPath);
  const blob = writeEnvelope(jsonPath, graph, jsonBytes);
  if (!blob) {
    await dropV8Sidecar(jsonPath);
    return;
  }
  try {
    await writeFileAtomicBytes(dest, blob, 1);
  } catch (err) {
    warnSidecar(err, jsonPath, 'v8 sidecar: write failed; JSON remains authoritative');
    await dropV8Sidecar(jsonPath);
  }
};

export const writeV8SidecarBestEffortSync = (
  jsonPath: string,
  graph: unknown,
  jsonBytes: number,
): void => {
  const dest = v8SidecarPath(jsonPath);
  const blob = writeEnvelope(jsonPath, graph, jsonBytes);
  if (!blob) {
    dropV8SidecarSync(jsonPath);
    return;
  }
  try {
    writeFileAtomicBytesSync(dest, blob);
  } catch (err) {
    warnSidecar(err, jsonPath, 'v8 sidecar: write failed; JSON remains authoritative');
    dropV8SidecarSync(jsonPath);
  }
};

export type V8SidecarHit = { value: unknown; bytes: number };

/**
 * Load a compatible sidecar. Callers that need ParsedFile intern MUST run
 * {@link internGraphStrings} on `value` with the load's shared string pool.
 */
export const tryLoadV8Sidecar = async (jsonPath: string): Promise<V8SidecarHit | undefined> => {
  let buf: Buffer;
  try {
    buf = await fs.readFile(v8SidecarPath(jsonPath));
  } catch (err) {
    if (!isEnoent(err)) {
      logger.debug({ err, jsonPath }, 'v8 sidecar: unreadable; falling back to JSON');
    }
    return undefined;
  }
  const decoded = decodeSidecar(buf);
  if (!decoded) return undefined;
  const size = jsonFileSize(jsonPath);
  if (size === undefined || size !== decoded.jsonBytes) return undefined;
  try {
    return { value: v8.deserialize(decoded.payload), bytes: buf.byteLength };
  } catch (err) {
    logger.debug(
      {
        err,
        jsonPath,
        recordedNodeMajor: decoded.recordedNodeMajor,
        recordedV8: decoded.recordedV8,
      },
      'v8 sidecar: deserialize failed; falling back to JSON',
    );
    return undefined;
  }
};

export const copyV8SidecarIfPresent = async (srcJson: string, dstJson: string): Promise<void> => {
  try {
    await fs.copyFile(v8SidecarPath(srcJson), v8SidecarPath(dstJson));
  } catch (copyErr) {
    if (!isEnoent(copyErr)) {
      warnSidecar(
        copyErr,
        srcJson,
        'v8 sidecar: copy failed; JSON remains authoritative',
      );
      return;
    }
    await dropV8Sidecar(dstJson);
  }
};
