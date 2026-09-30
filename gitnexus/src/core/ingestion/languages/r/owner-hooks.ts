/**
 * R owner hooks for the shared ingestion pipeline.
 *
 * R has no class syntax: R6 / RefClass members belong to a call or assignment
 * (`Foo <- R6::R6Class(...)`, `setRefClass(...)`), not to an enclosing
 * container node. `resolveMemberOwnerNode` hands the member extractors that
 * owner node. Members whose owner is a string (`setMethod("area", "Circle",
 * ...)`) or a top-level R6/RefClass call are instead tied to their class after
 * all chunks merge: `definitionPropertiesExtractor` records the owner name as
 * an `ownerNameHint`, resolved by R's `postParse` hook.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { DefinitionPropertiesContext } from '../../language-provider.js';
import { findRFieldOwnerNode, getRTopLevelPropertyOwnerName } from '../../field-extractors/r.js';
import { getRTopLevelMethodOwnerName } from '../../method-extractors/r.js';

/** `LanguageProvider.resolveMemberOwnerNode` for R. */
export const rResolveMemberOwnerNode = (definitionNode: SyntaxNode): SyntaxNode | null =>
  findRFieldOwnerNode(definitionNode);

/**
 * `LanguageProvider.definitionPropertiesExtractor` for R: the deferred owner
 * name (`ownerNameHint`) of a `Method`/`Property` whose owning class is named by
 * a string argument or a top-level R6/RefClass call rather than a syntactic
 * ancestor.
 */
export const rDefinitionProperties = (
  ctx: DefinitionPropertiesContext,
): Readonly<Record<string, unknown>> | undefined => {
  const ownerNameHint =
    ctx.nodeLabel === 'Method'
      ? (getRTopLevelMethodOwnerName(ctx.definitionNode) ??
        getRTopLevelPropertyOwnerName(ctx.definitionNode))
      : ctx.nodeLabel === 'Property'
        ? getRTopLevelPropertyOwnerName(ctx.definitionNode)
        : null;
  return ownerNameHint ? { ownerNameHint } : undefined;
};
