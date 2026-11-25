import type Parser from 'tree-sitter';
import {
  makeScopeId,
  type Capture,
  type CaptureMatch,
  type Range,
  type ScopeId,
  type TypeRef,
} from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import {
  eraseJavaTypeArguments,
  JAVA_DOTTED_SPELLING,
  JAVA_IDENTIFIER_PART_CHARS,
  javaTrailingDimensions,
  javaTypeText,
} from './type-spelling.js';
import { javaLambdaArgument, synthesizeJavaSamLambdaCaptures } from './sam-lambda-captures.js';
import {
  getJavaOverloadFacts,
  javaRangeContains,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';

type SyntaxNode = Parser.SyntaxNode;
interface DeclaredBinding {
  readonly declarationId: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly type?: string;
  /** Workspace facts an inferred element type depends on. */
  readonly proofs?: readonly BindingProof[];
  readonly typeSource: SyntaxNode;
  readonly evidence?: TypeEvidence;
}

/** What a name lookup found, and the class bodies it walked out of first. */
interface LookupResult {
  readonly binding?: DeclaredBinding;
  /** Innermost first: each body's supertypes may declare the name instead. */
  readonly shadows: readonly InheritedFieldProof[];
}
const UNRESOLVED: LookupResult = { shadows: [] };

const SINGLE_IMPORT = new RegExp(
  String.raw`^import\s+([${JAVA_IDENTIFIER_PART_CHARS}.]+)\s*;$`,
  'u',
);
const ON_DEMAND_IMPORT = new RegExp(
  String.raw`^import\s+([${JAVA_IDENTIFIER_PART_CHARS}.]+)\s*\.\s*\*\s*;$`,
  'u',
);
const WRITTEN_TYPE = new RegExp(String.raw`^[${JAVA_IDENTIFIER_PART_CHARS}.<>\[\],]+$`, 'u');
const NAME_SEPARATORS = new RegExp(`[^${JAVA_IDENTIFIER_PART_CHARS}]+`, 'u');

/**
 * The type of an element binding whose value may only come from a field that a
 * supertype declares. Resolution replaces it with that field's element type,
 * or removes it; it is not a Java identifier, so it never names a type.
 */
export const JAVA_INHERITED_FIELD_ELEMENT = '#inherited-field';

/**
 * A JDK container identity that only resolution can confirm: what a simple
 * name means where the container type was written. `root` is a raw `java.*`
 * spelling, `single` a single-type import, `on-demand` a type-import-on-demand
 * (including implicit `java.lang`). Inherited member types shadow all three;
 * same-package and other workspace types also shadow an on-demand import
 * (JLS 6.4.1, 7.5.2). Each proof is keyed by its binding's lookup anchor.
 */
export interface ContainerProof {
  readonly kind: 'root' | 'single' | 'on-demand';
  readonly name: string;
  readonly scope: ScopeId;
}

/** How a bound value is read from a field: a loop, a map view or a callback. */
export type JavaFieldElementRoute =
  | 'iterate'
  | 'values'
  | 'keySet'
  | 'forEach'
  | 'forEachOrdered'
  | 'forEachKey'
  | 'forEachValue';

/**
 * A lookup walked out of a class body that has supertypes without finding
 * `name`. The name means what it found further out only if no supertype of
 * that class declares an inherited field `name` (JLS 6.4.1, 8.3). When exactly
 * one does, a binding with a `route` takes that field's element instead; a
 * binding that depends on the field only transitively has no route.
 */
export interface InheritedFieldProof {
  readonly kind: 'unshadowed-field';
  readonly name: string;
  /** Class scope of the type whose supertypes are checked. */
  readonly scope: ScopeId;
  readonly route?: JavaFieldElementRoute;
}

export type BindingProof = ContainerProof | InheritedFieldProof;

export type JavaContainerProofFact = BindingProof & {
  /** `TypeRef.lookupPosition` of the dependent binding (1-based line). */
  readonly line: number;
  readonly col: number;
};

/** A field (or interface or enum constant) a type declares. */
export interface JavaFieldFact {
  readonly name: string;
  /** Who inherits it (JLS 8.3): no subclass inherits a private field, and
   * only a subclass in the same package inherits a package-access one. */
  readonly access: 'private' | 'package' | 'inherited';
  /** Elements of a JDK container or array field type, by route, each read
   * where the field type was written (1-based `line`), after `proofs` hold. */
  readonly element?: {
    readonly line: number;
    readonly col: number;
    readonly proofs: readonly ContainerProof[];
    readonly elements: readonly {
      readonly route: JavaFieldElementRoute;
      readonly spelling: string;
      readonly scope: ScopeId;
    }[];
  };
}

/** The written supertypes and fields of one type that has either; a type
 * missing from its file's list has neither. */
export interface JavaTypeFieldsFact {
  /** The type's class scope range. */
  readonly range: Range;
  /** Erased simple names of the written supertypes. */
  readonly bases: readonly string[];
  readonly fields: readonly JavaFieldFact[];
}

/** How a call-result assignment reaches an element of the returned value. */
export type JavaCallResultElementRoute = 'iterate' | 'values' | 'keySet';

/**
 * What a method's declared JDK container return type yields per element
 * route, read where the return type was written. A caller's `var` loop over
 * the selected method's result is typed only through these facts, and only
 * after resolution confirms `proofs` at `line`/`col` of the return type.
 */
export interface JavaReturnElementFact {
  /** The method's `declarationRange` start (1-based line). */
  readonly methodLine: number;
  readonly methodCol: number;
  /** The return type's spelling (`javaTypeText`), matched against `SymbolDefinition.returnType`. */
  readonly written: string;
  /** Start of the written return type (1-based line). */
  readonly line: number;
  readonly col: number;
  readonly proofs: readonly ContainerProof[];
  readonly elements: readonly {
    readonly route: JavaCallResultElementRoute;
    readonly spelling: string;
    readonly scope: ScopeId;
  }[];
}

/**
 * How a dotted element spelling is read at a binding's lookup anchor (1-based
 * line). `import`: it is a single-type import's canonical name, so it names
 * the imported type wherever it is read, never a member of a type in scope
 * there (JLS 7.5.1; a same-package type is not in scope in an import, JLS 6.3).
 * `ambiguous`: the anchor also carries that spelling as written source, and
 * the two readings cannot be told apart, so resolution refuses both.
 */
export interface JavaImportedSpellingFact {
  readonly line: number;
  readonly col: number;
  /** Erased, without array dimensions, as qualified lookup reads it. */
  readonly spelling: string;
  readonly status: 'import' | 'ambiguous';
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
  /** How a simple-name base was proven to be a JDK container. */
  readonly imported?: 'single' | 'on-demand';
}

// A switch-group local is in scope for the rest of its switch block (JLS 6.3),
// and record components are fields of the record body only.
const LEXICAL_CONTAINERS = new Set([
  'program',
  'class_body',
  'interface_body',
  'enum_body',
  'annotation_type_body',
  'record_declaration',
  'block',
  'switch_block',
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'lambda_expression',
  'for_statement',
  'enhanced_for_statement',
  'catch_clause',
  'try_with_resources_statement',
]);
// Each type's single type parameter is its Iterable element type.
const ITERABLE_TYPES = new Set([
  'java.lang.Iterable',
  ...[
    'Collection',
    'SequencedCollection',
    'List',
    'Set',
    'SequencedSet',
    'SortedSet',
    'NavigableSet',
    'Queue',
    'Deque',
    'AbstractCollection',
    'AbstractList',
    'AbstractSequentialList',
    'AbstractSet',
    'AbstractQueue',
    'ArrayList',
    'LinkedList',
    'Vector',
    'Stack',
    'HashSet',
    'LinkedHashSet',
    'TreeSet',
    'EnumSet',
    'ArrayDeque',
    'PriorityQueue',
  ].map((name) => `java.util.${name}`),
  ...[
    'BlockingQueue',
    'BlockingDeque',
    'ArrayBlockingQueue',
    'LinkedBlockingQueue',
    'LinkedBlockingDeque',
    'PriorityBlockingQueue',
    'ConcurrentLinkedQueue',
    'ConcurrentLinkedDeque',
    'ConcurrentSkipListSet',
    'CopyOnWriteArrayList',
    'CopyOnWriteArraySet',
  ].map((name) => `java.util.concurrent.${name}`),
]);
// Each type's parameters are <K, V>: `keySet()` yields K, `values()` V.
const MAP_TYPES = new Set([
  ...[
    'Map',
    'SortedMap',
    'NavigableMap',
    'SequencedMap',
    'AbstractMap',
    'HashMap',
    'LinkedHashMap',
    'TreeMap',
    'Hashtable',
    'WeakHashMap',
    'IdentityHashMap',
    'EnumMap',
  ].map((name) => `java.util.${name}`),
  ...['ConcurrentMap', 'ConcurrentNavigableMap', 'ConcurrentHashMap', 'ConcurrentSkipListMap'].map(
    (name) => `java.util.concurrent.${name}`,
  ),
]);
const STREAM_TYPE = 'java.util.stream.Stream';
const JDK_CONTAINERS = new Set([...ITERABLE_TYPES, ...MAP_TYPES, STREAM_TYPE]);

// Worker-local until `collectJavaCaptureSideChannel` snapshots it for the
// ParsedFile; resolution reads the snapshot, never this map.
const containerProofs = new Map<string, readonly JavaContainerProofFact[]>();
const returnElements = new Map<string, readonly JavaReturnElementFact[]>();
const typeFields = new Map<string, readonly JavaTypeFieldsFact[]>();
const importedSpellings = new Map<string, readonly JavaImportedSpellingFact[]>();

export function getJavaImportedSpellings(filePath: string): readonly JavaImportedSpellingFact[] {
  return importedSpellings.get(filePath) ?? [];
}

export function getJavaContainerProofs(filePath: string): readonly JavaContainerProofFact[] {
  return containerProofs.get(filePath) ?? [];
}

export function getJavaReturnElements(filePath: string): readonly JavaReturnElementFact[] {
  return returnElements.get(filePath) ?? [];
}

/** `undefined` when this file was not captured: its fields are unknown. */
export function getJavaTypeFields(filePath: string): readonly JavaTypeFieldsFact[] | undefined {
  return typeFields.get(filePath);
}

/** The binding an element of a method's declared return type gives a caller.
 * The element means what it meant where the return type was written. */
export function javaReturnElementRef(
  fact: JavaReturnElementFact,
  element: JavaReturnElementFact['elements'][number],
): TypeRef {
  const erased = eraseJavaTypeArguments(element.spelling);
  const rawName = erased.slice(erased.lastIndexOf('.') + 1);
  return {
    rawName,
    ...(rawName === element.spelling ? {} : { declaredSpelling: element.spelling }),
    declaredAtScope: element.scope,
    lookupPosition: { startLine: fact.line, startCol: fact.col },
    source: 'assignment-inferred',
  };
}

export function clearJavaContainerProofs(): void {
  containerProofs.clear();
  returnElements.clear();
  typeFields.clear();
  importedSpellings.clear();
}

/** Keep container types on ordinary receivers. Element types are available
 * only at an array/Iterable iteration or a bounded, proven JDK callback. */
export function synthesizeJavaDeclaredTypeCaptures(
  root: SyntaxNode,
  filePath: string,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const bindings = new Map<number, Map<string, DeclaredBinding[]>>();
  const imports = new Map<string, Set<string>>();
  // `java.lang` is implicitly imported on demand (JLS 7.3).
  const onDemandPackages = new Set<string>(['java.lang']);
  const proofs: JavaContainerProofFact[] = [];
  const returns: JavaReturnElementFact[] = [];
  const spellingReads = new Map<
    string,
    Omit<JavaImportedSpellingFact, 'status'> & {
      readonly status: JavaImportedSpellingFact['status'] | 'written';
    }
  >();
  const fieldDeclarations: SyntaxNode[] = [];
  const typeBodies: SyntaxNode[] = [];
  const localTypes = new Set<string>();
  // A type parameter is in scope only within its generic declaration (JLS 6.3).
  const typeParameters = new Map<string, { readonly start: number; readonly end: number }[]>();
  const isTypeParameter = (name: string, at: SyntaxNode): boolean =>
    typeParameters
      .get(name)
      ?.some((range) => range.start <= at.startIndex && at.startIndex < range.end) === true;
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
    'constant_declaration',
    'enum_constant',
    'class_body',
    'interface_body',
    'enum_body',
    'annotation_type_body',
    'local_variable_declaration',
    'formal_parameter',
    'spread_parameter',
    'catch_formal_parameter',
    'resource',
    'lambda_expression',
    'enhanced_for_statement',
    'method_declaration',
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
    dependsOn: readonly BindingProof[] = [],
    typeSource = name,
    evidence?: TypeEvidence,
  ) => {
    const names = bindings.get(owner.id) ?? new Map<string, DeclaredBinding[]>();
    const values = names.get(name.text) ?? [];
    values.push({
      declarationId: name.id,
      name: name.text,
      start,
      end,
      ...(type === undefined ? {} : { type }),
      // A later binding read through this one depends on the field only
      // transitively: it cannot take the field's element by its own route.
      ...(dependsOn.length === 0 ? {} : { proofs: dependsOn.map(withoutRoute) }),
      typeSource,
      ...(evidence === undefined ? {} : { evidence }),
    });
    names.set(name.text, values);
    bindings.set(owner.id, names);
  };
  const lookup = (expression: SyntaxNode): LookupResult => {
    if (expression.type !== 'identifier') return UNRESOLVED;
    const shadows: InheritedFieldProof[] = [];
    let current: SyntaxNode | null = expression;
    // Deeply nested callbacks are an uncertainty boundary, not an unbounded
    // per-callback ancestor walk on hostile or generated source.
    for (let depth = 0; current !== null; depth++) {
      if (depth >= 128) return UNRESOLVED;
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
      if (selected !== undefined) return { binding: selected, shadows };
      // An inherited field shadows an enclosing declaration (JLS 6.4.1).
      // Supertypes are a workspace fact, so resolution checks each body left.
      if (inheritsMembers(current)) {
        const scope = javaClassScopeOfBody(current, filePath);
        if (scope === undefined) return UNRESOLVED;
        shadows.push({ kind: 'unshadowed-field', name: expression.text, scope });
      }
      current = current.parent;
    }
    return { shadows };
  };

  for (const node of nodes) {
    if (node.type === 'import_declaration') {
      const imported = SINGLE_IMPORT.exec(node.text)?.[1];
      if (imported !== undefined) {
        const tail = imported.slice(imported.lastIndexOf('.') + 1);
        const targets = imports.get(tail) ?? new Set<string>();
        targets.add(imported);
        imports.set(tail, targets);
      }
      const onDemand = ON_DEMAND_IMPORT.exec(node.text)?.[1];
      if (onDemand !== undefined) onDemandPackages.add(onDemand);
    } else if (node.type === 'type_parameter') {
      const name =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'type_identifier');
      const declaration = node.parent?.parent;
      if (name !== undefined && name !== null && declaration != null) {
        const ranges = typeParameters.get(name.text) ?? [];
        ranges.push({ start: declaration.startIndex, end: declaration.endIndex });
        typeParameters.set(name.text, ranges);
      }
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
      }
    }

    if (
      node.type === 'field_declaration' ||
      node.type === 'constant_declaration' ||
      node.type === 'local_variable_declaration'
    ) {
      const declared = node.childForFieldName('type');
      const owner = ownerOf(node.parent ?? root);
      const field = node.type !== 'local_variable_declaration';
      if (field) fieldDeclarations.push(node);
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
          field ? -1 : name.startIndex,
          owner.endIndex,
          [],
          type ?? name,
        );
      }
    } else if (node.type === 'enum_constant') {
      // An enum constant is a field of its enum: it hides an outer name.
      const name = node.childForFieldName('name');
      if (name !== null) {
        add(ownerOf(node.parent ?? root), name, undefined, -1);
        fieldDeclarations.push(node);
      }
    } else if (
      node.type === 'class_body' ||
      node.type === 'interface_body' ||
      node.type === 'enum_body' ||
      node.type === 'annotation_type_body'
    ) {
      typeBodies.push(node);
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
      let owner = ownerOf(node.parent ?? root);
      // A record component is a field of the record body (and the compact
      // constructor's parameter inside it), never of the enclosing container.
      if (owner.type === 'record_declaration') owner = owner.childForFieldName('body') ?? owner;
      if (name !== undefined && name !== null)
        add(
          owner,
          name,
          type === undefined || type === null || type.text === 'var'
            ? undefined
            : javaTypeText(type) +
                javaTrailingDimensions(node) +
                (node.type === 'spread_parameter' ? '[]' : ''),
          -1,
          owner.endIndex,
          [],
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
          [],
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
    if (!JAVA_DOTTED_SPELLING.test(raw) || isTypeParameter(raw, source)) return undefined;
    const argumentsText =
      generic < 0 ? [] : core.endsWith('>') ? splitArguments(core.slice(generic + 1, -1)) : [];
    if (generic >= 0 && argumentsText.length === 0) return undefined;
    const args = argumentsText.map((argument) => identify(argument, source, use, inheritedScope));
    if (args.some((argument) => argument === undefined)) return undefined;
    let lookupScope = inheritedScope ?? producerScope(source);
    if (lookupScope === undefined) return undefined;
    let base = raw;
    let imported: TypeEvidence['imported'];
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
        const single = imports.get(raw);
        if (single?.size === 1) {
          base = [...single][0]!;
          imported = 'single';
        } else if (single !== undefined || (localTypes.has(raw) && named.length === 0))
          return undefined;
        else if (
          named.some(
            (fact) =>
              javaRangeContains(fact.visible, point(use)) &&
              !javaRangeContains(fact.visible, point(source)),
          )
        )
          return undefined;
        else if (named.length === 0) {
          // Only a known JDK container; resolution confirms that no other
          // type with this simple name is visible where it was written.
          const packages = [...onDemandPackages].filter((pkg) =>
            JDK_CONTAINERS.has(`${pkg}.${raw}`),
          );
          if (packages.length === 1) {
            base = `${packages[0]}.${raw}`;
            imported = 'on-demand';
          }
        }
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
      ...(imported === undefined ? {} : { imported }),
      // An on-demand base only decides container shape; a binding keeps the
      // written simple name, which ordinary lookup already resolves.
      spelling:
        (imported === 'on-demand' ? raw : base) +
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
      !WRITTEN_TYPE.test(written) ||
      written.split(NAME_SEPARATORS).some((token) => isTypeParameter(token, binding.typeSource))
    )
      return undefined;
    return binding.evidence ?? identify(written, binding.typeSource, use);
  };
  /** What resolution must confirm about how `evidence` names its base type. */
  const proofOf = (evidence: TypeEvidence): ContainerProof | undefined => {
    const scope = producerScope(evidence.source) ?? evidence.lookupScope;
    if (evidence.writtenQualified) return { kind: 'root', name: 'java', scope };
    if (evidence.imported === undefined || !JDK_CONTAINERS.has(evidence.base)) return undefined;
    const name = evidence.base.slice(evidence.base.lastIndexOf('.') + 1);
    return { kind: evidence.imported, name, scope };
  };
  const withProof = (
    inherited: readonly BindingProof[] | undefined,
    evidence: TypeEvidence | undefined,
  ): readonly BindingProof[] => {
    const own = evidence === undefined ? undefined : proofOf(evidence);
    return own === undefined ? (inherited ?? []) : [...(inherited ?? []), own];
  };
  const container = (
    binding: DeclaredBinding | undefined,
    use: SyntaxNode,
  ):
    | { base: string; args: readonly TypeEvidence[]; proofs: readonly BindingProof[] }
    | undefined => {
    const evidence = evidenceFor(binding, use);
    if (
      evidence === undefined ||
      evidence.dimensions !== 0 ||
      evidence.args.length === 0 ||
      !JDK_CONTAINERS.has(evidence.base) ||
      localTypes.has(evidence.base.split('.')[0]!)
    )
      return undefined;
    return {
      base: evidence.base,
      args: evidence.args,
      proofs: withProof(binding?.proofs, evidence),
    };
  };
  /** Record how qualified lookup must read `evidence` at a binding anchor. */
  const readAt = (line: number, col: number, evidence: TypeEvidence) => {
    const spelling = eraseJavaTypeArguments(evidence.spelling).replace(/(?:\[\])+$/, '');
    if (!spelling.includes('.')) return;
    const status = evidence.imported === 'single' ? 'import' : 'written';
    const key = `${line}:${col}:${spelling}`;
    const seen = spellingReads.get(key)?.status;
    spellingReads.set(key, {
      line,
      col,
      spelling,
      status: seen === undefined || seen === status ? status : 'ambiguous',
    });
  };
  const emit = (
    name: SyntaxNode,
    inferred: TypeEvidence | undefined,
    dependsOn: readonly BindingProof[],
    body?: SyntaxNode,
  ) => {
    const lookupScope = inferred?.lookupScope ?? producerScope(name);
    if (lookupScope === undefined) return;
    const capture = bindingCapture(
      name,
      inferred?.spelling ?? JAVA_INHERITED_FIELD_ELEMENT,
      body,
      dependsOn.some((proof) => proof.kind === 'root'),
      lookupScope,
    );
    const anchor = capture['@type-binding.parameter']!.range;
    for (const proof of dependsOn)
      proofs.push({ ...proof, line: anchor.startLine, col: anchor.startCol });
    if (inferred !== undefined) readAt(anchor.startLine, anchor.startCol, inferred);
    out.push(capture);
  };
  /** Proofs that the walk to a value's declaration left no inherited field
   * behind, each telling resolution how the binding reads that field. */
  const routed = (
    found: LookupResult,
    route: JavaFieldElementRoute | undefined,
  ): readonly InheritedFieldProof[] =>
    route === undefined ? found.shadows : found.shadows.map((shadow) => ({ ...shadow, route }));

  const lambdaOrigins = new Map<string, Map<number, CaptureMatch>>();
  const recordLambdaOrigin = (name: SyntaxNode, capture: CaptureMatch) => {
    let declarations = lambdaOrigins.get(name.text);
    if (!declarations) {
      declarations = new Map();
      lambdaOrigins.set(name.text, declarations);
    }
    declarations.set(name.id, capture);
  };
  const rememberLambda = (lambda: SyntaxNode, fallback = false) => {
    const captures = synthesizeJavaSamLambdaCaptures(lambda, fallback);
    for (const parameter of lambdaParameters(lambda)) {
      const name =
        parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name');
      const capture =
        name && captures.find((entry) => entry['@call-result-assignment.lhs']?.text === name.text);
      if (name && capture) recordLambdaOrigin(name, capture);
    }
    out.push(...captures);
  };
  // Native descendants are in source order: outer operations publish their
  // element declaration before a nested operation asks for that declaration.
  for (const node of nodes) {
    if (
      node.type === 'local_variable_declaration' &&
      node.childForFieldName('type')?.text === 'var'
    ) {
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        let value = declarator.childForFieldName('value');
        while (value?.type === 'parenthesized_expression') value = value.firstNamedChild;
        if (!name || value?.type !== 'identifier') continue;
        const declarations = lambdaOrigins.get(value.text);
        if (!declarations) continue;
        const source = lookup(value);
        const origin = source.binding && declarations.get(source.binding.declarationId);
        if (!origin || source.shadows.length) continue;
        const capture = {
          ...origin,
          '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
          '@call-result-assignment.scope': nodeToCapture('@call-result-assignment.scope', name),
        };
        recordLambdaOrigin(name, capture);
        out.push(capture);
      }
    } else if (node.type === 'enhanced_for_statement') {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const type = node.childForFieldName('type');
      const value = node.childForFieldName('value');
      if (name === null || body === null || type === null || value === null) continue;
      const found = lookup(value);
      const binding = found.binding;
      const written = binding?.type;
      const writtenEvidence = evidenceFor(binding, node);
      const iterable = container(binding, node);
      let mapElement: TypeEvidence | undefined;
      let mapProofs: readonly BindingProof[] = [];
      // The value's field, read through `for (var v : field)` or a map view.
      let shadows = routed(found, 'iterate');
      if (value.type === 'method_invocation') {
        const receiver = value.childForFieldName('object');
        const args = value.childForFieldName('arguments');
        const member = value.childForFieldName('name')?.text;
        const view =
          (member === 'values' || member === 'keySet') &&
          args !== null &&
          args.namedChildren.every(
            (child) => child.type === 'line_comment' || child.type === 'block_comment',
          )
            ? member
            : undefined;
        const receiverFound = receiver === null ? UNRESOLVED : lookup(receiver);
        shadows = view === undefined ? [] : routed(receiverFound, view);
        const map = container(receiverFound.binding, node);
        if (map !== undefined && MAP_TYPES.has(map.base) && map.args.length === 2) {
          if (view === 'values') mapElement = map.args[1];
          else if (view === 'keySet') mapElement = map.args[0];
          if (mapElement !== undefined) mapProofs = map.proofs;
        }
      }
      const elementOfIterable =
        iterable !== undefined && ITERABLE_TYPES.has(iterable.base) && iterable.args.length === 1;
      const inferred =
        type.text !== 'var'
          ? identify(javaTypeText(type), type, node)
          : writtenEvidence !== undefined && writtenEvidence.dimensions > 0
            ? {
                ...writtenEvidence,
                spelling: writtenEvidence.spelling.slice(0, -2),
                dimensions: writtenEvidence.dimensions - 1,
              }
            : elementOfIterable
              ? iterable.args[0]
              : mapElement;
      out.push(loopScope(body, name));
      // A `var` element is only as certain as the container identity it
      // came through. Each proof is checked where that container was written,
      // so the element keeps its own lookup anchor (and local visibility).
      // A written element type does not depend on the value at all.
      const inherited = type.text !== 'var' ? [] : shadows;
      const dependsOn = [
        ...inherited,
        ...(type.text !== 'var' || inferred === undefined
          ? []
          : written?.endsWith('[]')
            ? withProof(binding?.proofs, writtenEvidence)
            : elementOfIterable
              ? iterable.proofs
              : mapProofs),
      ];
      add(
        body,
        name,
        inferred?.spelling,
        body.startIndex,
        body.endIndex,
        dependsOn,
        inferred?.source ?? type,
        inferred,
      );
      // Without an element from the outer value, only a supertype's field
      // can type this variable; resolution decides or removes the binding.
      if (inferred !== undefined || inherited.length > 0) emit(name, inferred, dependsOn, body);
    } else if (node.type === 'lambda_expression') {
      // A lambda this JDK callback route does not type may still take its
      // parameter types from the selected method's functional interface.
      const argumentsNode = javaLambdaArgument(node).parent;
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
      ) {
        rememberLambda(node);
        continue;
      }
      const found = lookup(receiver);
      const owner = container(found.binding, node);
      const parameters = lambdaParameters(node);
      const expected =
        owner === undefined
          ? undefined
          : MAP_TYPES.has(owner.base) && member === 'forEach' && owner.args.length === 2
            ? owner.args
            : ((ITERABLE_TYPES.has(owner.base) && member === 'forEach') ||
                  (owner.base === STREAM_TYPE &&
                    (member === 'forEach' || member === 'forEachOrdered'))) &&
                owner.args.length === 1
              ? owner.args
              : undefined;
      const candidates =
        expected !== undefined && expected.length === parameters.length ? expected : undefined;
      // How each parameter reads the receiver's field, whatever declares it.
      const routes: readonly JavaFieldElementRoute[] | undefined =
        member === 'forEach' && parameters.length === 1
          ? ['forEach']
          : member === 'forEachOrdered' && parameters.length === 1
            ? ['forEachOrdered']
            : member === 'forEach' && parameters.length === 2
              ? ['forEachKey', 'forEachValue']
              : undefined;
      if (candidates === undefined && (routes === undefined || found.shadows.length === 0)) {
        rememberLambda(node);
        continue;
      }
      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i]!;
        const explicit = parameter.childForFieldName('type');
        if (explicit !== null && explicit.text !== 'var') continue;
        const name =
          parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name');
        if (name === null) continue;
        const inferred = candidates?.[i];
        const dependsOn = [
          ...routed(found, routes?.[i]),
          ...(inferred === undefined || owner === undefined ? [] : owner.proofs),
        ];
        add(
          node,
          name,
          inferred?.spelling,
          -1,
          node.endIndex,
          dependsOn,
          inferred?.source ?? name,
          inferred,
        );
        emit(name, inferred, dependsOn);
      }
      // Every binding above depends on a proof resolution may refute: a
      // workspace type named like the JDK container, or a supertype field. A
      // refuted parameter then takes the selected method's functional
      // interface parameter type instead, as any other lambda argument does.
      rememberLambda(node, true);
    } else if (node.type === 'method_declaration') {
      const type = node.childForFieldName('type');
      // Only a generic return type can name a JDK container's element.
      if (
        type === null ||
        node.childForFieldName('dimensions') !== null ||
        !type.text.includes('<')
      )
        continue;
      const evidence = identify(javaTypeText(type), type, type);
      const own = evidence === undefined ? undefined : proofOf(evidence);
      if (
        evidence === undefined ||
        own === undefined ||
        evidence.dimensions !== 0 ||
        !JDK_CONTAINERS.has(evidence.base) ||
        localTypes.has(evidence.base.split('.')[0]!)
      )
        continue;
      const [first, second] = evidence.args;
      const elements: JavaReturnElementFact['elements'][number][] = [];
      const read: TypeEvidence[] = [];
      if (ITERABLE_TYPES.has(evidence.base) && evidence.args.length === 1 && first !== undefined) {
        elements.push({ route: 'iterate', spelling: first.spelling, scope: first.lookupScope });
        read.push(first);
      } else if (
        MAP_TYPES.has(evidence.base) &&
        evidence.args.length === 2 &&
        first !== undefined &&
        second !== undefined
      ) {
        elements.push(
          { route: 'values', spelling: second.spelling, scope: second.lookupScope },
          { route: 'keySet', spelling: first.spelling, scope: first.lookupScope },
        );
        read.push(second, first);
      }
      if (elements.length === 0) continue;
      const line = type.startPosition.row + 1;
      const col = type.startPosition.column;
      // Every element of one return type is read at that type's start.
      for (const element of read) readAt(line, col, element);
      returns.push({
        methodLine: node.startPosition.row + 1,
        methodCol: node.startPosition.column,
        // Spelled as the method's `@declaration.return-type` capture spells it
        // (no trailing dimensions here, by the guard above).
        written: javaTypeText(type),
        line,
        col,
        proofs: [own],
        elements,
      });
    }
  }
  if (proofs.length === 0) containerProofs.delete(filePath);
  else containerProofs.set(filePath, proofs);
  if (returns.length === 0) returnElements.delete(filePath);
  else returnElements.set(filePath, returns);
  const imported: JavaImportedSpellingFact[] = [];
  for (const { status, ...read } of spellingReads.values())
    if (status !== 'written') imported.push({ ...read, status });
  if (imported.length === 0) importedSpellings.delete(filePath);
  else importedSpellings.set(filePath, imported);

  // Every type's written supertypes and fields, for a subclass anywhere in
  // the workspace to check which name it inherits (see `InheritedFieldProof`).
  const fieldElement = (declared: SyntaxNode, declarator: SyntaxNode): JavaFieldFact['element'] => {
    const written = javaTypeText(declared) + javaTrailingDimensions(declarator);
    if (!written.includes('<') && !written.endsWith(']')) return undefined;
    const evidence = identify(written, declared, declared);
    if (evidence === undefined) return undefined;
    const elements: NonNullable<JavaFieldFact['element']>['elements'][number][] = [];
    const [first, second] = evidence.args;
    if (evidence.dimensions > 0)
      elements.push({
        route: 'iterate',
        spelling: evidence.spelling.slice(0, -2),
        scope: evidence.lookupScope,
      });
    else if (!JDK_CONTAINERS.has(evidence.base) || localTypes.has(evidence.base.split('.')[0]!))
      return undefined;
    else if (ITERABLE_TYPES.has(evidence.base) && evidence.args.length === 1 && first)
      for (const route of ['iterate', 'forEach'] as const)
        elements.push({ route, spelling: first.spelling, scope: first.lookupScope });
    else if (evidence.base === STREAM_TYPE && evidence.args.length === 1 && first)
      for (const route of ['forEach', 'forEachOrdered'] as const)
        elements.push({ route, spelling: first.spelling, scope: first.lookupScope });
    else if (MAP_TYPES.has(evidence.base) && evidence.args.length === 2 && first && second)
      for (const [route, element] of [
        ['values', second],
        ['keySet', first],
        ['forEachKey', first],
        ['forEachValue', second],
      ] as const)
        elements.push({ route, spelling: element.spelling, scope: element.lookupScope });
    if (elements.length === 0) return undefined;
    const own = proofOf(evidence);
    return {
      line: declared.startPosition.row + 1,
      col: declared.startPosition.column,
      proofs: own === undefined ? [] : [own],
      elements,
    };
  };
  const fieldsByBody = new Map<number, JavaFieldFact[]>();
  for (const declaration of fieldDeclarations) {
    const body =
      declaration.parent?.type === 'enum_body_declarations'
        ? declaration.parent.parent
        : declaration.parent;
    if (body === null) continue;
    const fields = fieldsByBody.get(body.id) ?? [];
    fieldsByBody.set(body.id, fields);
    if (declaration.type === 'enum_constant') {
      const name = declaration.childForFieldName('name');
      if (name !== null) fields.push({ name: name.text, access: 'inherited' });
      continue;
    }
    const words = new Set(
      declaration.namedChildren
        .find((child) => child.type === 'modifiers')
        ?.children.map((child) => child.type) ?? [],
    );
    // Interface and annotation constants are implicitly public.
    const access: JavaFieldFact['access'] =
      declaration.type === 'constant_declaration' || words.has('public') || words.has('protected')
        ? 'inherited'
        : words.has('private')
          ? 'private'
          : 'package';
    const declared = declaration.childForFieldName('type');
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      if (name === null) continue;
      const element = declared === null ? undefined : fieldElement(declared, declarator);
      fields.push({ name: name.text, access, ...(element === undefined ? {} : { element }) });
    }
  }
  const inventory: JavaTypeFieldsFact[] = [];
  for (const body of typeBodies) {
    const owner = body.parent;
    if (owner === null) continue;
    const bases: string[] = [];
    let scopeNode = owner;
    if (owner.type === 'object_creation_expression' || owner.type === 'enum_constant') {
      scopeNode = body;
      const base =
        owner.type === 'object_creation_expression'
          ? owner.childForFieldName('type')
          : enclosingEnumName(owner);
      if (base === null) continue;
      bases.push(base.text);
    } else {
      for (const child of owner.namedChildren) {
        if (child.type === 'superclass')
          bases.push(...child.namedChildren.map((part) => part.text));
        if (child.type === 'super_interfaces' || child.type === 'extends_interfaces') {
          const list = child.namedChildren.find((part) => part.type === 'type_list');
          bases.push(...(list?.namedChildren ?? child.namedChildren).map((part) => part.text));
        }
      }
    }
    const fields = fieldsByBody.get(body.id) ?? [];
    if (bases.length === 0 && fields.length === 0) continue;
    inventory.push({
      range: nodeToCapture('', scopeNode).range,
      bases: bases.map((base) => {
        const erased = eraseJavaTypeArguments(base).replace(/\s+/g, '');
        return erased.slice(erased.lastIndexOf('.') + 1);
      }),
      fields,
    });
  }
  typeFields.set(filePath, inventory);
  return out;
}

/** The Class scope of the type a body belongs to; `owner` is the body's
 * parent, passed by a caller that already has it. */
export function javaClassScopeOfBody(
  body: SyntaxNode,
  filePath: string,
  owner: SyntaxNode | null = body.parent,
): ScopeId | undefined {
  if (owner === null) return undefined;
  // Anonymous and enum-constant classes are scoped by their body.
  const node =
    body.type === 'class_body' &&
    (owner.type === 'object_creation_expression' || owner.type === 'enum_constant')
      ? body
      : owner;
  return makeScopeId({ filePath, range: nodeToCapture('', node).range, kind: 'Class' });
}

/** The same proof for a binding that reads the field only transitively. */
function withoutRoute(proof: BindingProof): BindingProof {
  if (proof.kind !== 'unshadowed-field' || proof.route === undefined) return proof;
  return { kind: proof.kind, name: proof.name, scope: proof.scope };
}

/** The name node of the enum declaring `constant`. */
function enclosingEnumName(constant: SyntaxNode): SyntaxNode | null {
  for (let node = constant.parent; node !== null; node = node.parent)
    if (node.type === 'enum_declaration') return node.childForFieldName('name');
  return null;
}

/** Whether a type body can inherit members from a supertype. Anonymous and
 * enum-constant bodies always have one; `Object` and `Annotation` add none. */
function inheritsMembers(body: SyntaxNode): boolean {
  const owner = body.parent;
  if (owner === null) return false;
  if (body.type === 'class_body')
    return (
      owner.type === 'object_creation_expression' ||
      owner.type === 'enum_constant' ||
      owner.childForFieldName('superclass') !== null ||
      owner.childForFieldName('interfaces') !== null
    );
  if (body.type === 'enum_body') return owner.childForFieldName('interfaces') !== null;
  if (body.type === 'interface_body')
    return owner.namedChildren.some((child) => child.type === 'extends_interfaces');
  return false;
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
