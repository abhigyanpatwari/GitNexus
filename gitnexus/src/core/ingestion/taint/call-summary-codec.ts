/**
 * Call-summary reason codec (PDG FU-C, U-C2) — the ONE shared encoder/decoder
 * for the bitset carried on persisted `CALL_SUMMARY` edges.
 *
 * A `CALL_SUMMARY` edge is a self-loop on a Function/Method/Constructor node
 * recording that callee's RETURN-VALUE ASCENT: for each formal-parameter index,
 * whether that parameter flows to the function's return value. The producer
 * (the whole-program emit phase) writes this; a later consumer phase reads it to
 * ascend a callee's return effect into the caller continuation. Two hand-rolled
 * copies of a wire format drift — both sides MUST import from here (the same
 * discipline `path-codec.ts` documents).
 *
 * ## Wire format (version `1`)
 *
 * ```
 * 1|r:<hexbitset>[|<reserved-segment>…]
 * ```
 *
 * - One-character version prefix ({@link CALL_SUMMARY_CODEC_VERSION}), then `|`,
 *   then a `r:` (return) segment whose payload is the param→return bitset as a
 *   lowercase hex string (LSB = formal index 0). Bit `i` set ⇒ formal parameter
 *   `i` flows to the return value. An empty/zero bitset is the absence of any
 *   return-flow (a sound EMPTY summary — never a false claim).
 * - FORWARD COMPATIBILITY: the format reserves space for future facts via
 *   additional trailing `|<tag>:<payload>` segments (planned: `o:` out-params,
 *   `e:` exception ascent — both deferred: out-params need an alias model,
 *   exception ascent needs try/catch CDG). The decoder accepts and ignores any
 *   trailing segment whose tag it does not understand, so a future writer's
 *   output stays decodable by today's reader (and vice-versa: today's reader
 *   only requires the `r:` segment). Reserved tags MUST stay disjoint from `r`.
 *
 * ## Delimiter / round-trip discipline (mirrors path-codec KTD6)
 *
 * Every structural character (`|`, `:`, the version digit, hex digits `[0-9a-f]`)
 * is printable ASCII, so the encoding survives `escapeCSVField ∘ sanitizeUTF8`
 * (csv-generator.ts) byte-exact (pinned by the round-trip test). The hex payload
 * is a non-negative integer rendered via BigInt, so the codec handles functions
 * with arbitrarily many formal parameters without overflow.
 *
 * The decoder NEVER throws — anything malformed yields a typed failure, exactly
 * like `decodeTaintPath`. A decode failure on the consumer side means "no usable
 * ascent fact", which is the sound default (never claim a false return-flow).
 */

/** One-character format version prefix. Bump on any wire-format change. */
export const CALL_SUMMARY_CODEC_VERSION = '1';

/** Return-flow segment tag (`r:<hexbitset>`). */
const RETURN_TAG = 'r';

/** Hex payload charset (lowercase). */
const HEX = /^[0-9a-f]+$/;

/** A decoded call summary's facts. Forward-compatible: future facts add fields. */
export interface DecodedCallSummary {
  readonly ok: true;
  readonly version: string;
  /**
   * Sorted, de-duplicated formal-parameter indices that flow to the return
   * value (ascending). Empty ⇒ no return-flow recorded (sound EMPTY summary).
   */
  readonly returnFlowParams: readonly number[];
}

/** Typed parse failure — the decoder never throws. */
export interface CallSummaryDecodeFailure {
  readonly ok: false;
  readonly error: string;
}

export type CallSummaryDecodeResult = DecodedCallSummary | CallSummaryDecodeFailure;

/**
 * Pack a set of return-flowing formal-parameter indices into a bitset (LSB =
 * index 0). Negative or non-integer indices are ignored (defensive; the
 * harvester only ever passes non-negative integers). Returns a `BigInt`.
 */
function packReturnBitset(returnFlowParams: Iterable<number>): bigint {
  let bits = 0n;
  for (const idx of returnFlowParams) {
    if (!Number.isInteger(idx) || idx < 0) continue;
    bits |= 1n << BigInt(idx);
  }
  return bits;
}

/**
 * Encode the param→return ascent into the versioned `reason` wire string.
 * Deterministic; never throws. `returnFlowParams` is the set of formal indices
 * that flow to the return value (order/duplication irrelevant — the bitset
 * canonicalises). An empty set encodes as `r:0` (an explicit empty summary).
 */
export function encodeCallSummary(returnFlowParams: Iterable<number>): string {
  const bits = packReturnBitset(returnFlowParams);
  return `${CALL_SUMMARY_CODEC_VERSION}|${RETURN_TAG}:${bits.toString(16)}`;
}

/**
 * Decode a `CALL_SUMMARY` reason wire string into its ascent facts. Returns a
 * typed failure for anything that is not a well-formed version-`1` summary —
 * never throws. Unknown trailing segments (future facts) are accepted and
 * ignored (forward compatibility).
 */
export function decodeCallSummary(reason: unknown): CallSummaryDecodeResult {
  if (typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, error: 'empty or non-string reason' };
  }
  // Read the version as the substring BEFORE the first '|' (NOT a single char):
  // the wire format reserves multi-digit future versions, so a `12|…` writer must
  // degrade to a clean 'unsupported version' typed-failure here, never silently
  // parse as version '1' with a stray '2' segment. No '|' ⇒ the whole reason is a
  // bare token with no body, which is malformed.
  const firstSep = reason.indexOf('|');
  if (firstSep === -1) {
    return { ok: false, error: 'malformed body: expected a segment separator after the version' };
  }
  const version = reason.slice(0, firstSep);
  if (version !== CALL_SUMMARY_CODEC_VERSION) {
    return { ok: false, error: `unsupported call-summary version '${version}'` };
  }
  const segments = reason.slice(firstSep + 1).split('|');
  let returnBits: bigint | undefined;
  for (const seg of segments) {
    const sep = seg.indexOf(':');
    if (sep === -1) {
      return { ok: false, error: `malformed segment '${seg}' (expected '<tag>:<payload>')` };
    }
    const tag = seg.slice(0, sep);
    const payload = seg.slice(sep + 1);
    if (tag === RETURN_TAG) {
      if (!HEX.test(payload)) {
        return { ok: false, error: `invalid return bitset '${payload}'` };
      }
      returnBits = BigInt(`0x${payload}`);
    }
    // Unknown tag (reserved future fact): accept + ignore for forward compat.
  }
  if (returnBits === undefined) {
    return { ok: false, error: "missing required 'r:' return segment" };
  }
  // Unpack the bitset into ascending formal indices.
  const returnFlowParams: number[] = [];
  let bits = returnBits;
  let idx = 0;
  while (bits > 0n) {
    if ((bits & 1n) === 1n) returnFlowParams.push(idx);
    bits >>= 1n;
    idx++;
  }
  return { ok: true, version, returnFlowParams };
}
