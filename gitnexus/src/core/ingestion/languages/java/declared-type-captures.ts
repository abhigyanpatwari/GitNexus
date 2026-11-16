import type Parser from 'tree-sitter';
import {
  makeScopeId,
  type Capture,
  type CaptureMatch,
  type Range,
  type ScopeId,
} from 'gitnexus-shared';
import { javaLocalTypeDeclarationContainer, nodeToCapture } from '../../utils/ast-helpers.js';
import { javaTrailingDimensions, javaTypeText } from './type-spelling.js';
import {
  getJavaOverloadFacts,
  javaRangeContains,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';

type SyntaxNode = Parser.SyntaxNode;
interface DeclaredBinding {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly type?: string;
  readonly contextualQualified?: boolean;
  readonly typeSource: SyntaxNode;
  readonly evidence?: TypeEvidence;
}

/** Ephemeral proof tree: no AST nodes or new fields enter ParsedFile. */
interface TypeEvidence {
  readonly spelling: string;
  readonly base: string;
  readonly dimensions: number;
  readonly args: readonly TypeEvidence[];
  readonly lookupScope: ScopeId;
  readonly source: SyntaxNode;
  readonly writtenQualified: boolean;
}

const LEXICAL_CONTAINERS = new Set([
  'program',
  'class_body',
  'interface_body',
  'enum_body',
  'annotation_type_body',
  'block',
  'method_declaration',
  'constructor_declaration',
  'lambda_expression',
  'for_statement',
  'enhanced_for_statement',
  'catch_clause',
  'try_with_resources_statement',
]);
const ITERABLE_TYPES = new Set([
  'java.lang.Iterable',
  'java.util.Collection',
  'java.util.List',
  'java.util.Set',
]);
const STREAM_TYPE = 'java.util.stream.Stream';

/** Keep container types on ordinary receivers. Element types are available
 * only at an array/Iterable iteration or a bounded, proven JDK callback. */
export function synthesizeJavaDeclaredTypeCaptures(
  root: SyntaxNode,
  filePath: string,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const bindings = new Map<number, Map<string, DeclaredBinding[]>>();
  const imports = new Map<string, Set<string>>();
  const localTypes = new Set<string>();
  const localTypeScopes = new Set<ScopeId>();
  const typeParameters = new Set<string>();
  const ownerCache = new Map<number, SyntaxNode>();
  const sourceTypes = new Map<string, JavaOverloadTypeFact[]>();
  for (const fact of getJavaOverloadFacts(filePath)?.types ?? []) {
    const named = sourceTypes.get(fact.simpleName) ?? [];
    named.push(fact);
    sourceTypes.set(fact.simpleName, named);
  }
  const nodes = root.descendantsOfType([
    'import_declaration',
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'annotation_type_declaration',
    'type_parameter',
    'field_declaration',
    'local_variable_declaration',
    'formal_parameter',
    'spread_parameter',
    'catch_formal_parameter',
    'resource',
    'lambda_expression',
    'enhanced_for_statement',
  ]);
  const ownerOf = (node: SyntaxNode): SyntaxNode => {
    const seen: SyntaxNode[] = [];
    let current = node;
    while (!LEXICAL_CONTAINERS.has(current.type) && current.parent !== null) {
      const cached = ownerCache.get(current.id);
      if (cached !== undefined) {
        current = cached;
        break;
      }
      seen.push(current);
      current = current.parent;
    }
    for (const entry of seen) ownerCache.set(entry.id, current);
    return current;
  };
  const add = (
    owner: SyntaxNode,
    name: SyntaxNode,
    type?: string,
    start = name.startIndex,
    end = owner.endIndex,
    contextualQualified = false,
    typeSource = name,
    evidence?: TypeEvidence,
  ) => {
    const names = bindings.get(owner.id) ?? new Map<string, DeclaredBinding[]>();
    const values = names.get(name.text) ?? [];
    values.push({
      name: name.text,
      start,
      end,
      ...(type === undefined ? {} : { type }),
      ...(contextualQualified ? { contextualQualified: true } : {}),
      typeSource,
      ...(evidence === undefined ? {} : { evidence }),
    });
    names.set(name.text, values);
    bindings.set(owner.id, names);
  };
  const lookup = (expression: SyntaxNode): DeclaredBinding | undefined => {
    if (expression.type !== 'identifier') return undefined;
    let current: SyntaxNode | null = expression;
    // Deeply nested callbacks are an uncertainty boundary, not an unbounded
    // per-callback ancestor walk on hostile or generated source.
    for (let depth = 0; current !== null && depth < 128; depth++) {
      const candidates = bindings.get(current.id)?.get(expression.text);
      let selected: DeclaredBinding | undefined;
      for (const binding of candidates ?? []) {
        if (
          binding.start <= expression.startIndex &&
          expression.startIndex < binding.end &&
          (selected === undefined || binding.start >= selected.start)
        )
          selected = binding;
      }
      // An unknown declaration still stops the walk; do not borrow an outer type.
      if (selected !== undefined) return selected;
      current = current.parent;
    }
    return undefined;
  };

  for (const node of nodes) {
    if (node.type === 'import_declaration') {
      const imported = /^import\s+([\w.$]+)\s*;$/.exec(node.text)?.[1];
      if (imported !== undefined) {
        const tail = imported.slice(imported.lastIndexOf('.') + 1);
        const targets = imports.get(tail) ?? new Set<string>();
        targets.add(imported);
        imports.set(tail, targets);
      }
    } else if (node.type === 'type_parameter') {
      const name =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'type_identifier');
      if (name !== undefined && name !== null) typeParameters.add(name.text);
    } else if (
      node.type.endsWith('_declaration') &&
      node.childForFieldName('body') !== null &&
      node.childForFieldName('name') !== null
    ) {
      if (
        [
          'class_declaration',
          'interface_declaration',
          'enum_declaration',
          'record_declaration',
          'annotation_type_declaration',
        ].includes(node.type)
      ) {
        localTypes.add(node.childForFieldName('name')!.text);
        if (javaLocalTypeDeclarationContainer(node) !== null)
          localTypeScopes.add(
            makeScopeId({ filePath, range: nodeToCapture('', node).range, kind: 'Class' }),
          );
      }
    }

    if (node.type === 'field_declaration' || node.type === 'local_variable_declaration') {
      const declared = node.childForFieldName('type');
      const owner = ownerOf(node.parent ?? root);
      for (const declarator of node.namedChildren.filter(
        (child) => child.type === 'variable_declarator',
      )) {
        const name = declarator.childForFieldName('name');
        if (name === null) continue;
        const value = declarator.childForFieldName('value');
        const type =
          declared?.text === 'var'
            ? value?.type === 'object_creation_expression'
              ? value.childForFieldName('type')
              : null
            : declared;
        add(
          owner,
          name,
          type === null ? undefined : javaTypeText(type) + javaTrailingDimensions(declarator),
          node.type === 'field_declaration' ? -1 : name.startIndex,
          owner.endIndex,
          false,
          type ?? name,
        );
      }
    } else if (
      node.type === 'formal_parameter' ||
      node.type === 'spread_parameter' ||
      node.type === 'catch_formal_parameter'
    ) {
      const declarator = node.namedChildren.find((child) => child.type === 'variable_declarator');
      const name = node.childForFieldName('name') ?? declarator?.childForFieldName('name');
      const type =
        node.childForFieldName('type') ??
        (node.type === 'spread_parameter'
          ? node.namedChildren.find(
              (child) => child.type !== 'modifiers' && child.type !== 'variable_declarator',
            )
          : undefined);
      if (name !== undefined && name !== null)
        add(
          ownerOf(node.parent ?? root),
          name,
          type === undefined || type === null || type.text === 'var'
            ? undefined
            : javaTypeText(type) +
                javaTrailingDimensions(node) +
                (node.type === 'spread_parameter' ? '[]' : ''),
          -1,
          ownerOf(node.parent ?? root).endIndex,
          false,
          type ?? name,
        );
    } else if (node.type === 'lambda_expression') {
      for (const parameter of lambdaParameters(node)) {
        if (parameter.type === 'identifier') add(node, parameter, undefined, -1);
      }
    } else if (node.type === 'resource') {
      const name = node.childForFieldName('name');
      const type = node.childForFieldName('type');
      const owner = ownerOf(node.parent ?? root);
      const body = owner.childForFieldName('body');
      if (name !== null && type !== null)
        add(
          owner,
          name,
          type.text === 'var' ? undefined : javaTypeText(type),
          name.startIndex,
          body?.endIndex ?? owner.endIndex,
          false,
          type,
        );
    }
  }

  const producerScope = (source: SyntaxNode): ScopeId | undefined => {
    let node: SyntaxNode | null = source;
    for (let depth = 0; node !== null && depth < 128; depth++, node = node.parent) {
      const range = nodeToCapture('', node).range;
      if (
        [
          'class_declaration',
          'interface_declaration',
          'enum_declaration',
          'record_declaration',
          'annotation_type_declaration',
        ].includes(node.type)
      )
        return makeScopeId({ filePath, range, kind: 'Class' });
      if (
        node.type === 'class_body' &&
        ['object_creation_expression', 'enum_constant'].includes(node.parent?.type ?? '')
      )
        return makeScopeId({ filePath, range, kind: 'Class' });
      if (
        [
          'method_declaration',
          'constructor_declaration',
          'compact_constructor_declaration',
        ].includes(node.type)
      )
        return makeScopeId({ filePath, range, kind: 'Function' });
      if (['block', 'for_statement', 'lambda_expression'].includes(node.type))
        return makeScopeId({ filePath, range, kind: 'Block' });
      if (node.type === 'program') return makeScopeId({ filePath, range, kind: 'Module' });
    }
    return undefined;
  };
  const point = (node: SyntaxNode): Range => ({
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.startPosition.row + 1,
    endCol: node.startPosition.column,
  });
  const identify = (
    spelling: string,
    source: SyntaxNode,
    use: SyntaxNode,
    inheritedScope?: ScopeId,
  ): TypeEvidence | undefined => {
    const array = spelling.match(/(?:\[\])+$/)?.[0] ?? '';
    const dimensions = array.length / 2;
    const core = spelling.slice(0, spelling.length - array.length);
    const generic = core.indexOf('<');
    const raw = generic < 0 ? core : core.slice(0, generic);
    if (!/^[\w.$]+$/.test(raw) || typeParameters.has(raw)) return undefined;
    const argumentsText =
      generic < 0 ? [] : core.endsWith('>') ? splitArguments(core.slice(generic + 1, -1)) : [];
    if (generic >= 0 && argumentsText.length === 0) return undefined;
    const args = argumentsText.map((argument) => identify(argument, source, use, inheritedScope));
    if (args.some((argument) => argument === undefined)) return undefined;
    let lookupScope = inheritedScope ?? producerScope(source);
    if (lookupScope === undefined) return undefined;
    let base = raw;
    if (!raw.includes('.')) {
      const named = sourceTypes.get(raw) ?? [];
      const visible = named
        .filter((fact) => javaRangeContains(fact.visible, point(source)))
        .sort((a, b) =>
          javaRangeContains(a.visible, b.visible)
            ? javaRangeContains(b.visible, a.visible)
              ? 0
              : 1
            : javaRangeContains(b.visible, a.visible)
              ? -1
              : 0,
        );
      const nearest = visible[0];
      if (nearest !== undefined) {
        if (
          visible[1] !== undefined &&
          (javaRangeContains(nearest.visible, visible[1].visible) ||
            !javaRangeContains(visible[1].visible, nearest.visible))
        )
          return undefined;
        lookupScope = makeScopeId({ filePath, range: nearest.range, kind: 'Class' });
      } else {
        const imported = imports.get(raw);
        if (imported?.size === 1) base = [...imported][0]!;
        else if (imported !== undefined || (localTypes.has(raw) && named.length === 0))
          return undefined;
        else if (
          named.some(
            (fact) =>
              javaRangeContains(fact.visible, point(use)) &&
              !javaRangeContains(fact.visible, point(source)),
          )
        )
          return undefined;
      }
    }
    const proven = args as TypeEvidence[];
    return {
      base,
      dimensions,
      args: proven,
      lookupScope,
      source,
      writtenQualified: raw.startsWith('java.'),
      spelling:
        base +
        (generic < 0 ? '' : `<${proven.map((argument) => argument.spelling).join(',')}>`) +
        array,
    };
  };
  const evidenceFor = (
    binding: DeclaredBinding | undefined,
    use: SyntaxNode,
  ): TypeEvidence | undefined => {
    const written = binding?.type;
    if (written === undefined || written.length > 512) return undefined;
    if (
      !/^[\w.$<>\[\],]+$/.test(written) ||
      written.split(/[^\w$]+/).some((token) => typeParameters.has(token))
    )
      return undefined;
    return binding.evidence ?? identify(written, binding.typeSource, use);
  };
  const container = (
    binding: DeclaredBinding | undefined,
    use: SyntaxNode,
  ): { base: string; args: readonly TypeEvidence[]; contextualQualified: boolean } | undefined => {
    const evidence = evidenceFor(binding, use);
    if (
      evidence === undefined ||
      evidence.dimensions !== 0 ||
      evidence.args.length === 0 ||
      localTypes.has(evidence.base.split('.')[0]!)
    )
      return undefined;
    return {
      base: evidence.base,
      args: evidence.args,
      contextualQualified: binding?.contextualQualified === true || evidence.writtenQualified,
    };
  };

  // Native descendants are in source order: outer operations publish their
  // element declaration before a nested operation asks for that declaration.
  for (const node of nodes) {
    if (node.type === 'enhanced_for_statement') {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const type = node.childForFieldName('type');
      const value = node.childForFieldName('value');
      if (name === null || body === null || type === null || value === null) continue;
      const binding = lookup(value);
      const written = binding?.type;
      const writtenEvidence = evidenceFor(binding, node);
      const iterable = container(binding, node);
      let mapElement: TypeEvidence | undefined;
      let mapQualified = false;
      if (value.type === 'method_invocation') {
        const receiver = value.childForFieldName('object');
        const args = value.childForFieldName('arguments');
        const member = value.childForFieldName('name')?.text;
        const map = receiver === null ? undefined : container(lookup(receiver), node);
        if (
          map?.base === 'java.util.Map' &&
          map.args.length === 2 &&
          args !== null &&
          args.namedChildren.every(
            (child) => child.type === 'line_comment' || child.type === 'block_comment',
          )
        ) {
          if (member === 'values') mapElement = map.args[1];
          else if (member === 'keySet') mapElement = map.args[0];
          if (mapElement !== undefined) mapQualified = map.contextualQualified;
        }
      }
      const candidate =
        type.text !== 'var'
          ? identify(javaTypeText(type), type, node)
          : writtenEvidence !== undefined && writtenEvidence.dimensions > 0
            ? {
                ...writtenEvidence,
                spelling: writtenEvidence.spelling.slice(0, -2),
                dimensions: writtenEvidence.dimensions - 1,
              }
            : iterable !== undefined &&
                ITERABLE_TYPES.has(iterable.base) &&
                iterable.args.length === 1
              ? iterable.args[0]
              : mapElement;
      out.push(loopScope(body, name));
      const contextualQualified =
        type.text === 'var' &&
        (written?.endsWith('[]')
          ? binding?.contextualQualified === true || writtenEvidence?.writtenQualified === true
          : iterable !== undefined &&
              ITERABLE_TYPES.has(iterable.base) &&
              iterable.args.length === 1
            ? iterable.contextualQualified
            : mapQualified);
      // A raw JDK spelling needs validation in the container's environment.
      // Re-anchoring a local element there loses its synthetic visibility
      // scope. Keep the lexical barrier until both proofs can be retained.
      const inferred =
        contextualQualified && candidate !== undefined && localTypeScopes.has(candidate.lookupScope)
          ? undefined
          : candidate;
      add(
        body,
        name,
        inferred?.spelling,
        body.startIndex,
        body.endIndex,
        contextualQualified,
        inferred?.source ?? type,
        inferred,
      );
      if (inferred !== undefined)
        out.push(
          bindingCapture(
            name,
            inferred.spelling,
            body,
            contextualQualified,
            contextualQualified
              ? (producerScope(inferred.source) ?? inferred.lookupScope)
              : inferred.lookupScope,
          ),
        );
    } else if (node.type === 'lambda_expression') {
      const argumentsNode = node.parent;
      const call = argumentsNode?.parent;
      const receiver = call?.childForFieldName('object');
      const member = call?.childForFieldName('name')?.text;
      if (
        argumentsNode?.type !== 'argument_list' ||
        call?.type !== 'method_invocation' ||
        receiver === undefined ||
        receiver === null ||
        argumentsNode.namedChildren.filter(
          (child) => child.type !== 'line_comment' && child.type !== 'block_comment',
        ).length !== 1
      )
        continue;
      const owner = container(lookup(receiver), node);
      if (owner === undefined) continue;
      const parameters = lambdaParameters(node);
      const expected =
        owner.base === 'java.util.Map' && member === 'forEach' && owner.args.length === 2
          ? owner.args
          : ((ITERABLE_TYPES.has(owner.base) && member === 'forEach') ||
                (owner.base === STREAM_TYPE &&
                  (member === 'forEach' || member === 'forEachOrdered'))) &&
              owner.args.length === 1
            ? owner.args
            : undefined;
      if (expected === undefined || expected.length !== parameters.length) continue;
      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i]!;
        const explicit = parameter.childForFieldName('type');
        if (explicit !== null && explicit.text !== 'var') continue;
        const name =
          parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name');
        if (name === null) continue;
        const inferred = expected[i]!;
        if (owner.contextualQualified && localTypeScopes.has(inferred.lookupScope)) {
          add(node, name, undefined, -1, node.endIndex);
          continue;
        }
        add(
          node,
          name,
          inferred.spelling,
          -1,
          node.endIndex,
          owner.contextualQualified,
          inferred.source,
          inferred,
        );
        out.push(
          bindingCapture(
            name,
            inferred.spelling,
            undefined,
            owner.contextualQualified,
            // Raw-JDK validation must inspect the container's original
            // declaration environment, including inherited/package roots.
            owner.contextualQualified
              ? (producerScope(inferred.source) ?? inferred.lookupScope)
              : inferred.lookupScope,
          ),
        );
      }
    }
  }
  return out;
}

function lambdaParameters(lambda: SyntaxNode): SyntaxNode[] {
  const parameters = lambda.childForFieldName('parameters');
  return parameters === null
    ? []
    : parameters.type === 'identifier'
      ? [parameters]
      : parameters.namedChildren.filter(
          (node) =>
            node.type === 'identifier' ||
            node.type === 'formal_parameter' ||
            node.type === 'spread_parameter',
        );
}

function splitArguments(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') depth--;
    else if (text[i] === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) return [];
  }
  if (depth !== 0) return [];
  args.push(text.slice(start));
  return args.every((arg) => arg.length > 0) ? args : [];
}

function loopScope(body: SyntaxNode, name: SyntaxNode): CaptureMatch {
  const scope = nodeToCapture('@scope.block', body);
  return {
    '@scope.block': scope,
    '@scope.lexical-names': {
      ...scope,
      name: '@scope.lexical-names',
      text: JSON.stringify([name.text]),
    },
  };
}

function bindingCapture(
  name: SyntaxNode,
  spelling: string,
  body?: SyntaxNode,
  contextualQualified = false,
  lookupScope?: ScopeId,
): CaptureMatch {
  const anchor: Capture =
    body === undefined
      ? nodeToCapture('@type-binding.parameter', name)
      : {
          name: '@type-binding.parameter',
          text: name.text,
          range: {
            startLine: body.startPosition.row + 1,
            startCol: body.startPosition.column,
            endLine: body.startPosition.row + 1,
            endCol: body.startPosition.column,
          },
        };
  return {
    '@type-binding.parameter': anchor,
    '@type-binding.name': nodeToCapture('@type-binding.name', name),
    '@type-binding.type': { ...nodeToCapture('@type-binding.type', name), text: spelling },
    ...(lookupScope === undefined
      ? {}
      : {
          '@type.lookup-scope': { ...anchor, name: '@type.lookup-scope', text: lookupScope },
        }),
    ...(contextualQualified
      ? {
          '@type-binding.contextual-qualified': {
            ...anchor,
            name: '@type-binding.contextual-qualified',
          },
        }
      : {}),
  };
}
