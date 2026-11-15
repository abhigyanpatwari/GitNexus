import type Parser from 'tree-sitter';
import { CLASS_KINDS, SupportedLanguages } from 'gitnexus-shared';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
} from '../../scope-resolution/graph-bridge/node-lookup.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  nodeRange,
} from '../rename-tree-sitter.js';
import { graphRenameFamily } from '../rename-family.js';

const canonicalName = (name: string): string =>
  name.replace(/\\u+([0-9a-fA-F]{4})/g, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
const names = new Set(['identifier', 'type_identifier']);
const keywords = new Set(
  '_ abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null record sealed permits yield var'.split(
    ' ',
  ),
);

function role(node: Parser.SyntaxNode): RenameOccurrence['role'] {
  const parent = node.parent;
  if (!parent) return 'name';
  if (
    (parent.type === 'formal_parameter' && parent.childForFieldName('name')?.id === node.id) ||
    parent.type === 'inferred_parameters' ||
    (parent.type === 'lambda_expression' && parent.childForFieldName('parameters')?.id === node.id)
  )
    return 'binding';
  if (
    parent.type === 'labeled_statement' ||
    parent.type === 'break_statement' ||
    parent.type === 'continue_statement'
  )
    return 'unrelated';
  for (let ancestor: Parser.SyntaxNode | null = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'import_declaration') return 'imported';
    if (ancestor.type === 'package_declaration') return 'unrelated';
  }
  return 'name';
}

function reference(node: Parser.SyntaxNode, source: RenameSource) {
  const parent = node.parent;
  if (
    !parent ||
    (parent.childForFieldName('name')?.id === node.id &&
      /declaration|definition|signature|declarator/.test(parent.type))
  )
    return undefined;
  // A qualified member has its own semantic receiver; never reinterpret it as a bare lexical read.
  if (
    [
      'field_access',
      'method_invocation',
      'method_reference',
      'scoped_identifier',
      'scoped_type_identifier',
    ].includes(parent.type) &&
    parent.namedChildCount > 1 &&
    parent.lastNamedChild?.id === node.id
  )
    return undefined;
  const inScope = innermostRenameScope(source.parsed, node);
  if (!inScope) return undefined;
  const range = nodeRange(node);
  return {
    name: canonicalName(node.text),
    atRange: range,
    nameRange: range,
    inScope,
    kind: node.type === 'type_identifier' ? ('type-reference' as const) : ('read' as const),
  };
}

export const javaRenameProvider: RenameProvider = {
  interoperatesWithSourceProvider: (provider) => provider.id === SupportedLanguages.Kotlin,
  interopNames(name) {
    // Kotlin can spell a Java accessor call as a synthetic property read/write.
    const suffix = /^(?:get|set)([A-Z].*)$/.exec(name)?.[1];
    return suffix ? [suffix[0].toLowerCase() + suffix.slice(1), suffix, `is${suffix}`] : [];
  },
  canonicalName,
  matchesGraphIdentity({ definition, definitions, node, graph }) {
    let name = definition.qualifiedName;
    if (!name) return false;
    if (definition.namespacePrefix && !name.startsWith(`${definition.namespacePrefix}.`))
      name = `${definition.namespacePrefix}.${name}`;
    if (
      !node.properties.qualifiedName &&
      (definition.type === 'Constructor' || definition.type === 'Annotation')
    ) {
      // These graph labels retain the immediate owner or bare declaration name.
      // The shared bridge already checked the file and current source range.
      const graphName = (def: typeof definition) => {
        const ownName = simpleQualifiedName(def);
        if (def.type === 'Annotation') return ownName;
        const owner = definitions.find((candidate) => candidate.nodeId === def.ownerId);
        return owner && ownName ? `${simpleQualifiedName(owner)}.${ownName}` : undefined;
      };
      name = graphName(definition);
      if (
        !name ||
        definitions.some(
          (other) =>
            other.nodeId !== definition.nodeId &&
            other.filePath === definition.filePath &&
            other.type === definition.type &&
            graphName(other) === name &&
            (definition.type === 'Annotation' || other.ownerId !== definition.ownerId),
        )
      )
        return false;
    }
    return (
      buildGraphNodeLookup(graph, new Set([node.label])).get(
        qualifiedKey(definition.filePath, node.label, name),
      ) === node.id
    );
  },
  validateName(name) {
    const canonical = canonicalName(name);
    if (!(/^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(canonical) && !keywords.has(canonical)))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved identifier.' };
  },
  parseSource: createTreeSitterRenameSource({
    isName: (node) => names.has(node.type),
    skip: (node) => node.type.includes('comment'),
    role,
    canonicalName,
    transformParsed: (parsed) => canonicalizeRenameBindings(parsed, canonicalName),
    reference,
  }),
  checkSafety({ target, definitions, files, newName }) {
    const type =
      target.type === 'Constructor'
        ? definitions.find((definition) => definition.nodeId === target.ownerId)
        : target;
    if (!type || !CLASS_KINDS.includes(type.type)) return;
    const declaration = files
      .get(type.filePath)
      ?.occurrences.find((occurrence) => occurrence.definitionId === type.nodeId)?.node?.parent;
    if (
      declaration?.parent?.type === 'program' &&
      declaration.namedChildren.some(
        (node) =>
          node.type === 'modifiers' && node.children.some((child) => child.type === 'public'),
      ) &&
      type.filePath.split('/').at(-1) !== `${canonicalName(newName)}.java`
    )
      return {
        code: 'unsupported_occurrence',
        status: 'unsupported',
        message: 'Renaming this public top-level Java type requires a file move to match its name.',
      };
  },
  symbolFamily(context) {
    const name = (def: typeof context.target) => canonicalName(simpleQualifiedName(def) ?? '');
    const method = (def: typeof context.target) =>
      ['Method', 'Function'].includes(def.type) && !!def.ownerId;
    const declaration = (def: typeof context.target) =>
      context.files
        .get(def.filePath)
        ?.occurrences.find((occurrence) => occurrence.definitionId === def.nodeId)?.node?.parent;
    const isInstance = (def: typeof context.target) =>
      !declaration(def)?.namedChildren.some(
        (node) =>
          node.type === 'modifiers' &&
          node.children.some((child) => ['private', 'static'].includes(child.text)),
      );
    return graphRenameFamily(context, {
      requiresBaseMember: (def) =>
        declaration(def)?.namedChildren.some(
          (node) =>
            node.type === 'modifiers' &&
            node.namedChildren.some(
              (child) =>
                ['marker_annotation', 'annotation'].includes(child.type) &&
                ['Override', 'java.lang.Override'].includes(
                  canonicalName(child.childForFieldName('name')?.text ?? ''),
                ),
            ),
        ) === true,
      matches: (left, right) =>
        method(left) &&
        method(right) &&
        isInstance(left) &&
        isInstance(right) &&
        name(left) === name(right),
      sameDeclarationGroup: (left, right) =>
        (method(left) &&
          method(right) &&
          left.ownerId === right.ownerId &&
          name(left) === name(right)) ||
        (CLASS_KINDS.includes(left.type) &&
          right.type === 'Constructor' &&
          right.ownerId === left.nodeId &&
          name(left) === name(right)) ||
        (CLASS_KINDS.includes(right.type) &&
          left.type === 'Constructor' &&
          left.ownerId === right.nodeId &&
          name(left) === name(right)),
    });
  },
};
