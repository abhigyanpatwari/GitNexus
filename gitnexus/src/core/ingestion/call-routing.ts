/**
 * Shared Ruby call routing logic.
 *
 * Ruby expresses imports, heritage (mixins), and property definitions as
 * method calls rather than syntax-level constructs. This module provides a
 * routing function used by the CLI call-processor, CLI parse-worker, and
 * the web call-processor so that the classification logic lives in one place.
 *
 * NOTE: This file is intentionally duplicated in gitnexus-web/ because the
 * two packages have separate build targets (Node native vs WASM/browser).
 * Keep both copies in sync until a shared package is introduced.
 */

import type { SyntaxNode } from './utils/ast-helpers.js';

// ── Call routing dispatch table ─────────────────────────────────────────────

/** null = this call was not routed; fall through to default call handling */
export type CallRoutingResult = RubyCallRouting | null;

/**
 * Per-language call router.
 * IMPORTANT: Call-routed imports bypass preprocessImportPath(), so any router that
 * returns an importPath MUST validate it independently (length cap, control-char
 * rejection). See routeRubyCall for the reference implementation.
 */
export type CallRouter = (
  calledName: string,
  callNode: SyntaxNode,
) => CallRoutingResult;

// ── Result types ────────────────────────────────────────────────────────────

export type RubyCallRouting =
  | { kind: 'import'; importPath: string; isRelative: boolean }
  | { kind: 'heritage'; items: RubyHeritageItem[] }
  | { kind: 'properties'; items: RubyPropertyItem[] }
  | { kind: 'call' }
  | { kind: 'skip' };

export interface RubyHeritageItem {
  enclosingClass: string;
  mixinName: string;
  heritageKind: 'include' | 'extend' | 'prepend';
}

export type RubyAccessorType = 'attr_accessor' | 'attr_reader' | 'attr_writer';

export interface RubyPropertyItem {
  propName: string;
  accessorType: RubyAccessorType;
  startLine: number;
  endLine: number;
  /** YARD @return [Type] annotation preceding the attr_accessor call */
  declaredType?: string;
}

// ── Pre-allocated singletons for common return values ────────────────────────
const CALL_RESULT: RubyCallRouting = { kind: 'call' };
const SKIP_RESULT: RubyCallRouting = { kind: 'skip' };

/** Max depth for parent-walking loops to prevent pathological AST traversals */
const MAX_PARENT_DEPTH = 50;

// ── Routing function ────────────────────────────────────────────────────────

/**
 * Classify a Ruby call node and extract its semantic payload.
 *
 * @param calledName - The method name (e.g. 'require', 'include', 'attr_accessor')
 * @param callNode   - The tree-sitter `call` AST node
 * @returns A discriminated union describing the call's semantic role
 */
export function routeRubyCall(calledName: string, callNode: SyntaxNode): RubyCallRouting {
  // ── require / require_relative → import ─────────────────────────────────
  if (calledName === 'require' || calledName === 'require_relative') {
    const argList = callNode.childForFieldName?.('arguments');
    const stringNode = argList?.children?.find((c: any) => c.type === 'string');
    const contentNode = stringNode?.children?.find((c: any) => c.type === 'string_content');
    if (!contentNode) return SKIP_RESULT;

    let importPath: string = contentNode.text;
    // Validate: reject null bytes, control chars, excessively long paths
    if (!importPath || importPath.length > 1024 || /[\x00-\x1f]/.test(importPath)) {
      return SKIP_RESULT;
    }
    const isRelative = calledName === 'require_relative';
    if (isRelative && !importPath.startsWith('.')) {
      importPath = './' + importPath;
    }
    return { kind: 'import', importPath, isRelative };
  }

  // ── include / extend / prepend → heritage (mixin) ──────────────────────
  if (calledName === 'include' || calledName === 'extend' || calledName === 'prepend') {
    let enclosingClass: string | null = null;
    let current = callNode.parent;
    let depth = 0;
    while (current && ++depth <= MAX_PARENT_DEPTH) {
      if (current.type === 'class' || current.type === 'module') {
        const nameNode = current.childForFieldName?.('name');
        if (nameNode) { enclosingClass = nameNode.text; break; }
      }
      current = current.parent;
    }
    if (!enclosingClass) return SKIP_RESULT;

    const items: RubyHeritageItem[] = [];
    const argList = callNode.childForFieldName?.('arguments');
    for (const arg of (argList?.children ?? [])) {
      if (arg.type === 'constant' || arg.type === 'scope_resolution') {
        items.push({ enclosingClass, mixinName: arg.text, heritageKind: calledName as 'include' | 'extend' | 'prepend' });
      }
    }
    return items.length > 0 ? { kind: 'heritage', items } : SKIP_RESULT;
  }

  // ── attr_accessor / attr_reader / attr_writer → property definitions ───
  if (calledName === 'attr_accessor' || calledName === 'attr_reader' || calledName === 'attr_writer') {
    // Extract YARD @return [Type] from preceding comment (e.g. `# @return [Address]`)
    let yardType: string | undefined;
    let sibling = callNode.previousSibling;
    while (sibling) {
      if (sibling.type === 'comment') {
        const match = /@return\s+\[([^\]]+)\]/.exec(sibling.text);
        if (match) {
          const raw = match[1].trim();
          // Extract simple type name: "User", "Array<User>" → "User"
          const simple = raw.match(/^([A-Z]\w*)/);
          if (simple) yardType = simple[1];
          break;
        }
      } else if (sibling.isNamed) {
        break; // stop at non-comment named sibling
      }
      sibling = sibling.previousSibling;
    }

    const items: RubyPropertyItem[] = [];
    const argList = callNode.childForFieldName?.('arguments');
    for (const arg of (argList?.children ?? [])) {
      if (arg.type === 'simple_symbol') {
        items.push({
          propName: arg.text.startsWith(':') ? arg.text.slice(1) : arg.text,
          accessorType: calledName as RubyAccessorType,
          startLine: arg.startPosition.row,
          endLine: arg.endPosition.row,
          ...(yardType ? { declaredType: yardType } : {}),
        });
      }
    }
    return items.length > 0 ? { kind: 'properties', items } : SKIP_RESULT;
  }

  // ── Everything else → regular call ─────────────────────────────────────
  return CALL_RESULT;
}
