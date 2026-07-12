/**
 * `emitSolidityScopeCaptures` — query-driven captures + heritage synthesis
 * + import decomposition.
 */

import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getSolidityParser, getSolidityScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitSolidityImportDirective } from './import-decomposer.js';
import { synthesizeUsingForCalls } from './using-for.js';
import { synthesizeEmitAndRevert } from './emit-revert.js';
import { synthesizeAllSolidityReceiverBindings } from './receiver-binding.js';
import { SOLIDITY_BUILT_INS, SOLIDITY_BUILTIN_RECEIVERS } from './built-ins.js';

const TYPE_DECLS = new Set([
  'contract_declaration',
  'interface_declaration',
  'library_declaration',
]);

function specialFunctionName(node: SyntaxNode): string | null {
  if (node.type === 'constructor_definition') return 'constructor';
  if (node.type === 'fallback_receive_definition') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      const text = child.text.trim();
      if (text === 'receive' || text === 'fallback') return text;
    }
    return 'fallback';
  }
  return null;
}

function synthesizeHeritage(root: SyntaxNode, out: CaptureMatch[]): void {
  walkNamedTree(root, (node) => {
    if (!TYPE_DECLS.has(node.type)) return;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child || child.type !== 'inheritance_specifier') continue;
      const ancestor = child.childForFieldName('ancestor');
      if (!ancestor) continue;
      // Prefer the trailing identifier inside user_defined_type (Base / pkg.Base).
      const nameNode =
        ancestor.type === 'identifier' ? ancestor : (ancestor.lastNamedChild ?? ancestor);
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', ancestor),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  });
}

/**
 * Modifier use sites (`function f() onlyOwner onlyRole(r)`) are
 * `modifier_invocation` nodes, not `call_expression`. Emit free-call
 * captures so Phase-2 CALLS edges resolve function → modifier.
 *
 * AST shape (tree-sitter-solidity@1.1.0): first named child is the modifier
 * name (`identifier` or `member_expression`); remaining named children are
 * arguments (no `arguments` wrapper).
 */
function synthesizeModifierInvocations(root: SyntaxNode, out: CaptureMatch[]): void {
  walkNamedTree(root, (node) => {
    if (node.type !== 'modifier_invocation') return;

    const first = node.namedChild(0);
    if (!first) return;

    let nameNode: SyntaxNode | null = null;
    if (first.type === 'identifier' || first.type === 'property_identifier') {
      nameNode = first;
    } else if (first.type === 'member_expression') {
      nameNode = first.childForFieldName('property') ?? first.lastNamedChild;
    } else if (first.type === 'call_expression') {
      // Defensive: some grammars wrap `mod(args)` as call_expression.
      const callee = first.namedChild(0);
      if (callee?.type === 'identifier' || callee?.type === 'property_identifier') {
        nameNode = callee;
      } else if (callee?.type === 'member_expression') {
        nameNode = callee.childForFieldName('property') ?? callee.lastNamedChild;
      }
    }
    if (!nameNode) return;

    // Bare `onlyOwner` / `m()` → arity 0; `onlyRole(x, y)` → remaining siblings.
    const arity =
      first.type === 'call_expression'
        ? Math.max(0, first.namedChildCount - 1)
        : Math.max(0, node.namedChildCount - 1);

    out.push({
      '@reference.call.free': nodeToCapture('@reference.call.free', nameNode),
      '@reference.name': nodeToCapture('@reference.name', nameNode),
      '@reference.arity': syntheticCapture('@reference.arity', nameNode, String(arity)),
    });
  });
}

export function emitSolidityScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
    recordCacheHit();
  } else {
    tree = parseSourceSafe(getSolidityParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  }

  const root = tree.rootNode;
  const out: CaptureMatch[] = [];

  for (const match of getSolidityScopeQuery().matches(root)) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    let declNode: SyntaxNode | undefined;
    for (const c of match.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
      if (
        c.name === 'declaration.constructor' ||
        c.name === 'declaration.method' ||
        c.name === 'declaration.class' ||
        c.name === 'declaration.interface' ||
        c.name === 'declaration.struct' ||
        c.name === 'declaration.enum' ||
        c.name === 'declaration.property'
      ) {
        declNode = c.node;
      }
    }

    // Decompose each `import_directive` into one match per binding.
    if (grouped['@import.statement'] !== undefined) {
      const stmtNode = nodeIfType(nodeMap['@import.statement'], 'import_directive');
      if (stmtNode !== null) {
        for (const piece of splitSolidityImportDirective(stmtNode)) out.push(piece);
      }
      continue;
    }

    // Suppress Foundry / global member-call noise (`vm.prank`, `abi.encode`, …).
    if (grouped['@reference.call.member'] !== undefined) {
      const receiverText = grouped['@reference.receiver']?.text?.trim() ?? '';
      const calleeText = grouped['@reference.name']?.text?.trim() ?? '';
      if (
        SOLIDITY_BUILTIN_RECEIVERS.has(receiverText) ||
        SOLIDITY_BUILT_INS.has(calleeText)
      ) {
        continue;
      }
    }

    // Free-call built-ins (`require`, `keccak256`, …).
    if (grouped['@reference.call.free'] !== undefined) {
      const calleeText = grouped['@reference.name']?.text?.trim() ?? '';
      if (SOLIDITY_BUILT_INS.has(calleeText)) continue;
    }

    if (declNode && grouped['@declaration.name'] === undefined) {
      const synth = specialFunctionName(declNode);
      if (synth) {
        grouped['@declaration.name'] = syntheticCapture('@declaration.name', declNode, synth);
      }
    }

    if (Object.keys(grouped).length > 0) out.push(grouped);
  }

  synthesizeHeritage(root, out);
  synthesizeModifierInvocations(root, out);
  for (const cm of synthesizeAllSolidityReceiverBindings(root)) out.push(cm);
  synthesizeUsingForCalls(root, out);
  synthesizeEmitAndRevert(root, out);
  return out;
}
