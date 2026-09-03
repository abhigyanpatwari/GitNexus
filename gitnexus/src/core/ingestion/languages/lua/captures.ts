/**
 * Lua scope-capture emitter (RFC #909 Ring 3).
 *
 * Minimal grouping: parse (or reuse the worker's cached AST) → run the scope
 * query → group each match's captures into a CaptureMatch keyed by `@name`.
 * No Ruby-style decomposition, no YARD, and no static type inference. Lua
 * require imports are collected structurally so positional local/RHS pairing
 * remains correct for multi-assignment and parenthesis-free forms. Lua
 * callable-value-flow facts are synthesized
 * through the shared provider contract below.
 *
 * Side effect: also runs the heritage + method-owner queries against the same
 * AST and stashes the pairs into the capture-side-channel map, so the main-
 * thread `emitLuaHeritageEdges` hook can emit EXTENDS + HAS_METHOD edges
 * WITHOUT re-reading or re-parsing the file (#1983 no-main-thread-re-parse).
 *
 * The central ScopeExtractor partitions the capture output by prefix
 * (@scope.* / @declaration.* / @import.* / @reference.*) and builds the scope
 * tree, declarations, imports, and reference sites that finalize turns into
 * CALLS + IMPORTS edges.
 */
import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getLuaParser, getLuaScopeQuery, getHeritageQuery, getMethodOwnerQuery } from './query.js';
import {
  setLuaHeritageFacts,
  clearLuaHeritageFactsForFile,
  type LuaExtendsPair,
  type LuaMethodOwnerPair,
  type LuaReturnedField,
} from './capture-side-channel.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';

const LUA_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set([
    'function_definition_statement',
    'local_function_definition_statement',
    'function_definition',
  ]),
  callNodeTypes: new Set(['call']),
  parameterListNodeTypes: new Set(['parameter_list', 'argument_list']),
  parameterNodeTypes: new Set(['identifier', 'vararg_expression']),
  bindingNodeTypes: new Set(['local_variable_declaration']),
  assignmentNodeTypes: new Set(['variable_assignment']),
  identifierNodeTypes: new Set(['identifier']),
  functionScopedValueBindings: true,
  extractAssignment: (node: Parser.SyntaxNode) => {
    if (node.type !== 'local_variable_declaration' && node.type !== 'variable_assignment') {
      return undefined;
    }
    const destinations =
      node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
    const sources =
      node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
    if (destinations.length === 0 || sources.length === 0) return [];
    return destinations.slice(0, sources.length).flatMap((destination, index) => {
      const source = sources[index];
      const simpleDestination =
        destination.type === 'variable' &&
        destination.childForFieldName('name')?.type === 'identifier' &&
        destination.childForFieldName('table') === null &&
        destination.childForFieldName('field') === null;
      const simpleSource =
        source?.type === 'variable' &&
        source.childForFieldName('name')?.type === 'identifier' &&
        source.childForFieldName('table') === null &&
        source.childForFieldName('field') === null;
      return simpleDestination && simpleSource && source !== undefined
        ? [{ destination, source }]
        : [];
    });
  },
} as const;

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function isRequireCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'variable' && fn.childForFieldName('name')?.text === 'require';
}

function requireStringNode(call: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const args = call.childForFieldName('arguments');
  if (args === null) return undefined;
  const first = args.namedChildren[0];
  if (first?.type === 'string') return first;
  if (first?.type === 'expression_list' && first.namedChildren[0]?.type === 'string') {
    return first.namedChildren[0];
  }
  return undefined;
}

function importCapture(
  statement: Parser.SyntaxNode,
  source: Parser.SyntaxNode,
  localName?: Parser.SyntaxNode,
): CaptureMatch {
  const match: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', statement),
    '@import.source': nodeToCapture('@import.source', source),
  };
  if (localName !== undefined) {
    match['@import.localName'] = nodeToCapture('@import.localName', localName);
  }
  return match;
}

function collectLuaImportCaptures(root: Parser.SyntaxNode): readonly CaptureMatch[] {
  const out: CaptureMatch[] = [];

  const visit = (node: Parser.SyntaxNode, suppressed: ReadonlySet<Parser.SyntaxNode>): void => {
    if (node.type === 'local_variable_declaration') {
      const variables =
        node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
      const expressions =
        node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
      const names = variables
        .map((variable) => variable.childForFieldName('name'))
        .filter((name): name is Parser.SyntaxNode => name?.type === 'identifier');

      // Pair by source position. Never reuse an RHS for multiple LHS names.
      for (let i = 0; i < Math.min(names.length, expressions.length); i++) {
        const expression = expressions[i];
        if (!isRequireCall(expression)) continue;
        const source = requireStringNode(expression);
        if (source !== undefined) out.push(importCapture(node, source, names[i]));
      }

      // Keep walking all initializer descendants. Direct require calls are
      // suppressed because they already have their positional local binding;
      // nested calls (function bodies, wrappers, and other expressions) still
      // need their own IMPORTS edge.
      const directRequires = new Set<Parser.SyntaxNode>();
      for (const expression of expressions) {
        if (isRequireCall(expression) && requireStringNode(expression) !== undefined) {
          directRequires.add(expression);
        }
      }
      for (const child of node.namedChildren) visit(child, directRequires);
      return;
    }

    if (isRequireCall(node)) {
      if (suppressed.has(node)) {
        for (const child of node.namedChildren) visit(child, suppressed);
        return;
      }
      const source = requireStringNode(node);
      if (source !== undefined) {
        out.push(importCapture(node, source));
        return;
      }
    }

    for (const child of node.namedChildren) visit(child, suppressed);
  };

  visit(root, new Set());
  return out;
}

function collectLuaReturnedNames(root: Parser.SyntaxNode): readonly string[] {
  const returnedNames: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'return_statement') continue;
    const expressionList = node.namedChildren.find((child) => child.type === 'expression_list');
    const first = expressionList?.namedChildren[0];
    const name = first?.childForFieldName('name');
    if (name?.type === 'identifier') returnedNames.push(name.text);
  }
  return returnedNames;
}

function collectLuaReturnedFields(root: Parser.SyntaxNode): readonly LuaReturnedField[] {
  const returnedFields: LuaReturnedField[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'return_statement') continue;
    const expressionList = node.namedChildren.find((child) => child.type === 'expression_list');
    const table = expressionList?.namedChildren[0];
    if (table?.type !== 'table') continue;
    const fields = table.namedChildren.find((child) => child.type === 'field_list');
    for (const field of fields?.namedChildren ?? []) {
      if (field.type !== 'field') continue;
      const key = field.childForFieldName('key');
      const value = field.childForFieldName('value');
      if ((key?.type !== 'identifier' && key?.type !== 'string') || value?.type !== 'variable')
        continue;
      const localName = value.childForFieldName('name');
      if (localName?.type !== 'identifier') continue;
      returnedFields.push({ exportName: stripQuotes(key.text), localName: localName.text });
    }
  }
  return returnedFields;
}

function collectLuaAssignmentMethodCaptures(root: Parser.SyntaxNode): readonly CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'variable_assignment') {
      const variable = node.namedChildren.find((child) => child.type === 'variable_list')
        ?.namedChildren[0];
      const value = node.namedChildren.find((child) => child.type === 'expression_list')
        ?.namedChildren[0];
      const owner = variable?.childForFieldName('table');
      const method = variable?.childForFieldName('field');
      if (
        variable?.type === 'variable' &&
        owner?.type === 'identifier' &&
        (method?.type === 'identifier' || method?.type === 'string') &&
        value?.type === 'function_definition'
      ) {
        let enclosing = node.parent;
        let nestedInFunction = false;
        while (enclosing !== null) {
          if (
            enclosing.type === 'function_definition_statement' ||
            enclosing.type === 'local_function_definition_statement' ||
            enclosing.type === 'function_definition'
          ) {
            nestedInFunction = true;
            break;
          }
          enclosing = enclosing.parent;
        }
        if (nestedInFunction) {
          for (const child of node.namedChildren) visit(child);
          return;
        }
        const match: Record<string, Capture> = {
          '@scope.function': nodeToCapture('@scope.function', value),
          '@declaration.method': nodeToCapture('@declaration.method', value),
          '@declaration.name': {
            ...nodeToCapture('@declaration.name', method),
            text: method.type === 'string' ? stripQuotes(method.text) : method.text,
          },
        };
        addLuaArityCaptures(match, value);
        out.push(match);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function addLuaArityCaptures(
  match: Record<string, Capture>,
  functionNode: Parser.SyntaxNode,
): void {
  const parameters = functionNode.childForFieldName('parameters');
  if (parameters?.type !== 'parameter_list') return;
  const hasVararg = parameters.namedChildren.some((child) => child.type === 'vararg_expression');
  const fixedCount = parameters.namedChildren.filter(
    (child) => child.type !== 'vararg_expression',
  ).length;
  match['@declaration.parameter-count'] = {
    ...nodeToCapture('@declaration.parameter-count', parameters),
    text: hasVararg ? '' : String(fixedCount),
  };
  match['@declaration.required-parameter-count'] = {
    ...nodeToCapture('@declaration.required-parameter-count', parameters),
    text: String(fixedCount),
  };
  match['@declaration.parameter-types'] = {
    ...nodeToCapture('@declaration.parameter-types', parameters),
    text: JSON.stringify(hasVararg ? ['params'] : []),
  };
}

export function emitLuaScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
  } else {
    tree = parseSourceSafe(getLuaParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const out: CaptureMatch[] = [];
  for (const match of getLuaScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const c of match.captures) {
      const tag = '@' + c.name;
      // Skip tree-sitter predicate captures (e.g. @_req used by #eq?).
      if (tag.startsWith('@_')) continue;
      if (grouped[tag] === undefined) grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    // middleclass `class("Name", ...)`: strip surrounding quotes from the name
    // so the Class node is named `BattleSkill`, not `"BattleSkill"`. tree-sitter-lua's
    // string node has no content child, so .text carries the quotes.
    const nameCap = grouped['@declaration.name'];
    if (grouped['@declaration.class'] !== undefined && nameCap !== undefined) {
      const stripped = nameCap.text.replace(/^["']|["']$/g, '');
      if (stripped !== nameCap.text) {
        grouped['@declaration.name'] = { ...nameCap, text: stripped };
      }
    }
    const declarationNode = match.captures.find(
      (capture) => capture.name === 'declaration.function' || capture.name === 'declaration.method',
    )?.node;
    if (declarationNode !== undefined) addLuaArityCaptures(grouped, declarationNode);
    out.push(grouped);
  }

  // Imports are collected structurally instead of through the generic query:
  // the AST lists preserve positional local/RHS pairing and support all Lua
  // string-call forms without producing a cross-product of captures.
  out.push(...collectLuaImportCaptures(tree.rootNode));
  out.push(...collectLuaAssignmentMethodCaptures(tree.rootNode));
  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, LUA_CALLABLE_CAPTURE_OPTIONS));

  // Heritage pairs (middleclass EXTENDS + HAS_METHOD) — collected here in the
  // worker where the AST is live, snapshotted onto ParsedFile.captureSideChannel
  // by `collectLuaCaptureSideChannel`, consumed by `emitLuaHeritageEdges`.
  const extendsPairs: LuaExtendsPair[] = [];
  for (const m of getHeritageQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const child = stripQuotes(caps['child.name']?.text ?? '');
    const parent =
      caps['parent.name']?.text ??
      (caps['parent.module'] !== undefined && caps['parent.field'] !== undefined
        ? `${caps['parent.module'].text}.${caps['parent.field'].text}`
        : undefined);
    if (child.length > 0 && parent !== undefined) {
      extendsPairs.push({ child, parent });
    }
  }
  const methodOwners: LuaMethodOwnerPair[] = [];
  for (const m of getMethodOwnerQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const owner = caps['method.owner']?.text;
    const method = caps['method.name']?.text;
    const defNode = caps['method.def'];
    if (owner === undefined || method === undefined || defNode === undefined) continue;
    let enclosing = defNode.parent;
    let nestedInFunction = false;
    while (enclosing !== null) {
      if (
        enclosing.type === 'function_definition_statement' ||
        enclosing.type === 'local_function_definition_statement'
      ) {
        nestedInFunction = true;
        break;
      }
      enclosing = enclosing.parent;
    }
    if (nestedInFunction) continue;
    methodOwners.push({
      owner,
      method: stripQuotes(method),
      defRow: defNode.startPosition.row,
    });
  }
  const classNames = new Set(
    out
      .filter((match) => match['@declaration.class'] !== undefined)
      .map((match) => match['@declaration.name']?.text)
      .filter((name): name is string => name !== undefined),
  );
  const returnedNames = collectLuaReturnedNames(tree.rootNode).filter((name) =>
    classNames.has(name),
  );
  const returnedFields = collectLuaReturnedFields(tree.rootNode);
  if (
    extendsPairs.length > 0 ||
    methodOwners.length > 0 ||
    returnedNames.length > 0 ||
    returnedFields.length > 0
  ) {
    setLuaHeritageFacts(filePath, {
      kind: 'lua',
      extendsPairs,
      methodOwners,
      returnedNames,
      returnedFields,
    });
  } else {
    // Re-capture produced no heritage — drop any prior facts for this file so
    // reanalysis of a file that lost its middleclass class does not emit stale
    // EXTENDS / HAS_METHOD edges from the previous pass.
    clearLuaHeritageFactsForFile(filePath);
  }

  return out;
}
