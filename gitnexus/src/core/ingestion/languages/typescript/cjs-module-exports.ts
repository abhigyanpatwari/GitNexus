/**
 * CommonJS module-export capture synthesis, shared by the JavaScript and
 * TypeScript emitters (#2723; TS parity per the #2729 review, F7).
 *
 * These declarations cannot come from the tree-sitter queries: the anonymous
 * default export takes its name from the FILE, which a query pattern cannot
 * see. They therefore had to be synthesized in the emitter — and living only in
 * `javascript/captures.ts` meant a `.ts` file emitted the default-export NODE
 * (the query and `labelOverride` are wired on both providers) while nothing
 * ever declared it. That is precisely the "found, zero callers" half-fix state
 * this issue set out to remove, reintroduced for TypeScript.
 *
 * Every grammar node named here exists in both `tree-sitter-javascript` and
 * `tree-sitter-typescript`, so one implementation serves both.
 *
 * Pure given the input nodes. No I/O, no globals.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { deriveDefaultExportHocName } from '../../ts-js-hoc-utils.js';
import { defaultExportNameCollides } from './cjs-export-assignment.js';

/**
 * Synthesize re-export markers for CJS forwarding assignments (#2723).
 *
 *   const lib = require('./lib');
 *   exports.forwarded = lib.imported;   // re-export of `imported` from ./lib
 *   const { imported } = require('./lib');
 *   exports.alsoForwarded = imported;   // same, through a named binding
 *
 * The right-hand side is an existing symbol rather than a function literal, so
 * no definition rule reaches it and importers of `forwarded` resolved to
 * nothing. Emitted with the `named-alias` vocabulary the destructured
 * `require()` form already uses, so `interpretJsImport` needs no new case.
 *
 * `exports.foo = localFn` (a locally DECLARED function) is deliberately not
 * handled here: the module scope already binds `localFn`, importers already
 * resolve through it, and synthesizing a second binding would re-create the
 * ambiguity the shadow guard exists to prevent.
 */
export function synthesizeCjsReExports(root: SyntaxNode, out: CaptureMatch[]): void {
  // Namespace and named bindings introduced by require(), by local name.
  const namespaceSources = new Map<string, { source: string; node: SyntaxNode }>();
  const namedSources = new Map<string, { source: string; name: string; node: SyntaxNode }>();

  for (const child of root.namedChildren) {
    if (child.type !== 'lexical_declaration' && child.type !== 'variable_declaration') continue;
    for (const declarator of child.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const value = declarator.childForFieldName('value');
      if (value === null || value.type !== 'call_expression') continue;
      if (value.childForFieldName('function')?.text !== 'require') continue;
      const arg = value.childForFieldName('arguments')?.namedChild(0);
      if (arg === undefined || arg === null || arg.type !== 'string') continue;
      const source = arg.namedChild(0)?.text ?? arg.text.slice(1, -1);

      const nameNode = declarator.childForFieldName('name');
      if (nameNode === null) continue;
      if (nameNode.type === 'identifier') {
        namespaceSources.set(nameNode.text, { source, node: arg });
      } else if (nameNode.type === 'object_pattern') {
        for (const field of nameNode.namedChildren) {
          if (field.type === 'shorthand_property_identifier_pattern') {
            namedSources.set(field.text, { source, name: field.text, node: arg });
          } else if (field.type === 'pair_pattern') {
            const key = field.childForFieldName('key');
            const local = field.childForFieldName('value');
            if (key !== null && local !== null && local.type === 'identifier')
              namedSources.set(local.text, { source, name: key.text, node: arg });
          }
        }
      }
    }
  }

  if (namespaceSources.size === 0 && namedSources.size === 0) return;

  for (const child of root.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const assignment = child.namedChild(0);
    if (assignment === null || assignment.type !== 'assignment_expression') continue;

    const left = assignment.childForFieldName('left');
    if (left === null || left.type !== 'member_expression') continue;
    const receiver = left.childForFieldName('object');
    const exposed = left.childForFieldName('property');
    if (receiver === null || exposed === null || exposed.type !== 'property_identifier') continue;

    const isExportsReceiver =
      (receiver.type === 'identifier' && receiver.text === 'exports') ||
      (receiver.type === 'member_expression' &&
        receiver.childForFieldName('object')?.text === 'module' &&
        receiver.childForFieldName('property')?.text === 'exports');
    if (!isExportsReceiver) continue;

    const right = assignment.childForFieldName('right');
    if (right === null) continue;

    // `exports.fwd = ns.member`
    if (right.type === 'member_expression') {
      const ns = right.childForFieldName('object');
      const member = right.childForFieldName('property');
      if (ns === null || member === null || ns.type !== 'identifier') continue;
      const origin = namespaceSources.get(ns.text);
      if (origin === undefined) continue;
      out.push({
        '@import.statement': syntheticCapture('@import.statement', assignment, origin.source),
        '@import.kind': syntheticCapture('@import.kind', assignment, 'reexport-alias'),
        '@import.name': syntheticCapture('@import.name', member, member.text),
        '@import.alias': syntheticCapture('@import.alias', exposed, exposed.text),
        '@import.source': syntheticCapture('@import.source', origin.node, origin.source),
      });
      continue;
    }

    // `exports.fwd = importedName`
    if (right.type === 'identifier') {
      const origin = namedSources.get(right.text);
      if (origin === undefined) continue;
      out.push({
        '@import.statement': syntheticCapture('@import.statement', assignment, origin.source),
        '@import.kind': syntheticCapture('@import.kind', assignment, 'reexport-alias'),
        '@import.name': syntheticCapture('@import.name', right, origin.name),
        '@import.alias': syntheticCapture('@import.alias', exposed, exposed.text),
        '@import.source': syntheticCapture('@import.source', origin.node, origin.source),
      });
    }
  }
}

/**
 * Synthesize the scope declaration for `module.exports = <function>` (#2723).
 *
 * The graph node for this comes from the definition query, but the scope query
 * cannot produce its name: an anonymous default export takes its name from the
 * FILE, which a tree-sitter pattern has no access to. Without a declaration the
 * node exists and nothing resolves to it — the half-fixed state this issue's
 * first commit already had to correct once.
 *
 * A named function expression (`module.exports = function named() {}`) keeps
 * its own name; the anonymous forms use `deriveDefaultExportHocName`, the
 * convention already applied to anonymous default exports elsewhere.
 */
export function synthesizeCjsDefaultExport(
  root: SyntaxNode,
  filePath: string,
  out: CaptureMatch[],
): void {
  for (const child of root.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const assignment = child.namedChild(0);
    if (assignment === null || assignment.type !== 'assignment_expression') continue;

    const left = assignment.childForFieldName('left');
    if (left === null || left.type !== 'member_expression') continue;
    if (left.childForFieldName('object')?.text !== 'module') continue;
    if (left.childForFieldName('property')?.text !== 'exports') continue;

    const value = assignment.childForFieldName('right');
    if (value === null) continue;
    if (
      value.type !== 'function_expression' &&
      value.type !== 'arrow_function' &&
      value.type !== 'generator_function'
    )
      continue;

    const ownName = value.childForFieldName('name');
    const name = ownName?.text ?? deriveDefaultExportHocName(filePath);

    // Mirror the worker's suppression: when the DERIVED name collides with a
    // callable the module already declares, emit nothing. Declaring it anyway
    // would bind a second callable under one name, merging two functions onto
    // one node and fabricating a self-recursive call edge (#2729 review F4).
    if (ownName === null && defaultExportNameCollides(assignment, root, name)) continue;

    // Anchored on the INNER function so the declaration range matches the
    // `@scope.function` range — the same anchor discipline as every other
    // closure-binding rule.
    out.push({
      '@declaration.function': nodeToCapture('@declaration.function', value),
      '@declaration.name': syntheticCapture('@declaration.name', ownName ?? value, name),
    });
  }
}

/** Run every CommonJS export-capture synthesis pass for one file. */
export function synthesizeCjsModuleExports(
  root: SyntaxNode,
  filePath: string,
  out: CaptureMatch[],
): void {
  synthesizeCjsReExports(root, out);
  synthesizeCjsDefaultExport(root, filePath, out);
}
