/**
 * Worker-thread IPC wire format (U16, scaffold for U17 migration).
 *
 * This module defines the binary frame for messages exchanged between
 * the worker pool and `parse-worker.ts`. It is intentionally NOT wired
 * into `worker-pool.ts` / `parse-worker.ts` in this commit — the
 * production migration is U17. Shipping the wire-format contract first,
 * as an isolated and fully-tested module, de-risks U17 by establishing
 * a single source of truth for the byte layout.
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
 *   - `payload` is a UTF-8 JSON-encoded value, possibly `"null"`.
 *
 * Why JSON for the body (vs per-shape binary encoders): the doc-review
 * adversarial reviewer (A2) flagged that a true per-shape binary encoder
 * for the result message — which carries nested heterogeneous
 * extracted-call / import / heritage / route arrays — would be 500-1500
 * LOC and a substantial maintenance burden. The honest perf win the
 * IPC repack targets is moving file CONTENTS via `ArrayBuffer`
 * `transferList` (zero-copy ownership transfer for the largest single
 * piece of state in any message). That win is captured by U17 layering
 * `transferList` over the bulk file-content payload while keeping this
 * module's framing for the surrounding metadata. If U18 benchmark data
 * shows the JSON body is itself a bottleneck after U17 lands, a
 * follow-up unit can swap to per-shape binary encoding behind this
 * same `encodeMessage` / `decodeMessage` surface without changing the
 * frame.
 */

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
 * U17's pool-side handler can route protocol violations through the
 * existing `messageerror` recovery layer (U3 H1) instead of treating
 * them as silent data loss.
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
 * `payload` is JSON-stringified; pass `undefined` or `null` for messages
 * with no body. The returned Buffer can be sent verbatim via
 * `worker.postMessage(buf)` once U17 swaps the dispatch layer over.
 *
 * Throws `RangeError` if the payload encodes to more than 4 GiB (the
 * uint32 length-field ceiling). In practice the structured-clone budget
 * caps payloads well below this, but the check makes the boundary
 * explicit instead of silently truncating.
 */
export function encodeMessage(tag: MessageTagValue, payload: unknown): Buffer {
  const json = JSON.stringify(payload ?? null);
  // `Buffer.byteLength(string, 'utf8')` returns the encoded byte length
  // without allocating an intermediate Buffer. Pre-checking it lets us
  // surface the uint32 cap as a RangeError before any allocation.
  const length = Buffer.byteLength(json, 'utf8');
  if (length > 0xffffffff) {
    throw new RangeError(`protocol payload exceeds uint32 length cap (${length} > ${0xffffffff})`);
  }
  // Single allocation, single write pass: `buf.write(string, offset,
  // 'utf8')` writes UTF-8 bytes directly into the target without an
  // intermediate `Buffer.from(string, 'utf8')` allocation + memcpy.
  // Halves the per-frame allocation count vs the previous two-Buffer +
  // copy approach — material under high message volume (every dispatch
  // envelope, every worker reply).
  const buf = Buffer.allocUnsafe(PROTOCOL_HEADER_BYTES + length);
  buf.writeUInt8(tag, 0);
  buf.writeUInt32LE(length, 1);
  buf.write(json, PROTOCOL_HEADER_BYTES, 'utf8');
  return buf;
}

/**
 * Decode a single message from a Buffer (or any Uint8Array containing a
 * frame). The buffer must start with a complete protocol frame; trailing
 * bytes beyond the declared length are ignored (callers receiving a
 * concatenated stream should slice at `PROTOCOL_HEADER_BYTES + length`
 * before decoding the next frame).
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
 *   - payload bytes are not valid UTF-8 JSON
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
  const json = buf.subarray(PROTOCOL_HEADER_BYTES, payloadEnd).toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProtocolDecodeError(`payload is not valid JSON: ${reason}`);
  }
  return { tag, payload };
}
