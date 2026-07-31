/**
 * Receiver-chain codec.
 *
 * THE one encoder/decoder for the compact receiver chain carried on
 * `ReferenceSite.receiverChain`: the capture emitters write it, the
 * scope-resolution fold reads it, and the durable ParsedFile store validates
 * it. Two hand-rolled copies of a wire format drift — every side MUST import
 * from here. (`taint/path-codec.ts` is the in-repo precedent for both the
 * discipline and the shape.)
 *
 * ## Why a string rather than `MixedChainStep[]`
 *
 * `makeInterningReviver` (parsedfile-store.ts) interns strings, but it
 * re-shares OBJECTS only when they carry `nodeId` + `filePath`. A
 * `MixedChainStep` has neither, so an object encoding leaves every step object
 * and every chain array as a distinct allocation on every warm load, while a
 * string collapses to one interned instance per distinct chain.
 *
 * ## Wire format (version `1`)
 *
 * ```
 * 1|<base>|<step>|<step>…[|~]
 * ```
 *
 * - One-character version prefix, then the BASE receiver name, then ordered
 *   base-first steps.
 * - Each step is a one-character kind sigil followed by the member name:
 *   `c` = call (`getUser()`), `f` = field (`address`). The sigil is the first
 *   character of the segment and the name follows immediately, so a member
 *   whose name begins with `c` or `f` needs no escaping (`ccount` decodes as a
 *   call to `count`).
 * - A trailing `|~` segment is the TRUNCATION MARKER. NOTE: no current producer
 *   mints one. `extractMixedChain` signals "stopped early" by returning
 *   `baseReceiverName: undefined`, and the encoder requires a base, so a
 *   truncated chain is unrepresentable rather than merely unused. The marker and
 *   the decoder/fold guards are kept as a forward-compatible contract: a future
 *   producer that CAN report a partial chain must set it, and the fold already
 *   refuses such chains. Read the `truncated` field as "reserved", not "live". the chain hit
 *   `MAX_CHAIN_DEPTH` and what is encoded is a base-side PREFIX of the real
 *   chain. A consumer MUST treat a truncated chain as unusable for typing —
 *   the missing tail is exactly what determines the final type — but never as
 *   an error.
 *
 * `|` and `~` cannot appear in an identifier in any supported language, so the
 * format needs no escaping and a malformed payload cannot silently decode as a
 * different valid chain.
 *
 * For `svc.getUser().address.save()`, the receiver of `save` encodes as
 * `1|svc|cgetUser|faddress` — 23 bytes.
 */

import type { MixedChainStep } from 'gitnexus-shared';

import { MAX_CHAIN_DEPTH } from './call-analysis.js';

const VERSION = '1';
const SEPARATOR = '|';
const TRUNCATED = '~';

/** Hard cap on the encoded payload. `MAX_CHAIN_DEPTH` already bounds the step
 *  COUNT; this bounds the total bytes so a pathological identifier cannot grow
 *  a shard without limit. Generous against real identifiers — the encoding for
 *  a full-depth chain of 30-character names is still under 130 bytes. */
export const MAX_RECEIVER_CHAIN_BYTES = 512;

export interface DecodedReceiverChain {
  readonly baseReceiverName: string;
  readonly steps: readonly MixedChainStep[];
  /** The encoded chain is a base-side prefix — the real chain was longer.
   *  Typing off a truncated chain would type off the wrong member. */
  readonly truncated: boolean;
}

/** A segment is safe when it contains no structural character. Identifiers in
 *  every supported language satisfy this; anything that does not is a payload
 *  we refuse to mint rather than escape. */
function isEncodableSegment(value: string): boolean {
  // `\s` does NOT match zero-width characters (U+200B ZWS, U+200C/D ZWNJ/ZWJ,
  // U+200E/F LRM/RLM, U+FEFF BOM). An identifier carrying one is a trojan-source
  // vector: it would encode and persist cleanly, then match no binding at
  // resolution time — a silent, unexplained miss. Refuse to mint instead.
  return (
    value.length > 0 &&
    !value.includes(SEPARATOR) &&
    !value.includes(TRUNCATED) &&
    !/[\s\u200B-\u200F\u2028\u2029\uFEFF]/.test(value)
  );
}

/**
 * Encode a chain, or `undefined` when it cannot be represented — an empty
 * chain (nothing to fold), an unencodable name, or a payload over the byte
 * cap. Refusing to mint is deliberate: a half-encoded chain would be decoded
 * as a complete-but-different one.
 */
export function encodeReceiverChain(
  baseReceiverName: string,
  steps: readonly MixedChainStep[],
  options?: { readonly truncated?: boolean },
): string | undefined {
  if (steps.length === 0 || steps.length > MAX_CHAIN_DEPTH) return undefined;
  if (!isEncodableSegment(baseReceiverName)) return undefined;

  const parts = [VERSION, baseReceiverName];
  for (const step of steps) {
    if (!isEncodableSegment(step.name)) return undefined;
    parts.push(`${step.kind === 'call' ? 'c' : 'f'}${step.name}`);
  }
  if (options?.truncated === true) parts.push(TRUNCATED);

  const encoded = parts.join(SEPARATOR);
  return encoded.length > MAX_RECEIVER_CHAIN_BYTES ? undefined : encoded;
}

/**
 * Decode a payload, or `undefined` when it is not a well-formed chain. Total
 * function: every malformed input returns `undefined` rather than throwing,
 * because the two callers that matter — the extractor and the untrusted store
 * boundary — are both on paths where a throw would cost the whole file.
 */
export function decodeReceiverChain(value: unknown): DecodedReceiverChain | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_RECEIVER_CHAIN_BYTES) return undefined;

  const parts = value.split(SEPARATOR);
  if (parts.length < 3) return undefined; // version + base + at least one step
  if (parts[0] !== VERSION) return undefined;

  // `parts.length < 3` above already proves this element exists.
  const baseReceiverName = parts[1] as string;
  if (!isEncodableSegment(baseReceiverName)) return undefined;

  let stepParts = parts.slice(2);
  const truncated = stepParts[stepParts.length - 1] === TRUNCATED;
  if (truncated) stepParts = stepParts.slice(0, -1);
  if (stepParts.length === 0 || stepParts.length > MAX_CHAIN_DEPTH) return undefined;

  const steps: MixedChainStep[] = [];
  for (const part of stepParts) {
    const sigil = part[0];
    const name = part.slice(1);
    if (sigil !== 'c' && sigil !== 'f') return undefined;
    if (!isEncodableSegment(name)) return undefined;
    steps.push({ kind: sigil === 'c' ? 'call' : 'field', name });
  }

  return { baseReceiverName, steps, truncated };
}

/** Whether a persisted value is a chain this build can use. The store boundary
 *  wants the predicate, not the decoded value. */
export function isValidReceiverChain(value: unknown): value is string {
  return decodeReceiverChain(value) !== undefined;
}
