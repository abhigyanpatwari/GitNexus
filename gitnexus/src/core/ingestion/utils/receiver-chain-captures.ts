/**
 * Synthesize `@reference.receiver-chain` for a call match whose receiver is
 * itself an expression.
 *
 * Shared across every language emitter, and deliberately language-free (AGENTS.md
 * R6): the call gate reads the `@reference.call.*` tag vocabulary, which is
 * shared by every language's `.scm` query, rather than a per-language tag list.
 *
 * Lives in the emitter layer rather than the query because a `.scm` pattern
 * cannot call `extractMixedChain`, and the receiver capture originates in
 * several patterns per language.
 */

import type { Capture } from 'gitnexus-shared';

import type { SyntaxNode } from './ast-helpers.js';
import { syntheticCapture } from './ast-helpers.js';
import { extractMixedChain } from './call-analysis.js';
import { encodeReceiverChain } from './receiver-chain-codec.js';

/** Tag prefix marking a match as a CALL. `@reference.callable` is deliberately
 *  excluded by the trailing dot — it marks a callable VALUE, not a call site. */
const CALL_TAG_PREFIX = '@reference.call.';

/** Does this match represent a call? */
function isCallMatch(grouped: Record<string, Capture>): boolean {
  for (const tag of Object.keys(grouped)) {
    if (tag.startsWith(CALL_TAG_PREFIX)) return true;
  }
  return false;
}

/**
 * Add `@reference.receiver-chain` to `grouped` when the match is a call whose
 * receiver decodes to a chain over a nameable base. Mutates `grouped` in place
 * and returns nothing — mirroring how the other synthesized captures are added.
 *
 * Gated on the call tags: without that gate this fires on read, write and JSX
 * receivers too, which pay the AST walk and the persisted bytes for a field no
 * call-site resolver reads.
 *
 * A chain is minted ONLY when the walk reached a nameable base.
 * `extractMixedChain` reports `baseReceiverName: undefined` whenever it stopped
 * early — at `MAX_CHAIN_DEPTH`, or because a step could not be read — and what it
 * collected then is a partial chain missing exactly the head that decides the
 * final type. Encoding that would turn a receiver we cannot type into one we type
 * WRONGLY, so those fall through to the resolver's existing text cascade.
 */
export function synthesizeReceiverChainCapture(
  grouped: Record<string, Capture>,
  receiverNode: SyntaxNode | undefined | null,
): void {
  if (receiverNode === undefined || receiverNode === null) return;
  if (grouped['@reference.receiver-chain'] !== undefined) return;
  if (!isCallMatch(grouped)) return;

  const extracted = extractMixedChain(receiverNode);
  if (extracted === undefined || extracted.baseReceiverName === undefined) return;

  const encoded = encodeReceiverChain(extracted.baseReceiverName, extracted.chain);
  if (encoded === undefined) return;

  grouped['@reference.receiver-chain'] = syntheticCapture(
    '@reference.receiver-chain',
    receiverNode,
    encoded,
  );
}
