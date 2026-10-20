/**
 * CommonJS export DECLARATIONS written through a qualified receiver, as the
 * resolver sees them: `module.exports.arrowRequest = (url) => fetch(url)`.
 *
 * The capture side already treats this line as a declaration — the CJS rules in
 * the JS/TS scope queries bind `arrowRequest` into the module scope, exactly as
 * they do for `exports.memberRequest = …` (see `cjs-export-assignment.ts`). But
 * the same line also yields a WRITE reference whose receiver is `module.exports`,
 * and that receiver has a dot in it, so the receiver-bound pass tries to fold it
 * as a compound value, fails, and would file the declaration as a dropped member
 * write. The bare `exports.x = …` spelling never reaches that path at all, which
 * is the inconsistency this closes.
 *
 * Shared by the JavaScript and TypeScript scope resolvers, like the capture-side
 * CJS helpers it mirrors.
 */

import type { ReferenceSite } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { decodeReceiverChain } from '../../utils/receiver-chain-codec.js';

/**
 * True when `site` writes a member of `module.exports` and `module` is the
 * CommonJS module object.
 *
 * `module` must resolve to NOTHING in scope. The canonical UMD wrapper and any
 * `function wrap(module) { … }` take it as a parameter, and a write through that
 * local is a write to a value the resolver cannot type — a real drop, not a
 * declaration. Same rule `cjs-export-assignment.ts` applies to `exports` on the
 * capture side, asked here of the resolved scope chain instead of the AST.
 */
export function isCommonJsExportAssignment(
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
): boolean {
  if (site.kind !== 'write') return false;
  if (!isModuleExportsReceiver(site)) return false;
  const claim = lookupNameClaim(site.inScope, 'module', scopes, {
    position: site.atRange,
    purpose: 'value',
  });
  return claim.status === 'absent';
}

/**
 * The receiver is exactly `module.exports` — one field step off `module`. Read
 * from the minted chain when there is one, so a longer receiver
 * (`module.exports.api.x = …`, a write INTO an exported value) never matches;
 * the receiver text answers only when no chain was minted.
 */
function isModuleExportsReceiver(site: ReferenceSite): boolean {
  const chain = decodeReceiverChain(site.receiverChain);
  if (chain === undefined) return site.explicitReceiver?.name === 'module.exports';
  const [step] = chain.steps;
  return (
    chain.baseReceiverName === 'module' &&
    !chain.truncated &&
    chain.steps.length === 1 &&
    step?.kind === 'field' &&
    step.name === 'exports'
  );
}
