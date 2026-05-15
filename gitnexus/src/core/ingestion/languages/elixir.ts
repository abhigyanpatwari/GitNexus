/**
 * Elixir Language Provider
 *
 * Key Elixir traits:
 *   - importSemantics: 'wildcard-leaf' (import/use bring all public functions into scope)
 *   - mroStrategy: 'none' (functional language — no class inheritance)
 *   - heritageDefaultEdge: 'IMPLEMENTS' (protocol/behaviour relationships)
 *   - Modules defined with defmodule, functions with def/defp
 *   - Module names are atoms: MyApp.User → lib/my_app/user.ex by convention
 */

import { SupportedLanguages, type NodeLabel } from 'gitnexus-shared';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as elixirTypeConfig } from '../type-extractors/elixir.js';
import { elixirExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { elixirImportConfig } from '../import-resolvers/configs/elixir.js';
import { ELIXIR_QUERIES } from '../tree-sitter-queries.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { elixirMethodConfig } from '../method-extractors/configs/elixir.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import { elixirClassConfig } from '../class-extractors/configs/elixir.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import type { CallExtractor, ExtractedCallSite } from '../call-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { countCallArguments } from '../utils/call-analysis.js';
import { generateId } from '../../../lib/utils.js';

const ELIXIR_DEF_KEYWORDS = new Set([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defguard',
  'defguardp',
  'defdelegate',
]);

const ELIXIR_MODULE_KEYWORDS = new Set(['defmodule', 'defprotocol']);

const ELIXIR_NON_CALL_KEYWORDS = new Set([
  ...ELIXIR_DEF_KEYWORDS,
  ...ELIXIR_MODULE_KEYWORDS,
  'defimpl',
  'defstruct',
  'defoverridable',
  'defexception',
  'import',
  'alias',
  'use',
  'require',
  'case',
  'cond',
  'if',
  'unless',
  'for',
  'with',
  'receive',
  'try',
  'quote',
  'fn',
]);

function callKeyword(node: SyntaxNode): string | undefined {
  const target = node.childForFieldName?.('target');
  return target?.type === 'identifier' ? target.text : undefined;
}

function findArguments(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'arguments') return child;
  }
  return null;
}

function firstAliasArgument(node: SyntaxNode): string | undefined {
  const args = findArguments(node);
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child?.type === 'alias') return child.text;
  }
  return undefined;
}

function extractFunctionNameFromDef(node: SyntaxNode): string | undefined {
  if (!ELIXIR_DEF_KEYWORDS.has(callKeyword(node) ?? '')) return undefined;
  const args = findArguments(node);
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    if (arg.type === 'identifier') return arg.text;
    if (arg.type === 'call') {
      const target = arg.childForFieldName?.('target');
      if (target?.type === 'identifier') return target.text;
    }
    if (arg.type === 'binary_operator') {
      const left = arg.childForFieldName?.('left');
      if (left?.type === 'call') {
        const target = left.childForFieldName?.('target');
        if (target?.type === 'identifier') return target.text;
      }
    }
  }
  return undefined;
}

function isInsideDefinitionHead(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'do_block') return false;
    if (current.type === 'call' && ELIXIR_DEF_KEYWORDS.has(callKeyword(current) ?? '')) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isModuleAttributeCall(node: SyntaxNode): boolean {
  return node.parent?.type === 'unary_operator' && node.parent.text.startsWith('@');
}

function remoteReceiver(callNode: SyntaxNode): string | undefined {
  const target = callNode.childForFieldName?.('target');
  if (target?.type !== 'dot') return undefined;
  const left = target.childForFieldName?.('left');
  return left?.type === 'alias' ? left.text : undefined;
}

const elixirCallExtractor: CallExtractor = {
  language: SupportedLanguages.Elixir,

  extract(callNode, callNameNode): ExtractedCallSite | null {
    if (!callNameNode) return null;
    if (isModuleAttributeCall(callNode) || isInsideDefinitionHead(callNode)) return null;

    const calledName = callNameNode.text;
    if (ELIXIR_NON_CALL_KEYWORDS.has(calledName)) return null;

    const receiverName = remoteReceiver(callNode);
    return {
      calledName,
      callForm: receiverName ? 'member' : 'free',
      ...(receiverName ? { receiverName } : {}),
      argCount: countCallArguments(callNode),
    };
  },
};

const elixirIsClassContainerNode = (node: SyntaxNode): boolean =>
  node.type === 'call' && ELIXIR_MODULE_KEYWORDS.has(callKeyword(node) ?? '');

const elixirExtractEnclosingClassInfo = (node: SyntaxNode, filePath: string) => {
  if (!elixirIsClassContainerNode(node)) return null;
  const className = firstAliasArgument(node);
  if (!className) return null;
  const label = callKeyword(node) === 'defprotocol' ? 'Interface' : 'Class';
  return { classId: generateId(label, `${filePath}:${className}`), className };
};

const elixirEnclosingFunctionFinder = (
  node: SyntaxNode,
): { funcName: string; label: NodeLabel; definitionNode: SyntaxNode } | null => {
  if (node.type !== 'call') return null;
  const funcName = extractFunctionNameFromDef(node);
  return funcName ? { funcName, label: 'Function', definitionNode: node } : null;
};

const elixirImportPathPreprocessor = (cleaned: string, importNode: SyntaxNode): string | null => {
  const keyword = callKeyword(importNode);
  return keyword === 'import' || keyword === 'use' || keyword === 'require' || keyword === 'alias'
    ? cleaned
    : null;
};

const BUILT_INS: ReadonlySet<string> = new Set([
  // Kernel built-ins
  'send', 'spawn', 'spawn_link', 'spawn_monitor', 'exit', 'throw', 'raise',
  'reraise', 'apply', 'is_atom', 'is_binary', 'is_bitstring', 'is_boolean',
  'is_float', 'is_function', 'is_integer', 'is_list', 'is_map', 'is_nil',
  'is_number', 'is_pid', 'is_port', 'is_reference', 'is_struct', 'is_tuple',
  'length', 'hd', 'tl', 'abs', 'ceil', 'floor', 'round', 'trunc', 'rem',
  'div', 'max', 'min', 'elem', 'put_elem', 'tuple_size', 'map_size',
  'byte_size', 'bit_size', 'binary_part', 'get_in', 'put_in', 'update_in',
  'pop_in', 'get_and_update_in', 'struct', 'struct!',
  // IO
  'IO.puts', 'IO.inspect', 'IO.gets', 'IO.write', 'IO.read',
  // Common pipeline functions
  'then', 'tap', 'dbg',
]);

export const elixirProvider = defineLanguage({
  id: SupportedLanguages.Elixir,
  extensions: ['.ex', '.exs'],

  entryPointPatterns: [
    /^mount$/,
    /^handle_event$/,
    /^handle_info$/,
    /^handle_call$/,
    /^handle_cast$/,
    /^handle_continue$/,
    /^perform$/,
    /^process$/,
    /^call$/,
    /^init$/,
    /^start_link$/,
    /^action$/,
  ],

  astFrameworkPatterns: [
    {
      framework: 'phoenix-liveview',
      entryPointMultiplier: 3.0,
      reason: 'liveview-handler',
      patterns: ['Phoenix.LiveView', 'use Phoenix.LiveView', 'mount', 'handle_event'],
    },
    {
      framework: 'phoenix-controller',
      entryPointMultiplier: 2.5,
      reason: 'phoenix-action',
      patterns: ['use Phoenix.Controller', 'conn', 'params', 'Phoenix.Controller'],
    },
    {
      framework: 'phoenix-channel',
      entryPointMultiplier: 2.5,
      reason: 'phoenix-channel',
      patterns: ['use Phoenix.Channel', 'Phoenix.Channel', 'socket', 'join'],
    },
    {
      framework: 'oban-worker',
      entryPointMultiplier: 2.8,
      reason: 'oban-job',
      patterns: ['use Oban.Worker', 'Oban.Worker', 'perform'],
    },
    {
      framework: 'genserver',
      entryPointMultiplier: 2.0,
      reason: 'genserver',
      patterns: ['use GenServer', 'GenServer', 'handle_call', 'handle_cast', 'handle_info'],
    },
    {
      framework: 'plug',
      entryPointMultiplier: 2.0,
      reason: 'plug-middleware',
      patterns: ['use Plug.Router', 'Plug.Conn', 'plug'],
    },
  ] satisfies AstFrameworkPatternConfig[],

  treeSitterQueries: ELIXIR_QUERIES,
  typeConfig: elixirTypeConfig,
  exportChecker: elixirExportChecker,
  importResolver: createImportResolver(elixirImportConfig),
  importPathPreprocessor: elixirImportPathPreprocessor,
  importSemantics: 'wildcard-leaf',

  callExtractor: elixirCallExtractor,
  isClassContainerNode: elixirIsClassContainerNode,
  extractEnclosingClassInfo: elixirExtractEnclosingClassInfo,
  enclosingFunctionFinder: elixirEnclosingFunctionFinder,
  methodExtractor: createMethodExtractor(elixirMethodConfig),
  classExtractor: createClassExtractor(elixirClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.Elixir),

  heritageDefaultEdge: 'IMPLEMENTS',

  builtInNames: BUILT_INS,
});
