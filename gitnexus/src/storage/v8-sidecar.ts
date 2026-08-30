/**
 * Optional V8 binary sidecar beside a canonical JSON cache shard (#3089).
 *
 * JSON remains authoritative. The sidecar is a best-effort warm-load shortcut:
 * missing, corrupt, generation-mismatched, or size-mismatched files are a
 * cache miss into JSON.parse — never an analyze failure.
 *
 * Compatibility: Node major and `process.versions.v8` are recorded in the
 * envelope for diagnostics only. They are not a read gate. GitNexus does not
 * predict serialization compatibility from those stamps. Read path: validate
 * our envelope → match durable generation → `v8.deserialize` (+ optional
 * intern) → on failure fall back to JSON. That avoids exact-version
 * invalidation on upgrades without introducing false misses for
 * newer-writer/older-reader combinations that V8 may actually be able to
 * deserialize.
 *
 * Generation binding: persist publishes a tiny `<json>.v8gen` token *before*
 * overwriting JSON, then stamps the same token into the sidecar envelope.
 * `jsonBytes` vs `stat` is defense in depth only — two JSON generations can
 * share a byte length, so size is not identity.
 *
 * Invalidation contract (why the drop helpers return a boolean): a sidecar
 * failure must never make a stale V8 payload authoritative. There are two
 * independent ways to make the previous sidecar unusable — rotate `.v8gen`, or
 * remove the old `.v8`. ONE of them succeeding is enough to publish a new
 * canonical JSON generation. If BOTH fail, a same-length rewrite would leave
 * the old sidecar indistinguishable from the new JSON after a restart, so the
 * writer keeps the previous cache generation instead. This is a derived cache:
 * a skipped generation costs a re-parse, a stale hit costs correctness.
 *
 * When rotation failed but removal succeeded, no new sidecar is published —
 * there is no durable generation to bind it to. JSON stays usable and the next
 * successful write restores acceleration.
 *
 * Atomic tmp+rename publish means a crash mid-write cannot leave a truncated
 * sidecar or generation file at the final path.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs, unlinkSync } from 'node:fs';
import v8 from 'node:v8';
import { logger } from '../core/logger.js';
import { writeFileAtomicBytes, writeFileAtomicBytesSync } from './fs-atomic.js';

const MAGIC = Buffer.from('GNXV8SC1', 'ascii');
const GEN_MAGIC = Buffer.from('GNXV8GN1', 'ascii');
/** Sidecar envelope version — independent of PARSE_CACHE_VERSION / SCHEMA_BUMP. */
const V8_SIDECAR_FORMAT = 2;
const U32 = 4;
const U16 = 2;
const U64 = 8;
const MAGIC_LEN = 8;
const GEN_LEN = 16;
const FIXED_PREFIX = MAGIC_LEN + U32 + U16 + U16; // magic + format + nodeMajor + v8len
const BIND_LEN = MAGIC_LEN + GEN_LEN + U64;

export const v8SidecarPath = (jsonPath: string): string => `${jsonPath}.v8`;
export const v8GenerationPath = (jsonPath: string): string => `${jsonPath}.v8gen`;

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

const nodeMajor = (): number => Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

export const newV8Generation = (): Buffer => randomBytes(GEN_LEN);

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

const encodeSidecar = (jsonBytes: number, generation: Buffer, payload: Buffer): Buffer => {
  const v8ver = Buffer.from(process.versions.v8, 'utf8');
  const header = Buffer.allocUnsafe(FIXED_PREFIX + v8ver.length + U64 + GEN_LEN + U32);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(V8_SIDECAR_FORMAT, MAGIC_LEN);
  header.writeUInt16LE(nodeMajor(), MAGIC_LEN + U32);
  header.writeUInt16LE(v8ver.length, MAGIC_LEN + U32 + U16);
  v8ver.copy(header, FIXED_PREFIX);
  let off = FIXED_PREFIX + v8ver.length;
  header.writeBigUInt64LE(BigInt(jsonBytes), off);
  off += U64;
  generation.copy(header, off);
  off += GEN_LEN;
  header.writeUInt32LE(payload.byteLength, off);
  return Buffer.concat([header, payload]);
};

const decodeSidecar = (
  buf: Buffer,
):
  | {
      jsonBytes: number;
      generation: Buffer;
      payload: Buffer;
      recordedNodeMajor: number;
      recordedV8: string;
    }
  | undefined => {
  if (buf.byteLength < FIXED_PREFIX + U64 + GEN_LEN + U32) return undefined;
  if (!buf.subarray(0, MAGIC_LEN).equals(MAGIC)) return undefined;
  if (buf.readUInt32LE(MAGIC_LEN) !== V8_SIDECAR_FORMAT) return undefined;
  const recordedNodeMajor = buf.readUInt16LE(MAGIC_LEN + U32);
  const v8len = buf.readUInt16LE(MAGIC_LEN + U32 + U16);
  const v8off = FIXED_PREFIX;
  if (buf.byteLength < v8off + v8len + U64 + GEN_LEN + U32) return undefined;
  const recordedV8 = buf.subarray(v8off, v8off + v8len).toString('utf8');
  let off = v8off + v8len;
  const jsonBytes = Number(buf.readBigUInt64LE(off));
  off += U64;
  const generation = buf.subarray(off, off + GEN_LEN);
  off += GEN_LEN;
  const payloadBytes = buf.readUInt32LE(off);
  const payloadOff = off + U32;
  if (jsonBytes > Number.MAX_SAFE_INTEGER) return undefined;
  if (buf.byteLength !== payloadOff + payloadBytes) return undefined;
  return {
    jsonBytes,
    generation,
    payload: buf.subarray(payloadOff),
    recordedNodeMajor,
    recordedV8,
  };
};

const encodeBind = (generation: Buffer, jsonBytes: number): Buffer => {
  const buf = Buffer.allocUnsafe(BIND_LEN);
  GEN_MAGIC.copy(buf, 0);
  generation.copy(buf, MAGIC_LEN);
  buf.writeBigUInt64LE(BigInt(jsonBytes), MAGIC_LEN + GEN_LEN);
  return buf;
};

const decodeBind = (buf: Buffer): { generation: Buffer; jsonBytes: number } | undefined => {
  if (buf.byteLength !== BIND_LEN) return undefined;
  if (!buf.subarray(0, MAGIC_LEN).equals(GEN_MAGIC)) return undefined;
  const jsonBytes = Number(buf.readBigUInt64LE(MAGIC_LEN + GEN_LEN));
  if (jsonBytes > Number.MAX_SAFE_INTEGER) return undefined;
  return { generation: buf.subarray(MAGIC_LEN, MAGIC_LEN + GEN_LEN), jsonBytes };
};

const warnSidecar = (err: unknown, jsonPath: string, msg: string): void => {
  logger.warn({ err, jsonPath }, msg);
};

const ignoreMissingUnlink = (err: unknown, jsonPath: string): void => {
  if (isEnoent(err)) return;
  warnSidecar(err, jsonPath, 'v8 sidecar: failed to drop leftover; JSON remains authoritative');
};

const isBindableGeneration = (generation: Buffer, jsonBytes: number): boolean =>
  generation.byteLength === GEN_LEN &&
  Number.isSafeInteger(jsonBytes) &&
  jsonBytes >= 0 &&
  jsonBytes <= 0xffff_ffff;

const unlinkGone = async (target: string, jsonPath: string): Promise<boolean> => {
  try {
    await fs.unlink(target);
    return true;
  } catch (err) {
    ignoreMissingUnlink(err, jsonPath);
    return isEnoent(err);
  }
};

const unlinkGoneSync = (target: string, jsonPath: string): boolean => {
  try {
    unlinkSync(target);
    return true;
  } catch (err) {
    ignoreMissingUnlink(err, jsonPath);
    return isEnoent(err);
  }
};

/**
 * Remove a sidecar. Returns true when the file is gone (deleted or already
 * absent) — i.e. when this invalidation mechanism succeeded.
 */
export const dropV8Sidecar = (jsonPath: string): Promise<boolean> =>
  unlinkGone(v8SidecarPath(jsonPath), jsonPath);

export const dropV8SidecarSync = (jsonPath: string): boolean =>
  unlinkGoneSync(v8SidecarPath(jsonPath), jsonPath);

/** Remove the generation token. Same true-on-gone contract as {@link dropV8Sidecar}. */
export const dropV8Generation = (jsonPath: string): Promise<boolean> =>
  unlinkGone(v8GenerationPath(jsonPath), jsonPath);

const warnStaleV8Unresolvable = (jsonPath: string): void => {
  logger.warn(
    { jsonPath },
    'v8 sidecar: neither generation rotation nor sidecar removal succeeded; ' +
      'keeping the previous cache generation instead of risking a stale V8 read',
  );
};

/**
 * Rotate the durable generation token. Returns false on failure; that is only
 * one of the two invalidation mechanisms and does not by itself authorize a
 * JSON overwrite.
 */
export const bindV8GenerationBestEffort = async (
  jsonPath: string,
  generation: Buffer,
  jsonBytes: number,
): Promise<boolean> => {
  if (!isBindableGeneration(generation, jsonBytes)) return false;
  try {
    await writeFileAtomicBytes(v8GenerationPath(jsonPath), encodeBind(generation, jsonBytes), 1);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    warnSidecar(err, jsonPath, 'v8 sidecar: generation bind failed; JSON remains authoritative');
    return false;
  }
};

export const bindV8GenerationBestEffortSync = (
  jsonPath: string,
  generation: Buffer,
  jsonBytes: number,
): boolean => {
  if (!isBindableGeneration(generation, jsonBytes)) return false;
  try {
    writeFileAtomicBytesSync(v8GenerationPath(jsonPath), encodeBind(generation, jsonBytes));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    warnSidecar(err, jsonPath, 'v8 sidecar: generation bind failed; JSON remains authoritative');
    return false;
  }
};

/** Result of the OR invalidation gate. `blocked` means leave the previous generation. */
export type V8Invalidation = 'blocked' | 'json-only' | 'json+v8';

const decideInvalidation = (
  jsonPath: string,
  generationBound: boolean,
  oldSidecarDropped: boolean,
): V8Invalidation => {
  if (!generationBound && !oldSidecarDropped) {
    warnStaleV8Unresolvable(jsonPath);
    return 'blocked';
  }
  return generationBound ? 'json+v8' : 'json-only';
};

/**
 * Bind a new generation and/or drop the old sidecar. Callers overwrite JSON
 * only when the result is not `blocked`, and publish a new sidecar only for
 * `json+v8`.
 */
export const invalidatePriorV8Generation = async (
  jsonPath: string,
  generation: Buffer,
  jsonBytes: number,
): Promise<V8Invalidation> => {
  const [generationBound, oldSidecarDropped] = await Promise.all([
    bindV8GenerationBestEffort(jsonPath, generation, jsonBytes),
    dropV8Sidecar(jsonPath),
  ]);
  return decideInvalidation(jsonPath, generationBound, oldSidecarDropped);
};

export const invalidatePriorV8GenerationSync = (
  jsonPath: string,
  generation: Buffer,
  jsonBytes: number,
): V8Invalidation =>
  decideInvalidation(
    jsonPath,
    bindV8GenerationBestEffortSync(jsonPath, generation, jsonBytes),
    dropV8SidecarSync(jsonPath),
  );

/** Destination of a copied shard is a new generation — drop `.v8gen` or `.v8`. */
export const prepareCopiedShardDestination = async (jsonPath: string): Promise<boolean> => {
  const [generationDropped, oldSidecarDropped] = await Promise.all([
    dropV8Generation(jsonPath),
    dropV8Sidecar(jsonPath),
  ]);
  if (!generationDropped && !oldSidecarDropped) {
    warnStaleV8Unresolvable(jsonPath);
    return false;
  }
  return true;
};

const jsonFileSize = async (jsonPath: string): Promise<number | undefined> => {
  try {
    return (await fs.stat(jsonPath)).size;
  } catch {
    return undefined;
  }
};

const writeEnvelope = (
  jsonPath: string,
  graph: unknown,
  jsonBytes: number,
  generation: Buffer,
): Buffer | undefined => {
  if (!isBindableGeneration(generation, jsonBytes)) return undefined;
  let payload: Buffer;
  try {
    payload = v8.serialize(graph);
  } catch (err) {
    warnSidecar(err, jsonPath, 'v8 sidecar: serialize failed; JSON remains authoritative');
    return undefined;
  }
  if (payload.byteLength > 0xffff_ffff) return undefined;
  return encodeSidecar(jsonBytes, generation, payload);
};

export const writeV8SidecarBestEffort = async (
  jsonPath: string,
  graph: unknown,
  jsonBytes: number,
  generation: Buffer,
): Promise<void> => {
  const dest = v8SidecarPath(jsonPath);
  const blob = writeEnvelope(jsonPath, graph, jsonBytes, generation);
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
  generation: Buffer,
): void => {
  const dest = v8SidecarPath(jsonPath);
  const blob = writeEnvelope(jsonPath, graph, jsonBytes, generation);
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

const readBindFile = async (
  jsonPath: string,
): Promise<{ generation: Buffer; jsonBytes: number } | undefined> => {
  let buf: Buffer;
  try {
    buf = await fs.readFile(v8GenerationPath(jsonPath));
  } catch (err) {
    if (!isEnoent(err)) {
      logger.debug({ err, jsonPath }, 'v8 sidecar: generation unreadable; falling back to JSON');
    }
    return undefined;
  }
  return decodeBind(buf);
};

/**
 * Load a compatible sidecar. When `internPool` is set, {@link internGraphStrings}
 * runs inside the same best-effort catch as `v8.deserialize` so intern failures
 * fall back to JSON instead of failing analyze.
 */
export const tryLoadV8Sidecar = async (
  jsonPath: string,
  internPool?: Map<string, string>,
): Promise<V8SidecarHit | undefined> => {
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
  const [bound, size] = await Promise.all([readBindFile(jsonPath), jsonFileSize(jsonPath)]);
  if (!bound || !bound.generation.equals(decoded.generation)) return undefined;
  if (size === undefined || size !== decoded.jsonBytes || size !== bound.jsonBytes) {
    return undefined;
  }
  try {
    const value = v8.deserialize(decoded.payload);
    if (internPool) internGraphStrings(value, internPool);
    return { value, bytes: buf.byteLength };
  } catch (err) {
    logger.debug(
      {
        err,
        jsonPath,
        recordedNodeMajor: decoded.recordedNodeMajor,
        recordedV8: decoded.recordedV8,
      },
      'v8 sidecar: materialize failed; falling back to JSON',
    );
    return undefined;
  }
};

export const copyV8SidecarIfPresent = async (srcJson: string, dstJson: string): Promise<void> => {
  try {
    await fs.copyFile(v8SidecarPath(srcJson), v8SidecarPath(dstJson));
  } catch (copyErr) {
    if (!isEnoent(copyErr)) {
      warnSidecar(copyErr, srcJson, 'v8 sidecar: copy failed; JSON remains authoritative');
      return;
    }
    await Promise.all([dropV8Sidecar(dstJson), dropV8Generation(dstJson)]);
    return;
  }
  try {
    await fs.copyFile(v8GenerationPath(srcJson), v8GenerationPath(dstJson));
  } catch (copyErr) {
    if (!isEnoent(copyErr)) {
      warnSidecar(
        copyErr,
        srcJson,
        'v8 sidecar: generation copy failed; JSON remains authoritative',
      );
      return;
    }
    await dropV8Generation(dstJson);
  }
};
