/**
 * One-file V8 cache envelope for parse-cache and ParsedFile shards.
 *
 * Each object-graph shard is a single immutable `.v8` file published by
 * tmp+rename. JSON is not a fallback: a missing, corrupt, runtime-incompatible,
 * or deserialize-failed envelope is a cache miss (re-extract / re-dispatch).
 * Tiny JSON manifests (`index.json`) stay outside this module.
 *
 * Envelope: magic, format, Node major, V8 version, optional path listing,
 * `v8.serialize` of the live graph, then its SHA-256 digest. Path bytes live
 * before the payload so a ParsedFile loader can skip a shard whose listing
 * misses `wantPaths` without deserializing. An unreadable/invalid listing is
 * fail-closed: deserialize, never skip.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import { logger } from '../core/logger.js';
import { linkOrCopyFile, writeFileAtomicBytes, writeFileAtomicBytesSync } from './fs-atomic.js';

const MAGIC = Buffer.from('GNXV8CF1', 'ascii');
/** Envelope version — independent of PARSE_CACHE_VERSION / SCHEMA_BUMP. */
export const V8_CACHE_FORMAT = 4;
const U32 = 4;
const U16 = 2;
const PAYLOAD_HASH_LEN = 32;
const MAGIC_LEN = 8;
const FIXED_PREFIX = MAGIC_LEN + U32 + U16 + U16; // magic + format + nodeMajor + v8len

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

const nodeMajor = (): number => Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

const warnCache = (err: unknown, filePath: string, msg: string): void => {
  logger.warn({ err, filePath }, msg);
};

/** NDJSON listing cannot encode paths that themselves contain CR/LF/NUL. */
export const encodeCachePathListing = (paths: readonly string[]): Buffer => {
  if (paths.length === 0) return Buffer.alloc(0);
  if (paths.some((p) => /[\r\n\0]/.test(p))) return Buffer.alloc(0);
  return Buffer.from(`${paths.length}\n${paths.join('\n')}\n`, 'utf8');
};

/**
 * Parse a counted NDJSON path listing. Returns `null` when it must not be
 * trusted to skip the payload: missing trailing newline, CR/NUL, or a count
 * that does not match the remaining lines.
 */
export const parseCachePathListing = (raw: Buffer): string[] | null => {
  if (raw.byteLength === 0) return [];
  const sidecarRaw = raw.toString('utf8');
  if (sidecarRaw.includes('\0') || sidecarRaw.includes('\r') || !sidecarRaw.endsWith('\n')) {
    return null;
  }
  const nl = sidecarRaw.indexOf('\n');
  if (nl < 0) return null;
  const countToken = sidecarRaw.slice(0, nl);
  if (!/^[0-9]+$/.test(countToken)) return null;
  const count = Number(countToken);
  const body = sidecarRaw.slice(nl + 1);
  const listed = body === '' ? [] : body.slice(0, -1).split('\n');
  if (listed.length !== count) return null;
  return listed;
};

const encodeEnvelope = (graph: unknown, paths: readonly string[]): Buffer | undefined => {
  let payload: Buffer;
  try {
    payload = v8.serialize(graph);
  } catch (err) {
    warnCache(err, '', 'v8 cache: serialize failed; treating as miss on next load');
    return undefined;
  }
  const pathListing = encodeCachePathListing(paths);
  const listed = parseCachePathListing(pathListing);
  const pathCount = listed === null ? 0 : listed.length;
  if (payload.byteLength > 0xffff_ffff || pathListing.byteLength > 0xffff_ffff) return undefined;
  const v8ver = Buffer.from(process.versions.v8, 'utf8');
  if (v8ver.byteLength > 0xffff) return undefined;
  const header = Buffer.allocUnsafe(FIXED_PREFIX + v8ver.length + U32 * 3);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(V8_CACHE_FORMAT, MAGIC_LEN);
  header.writeUInt16LE(nodeMajor(), MAGIC_LEN + U32);
  header.writeUInt16LE(v8ver.length, MAGIC_LEN + U32 + U16);
  v8ver.copy(header, FIXED_PREFIX);
  let off = FIXED_PREFIX + v8ver.length;
  header.writeUInt32LE(pathCount, off);
  off += U32;
  header.writeUInt32LE(pathListing.byteLength, off);
  off += U32;
  header.writeUInt32LE(payload.byteLength, off);
  const payloadHash = createHash('sha256').update(payload).digest();
  return Buffer.concat([header, pathListing, payload, payloadHash]);
};

type EnvelopeMeta = {
  recordedNodeMajor: number;
  recordedV8: string;
  pathCount: number;
  pathBytes: number;
  payloadLen: number;
  pathsOff: number;
  payloadOff: number;
};

const decodePrefix = (buf: Buffer): EnvelopeMeta | undefined => {
  if (buf.byteLength < FIXED_PREFIX) return undefined;
  if (!buf.subarray(0, MAGIC_LEN).equals(MAGIC)) return undefined;
  if (buf.readUInt32LE(MAGIC_LEN) !== V8_CACHE_FORMAT) return undefined;
  const recordedNodeMajor = buf.readUInt16LE(MAGIC_LEN + U32);
  const v8len = buf.readUInt16LE(MAGIC_LEN + U32 + U16);
  const v8off = FIXED_PREFIX;
  const countsOff = v8off + v8len;
  if (buf.byteLength < countsOff + U32 * 3) return undefined;
  const recordedV8 = buf.subarray(v8off, v8off + v8len).toString('utf8');
  const pathCount = buf.readUInt32LE(countsOff);
  const pathBytes = buf.readUInt32LE(countsOff + U32);
  const payloadLen = buf.readUInt32LE(countsOff + U32 * 2);
  const pathsOff = countsOff + U32 * 3;
  const payloadOff = pathsOff + pathBytes;
  return {
    recordedNodeMajor,
    recordedV8,
    pathCount,
    pathBytes,
    payloadLen,
    pathsOff,
    payloadOff,
  };
};

const runtimeCompatible = (meta: EnvelopeMeta): boolean =>
  meta.recordedNodeMajor === nodeMajor() && meta.recordedV8 === process.versions.v8;

export type V8CacheHit = { kind: 'hit'; value: unknown; bytes: number };
export type V8CacheSkip = { kind: 'skip'; bytes: number };
export type V8CacheLoad = V8CacheHit | V8CacheSkip;
export type V8CacheInspection = { paths: readonly string[]; bytes: number };

const readExact = async (
  fh: Awaited<ReturnType<typeof fs.open>>,
  offset: number,
  length: number,
): Promise<Buffer | undefined> => {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
    if (bytesRead === 0) return undefined;
    got += bytesRead;
  }
  return buf;
};

const payloadHashMatches = async (
  fh: Awaited<ReturnType<typeof fs.open>>,
  meta: EnvelopeMeta,
): Promise<boolean> => {
  const payload = await readExact(fh, meta.payloadOff, meta.payloadLen);
  const expected = await readExact(fh, meta.payloadOff + meta.payloadLen, PAYLOAD_HASH_LEN);
  if (!payload || !expected) return false;
  return createHash('sha256').update(payload).digest().equals(expected);
};

/**
 * Validate the immutable envelope metadata needed by the durable ParsedFile
 * warm-hit gate without deserializing its payload. Atomic publication means a
 * runtime-compatible envelope whose exact file length and counted path listing
 * validate is a stable snapshot candidate; malformed/truncated envelopes miss.
 */
export const inspectV8Cache = async (filePath: string): Promise<V8CacheInspection | undefined> => {
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const st = await fh.stat();
    const prefix = await readExact(fh, 0, Math.min(st.size, FIXED_PREFIX + 256 + U32 * 3));
    if (!prefix) return undefined;
    const meta = decodePrefix(prefix);
    if (!meta || !runtimeCompatible(meta)) return undefined;
    if (meta.payloadOff + meta.payloadLen + PAYLOAD_HASH_LEN !== st.size || meta.pathBytes === 0) {
      return undefined;
    }

    const pathRaw =
      prefix.byteLength >= meta.payloadOff
        ? Buffer.from(prefix.subarray(meta.pathsOff, meta.payloadOff))
        : await readExact(fh, meta.pathsOff, meta.pathBytes);
    if (!pathRaw) return undefined;
    const listed = parseCachePathListing(pathRaw);
    if (listed === null || listed.length !== meta.pathCount || listed.length === 0) {
      return undefined;
    }
    if (!(await payloadHashMatches(fh, meta))) return undefined;
    return { paths: listed, bytes: st.size };
  } catch (err) {
    if (!isEnoent(err)) {
      logger.debug({ err, filePath }, 'v8 cache: inspection failed; treating as miss');
    }
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
};

/**
 * Load a cache file. When `wantPaths` is set and a valid non-empty path listing
 * has no intersection, returns `{ kind: 'skip' }` without deserializing.
 * Invalid listings deserialize (fail closed). Envelope/runtime/payload failure
 * returns undefined (miss).
 */
export const tryLoadV8Cache = async (
  filePath: string,
  internPool?: Map<string, string>,
  wantPaths?: ReadonlySet<string>,
): Promise<V8CacheLoad | undefined> => {
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const st = await fh.stat();
    const prefix = await readExact(fh, 0, Math.min(st.size, FIXED_PREFIX + 256 + U32 * 3));
    if (!prefix) return undefined;
    const meta = decodePrefix(prefix);
    if (!meta) return undefined;
    if (!runtimeCompatible(meta)) return undefined;
    if (meta.payloadOff + meta.payloadLen + PAYLOAD_HASH_LEN !== st.size) return undefined;

    let pathRaw = Buffer.alloc(0);
    if (meta.pathBytes > 0) {
      if (prefix.byteLength >= meta.payloadOff) {
        pathRaw = Buffer.from(prefix.subarray(meta.pathsOff, meta.payloadOff));
      } else {
        const raw = await readExact(fh, meta.pathsOff, meta.pathBytes);
        if (!raw) return undefined;
        pathRaw = Buffer.from(raw);
      }
    }

    if (wantPaths && wantPaths.size > 0 && meta.pathBytes > 0) {
      const listed = parseCachePathListing(pathRaw);
      if (
        listed !== null &&
        listed.length === meta.pathCount &&
        listed.length > 0 &&
        !listed.some((p) => wantPaths.has(p))
      ) {
        return { kind: 'skip', bytes: st.size };
      }
    }

    const payload = await readExact(fh, meta.payloadOff, meta.payloadLen);
    if (!payload) return undefined;
    const expectedHash = await readExact(fh, meta.payloadOff + meta.payloadLen, PAYLOAD_HASH_LEN);
    if (!expectedHash || !createHash('sha256').update(payload).digest().equals(expectedHash)) {
      return undefined;
    }
    const value = v8.deserialize(payload);
    if (internPool) internGraphStrings(value, internPool);
    return { kind: 'hit', value, bytes: st.size };
  } catch (err) {
    if (!isEnoent(err)) {
      logger.debug({ err, filePath }, 'v8 cache: load failed; treating as miss');
    }
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
};

export const writeV8CacheFile = async (
  filePath: string,
  graph: unknown,
  paths?: readonly string[],
): Promise<boolean> => {
  const blob = encodeEnvelope(graph, paths ?? []);
  if (!blob) return false;
  try {
    await writeFileAtomicBytes(filePath, blob, 1);
    return true;
  } catch (err) {
    warnCache(err, filePath, 'v8 cache: write failed; treating as miss');
    return false;
  }
};

export const writeV8CacheFileSync = (
  filePath: string,
  graph: unknown,
  paths?: readonly string[],
): boolean => {
  const blob = encodeEnvelope(graph, paths ?? []);
  if (!blob) return false;
  try {
    writeFileAtomicBytesSync(filePath, blob);
    return true;
  } catch (err) {
    warnCache(err, filePath, 'v8 cache: write failed; treating as miss');
    return false;
  }
};

export const copyV8CacheIfPresent = async (srcPath: string, dstPath: string): Promise<boolean> => {
  try {
    await linkOrCopyFile(srcPath, dstPath);
    return true;
  } catch (copyErr) {
    if (!isEnoent(copyErr)) {
      warnCache(copyErr, srcPath, 'v8 cache: copy failed; treating as miss');
    }
    return false;
  }
};
