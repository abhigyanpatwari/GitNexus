// gitnexus/src/core/ingestion/method-extractors/configs/elixir.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig, ParameterInfo, MethodVisibility } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const ELIXIR_DEF_KEYWORDS = new Set([
  'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate',
]);

const ELIXIR_PRIVATE_KEYWORDS = new Set(['defp', 'defmacrop', 'defguardp']);

/** Return the `target` identifier text of a call node, or undefined. */
function callKeyword(node: SyntaxNode): string | undefined {
  const t = node.childForFieldName?.('target');
  return t?.type === 'identifier' ? t.text : undefined;
}

/** Find the arguments node among named children. */
function findArguments(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'arguments') return c;
  }
  return null;
}

/**
 * Extract the function name from a def/defp call node.
 *
 * AST shape: call(target: identifier("def"), arguments(call(target: identifier("name"), ...), ...))
 * No-arg zero-clause: call(target: identifier("def"), arguments(identifier("name"), ...))
 */
function extractElixirName(node: SyntaxNode): string | undefined {
  if (!ELIXIR_DEF_KEYWORDS.has(callKeyword(node) ?? '')) return undefined;
  const args = findArguments(node);
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    if (arg.type === 'call') {
      const innerTarget = arg.childForFieldName?.('target');
      if (innerTarget?.type === 'identifier') return innerTarget.text;
    }
    if (arg.type === 'identifier') return arg.text;
    // binary_operator covers guard forms: def name(x) when is_integer(x)
    if (arg.type === 'binary_operator') {
      const left = arg.childForFieldName?.('left');
      if (left?.type === 'call') {
        const innerTarget = left.childForFieldName?.('target');
        if (innerTarget?.type === 'identifier') return innerTarget.text;
      }
    }
  }
  return undefined;
}

/**
 * Extract parameters from the inner function-signature call inside a def node.
 * Captures simple identifier parameters; skips pattern-match and default-value nodes.
 */
function extractElixirParameters(node: SyntaxNode): ParameterInfo[] {
  const args = findArguments(node);
  if (!args) return [];

  // Find the inner call (the function signature)
  let sigArgs: SyntaxNode | null = null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type === 'call') {
      sigArgs = findArguments(arg);
      break;
    }
    // guard form: binary_operator left: call
    if (arg?.type === 'binary_operator') {
      const left = arg.childForFieldName?.('left');
      if (left?.type === 'call') {
        sigArgs = findArguments(left);
        break;
      }
    }
  }
  if (!sigArgs) return [];

  const params: ParameterInfo[] = [];
  for (let i = 0; i < sigArgs.namedChildCount; i++) {
    const p = sigArgs.namedChild(i);
    if (!p) continue;
    if (p.type === 'identifier') {
      params.push({ name: p.text, type: null, isOptional: false, isVariadic: false });
    } else if (p.type === 'binary_operator') {
      // default value: `param \\ default` or `param // default`
      const left = p.childForFieldName?.('left');
      if (left?.type === 'identifier') {
        params.push({ name: left.text, type: null, isOptional: true, isVariadic: false });
      }
    }
    // Skip map/struct patterns, tuples, etc. — complex destructuring
  }
  return params;
}

function extractElixirVisibility(node: SyntaxNode): MethodVisibility {
  return ELIXIR_PRIVATE_KEYWORDS.has(callKeyword(node) ?? '') ? 'private' : 'public';
}

/**
 * Walk up from a def/defp call to find the enclosing defmodule's alias name.
 * Returns undefined for top-level functions (no parent defmodule).
 */
function extractElixirOwnerName(node: SyntaxNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'do_block') {
      const parent = cur.parent;
      if (parent?.type === 'call') {
        const kw = callKeyword(parent);
        if (kw === 'defmodule') {
          const pArgs = findArguments(parent);
          if (pArgs) {
            for (let i = 0; i < pArgs.namedChildCount; i++) {
              const a = pArgs.namedChild(i);
              if (a?.type === 'alias') return a.text;
            }
          }
        }
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

export const elixirMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Elixir,

  // defmodule calls are the class-like containers; def/defp calls are the methods
  typeDeclarationNodes: ['call'],
  methodNodeTypes: ['call'],
  bodyNodeTypes: ['do_block'],
  staticOwnerTypes: new Set(), // opt out — Elixir has no static concept

  extractName: extractElixirName,
  extractReturnType: () => undefined, // dynamic typing — no return type annotation in AST
  extractParameters: extractElixirParameters,
  extractVisibility: extractElixirVisibility,
  extractOwnerName: extractElixirOwnerName,

  isStatic: () => false,
  isAbstract: () => false,
  isFinal: () => false,
};
