import type { ParsedFile, ReferenceSite } from 'gitnexus-shared';
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
  parsed: ParsedFile,
): boolean {
  if (parsed.captureSideChannel !== true) return false;
  if (site.kind !== 'write') return false;
  if (!isModuleExportsReceiver(site)) return false;
  const claim = lookupNameClaim(site.inScope, 'module', scopes, {
    position: site.atRange,
    purpose: 'value',
  });
  return claim.status === 'absent';
}

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
