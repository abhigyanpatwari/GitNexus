/**
 * R owner hooks for the shared ingestion pipeline.
 *
 * R has no class syntax: R6 / RefClass members belong to a call or assignment
 * (`Foo <- R6::R6Class(...)`, `setRefClass(...)`), not to an enclosing
 * container node. `resolveMemberOwnerNode` hands the member extractors that
 * owner node.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { findRFieldOwnerNode } from '../../field-extractors/r.js';

/** `LanguageProvider.resolveMemberOwnerNode` for R. */
export const rResolveMemberOwnerNode = (definitionNode: SyntaxNode): SyntaxNode | null =>
  findRFieldOwnerNode(definitionNode);
