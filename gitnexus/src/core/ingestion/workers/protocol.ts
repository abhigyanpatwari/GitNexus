/**
 * Worker-thread IPC wire format.
 *
 * This module defines the binary frame for messages exchanged between
 * the worker pool and `parse-worker.ts`.
 *
 * Wire layout — one message per buffer, 5-byte header + variable body:
 *
 *     +---------+-----------+---------------------+
 *     | tag     | length    | payload bytes …     |
 *     | 1 byte  | 4 bytes   |                     |
 *     +---------+-----------+---------------------+
 *
 *   - `tag` is one of the {@link MessageTag} values (0x01..0x08).
 *   - `length` is a little-endian uint32 byte count for the payload
 *     region (excludes the header).
 *   - `payload` is a V8-serialized value produced by `node:v8`'s
 *     `serialize()`, decodable via `deserialize()`.
 *
 * **Why V8 serialization (not JSON):** the original U17 implementation
 * used `JSON.stringify` / `JSON.parse` for the body. That silently
 * destroyed every `Map`, `Set`, `Date`, `RegExp`, `BigInt`, `TypedArray`,
 * and `undefined` value in the payload tree because plain JSON has no
 * representation for them. Production scope-resolution code keys data
 * structures on `Map`s throughout (e.g.
 * `ParsedFile.scopes[*].typeBindings: ReadonlyMap<string, TypeRef>`),
 * so the JSON round-trip turned the worker output into structurally
 * wrong data — manifesting as `'X.typeBindings is not iterable'` and
 * silently-broken call resolution on large fixtures.
 *
 * `v8.serialize` / `v8.deserialize` use the V8 structured-clone
 * algorithm — bit-for-bit the same one Node's `worker.postMessage`
 * uses natively. This restores the pre-U17 type-preservation guarantee
 * (Map, Set, Date, RegExp, BigInt, TypedArray, undefined, circular
 * refs, object identity) without depending on a third-party
 * serializer.
 *
 * **Trade-off vs JSON:**
 *   - Pro: full structured-clone compatibility; no per-type tagging
 *     glue (no replacer/reviver to maintain); future-proof for any
 *     new field type production code adds.
 *   - Pro: typically faster than JSON for object-heavy payloads
 *     because V8 uses a binary format and skips string escaping.
 *   - Con: body bytes are opaque (binary, not human-readable). For
 *     debugging, dump via `v8.deserialize(body)` — protocol.test.ts
 *     exercises this on every supported MessageTag.
 *   - Con: format is version-tied to the running Node major. A frame
 *     produced by one Node version isn't guaranteed to decode under
 *     another. The pool always spawns workers on the same Node
 *     instance the main thread runs, so this is moot in production —
 *     but it would matter if we ever persisted frames to disk
 *     (currently nothing does).
 *
 * U17 layers `transferList` over the bulk file-content payload while
 * keeping this module's framing for the surrounding metadata. The
 * envelope is small (path + byteLength per file) so V8 vs JSON
 * encoding overhead is negligible; the win is correctness, not perf.
 */

import { serialize as v8Serialize, deserialize as v8Deserialize } from 'node:v8';

/**
 * 1-byte type tag identifying the message shape on the wire. Values are
 * stable: never re-number an existing tag. New variants append at the
 * next unused byte and {@link isValidTag} below grows accordingly.
 */
export const MessageTag = {
  /** main -> worker: dispatch a sub-batch of files to parse. */
  DispatchJob: 0x01,
  /** worker -> main: parsed result for the sub-batch. */
  Result: 0x02,
  /** worker -> main: incremental progress count. */
  Progress: 0x03,
  /** worker -> main: authoritative in-flight file path for the pool's
   *  attribution layer. */
  StartingFile: 0x04,
  /** worker -> main: sub-batch fully processed; pool may send flush. */
  SubBatchDone: 0x05,
  /** worker -> main: non-fatal warning message. */
  Warning: 0x06,
  /** worker -> main: fatal error (the worker is about to bail). */
  Error: 0x07,
  /** worker -> main: top-of-script init complete; pool may dispatch. */
  Ready: 0x08,
} as const;

export type MessageTagValue = (typeof MessageTag)[keyof typeof MessageTag];

/** Header size: 1-byte tag + 4-byte little-endian length. */
export const PROTOCOL_HEADER_BYTES = 5;

/**
 * Thrown by {@link decodeMessage} when an incoming buffer cannot be
 * parsed as a valid protocol frame. Distinguishable from other errors so
 * the pool-side handler can route protocol violations through the
 * existing `messageerror` recovery layer instead of treating them as
 * silent data loss.
 */
export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolDecodeError';
  }
}

const MIN_TAG = 0x01;
const MAX_TAG = 0x08;

function isValidTag(byte: number): byte is MessageTagValue {
  return byte >= MIN_TAG && byte <= MAX_TAG;
}

/**
 * Encode a single message into a Buffer following the wire layout.
 * `payload` is serialized via `node:v8`'s `serialize()` — full
 * structured-clone fidelity for Map / Set / Date / RegExp / BigInt /
 * TypedArray / undefined / circular refs.
 *
 * Throws `RangeError` if the serialized body exceeds 4 GiB (the
 * uint32 length-field ceiling). In practice the worker_threads
 * postMessage budget caps payloads well below this; the check makes
 * the boundary explicit instead of silently truncating.
 */
export function encodeMessage(tag: MessageTagValue, payload: unknown): Buffer {
  // Normalize undefined → null for parity with the JSON-era contract:
  // every supported tag's payload was either an object or null. The
  // worker side never has to special-case undefined.
  const body = v8Serialize(payload ?? null);
  if (body.length > 0xffffffff) {
    throw new RangeError(
      `protocol payload exceeds uint32 length cap (${body.length} > ${0xffffffff})`,
    );
  }
  const buf = Buffer.allocUnsafe(PROTOCOL_HEADER_BYTES + body.length);
  buf.writeUInt8(tag, 0);
  buf.writeUInt32LE(body.length, 1);
  body.copy(buf, PROTOCOL_HEADER_BYTES);
  return buf;
}

/**
 * Decode a single message from a Buffer (or any Uint8Array containing a
 * frame). The buffer must start with a complete protocol frame; trailing
 * bytes beyond the declared length are ignored.
 *
 * Accepts `Uint8Array` rather than only `Buffer` because Node's
 * worker_threads `postMessage` uses structured clone, which strips the
 * `Buffer` prototype: a `Buffer` sent over the wire arrives on the
 * receiving thread as a plain `Uint8Array`. Buffer extends Uint8Array,
 * so when the input is already a Buffer the readUInt / subarray fast
 * paths still apply; when the input is a bare Uint8Array, we adopt its
 * underlying memory via `Buffer.from(view.buffer, view.byteOffset,
 * view.byteLength)` (a zero-copy view, not a clone) so the rest of the
 * decode runs through the same code path.
 *
 * Throws {@link ProtocolDecodeError} for any of:
 *   - buffer shorter than the 5-byte header
 *   - tag byte outside the valid range
 *   - declared payload length exceeds available bytes
 *   - body bytes are not a valid V8 serialization frame
 */
export function decodeMessage(input: Uint8Array): {
  tag: MessageTagValue;
  payload: unknown;
} {
  const buf: Buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < PROTOCOL_HEADER_BYTES) {
    throw new ProtocolDecodeError(
      `frame too small for header: got ${buf.length} bytes, need ${PROTOCOL_HEADER_BYTES}`,
    );
  }
  const tag = buf.readUInt8(0);
  if (!isValidTag(tag)) {
    throw new ProtocolDecodeError(
      `unknown message tag: 0x${tag.toString(16).padStart(2, '0')} (valid range: 0x01..0x08)`,
    );
  }
  const length = buf.readUInt32LE(1);
  const payloadEnd = PROTOCOL_HEADER_BYTES + length;
  if (buf.length < payloadEnd) {
    throw new ProtocolDecodeError(
      `truncated payload: header declared ${length} bytes, buffer has ${buf.length - PROTOCOL_HEADER_BYTES}`,
    );
  }
  const bodyBytes = buf.subarray(PROTOCOL_HEADER_BYTES, payloadEnd);
  let payload: unknown;
  try {
    payload = v8Deserialize(bodyBytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProtocolDecodeError(`payload is not a valid V8-serialized frame: ${reason}`);
  }
  return { tag, payload };
}
