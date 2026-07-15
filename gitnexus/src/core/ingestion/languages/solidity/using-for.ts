/**
 * Solidity `using Lib for Type` — capture-time rewrite of attached member calls.
 *
 * `x.add(1)` with `using MathLib for uint256` is rewritten as a member call
 * `MathLib.add` with arity = args + 1 (implicit `self` first parameter), so
 * Case-4 receiver resolution finds the library Class and the method.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const TYPE_OWNERS = new Set([
  'contract_declaration',
  'interface_declaration',
  'library_declaration',
]);

/** Normalize Solidity type spellings so `uint` matches `uint256`, etc. */
export function normalizeSolidityTypeName(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t === '*') return '*';
  const aliases: Record<string, string> = {
    uint: 'uint256',
    int: 'int256',
    ufixed: 'ufixed128x18',
    fixed: 'fixed128x18',
  };
  return aliases[t] ?? t;
}

type UsingAttachment = { readonly libName: string; readonly typeKey: string };

function typeNameFromTypeNode(typeNode: SyntaxNode | null): string | null {
  if (!typeNode) return null;
  // type_name → primitive_type | user_defined_type | …
  if (typeNode.type === 'type_name') {
    const inner = typeNode.namedChild(0);
    return typeNameFromTypeNode(inner);
  }
  if (typeNode.type === 'primitive_type') return normalizeSolidityTypeName(typeNode.text);
  if (typeNode.type === 'user_defined_type') {
    const id = typeNode.lastNamedChild;
    return id ? normalizeSolidityTypeName(id.text) : normalizeSolidityTypeName(typeNode.text);
  }
  if (typeNode.type === 'any_source_type') return '*';
  if (typeNode.type === 'identifier') return normalizeSolidityTypeName(typeNode.text);
  return normalizeSolidityTypeName(typeNode.text);
}

function collectUsingAttachments(typeOwner: SyntaxNode): UsingAttachment[] {
  const body =
    typeOwner.namedChildren.find((c) => c?.type === 'contract_body') ??
    typeOwner.childForFieldName('body');
  if (!body) return [];

  const out: UsingAttachment[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== 'using_directive') continue;

    let libName: string | null = null;
    let typeKey: string | null = null;
    for (let j = 0; j < child.namedChildCount; j++) {
      const part = child.namedChild(j);
      if (!part) continue;
      if (part.type === 'type_alias') {
        const id = part.namedChild(0) ?? part;
        libName = id.text.trim();
      } else if (part.type === 'type_name' || part.type === 'any_source_type') {
        typeKey = typeNameFromTypeNode(part);
      } else if (part.type === 'user_defined_type' || part.type === 'primitive_type') {
        typeKey = typeNameFromTypeNode(part);
      }
    }
    if (libName && typeKey) out.push({ libName, typeKey });
  }
  return out;
}

function collectStateTypeEnv(typeOwner: SyntaxNode, env: Map<string, string>): void {
  const body =
    typeOwner.namedChildren.find((c) => c?.type === 'contract_body') ??
    typeOwner.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== 'state_variable_declaration') continue;
    const name = child.childForFieldName('name')?.text?.trim();
    const typeNode = child.childForFieldName('type');
    const typeName = typeNameFromTypeNode(typeNode);
    if (name && typeName && typeName !== '*') env.set(name, typeName);
  }
}

function collectFunctionTypeEnv(fnNode: SyntaxNode, env: Map<string, string>): void {
  walkLocal(fnNode, (node) => {
    if (node.type === 'parameter' || node.type === 'variable_declaration') {
      const name = node.childForFieldName('name')?.text?.trim();
      const typeNode = node.childForFieldName('type') ?? node.namedChild(0);
      const typeName = typeNameFromTypeNode(typeNode);
      if (name && typeName && typeName !== '*') env.set(name, typeName);
    }
  });
}

function walkLocal(node: SyntaxNode, cb: (n: SyntaxNode) => void): void {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walkLocal(c, cb);
  }
}

function findMatchingLib(
  attachments: readonly UsingAttachment[],
  receiverType: string,
): string | null {
  const norm = normalizeSolidityTypeName(receiverType);
  for (const a of attachments) {
    if (a.typeKey === norm) return a.libName;
  }
  for (const a of attachments) {
    if (a.typeKey === '*') return a.libName;
  }
  return null;
}

/**
 * Emit rewritten member-call captures for `using Lib for T` sites.
 */
export function synthesizeUsingForCalls(root: SyntaxNode, out: CaptureMatch[]): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const typeOwner = root.namedChild(i);
    if (!typeOwner || !TYPE_OWNERS.has(typeOwner.type)) continue;

    const attachments = collectUsingAttachments(typeOwner);
    if (attachments.length === 0) continue;

    const stateEnv = new Map<string, string>();
    collectStateTypeEnv(typeOwner, stateEnv);

    walkLocal(typeOwner, (node) => {
      if (node.type !== 'call_expression') return;
      const callee = node.namedChild(0);
      if (!callee || callee.type !== 'member_expression') return;

      const object = callee.childForFieldName('object') ?? callee.namedChild(0);
      const property = callee.childForFieldName('property') ?? callee.namedChild(1);
      if (!object || !property) return;
      if (object.type !== 'identifier') return; // v1: simple receivers only

      const receiverName = object.text.trim();
      let fnEnv: Map<string, string> | null = null;
      let cur: SyntaxNode | null = node.parent;
      while (cur && cur !== typeOwner) {
        if (
          cur.type === 'function_definition' ||
          cur.type === 'modifier_definition' ||
          cur.type === 'constructor_definition' ||
          cur.type === 'fallback_receive_definition'
        ) {
          fnEnv = new Map(stateEnv);
          collectFunctionTypeEnv(cur, fnEnv);
          break;
        }
        cur = cur.parent;
      }
      const env = fnEnv ?? stateEnv;
      const receiverType = env.get(receiverName);
      if (!receiverType) return;

      const libName = findMatchingLib(attachments, receiverType);
      if (!libName) return;

      // Library call arity = explicit args + implicit self.
      const explicitArgs = Math.max(0, node.namedChildCount - 1);
      const arity = explicitArgs + 1;

      out.push({
        // Anchor on the call_expression (not the property) so the site key
        // differs from the original `x.add` member capture at the same name.
        '@reference.call.member': nodeToCapture('@reference.call.member', node),
        '@reference.name': nodeToCapture('@reference.name', property),
        '@reference.receiver': syntheticCapture('@reference.receiver', object, libName),
        '@reference.arity': syntheticCapture('@reference.arity', property, String(arity)),
      });
    });
  }
}
