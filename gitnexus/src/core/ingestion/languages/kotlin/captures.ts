import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { computeKotlinArityMetadata } from './arity-metadata.js';
import { splitKotlinImportHeader } from './import-decomposer.js';
import { recordKotlinCacheHit, recordKotlinCacheMiss } from './cache-stats.js';
import { normalizeKotlinType } from './interpret.js';
import { synthesizeKotlinReceiverBinding } from './receiver-binding.js';
import { getKotlinParser, getKotlinScopeQuery } from './query.js';

const FUNCTION_DECL_TAGS = ['@declaration.function'] as const;

export function emitKotlinScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getKotlinParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getKotlinParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordKotlinCacheMiss();
  } else {
    recordKotlinCacheHit();
  }

  const out: CaptureMatch[] = [];
  const returnTypes = collectKotlinReturnTypeTexts(tree.rootNode);
  out.push(...synthesizeKotlinLocalAssignmentBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinLoopBindings(tree.rootNode, returnTypes));

  for (const match of getKotlinScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const capture of match.captures) {
      const tag = '@' + capture.name;
      grouped[tag] = nodeToCapture(tag, capture.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      const importNode = findNodeAtRange(
        tree.rootNode,
        grouped['@import.statement']!.range,
        'import_header',
      );
      if (importNode !== null) {
        const decomposed = splitKotlinImportHeader(importNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
    }

    if (
      grouped['@reference.call.free'] !== undefined &&
      grouped['@reference.receiver'] !== undefined
    ) {
      continue;
    }

    if (grouped['@reference.read.member'] !== undefined) {
      const anchor = grouped['@reference.read.member']!;
      const navNode = findNodeAtRange(tree.rootNode, anchor.range, 'navigation_expression');
      if (navNode === null || !shouldEmitReadMember(navNode)) continue;
    }

    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped['@scope.function']!.range,
        'function_declaration',
      );
      if (fnNode !== null) {
        out.push(...synthesizeKotlinReceiverBinding(fnNode));
      }
      continue;
    }

    const declTag = FUNCTION_DECL_TAGS.find((tag) => grouped[tag] !== undefined);
    if (declTag !== undefined) {
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped[declTag]!.range,
        'function_declaration',
      );
      if (fnNode !== null) {
        const arity = computeKotlinArityMetadata(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
        if (arity.requiredParameterCount !== undefined) {
          grouped['@declaration.required-parameter-count'] = syntheticCapture(
            '@declaration.required-parameter-count',
            fnNode,
            String(arity.requiredParameterCount),
          );
        }
        if (arity.parameterTypes !== undefined) {
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }
      }
    }

    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((tag) => grouped[tag] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = findNodeAtRange(tree.rootNode, grouped[callTag]!.range, 'call_expression');
      if (callNode !== null) {
        const args = callArguments(callNode);
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(args.map(inferArgType)),
        );
      }
    }

    out.push(grouped);

    const extensionFallback = extensionFreeCallFallback(grouped, tree.rootNode);
    if (extensionFallback !== null) out.push(extensionFallback);
  }

  return out;
}

function synthesizeKotlinLoopBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = collectKotlinLocalTypeTexts(fnNode, returnTypes);
    for (const forNode of descendantsOfType(fnNode, 'for_statement')) {
      const variable = forNode.namedChildren.find((child) => child.type === 'variable_declaration');
      const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
      if (variable === undefined || name === undefined) continue;

      const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
      const iterable = forNode.namedChildren.find(
        (child) => child.id !== variable.id && child.type !== 'control_structure_body',
      );
      const rawType =
        explicitType?.text ??
        (iterable === undefined
          ? null
          : inferKotlinIterableElementType(iterable, localTypes, returnTypes));
      if (rawType === null || rawType.trim() === '') continue;

      const anchor =
        forNode.namedChildren.find((child) => child.type === 'control_structure_body') ?? forNode;
      out.push({
        '@type-binding.annotation': nodeToCapture('@type-binding.annotation', anchor),
        '@type-binding.name': syntheticCapture('@type-binding.name', name, name.text),
        '@type-binding.type': syntheticCapture(
          '@type-binding.type',
          explicitType ?? iterable ?? name,
          normalizeKotlinType(rawType),
        ),
      });
    }
  }
  return out;
}

function synthesizeKotlinLocalAssignmentBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = new Map<string, string>();
    for (const prop of descendantsOfType(fnNode, 'property_declaration')) {
      const inferred = inferKotlinPropertyType(prop, localTypes, returnTypes);
      if (inferred === null) continue;
      localTypes.set(inferred.name.text, inferred.rawType);
      if (inferred.synthetic) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', prop),
          '@type-binding.name': syntheticCapture(
            '@type-binding.name',
            inferred.name,
            inferred.name.text,
          ),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            inferred.source,
            normalizeKotlinType(inferred.rawType),
          ),
        });
      }
    }
  }
  return out;
}

function collectKotlinLocalTypeTexts(
  fnNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of descendants(fnNode)) {
    if (node.type === 'parameter') {
      const name = descendantsOfType(node, 'simple_identifier')[0];
      const type = node.namedChildren.find((child) => isKotlinTypeNode(child));
      if (name !== undefined && type !== undefined) out.set(name.text, type.text);
      continue;
    }

    if (node.type === 'property_declaration') {
      const inferred = inferKotlinPropertyType(node, out, returnTypes);
      if (inferred !== null) out.set(inferred.name.text, inferred.rawType);
    }
  }
  return out;
}

function collectKotlinReturnTypeTexts(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const name = fnNode.namedChildren.find((child) => child.type === 'simple_identifier');
    const paramsIndex = fnNode.namedChildren.findIndex(
      (child) => child.type === 'function_value_parameters',
    );
    const type =
      paramsIndex < 0
        ? undefined
        : fnNode.namedChildren.slice(paramsIndex + 1).find((child) => isKotlinTypeNode(child));
    if (name !== undefined && type !== undefined) out.set(name.text, type.text);
  }
  return out;
}

function inferKotlinPropertyType(
  prop: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
): { name: SyntaxNode; rawType: string; source: SyntaxNode; synthetic: boolean } | null {
  const variable = prop.namedChildren.find((child) => child.type === 'variable_declaration');
  const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
  if (variable === undefined || name === undefined) return null;

  const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
  if (explicitType !== undefined) {
    return { name, rawType: explicitType.text, source: explicitType, synthetic: false };
  }

  const value = prop.namedChildren.find(
    (child) => child.id !== variable.id && child.type !== 'binding_pattern_kind',
  );
  if (value?.type === 'simple_identifier') {
    const rawType = localTypes.get(value.text);
    return rawType === undefined ? null : { name, rawType, source: value, synthetic: true };
  }

  if (value?.type === 'call_expression') {
    const callee = value.namedChildren.find((child) => child.type === 'simple_identifier');
    if (callee === undefined) return null;
    const rawType =
      returnTypes.get(callee.text) ?? (isUppercaseName(callee.text) ? callee.text : null);
    if (rawType === null) return null;
    return { name, rawType, source: callee, synthetic: true };
  }

  return null;
}

function inferKotlinIterableElementType(
  iterable: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
): string | null {
  if (iterable.type === 'simple_identifier') {
    const raw = localTypes.get(iterable.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, 'values');
  }

  if (iterable.type === 'navigation_expression') {
    const receiver = iterable.namedChildren[0];
    const member = iterable.namedChildren
      .find((child) => child.type === 'navigation_suffix')
      ?.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
    if (receiver?.type !== 'simple_identifier') return null;
    const raw = localTypes.get(receiver.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, member ?? 'values');
  }

  if (iterable.type === 'call_expression') {
    const callee = iterable.namedChildren.find((child) => child.type === 'simple_identifier');
    if (callee === undefined) return null;
    const raw = returnTypes.get(callee.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, 'values');
  }

  return null;
}

function isUppercaseName(text: string): boolean {
  return /^[A-Z]/.test(text);
}

function kotlinContainerElementType(rawType: string, member: string): string | null {
  const parsed = parseKotlinGeneric(rawType);
  if (parsed === null) return normalizeKotlinType(rawType);

  const base = parsed.base.split('.').pop() ?? parsed.base;
  if (isKotlinMapType(base)) {
    if (member === 'keys') return parsed.args[0] ?? null;
    return parsed.args[1] ?? null;
  }
  if (isKotlinIterableType(base)) return parsed.args[0] ?? null;
  return normalizeKotlinType(rawType);
}

function parseKotlinGeneric(text: string): { base: string; args: string[] } | null {
  const trimmed = text.trim().replace(/\?$/, '');
  const open = trimmed.indexOf('<');
  const close = trimmed.lastIndexOf('>');
  if (open < 0 || close < open) return null;
  return {
    base: trimmed.slice(0, open).trim(),
    args: splitTopLevelKotlinArgs(trimmed.slice(open + 1, close)),
  };
}

function splitTopLevelKotlinArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((arg) => arg.length > 0);
}

function isKotlinMapType(base: string): boolean {
  return ['Map', 'MutableMap', 'HashMap', 'LinkedHashMap'].includes(base);
}

function isKotlinIterableType(base: string): boolean {
  return [
    'List',
    'MutableList',
    'ArrayList',
    'Set',
    'MutableSet',
    'Collection',
    'Iterable',
    'Sequence',
    'Array',
  ].includes(base);
}

function isKotlinTypeNode(node: SyntaxNode): boolean {
  return (
    node.type === 'user_type' || node.type === 'nullable_type' || node.type === 'function_type'
  );
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return descendants(node).filter((child) => child.type === type);
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function shouldEmitReadMember(navNode: SyntaxNode): boolean {
  const parent = navNode.parent;
  if (parent === null) return true;
  if (parent.type === 'call_expression') return false;
  if (parent.type === 'directly_assignable_expression') return false;
  return true;
}

function callArguments(callNode: SyntaxNode): SyntaxNode[] {
  const suffix = callNode.namedChildren.find((child) => child.type === 'call_suffix');
  if (suffix === undefined) return [];

  const valueArgs = suffix?.namedChildren.find((child) => child.type === 'value_arguments');
  const args = valueArgs?.namedChildren.filter((child) => child.type === 'value_argument') ?? [];
  const trailingLambdas = suffix.namedChildren.filter((child) => child.type === 'annotated_lambda');
  return [...args, ...trailingLambdas];
}

function inferArgType(argNode: SyntaxNode): string {
  const value = argNode.namedChild(0) ?? argNode;
  switch (value.type) {
    case 'integer_literal':
    case 'long_literal':
      return 'Int';
    case 'real_literal':
      return 'Double';
    case 'string_literal':
    case 'line_string_literal':
    case 'multi_line_string_literal':
      return 'String';
    case 'character_literal':
      return 'Char';
    case 'boolean_literal':
      return 'Boolean';
    case 'call_expression': {
      const first = value.namedChild(0);
      return first?.type === 'simple_identifier' ? first.text : '';
    }
    default:
      return '';
  }
}

function extensionFreeCallFallback(
  grouped: Record<string, Capture>,
  rootNode: SyntaxNode,
): CaptureMatch | null {
  const member = grouped['@reference.call.member'];
  const receiver = grouped['@reference.receiver'];
  const name = grouped['@reference.name'];
  if (member === undefined || receiver === undefined || name === undefined) return null;

  const callNode = findNodeAtRange(rootNode, member.range, 'call_expression');
  if (callNode === null) return null;
  const receiverNode = findNodeAtRange(rootNode, receiver.range);
  if (receiverNode === null || !isLiteralReceiver(receiverNode)) return null;

  const out: Record<string, Capture> = {
    '@reference.call.free': syntheticCapture('@reference.call.free', callNode, callNode.text),
    '@reference.name': syntheticCapture('@reference.name', callNode, name.text),
  };
  if (grouped['@reference.arity'] !== undefined)
    out['@reference.arity'] = grouped['@reference.arity'];
  if (grouped['@reference.parameter-types'] !== undefined) {
    out['@reference.parameter-types'] = grouped['@reference.parameter-types'];
  }
  return out;
}

function isLiteralReceiver(node: SyntaxNode): boolean {
  return [
    'integer_literal',
    'long_literal',
    'real_literal',
    'string_literal',
    'line_string_literal',
    'multi_line_string_literal',
    'character_literal',
    'boolean_literal',
  ].includes(node.type);
}
