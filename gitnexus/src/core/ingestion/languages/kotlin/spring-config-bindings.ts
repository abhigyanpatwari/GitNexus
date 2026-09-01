import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { makeScopeId, type ParsedFile, type ScopeId } from 'gitnexus-shared';
import {
  bindSpringConfigConsumers,
  type SpringConfigConsumer,
} from '../../frameworks/spring/config-bindings.js';
import { createSpringAnnotationNameResolver } from '../../frameworks/spring/bean-candidates.js';
import { parseSpringAnnotationArguments } from '../../frameworks/spring/annotation-arguments.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getKotlinParser } from './query.js';
import { getKotlinSpringConfigConsumerFacts } from './capture-side-channel.js';
import { isKotlinPackageSiblingVisibilityIncomplete } from './package-siblings.js';

const VALUE_ANNOTATION = 'org.springframework.beans.factory.annotation.Value';
const CONFIGURATION_PROPERTIES_ANNOTATION =
  'org.springframework.boot.context.properties.ConfigurationProperties';

const VALUE_SIMPLE = 'Value';
const CONFIGURATION_PROPERTIES_SIMPLE = 'ConfigurationProperties';
const SKIP_USE_SITES = new Set(['get', 'property', 'file']);
const BIND_USE_SITES = new Set(['field', 'set', 'param']);
const OWNER_TYPES = new Set(['class_declaration', 'object_declaration', 'companion_object']);
const INTERPOLATION_TYPES = new Set([
  'interpolated_identifier',
  'interpolated_expression',
  'interpolation_expression_start',
  'string_expression',
]);
const STRING_LITERAL_TYPES = new Set([
  'string_literal',
  'line_string_literal',
  'multi_line_string_literal',
  'character_literal',
]);

export interface KotlinSpringConfigConsumerFact {
  readonly consumer: SpringConfigConsumer;
  readonly annotationName: string;
  readonly classScopeId: ScopeId;
}

interface KotlinAnnotation {
  readonly name: string;
  readonly node: SyntaxNode;
  readonly useSiteTarget?: string;
}

interface KotlinImports {
  readonly exact: ReadonlyMap<string, string>;
  readonly wildcard: ReadonlySet<string>;
  readonly localTypes: ReadonlySet<string>;
}

function firstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  const stack = [...node.namedChildren].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.type === type) return current;
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      const child = current.namedChildren[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return undefined;
}

function ownerName(declaration: SyntaxNode): string | undefined {
  if (declaration.type === 'companion_object') {
    const named = declaration.namedChildren.find((child) => child.type === 'type_identifier');
    return named?.text.trim() || 'Companion';
  }
  return (
    declaration.childForFieldName('name')?.text.trim() ??
    declaration.namedChildren.find((child) => child.type === 'type_identifier')?.text.trim() ??
    declaration.namedChildren.find((child) => child.type === 'simple_identifier')?.text.trim()
  );
}

function enclosingOwner(node: SyntaxNode): SyntaxNode | undefined {
  let current = node.parent;
  while (current !== null) {
    if (OWNER_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return undefined;
}

function classScopeId(filePath: string, declaration: SyntaxNode): ScopeId {
  return makeScopeId({
    filePath,
    range: nodeToCapture('@scope.class', declaration).range,
    kind: 'Class',
  });
}

function collectKotlinImports(root: SyntaxNode): KotlinImports {
  const exact = new Map<string, string>();
  const wildcard = new Set<string>();
  const localTypes = new Set<string>();

  for (const header of root.descendantsOfType('import_header')) {
    const text = header.text.replace(/^import\s+/, '').trim();
    const aliasMatch = text.match(/^([\w.]+)\s+as\s+(\w+)\s*$/);
    if (aliasMatch !== null) {
      exact.set(aliasMatch[2], aliasMatch[1]);
      continue;
    }
    if (text.endsWith('.*')) wildcard.add(text.slice(0, -2));
    else {
      const simple = text.slice(text.lastIndexOf('.') + 1);
      if (simple.length > 0) exact.set(simple, text);
    }
  }

  for (const type of ['class_declaration', 'object_declaration']) {
    for (const declaration of root.descendantsOfType(type)) {
      const name = ownerName(declaration);
      if (name) localTypes.add(name);
    }
  }
  return { exact, wildcard, localTypes };
}

function annotationFromNode(annotation: SyntaxNode): KotlinAnnotation | null {
  const nameNode =
    firstDescendantOfType(annotation, 'user_type') ??
    firstDescendantOfType(annotation, 'type_identifier') ??
    firstDescendantOfType(annotation, 'simple_identifier');
  if (nameNode === undefined) return null;
  const useSiteTarget = annotation.namedChildren
    .find((child) => child.type === 'use_site_target')
    ?.text.replace(/:\s*$/, '')
    .trim();
  return {
    name: nameNode.text.trim(),
    node: annotation,
    ...(useSiteTarget === undefined || useSiteTarget.length === 0 ? {} : { useSiteTarget }),
  };
}

function annotationsOn(node: SyntaxNode): KotlinAnnotation[] {
  const annotations: KotlinAnnotation[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'annotation') {
      const fact = annotationFromNode(child);
      if (fact !== null) annotations.push(fact);
      continue;
    }
    if (child.type !== 'modifiers' && child.type !== 'parameter_modifiers') continue;
    for (const nested of child.namedChildren) {
      if (nested.type !== 'annotation') continue;
      const fact = annotationFromNode(nested);
      if (fact !== null) annotations.push(fact);
    }
  }
  return annotations;
}

function simpleName(rawName: string): string {
  const parts = rawName.split('.');
  return parts[parts.length - 1] ?? rawName;
}

function importedAs(
  imports: KotlinImports,
  simple: string,
  fqn: string,
  wildcardPackage: string,
): boolean {
  return imports.exact.get(simple) === fqn || imports.wildcard.has(wildcardPackage);
}

function configAnnotationKind(
  rawName: string,
  imports: KotlinImports,
): 'value' | 'configuration-properties' | null {
  if (rawName === VALUE_ANNOTATION) return 'value';
  if (rawName === CONFIGURATION_PROPERTIES_ANNOTATION) return 'configuration-properties';
  const simple = simpleName(rawName);
  const aliased = imports.exact.get(simple);
  if (aliased === VALUE_ANNOTATION) return 'value';
  if (aliased === CONFIGURATION_PROPERTIES_ANNOTATION) return 'configuration-properties';
  if (simple === VALUE_SIMPLE) {
    if (imports.localTypes.has(simple) && !imports.exact.has(simple)) return null;
    return importedAs(
      imports,
      simple,
      VALUE_ANNOTATION,
      'org.springframework.beans.factory.annotation',
    )
      ? 'value'
      : null;
  }
  if (simple === CONFIGURATION_PROPERTIES_SIMPLE) {
    if (imports.localTypes.has(simple) && !imports.exact.has(simple)) return null;
    return importedAs(
      imports,
      simple,
      CONFIGURATION_PROPERTIES_ANNOTATION,
      'org.springframework.boot.context.properties',
    )
      ? 'configuration-properties'
      : null;
  }
  return null;
}

function hasInterpolation(annotation: SyntaxNode): boolean {
  const stack: SyntaxNode[] = [...annotation.namedChildren];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (INTERPOLATION_TYPES.has(current.type)) return true;
    stack.push(...current.namedChildren);
  }
  return false;
}

function decodeKotlinStringLiteral(literal: string): string | null {
  const raw = literal.startsWith('"""') && literal.endsWith('"""');
  const delimiterLength = raw ? 3 : 1;
  if (literal.length < delimiterLength * 2) return null;
  const body = literal.slice(delimiterLength, -delimiterLength);
  if (!raw && /(?<!\\)\$\{/.test(body)) return null;
  if (raw) return body;
  return body
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\(["'\\$btnfr])/g, (_match, escaped: string) => {
      const controls: Record<string, string> = {
        b: '\b',
        t: '\t',
        n: '\n',
        f: '\f',
        r: '\r',
        $: '$',
      };
      return controls[escaped] ?? escaped;
    });
}

function kotlinStringLiterals(annotation: SyntaxNode): string[] {
  const literals: string[] = [];
  const stack: SyntaxNode[] = [...annotation.namedChildren];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (STRING_LITERAL_TYPES.has(current.type)) {
      const decoded = decodeKotlinStringLiteral(current.text);
      if (decoded !== null) literals.push(decoded);
      continue;
    }
    stack.push(...current.namedChildren);
  }
  return literals;
}

function parseValuePlaceholderKeys(annotation: SyntaxNode): string[] {
  if (hasInterpolation(annotation)) return [];
  const keys = new Set<string>();
  for (const literal of kotlinStringLiterals(annotation)) {
    for (const match of literal.matchAll(/\$\{([^{}]+)\}/g)) {
      const key = match[1].split(':', 1)[0].trim();
      if (/^[A-Za-z0-9_.-]+$/.test(key)) keys.add(key);
    }
  }
  return [...keys];
}

function parseConfigurationPropertiesPrefix(annotation: SyntaxNode): string | null {
  if (hasInterpolation(annotation)) return null;
  const argumentsList = parseSpringAnnotationArguments(annotation.text);
  if (argumentsList !== null) {
    const named = argumentsList.filter(
      (argument) => argument.name === 'prefix' || argument.name === 'value',
    );
    const chosen =
      named.length === 1 ? named[0] : named.length === 0 ? argumentsList[0] : undefined;
    if (chosen !== undefined) {
      const decoded = decodeKotlinStringLiteral(chosen.value.trim()) ?? chosen.value.trim();
      const prefix = decoded.replace(/^["']|["']$/g, '').replace(/^\.+|\.+$/g, '');
      if (/^[A-Za-z0-9_.-]+$/.test(prefix)) return prefix;
    }
  }
  const literals = kotlinStringLiterals(annotation);
  if (literals.length !== 1) return null;
  const prefix = literals[0].trim().replace(/^\.+|\.+$/g, '');
  return /^[A-Za-z0-9_.-]+$/.test(prefix) ? prefix : null;
}

function allowedUseSite(useSiteTarget: string | undefined): boolean {
  if (useSiteTarget === undefined) return true;
  if (SKIP_USE_SITES.has(useSiteTarget)) return false;
  return BIND_USE_SITES.has(useSiteTarget);
}

function hasBindingPattern(parameter: SyntaxNode): boolean {
  return parameter.namedChildren.some((child) => child.type === 'binding_pattern_kind');
}

function propertyName(node: SyntaxNode): string | undefined {
  if (node.type === 'class_parameter') {
    return node.namedChildren.find((child) => child.type === 'simple_identifier')?.text.trim();
  }
  const variable = node.namedChildren.find((child) => child.type === 'variable_declaration');
  return variable?.namedChildren.find((child) => child.type === 'simple_identifier')?.text.trim();
}

function underFileAnnotation(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current !== null) {
    if (current.type === 'file_annotation') return true;
    current = current.parent;
  }
  return false;
}

function pushValueFacts(
  facts: KotlinSpringConfigConsumerFact[],
  member: SyntaxNode,
  filePath: string,
  imports: KotlinImports,
): void {
  if (underFileAnnotation(member)) return;
  const owner = enclosingOwner(member);
  if (owner === undefined) return;
  const fieldName = propertyName(member);
  if (fieldName === undefined) return;
  for (const annotation of annotationsOn(member)) {
    if (!allowedUseSite(annotation.useSiteTarget)) continue;
    if (configAnnotationKind(annotation.name, imports) !== 'value') continue;
    const keys = parseValuePlaceholderKeys(annotation.node);
    if (keys.length === 0) continue;
    facts.push({
      consumer: {
        kind: 'value',
        fieldName,
        line: member.startPosition.row + 1,
        keys,
      },
      annotationName: annotation.name,
      classScopeId: classScopeId(filePath, owner),
    });
  }
}

/** Collect config facts from the Kotlin parser's existing AST (no reparse). */
export function captureKotlinSpringConfigConsumerFacts(
  root: SyntaxNode,
  filePath: string,
): KotlinSpringConfigConsumerFact[] {
  const imports = collectKotlinImports(root);
  const facts: KotlinSpringConfigConsumerFact[] = [];

  for (const property of root.descendantsOfType('property_declaration')) {
    pushValueFacts(facts, property, filePath, imports);
  }

  for (const parameter of root.descendantsOfType('class_parameter')) {
    if (!hasBindingPattern(parameter)) continue;
    pushValueFacts(facts, parameter, filePath, imports);
  }

  for (const type of ['class_declaration', 'object_declaration']) {
    for (const declaration of root.descendantsOfType(type)) {
      const className = ownerName(declaration);
      if (className === undefined) continue;
      for (const annotation of annotationsOn(declaration)) {
        if (configAnnotationKind(annotation.name, imports) !== 'configuration-properties') {
          continue;
        }
        const prefix = parseConfigurationPropertiesPrefix(annotation.node);
        if (prefix === null) continue;
        facts.push({
          consumer: {
            kind: 'configuration-properties',
            className,
            line: declaration.startPosition.row + 1,
            prefix,
          },
          annotationName: annotation.name,
          classScopeId: classScopeId(filePath, declaration),
        });
      }
    }
  }
  return facts;
}

/** Parse Kotlin consumers for focused unit tests; production reuses the worker AST. */
export function extractKotlinSpringConfigConsumers(source: string): SpringConfigConsumer[] {
  const tree = parseSourceSafe(getKotlinParser(), source);
  return captureKotlinSpringConfigConsumerFacts(tree.rootNode, '<memory>').map(
    (fact) => fact.consumer,
  );
}

export function extractKotlinSpringConfigConsumerFacts(
  source: string,
): KotlinSpringConfigConsumerFact[] {
  const tree = parseSourceSafe(getKotlinParser(), source);
  return captureKotlinSpringConfigConsumerFacts(tree.rootNode, '<memory>');
}

/** Kotlin ScopeResolver post-resolution hook for Spring configuration consumers. */
export function attachKotlinSpringConfigBindings(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  _nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): void {
  const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
  const recognizedAnnotations = new Set([VALUE_ANNOTATION, CONFIGURATION_PROPERTIES_ANNOTATION]);
  const batches: Array<{ filePath: string; consumers: SpringConfigConsumer[] }> = [];
  for (const parsed of parsedFiles) {
    const consumers: SpringConfigConsumer[] = [];
    for (const fact of getKotlinSpringConfigConsumerFacts(parsed.filePath)) {
      const classScope = indexes.scopeTree.getScope(fact.classScopeId);
      if (classScope === undefined || classScope.kind !== 'Class') continue;
      const expectedAnnotation =
        fact.consumer.kind === 'value' ? VALUE_ANNOTATION : CONFIGURATION_PROPERTIES_ANNOTATION;
      const enclosingScope = fact.consumer.kind === 'value' ? classScope.id : classScope.parent;
      const resolved = resolveAnnotation(
        fact.annotationName,
        parsed,
        enclosingScope,
        recognizedAnnotations,
        isKotlinPackageSiblingVisibilityIncomplete(parsed.filePath),
      );
      if (resolved === expectedAnnotation) consumers.push(fact.consumer);
    }
    if (consumers.length > 0) batches.push({ filePath: parsed.filePath, consumers });
  }
  bindSpringConfigConsumers(graph, batches);
}
