import type { ParsedFile, Range, ReferenceSite, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import { makeScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ReceiverMemberResolution } from '../../scope-resolution/contract/scope-resolver.js';
import {
  findEnclosingClassDef,
  isClassLike,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { getJavaPackageFact } from './package-facts.js';
import { javaBoundBase } from './qualified-heritage.js';
import {
  javaInheritedMemberType,
  javaStaticOnDemandImportBringsNoType,
  javaStaticSingleImportType,
} from './qualified-type-bindings.js';
import { decodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import {
  getJavaOverloadCall,
  endsAtOrAfter,
  getJavaOverloadFacts,
  javaRangeContains,
  startsAtOrBefore,
  type JavaArgumentFact,
  type JavaOverloadCallFact,
  type JavaOverloadFileFacts,
  type JavaOverloadMethodFact,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';
import {
  boxedJavaType,
  JAVA_PRIMITIVES,
  javaInvocationConversion,
  javaSubtype,
  KNOWN_JAVA_PLATFORM_TYPES,
  MAX_JAVA_TYPE_DEPTH,
  sameJavaType,
  selectJavaOverload,
  splitJavaTypeArguments,
  UNKNOWN_JAVA_TYPE,
  type JavaOverloadCandidate,
  type JavaPrimitive,
  type JavaReferenceType,
  type JavaType,
  type JavaTypeRelations,
  type JavaVerdict,
} from './overload-types.js';
import { JAVA_IDENTIFIER_PART_CHARS, JAVA_QUALIFIED_NAME } from './type-spelling.js';
import { selectJavaLambdaOverload } from './sam-lambda-types.js';

/** A written type-use annotation, `@Name` or `@a.Name(...)`, with its trailing space. */
const TYPE_ANNOTATION = new RegExp(
  String.raw`@[${JAVA_IDENTIFIER_PART_CHARS}.]+(?:\([^()]*\))?\s*`,
  'gu',
);
const QUALIFIED_NAME = new RegExp(`^${JAVA_QUALIFIED_NAME}$`, 'u');

interface TypeContext {
  readonly filePath: string;
  readonly at: Range;
}
type JavaImportFact = JavaOverloadFileFacts['imports'][number];
interface FileFactIndex {
  readonly methods: Map<string, JavaOverloadMethodFact[]>;
  readonly ownedMethods: Map<string, Map<string, JavaOverloadMethodFact[]>>;
  readonly typeParameters: Map<string, { starts: Range[]; parents: number[] }>;
  /** Single-type and single-static imports, by the simple name they import. */
  readonly singleImports: Map<string, JavaImportFact[]>;
  readonly onDemandImports: JavaImportFact[];
}
interface State {
  readonly argumentCalls: Set<JavaOverloadCallFact>;
  readonly model: SemanticModel;
  readonly scopes: ScopeResolutionIndexes;
  readonly types: Map<string, JavaType>;
  readonly methodFacts: Map<string, JavaOverloadMethodFact | undefined>;
  readonly files: WeakMap<JavaOverloadFileFacts, FileFactIndex>;
  readonly typeFacts: Map<string, JavaOverloadTypeFact | undefined>;
  readonly hierarchyCompleteness: Map<string, boolean>;
  readonly relations: JavaTypeRelations;
}
const states = new WeakMap<ScopeResolutionIndexes, State>();
const UNKNOWN_RANGE: Range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
const objectMethods = new Set([
  'equals',
  'hashCode',
  'toString',
  'getClass',
  'clone',
  'finalize',
  'notify',
  'notifyAll',
  'wait',
]);

function stateFor(scopes: ScopeResolutionIndexes, model: SemanticModel): State {
  const existing = states.get(scopes);
  if (existing !== undefined && existing.model === model) return existing;
  const activeSubtype = new Set<string>();
  const subtypeVerdicts = new Map<string, JavaVerdict>();
  const state: State = {
    argumentCalls: new Set(),
    scopes,
    model,
    types: new Map(),
    methodFacts: new Map(),
    files: new WeakMap(),
    typeFacts: new Map(),
    hierarchyCompleteness: new Map(),
    relations: {
      sourceSubtype: (from, to) => {
        const key = JSON.stringify([from, to]);
        if (activeSubtype.has(key) || activeSubtype.size >= 64) return 'unknown';
        const cacheKey = `${key}\0${activeSubtype.size}`;
        const cached = subtypeVerdicts.get(cacheKey);
        if (cached !== undefined) return cached;
        activeSubtype.add(key);
        try {
          const verdict = sourceSubtype(from, to, state);
          subtypeVerdicts.set(cacheKey, verdict);
          return verdict;
        } finally {
          activeSubtype.delete(key);
        }
      },
    },
  };
  states.set(scopes, state);
  return state;
}

function packageName(filePath: string): string | undefined {
  const fact = getJavaPackageFact(filePath);
  return fact?.status === 'known' ? fact.packageName : getJavaOverloadFacts(filePath)?.packageName;
}

/** A file's type facts by name, as indices in file order, so a definition's
 * candidates are found without a scan of every type in the file. */
const typeFactIndicesByName = new WeakMap<
  readonly JavaOverloadTypeFact[],
  ReadonlyMap<string, readonly number[]>
>();

function typeFactIndices(
  facts: readonly JavaOverloadTypeFact[],
): ReadonlyMap<string, readonly number[]> {
  const cached = typeFactIndicesByName.get(facts);
  if (cached !== undefined) return cached;
  const byName = new Map<string, number[]>();
  for (const [index, type] of facts.entries()) {
    const indices = byName.get(type.name);
    if (indices === undefined) byName.set(type.name, [index]);
    else indices.push(index);
  }
  typeFactIndicesByName.set(facts, byName);
  return byName;
}

/** A list of ranged items, searchable for the first one, in list order, whose
 * range contains a given range, so many same-named declarations cost a binary
 * search per lookup instead of a scan. */
interface FirstContainingSearch<T> {
  readonly items: readonly T[];
  readonly rangeOf: (item: T) => Range;
  /** Per index, the range with the greatest end up to it; `undefined` when
   * the starts ever decrease in list order, and the lookup scans instead. */
  readonly widest: readonly Range[] | undefined;
}

export function firstContainingSearch<T>(
  items: readonly T[],
  rangeOf: (item: T) => Range,
): FirstContainingSearch<T> {
  const widest: Range[] = [];
  for (let i = 0; i < items.length; i++) {
    const range = rangeOf(items[i]!);
    if (i > 0 && !startsAtOrBefore(rangeOf(items[i - 1]!), range))
      return { items, rangeOf, widest: undefined };
    const before = widest[i - 1];
    widest.push(before !== undefined && endsAtOrAfter(before, range) ? before : range);
  }
  return { items, rangeOf, widest };
}

/** The first item in list order whose range contains `at`, exactly as a scan
 * with `javaRangeContains` finds it. With starts in order, the items starting
 * at or before `at` are a prefix, and the first item ending at or after it is
 * where the running greatest end first reaches it; it contains `at` when that
 * index lies in the prefix, and no earlier item does. */
export function firstContaining<T>(search: FirstContainingSearch<T>, at: Range): T | undefined {
  const { items, rangeOf, widest } = search;
  if (widest === undefined) return items.find((item) => javaRangeContains(rangeOf(item), at));
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (startsAtOrBefore(rangeOf(items[middle]!), at)) low = middle + 1;
    else high = middle;
  }
  const prefix = low;
  low = 0;
  high = prefix;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (endsAtOrAfter(widest[middle]!, at)) high = middle;
    else low = middle + 1;
  }
  return low < prefix ? items[low] : undefined;
}

/** Each same-name type fact index list, searchable by position. A list
 * belongs to one facts array, the one `typeFactIndices` built it from. */
const typeIndexSearches = new WeakMap<readonly number[], FirstContainingSearch<number>>();

function typeIndexSearch(
  facts: readonly JavaOverloadTypeFact[],
  indices: readonly number[],
): FirstContainingSearch<number> {
  let search = typeIndexSearches.get(indices);
  if (search === undefined)
    typeIndexSearches.set(
      indices,
      (search = firstContainingSearch(indices, (index) => facts[index]!.range)),
    );
  return search;
}

function typeFact(definition: SymbolDefinition, state: State): JavaOverloadTypeFact | undefined {
  if (state.typeFacts.has(definition.nodeId)) return state.typeFacts.get(definition.nodeId);
  const facts = getJavaOverloadFacts(definition.filePath)?.types ?? [];
  // The facts whose name ends the node id after a `:` (a Java name has none)
  // or equals the qualified name, in file order. Each list is in file order,
  // so the first of their union containing the declaration is the earlier of
  // each list's first, and the union is one fact when every list is that one.
  const byName = typeFactIndices(facts);
  const colon = definition.nodeId.lastIndexOf(':');
  const suffix = colon < 0 ? undefined : byName.get(definition.nodeId.slice(colon + 1));
  const qualified =
    definition.qualifiedName === undefined ? undefined : byName.get(definition.qualifiedName);
  const lists = [suffix, qualified].filter((indices) => indices !== undefined);
  let byPosition: number | undefined;
  if (definition.declarationRange !== undefined)
    for (const indices of lists) {
      const found = firstContaining(typeIndexSearch(facts, indices), definition.declarationRange);
      if (found !== undefined && (byPosition === undefined || found < byPosition))
        byPosition = found;
    }
  const single =
    lists.length > 0 &&
    lists.every((indices) => indices.length === 1 && indices[0] === lists[0]![0])
      ? lists[0]![0]
      : undefined;
  const index = byPosition ?? single;
  const fact = index === undefined ? undefined : facts[index];
  state.typeFacts.set(definition.nodeId, fact);
  return fact;
}

function methodName(definition: SymbolDefinition): string {
  return definition.nodeId
    .slice(definition.nodeId.lastIndexOf(':') + 1)
    .split('#')[0]!
    .split('.')
    .at(-1)!;
}

function fileFactIndex(facts: JavaOverloadFileFacts, state: State): FileFactIndex {
  const cached = state.files.get(facts);
  if (cached !== undefined) return cached;
  const index: FileFactIndex = {
    methods: new Map(),
    ownedMethods: new Map(),
    typeParameters: new Map(),
    singleImports: new Map(),
    onDemandImports: [],
  };
  for (const item of facts.imports) {
    if (item.wildcard) {
      index.onDemandImports.push(item);
      continue;
    }
    const name = item.name.slice(item.name.lastIndexOf('.') + 1);
    const named = index.singleImports.get(name) ?? [];
    named.push(item);
    index.singleImports.set(name, named);
  }
  for (const method of facts.methods) {
    const named = index.methods.get(method.name) ?? [];
    named.push(method);
    index.methods.set(method.name, named);
    const owner =
      index.ownedMethods.get(method.owner) ?? new Map<string, JavaOverloadMethodFact[]>();
    const owned = owner.get(method.name) ?? [];
    owned.push(method);
    owner.set(method.name, owned);
    index.ownedMethods.set(method.owner, owner);
  }
  for (const declaration of [...facts.methods, ...facts.types]) {
    for (const name of declaration.typeParameters) {
      const ranges = index.typeParameters.get(name) ?? { starts: [], parents: [] };
      ranges.starts.push(declaration.range);
      index.typeParameters.set(name, ranges);
    }
  }
  for (const ranges of index.typeParameters.values()) {
    ranges.starts.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
    const parents: number[] = [];
    for (const [i, range] of ranges.starts.entries()) {
      while (parents.length && !javaRangeContains(ranges.starts[parents.at(-1)!]!, range))
        parents.pop();
      ranges.parents.push(parents.at(-1) ?? -1);
      parents.push(i);
    }
  }
  state.files.set(facts, index);
  return index;
}

function hasTypeParameter(index: FileFactIndex, name: string, at: Range): boolean {
  return typeParameterDeclaration(index, name, at) !== undefined;
}

function typeParameterDeclaration(
  index: FileFactIndex,
  name: string,
  at: Range,
): Range | undefined {
  const ranges = index.typeParameters.get(name);
  if (ranges === undefined) return undefined;
  // Find the last declaration starting before this use, then walk only its
  // enclosing declarations. Sibling methods may each declare their own T.
  let low = 0,
    high = ranges.starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (startsAtOrBefore(ranges.starts[mid]!, at)) low = mid + 1;
    else high = mid;
  }
  for (let i = low - 1; i >= 0; i = ranges.parents[i]!) {
    const declaration = ranges.starts[i]!;
    if (javaRangeContains(declaration, at)) return declaration;
  }
  return undefined;
}

function methodFact(
  definition: SymbolDefinition,
  state: State,
): JavaOverloadMethodFact | undefined {
  if (state.methodFacts.has(definition.nodeId)) return state.methodFacts.get(definition.nodeId);
  const owner =
    definition.ownerId === undefined ? undefined : state.scopes.defs.get(definition.ownerId);
  const ownerFact = owner === undefined ? undefined : typeFact(owner, state);
  const facts = getJavaOverloadFacts(definition.filePath);
  const index = facts === undefined ? undefined : fileFactIndex(facts, state);
  const candidates =
    (ownerFact === undefined
      ? index?.methods.get(methodName(definition))
      : index?.ownedMethods.get(ownerFact.name)?.get(methodName(definition))) ?? [];
  let fact =
    definition.declarationRange === undefined || candidates.length === 0
      ? undefined
      : firstContaining(methodSearch(candidates), definition.declarationRange);
  if (fact === undefined) {
    const exact = candidates.filter(
      (method) => method.parameterTypes.join('\0') === (definition.parameterTypes ?? []).join('\0'),
    );
    fact = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
  }
  state.methodFacts.set(definition.nodeId, fact);
  return fact;
}

/** Each same-owner, same-name method list of a file's fact index, searchable
 * by position. */
const methodSearches = new WeakMap<
  readonly JavaOverloadMethodFact[],
  FirstContainingSearch<JavaOverloadMethodFact>
>();

function methodSearch(
  methods: readonly JavaOverloadMethodFact[],
): FirstContainingSearch<JavaOverloadMethodFact> {
  let search = methodSearches.get(methods);
  if (search === undefined)
    methodSearches.set(
      methods,
      (search = firstContainingSearch(methods, (method) => method.range)),
    );
  return search;
}

function sourceQualifiedName(definition: SymbolDefinition): string | undefined {
  const pkg = packageName(definition.filePath);
  if (pkg === undefined) return undefined;
  const name =
    definition.qualifiedName ?? definition.nodeId.slice(definition.nodeId.lastIndexOf(':') + 1);
  return pkg === '' || name.startsWith(`${pkg}.`)
    ? name.replaceAll('$', '.')
    : `${pkg}.${name.replaceAll('$', '.')}`;
}

function sourceReference(definition: SymbolDefinition): JavaReferenceType {
  return { kind: 'reference', name: definition.nodeId, sourceId: definition.nodeId, arguments: [] };
}

interface NamedSourceDefinitions {
  readonly all: readonly SymbolDefinition[];
  readonly byFile: ReadonlyMap<string, readonly SymbolDefinition[]>;
  readonly byQualifiedName: ReadonlyMap<string, readonly SymbolDefinition[]>;
}

/** Class-like definitions per simple or scope name, built once per resolution
 * state and bucketed by file and by source-qualified name, so a lookup in one
 * file does not rescan every same-named nested type in the workspace. */
const namedSourceDefinitionsByState = new WeakMap<State, Map<string, NamedSourceDefinitions>>();
function namedSourceDefinitions(name: string, state: State): NamedSourceDefinitions {
  let cache = namedSourceDefinitionsByState.get(state);
  if (cache === undefined) {
    cache = new Map();
    namedSourceDefinitionsByState.set(state, cache);
  }
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const all = collectSourceDefinitions(name, state);
  const byFile = new Map<string, SymbolDefinition[]>();
  const byQualifiedName = new Map<string, SymbolDefinition[]>();
  for (const definition of all) {
    const inFile = byFile.get(definition.filePath) ?? [];
    inFile.push(definition);
    byFile.set(definition.filePath, inFile);
    const qualified = sourceQualifiedName(definition);
    if (qualified === undefined) continue;
    const named = byQualifiedName.get(qualified) ?? [];
    named.push(definition);
    byQualifiedName.set(qualified, named);
  }
  const named = { all, byFile, byQualifiedName };
  cache.set(name, named);
  return named;
}

function sourceDefinitions(name: string, state: State): readonly SymbolDefinition[] {
  return namedSourceDefinitions(name, state).all;
}

function sourceDefinitionsInFile(
  name: string,
  filePath: string,
  state: State,
): readonly SymbolDefinition[] {
  return namedSourceDefinitions(name, state).byFile.get(filePath) ?? [];
}

function sourceDefinitionsQualified(
  name: string,
  qualified: string,
  state: State,
): readonly SymbolDefinition[] {
  return namedSourceDefinitions(name, state).byQualifiedName.get(qualified) ?? [];
}

function collectSourceDefinitions(name: string, state: State): readonly SymbolDefinition[] {
  // Scope and graph identities are distinct. Use the finalized name index,
  // whose definitions share the inheritance and owner lookup key space.
  const qualifiedNames = new Set([
    name,
    ...state.model.types.lookupClassByName(name).flatMap((definition) => {
      const qualified = definition.qualifiedName;
      if (qualified === undefined) return [];
      const pkg = packageName(definition.filePath);
      // Model names include the package; nested scope names retain only owners.
      return pkg && qualified.startsWith(`${pkg}.`)
        ? [qualified, qualified.slice(pkg.length + 1)]
        : [qualified];
    }),
  ]);
  return [
    ...new Set(
      [...qualifiedNames].flatMap((qualified) => state.scopes.qualifiedNames.get(qualified)),
    ),
  ].flatMap((id) => {
    const definition = state.scopes.defs.get(id);
    return definition !== undefined && isClassLike(definition.type) ? [definition] : [];
  });
}

function qualifiedReference(name: string, state: State): JavaType {
  const matches = sourceDefinitionsQualified(name.split('.').at(-1)!, name, state);
  const unique = [
    ...new Map(matches.map((definition) => [definition.nodeId, definition])).values(),
  ];
  if (unique.length > 1) return UNKNOWN_JAVA_TYPE;
  if (unique.length === 1) return sourceReference(unique[0]!);
  return { kind: 'reference', name, arguments: [] };
}

/** Simple names of the member types workspace classes declare, so a
 * qualifier root skips the inheritance walk when no class declares one. */
const memberTypeNamesByState = new WeakMap<State, ReadonlySet<string>>();
function memberTypeNames(state: State): ReadonlySet<string> {
  const cached = memberTypeNamesByState.get(state);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (const definition of state.scopes.defs.byId.values()) {
    if (
      definition.ownerId === undefined ||
      !(isClassLike(definition.type) || definition.type === 'Annotation')
    )
      continue;
    const spelling = definition.qualifiedName ?? definition.nodeId;
    names.add(spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1));
  }
  memberTypeNamesByState.set(state, names);
  return names;
}

/** Type declarations nested by one of their ranges, so the ones around a
 * position take one binary search and a walk outward instead of a scan of
 * every declaration. Equal ranges nest in file order, the later inside. */
interface RangeNesting {
  /** Declarations by start, the wider first at one start, else file order. */
  readonly byStart: readonly JavaOverloadTypeFact[];
  /** The nearest declaration whose range encloses each one. */
  readonly parent: ReadonlyMap<JavaOverloadTypeFact, JavaOverloadTypeFact>;
}

function nestRanges(
  types: readonly JavaOverloadTypeFact[],
  rangeOf: (type: JavaOverloadTypeFact) => Range,
): RangeNesting {
  const byStart = [...types].sort((a, b) => {
    const left = rangeOf(a);
    const right = rangeOf(b);
    return (
      left.startLine - right.startLine ||
      left.startCol - right.startCol ||
      right.endLine - left.endLine ||
      right.endCol - left.endCol
    );
  });
  const parent = new Map<JavaOverloadTypeFact, JavaOverloadTypeFact>();
  const open: JavaOverloadTypeFact[] = [];
  for (const type of byStart) {
    while (open.length > 0 && !javaRangeContains(rangeOf(open.at(-1)!), rangeOf(type))) open.pop();
    const enclosing = open.at(-1);
    if (enclosing !== undefined) parent.set(type, enclosing);
    open.push(type);
  }
  return { byStart, parent };
}

/** The declarations whose range encloses `at`, innermost first. The last one
 * starting at or before `at` is the innermost or nests inside it. */
function enclosingRanges(
  nesting: RangeNesting,
  rangeOf: (type: JavaOverloadTypeFact) => Range,
  at: Range,
): JavaOverloadTypeFact[] {
  let low = 0;
  let high = nesting.byStart.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = rangeOf(nesting.byStart[middle]!);
    if (
      start.startLine < at.startLine ||
      (start.startLine === at.startLine && start.startCol <= at.startCol)
    )
      low = middle + 1;
    else high = middle;
  }
  const enclosing: JavaOverloadTypeFact[] = [];
  for (let type = nesting.byStart[low - 1]; type !== undefined; type = nesting.parent.get(type))
    if (javaRangeContains(rangeOf(type), at)) enclosing.push(type);
  return enclosing;
}

const declarationRange = (type: JavaOverloadTypeFact): Range => type.range;
const visibleRange = (type: JavaOverloadTypeFact): Range => type.visible;

/** A file's type declarations indexed for per-use lookups, built lazily. */
interface FileTypeIndex {
  declarations?: RangeNesting;
  readonly bySimpleName: ReadonlyMap<string, readonly JavaOverloadTypeFact[]>;
  /** Per simple name, the declarations nested by where they are visible. */
  readonly visible: Map<string, RangeNesting>;
  /** Each declaration's definitions that `typeFact` maps back to it, once read. */
  readonly classDefinitions: Map<JavaOverloadTypeFact, readonly SymbolDefinition[]>;
}
const fileTypeIndexes = new WeakMap<FileFactIndex, FileTypeIndex>();

function fileTypeIndex(facts: JavaOverloadFileFacts, state: State): FileTypeIndex {
  const index = fileFactIndex(facts, state);
  const cached = fileTypeIndexes.get(index);
  if (cached !== undefined) return cached;
  const bySimpleName = new Map<string, JavaOverloadTypeFact[]>();
  for (const type of facts.types) {
    const named = bySimpleName.get(type.simpleName);
    if (named === undefined) bySimpleName.set(type.simpleName, [type]);
    else named.push(type);
  }
  const types: FileTypeIndex = { bySimpleName, visible: new Map(), classDefinitions: new Map() };
  fileTypeIndexes.set(index, types);
  return types;
}

/** The type named `name` declared in this file that is visible at `at` from
 * the nearest scope, as the innermost visible range enclosing it; among equal
 * ranges the last in file order. */
function nearestVisibleType(
  name: string,
  at: Range,
  facts: JavaOverloadFileFacts,
  state: State,
): JavaOverloadTypeFact | undefined {
  const index = fileTypeIndex(facts, state);
  const types = index.bySimpleName.get(name);
  if (types === undefined) return undefined;
  let nesting = index.visible.get(name);
  if (nesting === undefined) index.visible.set(name, (nesting = nestRanges(types, visibleRange)));
  return enclosingRanges(nesting, visibleRange, at)[0];
}

/** A definition list keyed the way a type fact names its definitions: the
 * node id after its last `:`, and the qualified name. */
const definitionsByFactName = new WeakMap<
  readonly SymbolDefinition[],
  ReadonlyMap<string, readonly SymbolDefinition[]>
>();

function keyedByFactName(
  definitions: readonly SymbolDefinition[],
): ReadonlyMap<string, readonly SymbolDefinition[]> {
  const cached = definitionsByFactName.get(definitions);
  if (cached !== undefined) return cached;
  const keyed = new Map<string, SymbolDefinition[]>();
  const add = (key: string, definition: SymbolDefinition): void => {
    const named = keyed.get(key);
    if (named === undefined) keyed.set(key, [definition]);
    else if (!named.includes(definition)) named.push(definition);
  };
  for (const definition of definitions) {
    const colon = definition.nodeId.lastIndexOf(':');
    if (colon >= 0) add(definition.nodeId.slice(colon + 1), definition);
    if (definition.qualifiedName !== undefined) add(definition.qualifiedName, definition);
  }
  definitionsByFactName.set(definitions, keyed);
  return keyed;
}

/** The definitions in this file a type fact names: those whose node id ends in
 * `:` and its name, or whose qualified name is its name, first by its full
 * name and then by its simple name, each once. */
function definitionsOfType(
  type: JavaOverloadTypeFact,
  filePath: string,
  state: State,
): readonly SymbolDefinition[] {
  const unique = new Map<string, SymbolDefinition>();
  for (const name of [type.name, type.simpleName])
    for (const definition of keyedByFactName(sourceDefinitionsInFile(name, filePath, state)).get(
      type.name,
    ) ?? [])
      if (!unique.has(definition.nodeId)) unique.set(definition.nodeId, definition);
  const candidates = [...unique.values()];
  // A literal member name may equal a local class's binary spelling. The
  // lexical type fact identifies which source declaration supplied the name.
  return candidates.length > 1
    ? candidates.filter((definition) => typeFact(definition, state) === type)
    : candidates;
}

/** The classes enclosing `context`, innermost first, with their declarations; the
 * id is `undefined` for a class body without exactly one indexed definition. */
function enclosingClasses(
  context: TypeContext,
  facts: JavaOverloadFileFacts,
  state: State,
): { readonly id: string | undefined; readonly fact: JavaOverloadTypeFact }[] {
  const index = fileTypeIndex(facts, state);
  index.declarations ??= nestRanges(facts.types, declarationRange);
  return enclosingRanges(index.declarations, declarationRange, context.at).map((type) => {
    let definitions = index.classDefinitions.get(type);
    if (definitions === undefined)
      index.classDefinitions.set(
        type,
        (definitions = definitionsOfType(type, context.filePath, state).filter(
          (definition) => typeFact(definition, state) === type,
        )),
      );
    return { id: definitions.length === 1 ? definitions[0]!.nodeId : undefined, fact: type };
  });
}

/**
 * The type a simple name written at `context` names through a member type an
 * enclosing class inherits (JLS 8.5), which shadows every same-file, imported
 * and same-package type of that name in that class body (JLS 6.4.1). A type
 * `nearest` declares (lexically visible here) is nearer when it is declared in
 * or inside the inheriting class, a local class for one. Returns `undefined`
 * when no inherited reading applies (a private or other-package
 * package-access member type is not inherited), and the unknown type when it
 * is ambiguous or unprovable. Mirrors `inheritedSimpleTypeKey` in
 * qualified-type-bindings.ts.
 */
function inheritedSimpleType(
  name: string,
  nearest: JavaOverloadTypeFact | undefined,
  context: TypeContext,
  facts: JavaOverloadFileFacts,
  state: State,
): JavaType | undefined {
  if (!memberTypeNames(state).has(name)) return undefined;
  const classes = enclosingClasses(context, facts, state);
  const inherited = javaInheritedMemberType(
    classes.map((type) => type.id),
    name,
    state.scopes,
  );
  if (inherited === null) return UNKNOWN_JAVA_TYPE;
  if (
    inherited === undefined ||
    (nearest !== undefined &&
      javaRangeContains(classes[inherited.depth]!.fact.range, nearest.visible))
  )
    return undefined;
  const definition = state.scopes.defs.get(inherited.id);
  return definition === undefined ? UNKNOWN_JAVA_TYPE : sourceReference(definition);
}

/**
 * What the first identifier of a dotted type spelling names when no type
 * declared in this file claims it. A member type an enclosing class inherits
 * comes first: it shadows every file- and package-level type and package of
 * that name (JLS 6.4.1), so the spelling is a member path of the supertype that
 * declares it. Otherwise a type in scope there makes the spelling a member
 * path, and a package of that name is then never read (JLS 6.5.4.1): a
 * single-type import or the static member type a single static import brings
 * in (JLS 7.5.3, `Inner.Nested` after `import static p.Outer.Inner;`), then a
 * same-package top-level type, then a type from an on-demand import of a
 * workspace package. A single static import that provably brings in no type
 * (a static field or method of that name) is passed over. Returns `package`
 * when no such type is in scope, and `unknown` when the root is ambiguous or
 * may be a type this workspace cannot see (a static import whose owner is not
 * fully known, two single imports of the name, or an inherited or statically
 * imported member type that is ambiguous or inaccessible; see
 * `javaStaticSingleImportType`). Mirrors `qualifiedTypeKey` and
 * `staticImportQualifier` in qualified-type-bindings.ts.
 */
function qualifierRoot(
  root: string,
  context: TypeContext,
  facts: JavaOverloadFileFacts,
  state: State,
): JavaReferenceType | 'package' | 'unknown' {
  const index = fileFactIndex(facts, state);
  if (hasTypeParameter(index, root, context.at)) return 'unknown';
  // A supertype spelling is anchored at its class declaration. Only enclosing
  // classes can supply inherited names while that class's header is being read.
  const classes = enclosingClasses(context, facts, state).filter(
    (owner) => !javaRangeContains(context.at, owner.fact.range),
  );
  const inherited = javaInheritedMemberType(
    classes.map((type) => type.id),
    root,
    state.scopes,
    classes.some((type) => type.fact.bases.length > 0),
  );
  if (inherited === null) return 'unknown';
  if (inherited !== undefined) {
    const definition = state.scopes.defs.get(inherited.id);
    return definition === undefined ? 'unknown' : sourceReference(definition);
  }
  const single = index.singleImports.get(root) ?? [];
  if (single.length > 1) return 'unknown';
  if (single.length === 1 && !single[0]!.static) {
    const imported = qualifiedReference(single[0]!.name, state);
    return imported.kind === 'reference' ? imported : 'unknown';
  }
  if (single.length === 1) {
    const statically = javaStaticSingleImportType(single[0]!.name, context.filePath, state.scopes);
    if (statically === null) return 'unknown';
    if (statically !== 'none') {
      const imported = qualifiedReference(statically.fqn, state);
      return imported.kind === 'reference' && imported.sourceId !== undefined
        ? imported
        : 'unknown';
    }
  }
  const unique = (definitions: readonly SymbolDefinition[]): SymbolDefinition[] => [
    ...new Map(definitions.map((definition) => [definition.nodeId, definition])).values(),
  ];
  const inPackage = facts.packageName === '' ? root : `${facts.packageName}.${root}`;
  const local = unique(sourceDefinitionsQualified(root, inPackage, state));
  if (local.length > 0) return local.length === 1 ? sourceReference(local[0]!) : 'unknown';
  const onDemand: SymbolDefinition[] = [];
  for (const item of index.onDemandImports) {
    // A static on-demand import also imports its owner's member types,
    // inherited ones included, which an owner outside the workspace hides.
    if (item.static) {
      if (!javaStaticOnDemandImportBringsNoType(item.name, root, state.scopes)) return 'unknown';
      continue;
    }
    onDemand.push(...sourceDefinitionsQualified(root, `${item.name}.${root}`, state));
  }
  const imported = unique(onDemand);
  if (imported.length === 0) return 'package';
  // On-demand imports bring in accessible types only (JLS 7.5.2).
  return imported.length === 1 && typeFact(imported[0]!, state)?.modifiers?.includes('public')
    ? sourceReference(imported[0]!)
    : 'unknown';
}

function memberTypeAccessible(
  type: JavaOverloadTypeFact,
  owner: SymbolDefinition,
  context: TypeContext,
  state: State,
): boolean {
  if (type.modifiers?.includes('public')) return true;
  const caller = getJavaOverloadFacts(context.filePath);
  if (type.modifiers?.includes('private')) {
    if (!caller || owner.filePath !== context.filePath) return false;
    const nest = enclosingClasses(context, caller, state).at(-1);
    return nest !== undefined && javaRangeContains(nest.fact.range, type.range);
  }
  if (packageName(owner.filePath) === packageName(context.filePath)) return true;
  if (!caller || !type.modifiers?.includes('protected')) return false;
  return enclosingClasses(context, caller, state).some(
    ({ id }) =>
      id !== undefined &&
      (id === owner.nodeId || state.scopes.methodDispatch.mroFor(id).includes(owner.nodeId)),
  );
}

function declaredMemberPath(
  roots: readonly SymbolDefinition[],
  members: readonly string[],
  context: TypeContext,
  state: State,
): JavaType {
  let matches = roots;
  for (const member of members) {
    if (matches.length !== 1) return UNKNOWN_JAVA_TYPE;
    const owner = matches[0]!;
    const facts = getJavaOverloadFacts(owner.filePath);
    if (facts === undefined) return UNKNOWN_JAVA_TYPE;
    const types = fileTypeIndex(facts, state).bySimpleName.get(member) ?? [];
    matches = types.flatMap((type) => {
      const declarations = definitionsOfType(type, owner.filePath, state).filter(
        (def) => def.ownerId === owner.nodeId,
      );
      return declarations.length && memberTypeAccessible(type, owner, context, state)
        ? declarations
        : [];
    });
  }
  return matches.length === 1 ? sourceReference(matches[0]!) : UNKNOWN_JAVA_TYPE;
}

function resolveTypeName(name: string, context: TypeContext, state: State): JavaType {
  const facts = getJavaOverloadFacts(context.filePath);
  if (facts === undefined)
    return name.includes('.') ? qualifiedReference(name, state) : UNKNOWN_JAVA_TYPE;
  const index = fileFactIndex(facts, state);
  const members = name.split('.');
  const first = members.shift()!;
  const parameter = typeParameterDeclaration(index, first, context.at);
  if (parameter && members.length) return UNKNOWN_JAVA_TYPE;
  if (parameter)
    return {
      kind: 'variable',
      declaration: `${context.filePath}:${parameter.startLine}:${parameter.startCol}:${name}`,
    };
  const nearest = nearestVisibleType(first, context.at, facts, state);
  if (nearest !== undefined || members.length === 0) {
    const inherited = inheritedSimpleType(first, nearest, context, facts, state);
    if (inherited !== undefined) {
      if (members.length === 0 || inherited.kind !== 'reference') return inherited;
      const owner =
        inherited.sourceId === undefined ? undefined : state.scopes.defs.get(inherited.sourceId);
      return owner ? declaredMemberPath([owner], members, context, state) : UNKNOWN_JAVA_TYPE;
    }
  }
  if (nearest !== undefined) {
    return declaredMemberPath(
      definitionsOfType(nearest, context.filePath, state),
      members,
      context,
      state,
    );
  }
  if (name.includes('.')) {
    const root = qualifierRoot(first, context, facts, state);
    if (root === 'unknown') return UNKNOWN_JAVA_TYPE;
    if (root === 'package') return qualifiedReference(name, state);
    const rest = name.slice(first.length);
    if (root.sourceId === undefined)
      return { kind: 'reference', name: `${root.name}${rest}`, arguments: [] };
    const owner = state.scopes.defs.get(root.sourceId);
    const ownerName = owner === undefined ? undefined : sourceQualifiedName(owner);
    const member =
      ownerName === undefined
        ? UNKNOWN_JAVA_TYPE
        : qualifiedReference(`${ownerName}${rest}`, state);
    return member.kind === 'reference' && member.sourceId !== undefined
      ? member
      : UNKNOWN_JAVA_TYPE;
  }
  // Static imports can name types, values or methods. Require a source type
  // identity before resolving one; an unproven import must not become a JDK type.
  const single = index.singleImports.get(name) ?? [];
  if (single.some((item) => item.static)) {
    const explicit = single.filter((item) => item.static);
    if (explicit.length === 1) {
      const imported = qualifiedReference(explicit[0]!.name, state);
      if (imported.kind === 'reference' && imported.sourceId !== undefined) return imported;
    }
    return UNKNOWN_JAVA_TYPE;
  }
  // An inherited member type of this name was read above (`inheritedSimpleType`).
  const explicit = single.filter((item) => !item.static);
  if (explicit.length > 0)
    return explicit.length === 1 ? qualifiedReference(explicit[0]!.name, state) : UNKNOWN_JAVA_TYPE;
  const inPackage = facts.packageName === '' ? name : `${facts.packageName}.${name}`;
  const local = sourceDefinitionsQualified(name, inPackage, state);
  if (local.length > 0) {
    const unique = [
      ...new Map(local.map((definition) => [definition.nodeId, definition])).values(),
    ];
    return unique.length === 1 ? sourceReference(unique[0]!) : UNKNOWN_JAVA_TYPE;
  }
  const platform = `java.lang.${name}`;
  const imported: JavaType[] = KNOWN_JAVA_PLATFORM_TYPES.has(platform)
    ? [qualifiedReference(platform, state)]
    : [];
  let unknownWildcard = false;
  for (const item of index.onDemandImports) {
    if (item.static) {
      if (!javaStaticOnDemandImportBringsNoType(item.name, name, state.scopes))
        return UNKNOWN_JAVA_TYPE;
      continue;
    }
    const qualified = `${item.name}.${name}`;
    const candidates = sourceDefinitionsQualified(name, qualified, state);
    if (candidates.length > 0) imported.push(...candidates.map(sourceReference));
    else if (KNOWN_JAVA_PLATFORM_TYPES.has(qualified))
      imported.push(qualifiedReference(qualified, state));
    else if (!['java.lang', 'java.util', 'java.io'].includes(item.name)) unknownWildcard = true;
  }
  if (unknownWildcard) return UNKNOWN_JAVA_TYPE;
  const unique = [...new Map(imported.map((type) => [JSON.stringify(type), type])).values()];
  if (unique.length === 1) return unique[0]!;
  // An unqualified external declaration without a source/import witness is not
  // promoted to a platform class merely because its spelling looks familiar.
  return UNKNOWN_JAVA_TYPE;
}

function parseType(spelling: string, context: TypeContext, state: State, depth = 0): JavaType {
  if (depth >= MAX_JAVA_TYPE_DEPTH || spelling.length > 16_384) return UNKNOWN_JAVA_TYPE;
  const key = `${context.filePath}:${context.at.startLine}:${context.at.startCol}:${depth}:${spelling}`;
  const cached = state.types.get(key);
  if (cached !== undefined) return cached;
  let text = spelling.trim().replace(TYPE_ANNOTATION, '').replaceAll(/\s+/g, '');
  let dimensions = 0;
  while (text.endsWith('[]')) {
    dimensions++;
    if (depth + dimensions >= MAX_JAVA_TYPE_DEPTH) return UNKNOWN_JAVA_TYPE;
    text = text.slice(0, -2);
  }
  let type: JavaType;
  if (JAVA_PRIMITIVES.has(text as JavaPrimitive))
    type = { kind: 'primitive', name: text as JavaPrimitive };
  else {
    const open = text.indexOf('<');
    const name = open < 0 ? text : text.slice(0, open);
    if (!QUALIFIED_NAME.test(name) || (open >= 0 && !text.endsWith('>'))) type = UNKNOWN_JAVA_TYPE;
    else {
      type = resolveTypeName(name, context, state);
      if (open >= 0) {
        const args = splitJavaTypeArguments(text.slice(open + 1, -1));
        type =
          args === undefined || type.kind !== 'reference'
            ? UNKNOWN_JAVA_TYPE
            : {
                ...type,
                arguments: args.map((argument) =>
                  parseType(argument, context, state, depth + dimensions + 1),
                ),
              };
      }
    }
  }
  while (dimensions-- > 0) type = { kind: 'array', component: type };
  state.types.set(key, type);
  return type;
}

function sourceSubtype(from: JavaReferenceType, to: JavaReferenceType, state: State): JavaVerdict {
  if (from.sourceId === undefined)
    return KNOWN_JAVA_PLATFORM_TYPES.has(from.name) && to.sourceId !== undefined ? 'no' : 'unknown';
  const definition = state.scopes.defs.get(from.sourceId);
  if (definition === undefined) return 'unknown';
  if (
    to.sourceId !== undefined &&
    state.scopes.methodDispatch.mroFor(from.sourceId).includes(to.sourceId)
  ) {
    return from.arguments.length === 0 && to.arguments.length === 0 ? 'yes' : 'unknown';
  }
  const fact = typeFact(definition, state);
  if (fact === undefined) return 'unknown';
  if (from.arguments.length > 0 || fact.typeParameters.length > 0) return 'unknown';
  // Enum's implicit Enum<E> superclass and Record's superclass are not source
  // heritage edges. Do not prove disjointness from an empty explicit base list.
  if (fact.kind === 'enum_declaration' || fact.kind === 'record_declaration') return 'unknown';
  let uncertain = false;
  for (const base of fact.bases) {
    const result = javaSubtype(
      parseType(base, { filePath: definition.filePath, at: fact.range }, state),
      to,
      state.relations,
    );
    if (result === 'yes') return 'yes';
    if (result === 'unknown') uncertain = true;
  }
  return uncertain ? 'unknown' : 'no';
}

function normalizedCandidate(
  definition: SymbolDefinition,
  state: State,
): JavaOverloadCandidate<SymbolDefinition> {
  const fact = methodFact(definition, state);
  const raw = fact?.parameterTypes ?? definition.parameterTypes ?? [];
  const variadic = raw.at(-1) === 'varargs';
  const formalTypes = variadic ? raw.slice(0, -1) : raw;
  // Synthetic scope definitions can carry arity without formal type spellings.
  // Missing or inconsistent metadata cannot prove a zero-parameter signature
  // (or remove an unknown declaration from an inherited overload family).
  const missingParameterTypes =
    fact === undefined &&
    definition.parameterCount !== undefined &&
    definition.parameterCount !== formalTypes.length;
  const parameters = missingParameterTypes
    ? Array.from({ length: definition.parameterCount! }, () => UNKNOWN_JAVA_TYPE)
    : formalTypes.map((type) =>
        parseType(
          type,
          {
            filePath: definition.filePath,
            at: fact?.range ?? definition.declarationRange ?? UNKNOWN_RANGE,
          },
          state,
        ),
      );
  if (variadic && parameters.length > 0)
    parameters[parameters.length - 1] = { kind: 'array', component: parameters.at(-1)! };
  return {
    definition,
    parameters,
    variadic,
    unsupportedGeneric:
      missingParameterTypes ||
      (fact?.typeParameters.length ?? 0) > 0 ||
      (fact === undefined && (definition.parameterCount ?? parameters.length) !== 0),
  };
}

function argumentType(
  fact: JavaArgumentFact,
  filePath: string,
  state: State,
  enclosingSite?: ReferenceSite,
): JavaType {
  if (fact.kind === 'typed') return parseType(fact.spelling, { filePath, at: fact.at }, state);
  if (fact.kind === 'null') return { kind: 'null' };
  if (fact.kind !== 'invocation' || !enclosingSite) return UNKNOWN_JAVA_TYPE;
  const call = getJavaOverloadCall(filePath, fact.at, fact.name);
  if (!call || state.argumentCalls.has(call) || state.argumentCalls.size >= 12)
    return UNKNOWN_JAVA_TYPE;
  state.argumentCalls.add(call);
  try {
    return invocationReturnType(call, fact.qualifierShadowed, filePath, enclosingSite, state);
  } finally {
    state.argumentCalls.delete(call);
  }
}

function invocationReceiverType(
  call: JavaOverloadCallFact,
  shadowed: boolean,
  filePath: string,
  state: State,
): JavaType {
  if (call.receiver?.kind === 'typed') return argumentType(call.receiver, filePath, state);
  if (shadowed || call.receiverSpelling === undefined) return UNKNOWN_JAVA_TYPE;
  return parseType(call.receiverSpelling, { filePath, at: call.range }, state);
}

function resolvedReturnType(
  selected: ReceiverMemberResolution | undefined,
  state: State,
): JavaType {
  if (selected?.kind !== 'resolved') return UNKNOWN_JAVA_TYPE;
  const { returnType, filePath, declarationRange } = selected.definition;
  return returnType && declarationRange
    ? parseType(returnType, { filePath, at: declarationRange }, state)
    : UNKNOWN_JAVA_TYPE;
}

function invocationReturnType(
  call: JavaOverloadCallFact,
  qualifierShadowed: boolean,
  filePath: string,
  enclosingSite: ReferenceSite,
  state: State,
): JavaType {
  const site: ReferenceSite = {
    ...enclosingSite,
    name: call.name,
    atRange: call.range,
    arity: call.arguments.length,
    explicitReceiver:
      call.receiverSpelling === undefined ? undefined : { name: call.receiverSpelling },
    callForm: call.receiverSpelling === undefined ? 'free' : 'member',
    receiverChain: undefined,
  };
  let selected: ReceiverMemberResolution | undefined;
  if (call.receiverSpelling === undefined) {
    selected = resolveJavaUnqualifiedCall(site, state.scopes, state.model);
  } else {
    const owner = invocationReceiverType(call, qualifierShadowed, filePath, state);
    if (owner.kind !== 'reference') return UNKNOWN_JAVA_TYPE;
    if (!owner.sourceId) {
      if (call.name !== 'valueOf' || qualifierShadowed) return UNKNOWN_JAVA_TYPE;
      const args = call.arguments.map((arg) => argumentType(arg, filePath, state, site));
      if (owner.name === 'java.lang.String') return stringValueOfType(owner, args, state);
      return args.length === 1 ? wrapperValueOfType(owner, args[0]!, state) : UNKNOWN_JAVA_TYPE;
    }
    const definition = state.scopes.defs.get(owner.sourceId);
    if (definition)
      selected = resolveJavaReceiverMember(definition, call.name, site, state.scopes, state.model);
  }
  return resolvedReturnType(selected, state);
}

function stringValueOfType(owner: JavaReferenceType, args: JavaType[], state: State): JavaType {
  // Object and primitive overloads cover every known standalone value at arity one.
  if (args.length === 1 && args[0]!.kind !== 'unknown') return owner;
  if (args.length !== 3) return UNKNOWN_JAVA_TYPE;
  const integer = { kind: 'primitive', name: 'int' } as const;
  const chars = { kind: 'array', component: { kind: 'primitive', name: 'char' } } as const;
  return [chars, integer, integer].every(
    (parameter, i) =>
      javaInvocationConversion(args[i]!, parameter, 'loose', state.relations) === 'yes',
  )
    ? owner
    : UNKNOWN_JAVA_TYPE;
}

function wrapperValueOfType(owner: JavaReferenceType, argument: JavaType, state: State): JavaType {
  for (const name of JAVA_PRIMITIVES) {
    const primitive = { kind: 'primitive', name } as const;
    if (sameJavaType(owner, boxedJavaType(primitive)) !== 'yes') continue;
    const acceptsString =
      name !== 'char' &&
      argument.kind === 'reference' &&
      !argument.sourceId &&
      argument.name === 'java.lang.String';
    if (
      acceptsString ||
      javaInvocationConversion(argument, primitive, 'loose', state.relations) === 'yes'
    )
      return owner;
  }
  return UNKNOWN_JAVA_TYPE;
}

// These interfaces inherit Iterable.forEach. Implementations such as ArrayList
// can override it, so a known subtype alone cannot identify its declaration.
const inheritsIterableForEach = new Set([
  'java.lang.Iterable',
  'java.util.Collection',
  'java.util.List',
  'java.util.Set',
]);

export function javaExternalCallTarget(
  filePath: string,
  name: string,
  range: Range,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): string | undefined {
  if (name !== 'forEach') return undefined;
  const call = getJavaOverloadCall(filePath, range, name);
  if (!call?.receiverIsValue || call.receiver?.kind !== 'typed' || call.arguments.length !== 1)
    return undefined;
  const [argument] = call.arguments;
  if (argument?.kind !== 'implicit-void-lambda' || argument.arity !== 1) return undefined;
  const receiver = argumentType(call.receiver, filePath, stateFor(scopes, model));
  if (
    receiver.kind === 'reference' &&
    !receiver.sourceId &&
    inheritsIterableForEach.has(receiver.name)
  )
    return 'java.lang.Iterable#forEach(java.util.function.Consumer)';
  return undefined;
}

function factoryConversion(
  fact: Extract<JavaArgumentFact, { kind: 'factory' }>,
  target: JavaType,
  filePath: string,
  site: ReferenceSite,
  state: State,
): JavaVerdict {
  if (
    fact.shadowed ||
    fact.arguments.length === 0 ||
    (fact.name === 'singletonList' && fact.arguments.length !== 1) ||
    fact.typeArguments.length > 1
  )
    return 'unknown';
  const rootName = fact.owner.split('.')[0]!;
  const claim = lookupNameClaim(site.inScope, rootName, state.scopes);
  if (claim.bindings.some((binding) => !isClassLike(binding.def.type))) return 'unknown';
  const enclosing = findEnclosingClassDef(site.inScope, state.scopes);
  if (
    enclosing !== undefined &&
    [enclosing.nodeId, ...state.scopes.methodDispatch.mroFor(enclosing.nodeId)].some(
      (owner) => state.model.fields.lookupAllByOwner(owner, rootName).length > 0,
    )
  )
    return 'unknown';
  const owner = resolveTypeName(fact.owner, { filePath, at: fact.at }, state);
  const expectedOwner = fact.name === 'asList' ? 'java.util.Arrays' : 'java.util.Collections';
  if (owner.kind !== 'reference' || owner.sourceId !== undefined || owner.name !== expectedOwner)
    return 'unknown';
  let elements = fact.arguments.map((argument) => argumentType(argument, filePath, state, site));
  if (elements.some((element) => element.kind === 'unknown' || element.kind === 'null'))
    return 'unknown';
  const explicit =
    fact.typeArguments[0] === undefined
      ? undefined
      : parseType(fact.typeArguments[0], { filePath, at: fact.at }, state);
  if (explicit?.kind === 'primitive' || explicit?.kind === 'unknown') return 'unknown';
  if (fact.name === 'asList' && elements.length === 1 && elements[0]?.kind === 'array') {
    const component = elements[0].component;
    // Fixed-array applicability precedes varargs. Target typing must not turn
    // asList(String[]) into List<String[]> unless explicit T requires it.
    if (explicit === undefined && component.kind !== 'primitive') elements = [component];
    else if (
      explicit !== undefined &&
      javaSubtype(elements[0], { kind: 'array', component: explicit }, state.relations) === 'yes'
    )
      elements = [component];
  }
  const boxed = elements.map(boxedJavaType);
  if (boxed.some((element) => sameJavaType(element, boxed[0]!) !== 'yes')) return 'unknown';
  if (target.kind === 'unknown') return 'unknown';
  if (target.kind !== 'reference') return 'no';
  const elementTarget =
    explicit ??
    (['java.util.List', 'java.util.Collection', 'java.lang.Iterable'].includes(target.name) &&
    target.sourceId === undefined &&
    target.arguments.length === 1
      ? target.arguments[0]
      : boxed[0]);
  if (elementTarget === undefined) return 'unknown';
  const converted = elements.map((element) =>
    javaInvocationConversion(element, elementTarget, 'loose', state.relations),
  );
  if (converted.includes('no')) return 'no';
  if (converted.includes('unknown')) return 'unknown';
  return javaSubtype(
    { kind: 'reference', name: 'java.util.List', arguments: [elementTarget] },
    target,
    state.relations,
  );
}

function enclosingTopLevel(definition: SymbolDefinition, state: State): string | undefined {
  const fact = typeFact(definition, state);
  if (fact === undefined) return undefined;
  let outermost = fact;
  for (const candidate of getJavaOverloadFacts(definition.filePath)?.types ?? []) {
    if (javaRangeContains(candidate.range, outermost.range)) outermost = candidate;
  }
  const pkg = packageName(definition.filePath);
  return pkg === undefined ? undefined : `${pkg}:${outermost.name}`;
}

function isTypeQualifier(
  call: JavaOverloadCallFact,
  caller: SymbolDefinition | undefined,
  state: State,
): boolean {
  const name = call.receiverSpelling;
  if (
    caller === undefined ||
    call.receiverIsValue ||
    name === undefined ||
    name === 'this' ||
    name === 'super'
  )
    return false;
  if (
    [caller.nodeId, ...state.scopes.methodDispatch.mroFor(caller.nodeId)].some(
      (ownerId) => state.model.fields.lookupAllByOwner(ownerId, name).length > 0,
    )
  )
    return false;
  return (
    resolveTypeName(name, { filePath: caller.filePath, at: call.range }, state).kind === 'reference'
  );
}

function inheritsPackageMember(
  receiver: SymbolDefinition,
  declaringOwner: SymbolDefinition,
  state: State,
  seen = new Set<string>(),
): JavaVerdict {
  if (receiver.nodeId === declaringOwner.nodeId) return 'yes';
  if (seen.has(receiver.nodeId) || seen.size >= 64) return 'unknown';
  seen.add(receiver.nodeId);
  const ownerPackage = packageName(declaringOwner.filePath);
  const receiverPackage = packageName(receiver.filePath);
  if (ownerPackage === undefined || receiverPackage === undefined) return 'unknown';
  // Once a class outside the declaration's package fails to inherit this
  // member, a later subclass cannot regain it by returning to that package.
  if (ownerPackage !== receiverPackage) return 'no';
  const fact = typeFact(receiver, state);
  if (fact === undefined) return 'unknown';
  let uncertain = false;
  for (const spelling of fact.bases) {
    const base = parseType(spelling, { filePath: receiver.filePath, at: fact.range }, state);
    if (base.kind !== 'reference' || base.sourceId === undefined) {
      uncertain = true;
      continue;
    }
    const definition = state.scopes.defs.get(base.sourceId);
    const inherited =
      definition === undefined
        ? 'unknown'
        : inheritsPackageMember(definition, declaringOwner, state, new Set(seen));
    if (inherited === 'yes') return 'yes';
    if (inherited === 'unknown') uncertain = true;
  }
  return uncertain ? 'unknown' : 'no';
}

function eligible(
  definition: SymbolDefinition,
  receiver: SymbolDefinition,
  site: ReferenceSite,
  call: JavaOverloadCallFact | undefined,
  state: State,
): JavaVerdict {
  const fact = methodFact(definition, state);
  if (fact === undefined) return definition.isSynthetic ? 'yes' : 'unknown';
  const owner =
    definition.ownerId === undefined ? undefined : state.scopes.defs.get(definition.ownerId);
  if (owner === undefined) return 'unknown';
  const inherited = owner.nodeId !== receiver.nodeId;
  const isStatic = fact.modifiers.includes('static');
  const ownerKind = typeFact(owner, state)?.kind;
  if (
    inherited &&
    (fact.modifiers.includes('private') || (ownerKind === 'interface_declaration' && isStatic))
  )
    return 'no';
  if (fact.modifiers.includes('public')) return 'yes';
  const caller = findEnclosingClassDef(site.inScope, state.scopes);
  const callerPackage = caller === undefined ? undefined : packageName(caller.filePath);
  const ownerPackage = packageName(owner.filePath);
  const receiverPackage = packageName(receiver.filePath);
  if (fact.modifiers.includes('private')) {
    const callerNest = caller === undefined ? undefined : enclosingTopLevel(caller, state);
    const ownerNest = enclosingTopLevel(owner, state);
    return callerNest === undefined || ownerNest === undefined
      ? 'unknown'
      : callerNest === ownerNest
        ? 'yes'
        : 'no';
  }
  if (!fact.modifiers.includes('protected')) {
    if (inherited && receiverPackage !== ownerPackage) return 'no';
    if (inherited) {
      const membership = inheritsPackageMember(receiver, owner, state);
      if (membership !== 'yes') return membership;
    }
    return callerPackage === undefined || ownerPackage === undefined
      ? 'unknown'
      : callerPackage === ownerPackage
        ? 'yes'
        : 'no';
  }
  if (callerPackage !== undefined && callerPackage === ownerPackage) return 'yes';
  if (caller === undefined) return 'unknown';
  // JLS 6.6.2.1 permits access within any enclosing subclass body, but
  // an instance receiver must be that qualifying subclass or its subtype.
  const receiverMro = state.scopes.methodDispatch.mroFor(receiver.nodeId);
  for (const scopeId of [site.inScope, ...state.scopes.scopeTree.getAncestors(site.inScope)]) {
    const scope = state.scopes.scopeTree.getScope(scopeId);
    if (scope?.kind !== 'Class') continue;
    const enclosing = scope.ownedDefs.find((def) => isClassLike(def.type));
    if (
      enclosing === undefined ||
      !state.scopes.methodDispatch.mroFor(enclosing.nodeId).includes(owner.nodeId)
    )
      continue;
    if (
      isStatic ||
      call?.receiverSpelling === 'super' ||
      receiver.nodeId === enclosing.nodeId ||
      receiverMro.includes(enclosing.nodeId)
    )
      return 'yes';
  }
  return 'no';
}

function coversObjectSignature(owner: SymbolDefinition, name: string, state: State): boolean {
  if (!['equals', 'hashCode', 'toString', 'clone', 'finalize'].includes(name)) return false;
  return [owner.nodeId, ...state.scopes.methodDispatch.mroFor(owner.nodeId)].some((ownerId) =>
    state.model.methods.lookupAllByOwner(ownerId, name).some((method) => {
      const fact = methodFact(method, state);
      if (
        fact === undefined ||
        fact.modifiers.includes('static') ||
        fact.modifiers.includes('private')
      )
        return false;
      const parameters = normalizedCandidate(method, state).parameters;
      return name === 'equals'
        ? parameters.length === 1 &&
            sameJavaType(parameters[0]!, {
              kind: 'reference',
              name: 'java.lang.Object',
              arguments: [],
            }) === 'yes'
        : parameters.length === 0;
    }),
  );
}

function hierarchyBaseType(
  owner: SymbolDefinition,
  fact: JavaOverloadTypeFact,
  raw: string,
  state: State,
): JavaType {
  const bound = javaBoundBase(state.scopes.referenceSites, fact, raw);
  if (!bound) return parseType(raw, { filePath: owner.filePath, at: fact.range }, state);
  for (const id of state.scopes.methodDispatch.mroFor(owner.nodeId)) {
    const ancestor = state.scopes.defs.get(id);
    if (ancestor?.filePath === bound.filePath && typeFact(ancestor, state) === bound.target)
      return sourceReference(ancestor);
  }
  return UNKNOWN_JAVA_TYPE;
}

function hierarchyComplete(
  owner: SymbolDefinition,
  memberName: string,
  state: State,
  seen = new Set<string>(),
  objectCovered = coversObjectSignature(owner, memberName, state),
): boolean {
  if (seen.has(owner.nodeId) || seen.size >= 64) return false;
  // Reuse shared ancestors without letting a shallower proof bypass the
  // traversal bound on another path. Failed/cyclic inventories are cached too.
  const key = `${owner.nodeId}\0${memberName}\0${objectCovered}\0${seen.size}`;
  const cached = state.hierarchyCompleteness.get(key);
  if (cached !== undefined) return cached;
  state.hierarchyCompleteness.set(key, false);
  seen.add(owner.nodeId);
  const fact = typeFact(owner, state);
  if (fact === undefined) return false;
  if (objectMethods.has(memberName) && !objectCovered) return false;
  for (const raw of fact.bases) {
    const base = hierarchyBaseType(owner, fact, raw, state);
    if (base.kind !== 'reference') return false;
    if (base.sourceId === undefined) {
      if (base.name === 'java.lang.Object' && (!objectMethods.has(memberName) || objectCovered))
        continue;
      if (base.name === 'java.lang.Iterable' && !objectMethods.has(memberName)) {
        // Iterable<T> contributes exactly these three methods. A source
        // override of forEach(Consumer<? super T>) accounts for that default.
        if (!['iterator', 'spliterator', 'forEach'].includes(memberName)) continue;
        if (
          memberName === 'forEach' &&
          base.arguments.length === 1 &&
          state.model.methods.lookupAllByOwner(owner.nodeId, memberName).some((method) => {
            const declaration = methodFact(method, state);
            if (
              declaration?.parameterTypes.length !== 1 ||
              !declaration.modifiers.includes('public') ||
              declaration.modifiers.includes('static')
            )
              return false;
            const parameter = declaration.parameterTypes[0]!.trim();
            const open = parameter.indexOf('<');
            if (open <= 0 || !parameter.endsWith('>')) return false;
            const bound = parameter.slice(open + 1, -1).trimStart();
            const wildcard = /^\?\s+super\s+/u.exec(bound);
            if (!wildcard || wildcard[0].length === bound.length) return false;
            const context = { filePath: method.filePath, at: declaration.range };
            const consumer = parseType(parameter.slice(0, open), context, state);
            return (
              consumer.kind === 'reference' &&
              consumer.sourceId === undefined &&
              consumer.name === 'java.util.function.Consumer' &&
              sameJavaType(
                parseType(bound.slice(wildcard[0].length), context, state),
                base.arguments[0]!,
              ) === 'yes'
            );
          })
        )
          continue;
      }
      // Runnable declares only run(). An indexed zero-argument override
      // represents that signature; its other member names come from Object.
      if (base.name === 'java.lang.Runnable' && !objectMethods.has(memberName)) {
        if (
          memberName !== 'run' ||
          state.model.methods
            .lookupAllByOwner(owner.nodeId, memberName)
            .some((method) => methodFact(method, state)?.parameterTypes.length === 0)
        )
          continue;
      }
      return false;
    }
    const definition = state.scopes.defs.get(base.sourceId);
    if (
      definition === undefined ||
      !hierarchyComplete(definition, memberName, state, new Set(seen), objectCovered)
    )
      return false;
  }
  state.hierarchyCompleteness.set(key, true);
  return true;
}

function receiverInventory(
  owner: SymbolDefinition,
  name: string,
  site: ReferenceSite,
  call: JavaOverloadCallFact | undefined,
  state: State,
) {
  const declarations: SymbolDefinition[] = [];
  const originalDeclarationIds = new Set<string>();
  const normalized: JavaOverloadCandidate<SymbolDefinition>[] = [];
  let complete = hierarchyComplete(owner, name, state);
  for (const ownerId of [owner.nodeId, ...state.scopes.methodDispatch.mroFor(owner.nodeId)]) {
    for (const declaration of state.model.methods.lookupAllByOwner(ownerId, name)) {
      if (originalDeclarationIds.has(declaration.nodeId)) continue;
      originalDeclarationIds.add(declaration.nodeId);
      const verdict = eligible(declaration, owner, site, call, state);
      if (verdict === 'no') continue;
      declarations.push(declaration);
      if (verdict === 'unknown') complete = false;
      const candidate = normalizedCandidate(declaration, state);
      // A more-derived override removes only its override-equivalent ancestor,
      // never the other overloads on that ancestor.
      const overridden = normalized.some(
        (prior) =>
          prior.parameters.length === candidate.parameters.length &&
          prior.parameters.every(
            (parameter, i) => sameJavaType(parameter, candidate.parameters[i]!) === 'yes',
          ) &&
          prior.definition.ownerId !== undefined &&
          declaration.ownerId !== undefined &&
          state.scopes.methodDispatch
            .mroFor(prior.definition.ownerId)
            .includes(declaration.ownerId),
      );
      if (!overridden) normalized.push(candidate);
    }
  }
  return {
    declarations,
    normalized,
    complete,
    originalDeclarationCount: originalDeclarationIds.size,
  };
}

export function resolveJavaConstructorCall(
  owner: SymbolDefinition,
  constructors: readonly SymbolDefinition[],
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | undefined {
  if (constructors.length < 2) return undefined;
  const candidates = new Map(constructors.map((def) => [def.nodeId, def]));
  if (candidates.size < 2) return undefined;
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  const call =
    filePath === undefined ? undefined : getJavaOverloadCall(filePath, site.atRange, '<init>');
  const candidateIds = [...candidates.keys()];
  if (filePath === undefined || !call?.constructorForm)
    return { kind: 'unknown', candidateIds, candidateSetComplete: false };
  const state = stateFor(scopes, model);
  const visible: JavaOverloadCandidate<SymbolDefinition>[] = [];
  for (const constructor of candidates.values()) {
    const access = constructorAccess(constructor, owner, site, call, state, filePath);
    if (access === 'unknown') return { kind: 'unknown', candidateIds, candidateSetComplete: false };
    if (access === 'yes') visible.push(normalizedCandidate(constructor, state));
  }
  const decision = selectCallOverload(visible, call, filePath, site, state);
  return decision.kind === 'resolved'
    ? { kind: 'resolved', definition: decision.definition }
    : { kind: decision.kind, candidateIds, candidateSetComplete: true };
}

function constructorAccess(
  constructor: SymbolDefinition,
  owner: SymbolDefinition,
  site: ReferenceSite,
  call: JavaOverloadCallFact,
  state: State,
  filePath: string,
): JavaVerdict {
  // JLS 6.6.2.2 permits protected construction outside its package through super or anonymous creation.
  if (
    methodFact(constructor, state)?.modifiers.includes('protected') &&
    packageName(constructor.filePath) !== packageName(filePath)
  )
    return call.constructorForm === 'super' || call.constructorForm === 'anonymous' ? 'yes' : 'no';
  return eligible(constructor, owner, site, call, state);
}

function selectCallOverload(
  candidates: readonly JavaOverloadCandidate<SymbolDefinition>[],
  call: JavaOverloadCallFact,
  filePath: string,
  site: ReferenceSite,
  state: State,
) {
  const types: (JavaType | undefined)[] = [];
  return selectJavaOverload(
    candidates,
    call.arguments.length,
    (index, target, phase) => {
      const argument = call.arguments[index]!;
      if (argument.kind === 'factory')
        return factoryConversion(argument, target, filePath, site, state);
      const type = types[index] ?? argumentType(argument, filePath, state, site);
      types[index] = type;
      return javaInvocationConversion(type, target, phase, state.relations);
    },
    state.relations,
  );
}

/** The class a `this` (JLS 15.8.3) or `super` (JLS 15.11.2) receiver names at
 * a site. Only the innermost class body counts, anonymous bodies included; a
 * body without an indexed class definition stops the lookup instead of
 * escaping to an outer class. `super` is the direct superclass, which a class
 * declaration spells before its interfaces; an implicit `Object`, an
 * interface-only base list, an anonymous body or an unresolved first base
 * leaves it unknown. */
function lexicalReceiverOwner(
  spelling: 'this' | 'super',
  scopeId: ReferenceSite['inScope'],
  state: State,
): SymbolDefinition | undefined {
  let current: ReferenceSite['inScope'] | null = scopeId;
  const visited = new Set<ReferenceSite['inScope']>();
  let enclosing: SymbolDefinition | undefined;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = state.scopes.scopeTree.getScope(current);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      enclosing = scope.ownedDefs.find((definition) => isClassLike(definition.type));
      break;
    }
    current = scope.parent;
  }
  if (enclosing === undefined || spelling === 'this') return enclosing;
  const fact = typeFact(enclosing, state);
  const first = fact?.kind === 'class_declaration' ? fact.bases[0] : undefined;
  if (fact === undefined || first === undefined) return undefined;
  const base = parseType(first, { filePath: enclosing.filePath, at: fact.range }, state);
  const superclass =
    base.kind === 'reference' && base.sourceId !== undefined
      ? state.scopes.defs.get(base.sourceId)
      : undefined;
  return superclass !== undefined && typeFact(superclass, state)?.kind === 'class_declaration'
    ? superclass
    : undefined;
}

/** The source class named by a method's declared return type after `dimensions`
 * array accesses, read in the declaring method's own type context. */
function producedElementId(
  definition: SymbolDefinition,
  dimensions: number,
  state: State,
): string | undefined {
  if (definition.returnType === undefined) return undefined;
  let type = parseType(
    definition.returnType,
    {
      filePath: definition.filePath,
      at: methodFact(definition, state)?.range ?? definition.declarationRange ?? UNKNOWN_RANGE,
    },
    state,
  );
  for (let remaining = dimensions; remaining > 0; remaining--) {
    if (type.kind !== 'array') return undefined;
    type = type.component;
  }
  return type.kind === 'reference' ? type.sourceId : undefined;
}

/** Java claims full overload families before shared owner/rank pruning. A
 * complete original singleton with opaque arguments may retain the historical
 * unique-member inference; no pruned singleton or incomplete inventory may. */
export function resolveJavaReceiverMember(
  ownerDef: SymbolDefinition,
  memberName: string,
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | undefined {
  if (site.kind !== 'call' || site.callForm === 'constructor') return undefined;
  const state = stateFor(scopes, model);
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  const call =
    filePath === undefined ? undefined : getJavaOverloadCall(filePath, site.atRange, site.name);
  if (
    filePath !== undefined &&
    call?.receiverCall !== undefined &&
    decodeReceiverChain(site.receiverChain)?.steps.some((step) => step.kind === 'index')
  ) {
    const producer = getJavaOverloadCall(filePath, call.receiverCall.range, call.receiverCall.name);
    let decision: ReceiverMemberResolution | undefined;
    if (producer !== undefined) {
      // Reuse the JLS selector at the exact producer site. A unique method name
      // is insufficient evidence that a call is applicable or accessible.
      const producerSite: ReferenceSite = {
        ...site,
        name: producer.name,
        atRange: producer.range,
        arity: producer.arguments.length,
        callForm: producer.receiver === undefined ? 'free' : 'member',
        explicitReceiver:
          producer.receiverSpelling === undefined ? undefined : { name: producer.receiverSpelling },
        receiverChain: undefined,
      };
      if (producer.receiver === undefined) {
        decision = resolveJavaUnqualifiedCall(producerSite, scopes, model);
      } else {
        const type =
          producer.receiver.kind === 'typed'
            ? argumentType(producer.receiver, filePath, state)
            : !producer.receiverIsValue && producer.receiverSpelling !== undefined
              ? parseType(producer.receiverSpelling, { filePath, at: producer.range }, state)
              : UNKNOWN_JAVA_TYPE;
        const producerOwner =
          producer.receiverSpelling === 'this' || producer.receiverSpelling === 'super'
            ? lexicalReceiverOwner(producer.receiverSpelling, site.inScope, state)
            : type.kind === 'reference' && type.sourceId !== undefined
              ? scopes.defs.get(type.sourceId)
              : undefined;
        if (producerOwner !== undefined)
          decision = resolveJavaReceiverMember(
            producerOwner,
            producer.name,
            producerSite,
            scopes,
            model,
          );
      }
    }
    // The shared fold types the producer by name. Bind the member only when
    // the selected producer's own return type, indexed once per trailing
    // index step, names the same owner (e.g. not an outer class's same-named
    // method seen from an anonymous class body).
    const steps = decodeReceiverChain(site.receiverChain)?.steps ?? [];
    let indexSteps = 0;
    while (steps[steps.length - 1 - indexSteps]?.kind === 'index') indexSteps++;
    if (
      decision?.kind !== 'resolved' ||
      producedElementId(decision.definition, indexSteps, state) !== ownerDef.nodeId
    ) {
      return {
        kind: 'unknown',
        candidateIds: model.methods
          .lookupAllByOwner(ownerDef.nodeId, memberName)
          .map((method) => method.nodeId),
        candidateSetComplete: false,
        detail: 'Indexed Java receiver producer lacks an applicable, accessible method selection',
      };
    }
  }
  let owner = ownerDef;
  let runnableReceiver = false;
  if (call?.receiver?.kind === 'typed' && filePath !== undefined) {
    const declared = argumentType(call.receiver, filePath, state);
    if (declared.kind === 'reference' && declared.sourceId !== undefined)
      owner = scopes.defs.get(declared.sourceId) ?? owner;
    else if (declared.kind === 'reference' && declared.sourceId === undefined) {
      runnableReceiver =
        declared.name === 'java.lang.Runnable' &&
        memberName === 'run' &&
        typeFact(owner, state)?.bases.some((base) => {
          const type = parseType(
            base,
            { filePath: owner.filePath, at: typeFact(owner, state)!.range },
            state,
          );
          return (
            type.kind === 'reference' &&
            type.sourceId === undefined &&
            type.name === 'java.lang.Runnable'
          );
        }) === true;
      if (!runnableReceiver) {
        const candidateIds = [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)].flatMap(
          (id) =>
            model.methods.lookupAllByOwner(id, memberName).map((candidate) => candidate.nodeId),
        );
        return candidateIds.length === 0
          ? undefined
          : {
              kind: 'unknown',
              candidateIds,
              candidateSetComplete: false,
              detail: 'Declared receiver identity does not match the indexed owner',
            };
      }
    }
  }
  const caller = findEnclosingClassDef(site.inScope, scopes);
  const inventory = receiverInventory(owner, memberName, site, call, state);
  if (inventory.declarations.length === 0) return undefined;
  const candidateIds = inventory.declarations.map((candidate) => candidate.nodeId);
  // A declared fixed zero-argument method owns that exact signature even when
  // an external ancestor's other overloads are unavailable. An inherited
  // zero-argument signature is overridden; varargs apply only in a later phase.
  // Require the original singleton, its own arity metadata, and proven access:
  // this does not promote a pruned singleton or an inferred/variadic signature.
  const original = inventory.normalized[0];
  const exactOwnNoArg =
    call?.arguments.length === 0 &&
    inventory.originalDeclarationCount === 1 &&
    inventory.normalized.length === 1 &&
    original?.definition.ownerId === owner.nodeId &&
    original.definition.parameterCount === 0 &&
    original.parameters.length === 0 &&
    !original.variadic &&
    eligible(original.definition, owner, site, call, state) === 'yes';
  if (!inventory.complete && !exactOwnNoArg)
    return {
      kind: 'unknown',
      candidateIds,
      candidateSetComplete: false,
      detail: 'Incomplete Java inherited member inventory or accessibility evidence',
    };
  if (filePath === undefined || call === undefined) {
    return inventory.originalDeclarationCount === 1
      ? undefined
      : {
          kind: 'unknown',
          candidateIds,
          candidateSetComplete: true,
          detail: 'Java argument capture facts are unavailable',
        };
  }
  let candidates = inventory.normalized;
  if (call.receiver?.kind === 'typed') {
    const receiverType = argumentType(call.receiver, filePath, state);
    const ownerFact = typeFact(owner, state);
    if (
      receiverType.kind === 'reference' &&
      receiverType.sourceId === owner.nodeId &&
      ownerFact &&
      ownerFact.typeParameters.length > 0 &&
      ownerFact.typeParameters.length === receiverType.arguments.length
    ) {
      const substitute = receiverSubstitution(owner.filePath, ownerFact, receiverType);
      candidates = candidates.map((candidate) => ({
        ...candidate,
        parameters: candidate.parameters.map(substitute),
      }));
    }
  }
  const applicability = selectCallOverload(
    runnableReceiver
      ? candidates.filter((candidate) => candidate.parameters.length === 0 && !candidate.variadic)
      : candidates,
    call,
    filePath,
    site,
    state,
  );
  const decision =
    applicability.kind === 'unknown'
      ? (selectJavaLambdaOverload(
          { kind: 'unknown', candidateIds, candidateSetComplete: true },
          site,
          scopes,
        ) ?? applicability)
      : applicability;
  if (decision.kind === 'resolved') {
    const selected = methodFact(decision.definition, state);
    // JLS 15.12.3 checks invocation form AFTER choosing the most-specific
    // method. Removing instance methods earlier could invent a less-specific
    // static target for a program javac rejects.
    if (
      selected !== undefined &&
      !selected.modifiers.includes('static') &&
      ((call.staticContext && call.receiverSpelling === undefined) ||
        isTypeQualifier(call, caller, state))
    ) {
      return {
        kind: 'inapplicable',
        candidateIds,
        candidateSetComplete: true,
        detail: 'Selected instance method requires an instance receiver',
      };
    }
    return { kind: 'resolved', definition: decision.definition };
  }
  if (decision.kind === 'unknown' && inventory.originalDeclarationCount === 1) return undefined;
  return {
    kind: decision.kind,
    candidateIds,
    candidateSetComplete: true,
    ...(decision.kind === 'unknown'
      ? { detail: 'Unsupported Java argument, generic constraint, or subtype evidence' }
      : {}),
  };
}

function receiverSubstitution(
  filePath: string,
  fact: JavaOverloadTypeFact,
  receiver: JavaReferenceType,
) {
  const substitutions = new Map(
    fact.typeParameters.map((name, i) => [
      `${filePath}:${fact.range.startLine}:${fact.range.startCol}:${name}`,
      receiver.arguments[i],
    ]),
  );
  const substitute = (type: JavaType): JavaType => {
    if (type.kind === 'variable') return substitutions.get(type.declaration) ?? type;
    if (type.kind === 'array') return { ...type, component: substitute(type.component) };
    if (type.kind === 'reference' && type.arguments.length)
      return { ...type, arguments: type.arguments.map(substitute) };
    return type;
  };
  return substitute;
}

/** JLS 14.14.2 takes the element from the Iterable supertype, which may
 * differ from the first type argument of the expression's own class. */
function iterableElements(type: JavaType, state: State, seen: Set<string>): JavaType[] {
  if (type.kind === 'array') return [type.component];
  if (type.kind !== 'reference') return [];
  if (!type.sourceId) {
    const element = type.arguments[0];
    return element &&
      type.arguments.length === 1 &&
      javaSubtype(
        type,
        { kind: 'reference', name: 'java.lang.Iterable', arguments: [element] },
        state.relations,
      ) === 'yes'
      ? [element]
      : [];
  }
  if (seen.has(type.sourceId) || seen.size >= MAX_JAVA_TYPE_DEPTH) return [];
  const owner = state.scopes.defs.get(type.sourceId);
  const fact = owner && typeFact(owner, state);
  if (!owner || !fact) return [];
  const substitute = receiverSubstitution(owner.filePath, fact, type);
  const path = new Set(seen).add(type.sourceId);
  return fact.bases.flatMap((base) =>
    iterableElements(
      substitute(parseType(base, { filePath: owner.filePath, at: fact.range }, state)),
      state,
      path,
    ),
  );
}

export function populateJavaIterableBindings(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  model: SemanticModel,
): void {
  for (const parsed of files) {
    const loops = getJavaOverloadFacts(parsed.filePath)?.enhancedFor;
    if (!loops?.length) continue;
    const state = stateFor(indexes, model);
    for (const loop of loops) {
      bindIterableElement(loop, parsed.filePath, indexes, state);
    }
  }
}

function bindIterableElement(
  loop: NonNullable<JavaOverloadFileFacts['enhancedFor']>[number],
  filePath: string,
  indexes: ScopeResolutionIndexes,
  state: State,
): void {
  const scope = indexes.scopeTree.getScope(
    makeScopeId({ filePath: filePath, range: loop.body, kind: 'Block' }),
  );
  if (!scope) return;
  const site: ReferenceSite = {
    kind: 'call',
    name: loop.name,
    inScope: scope.id,
    atRange: loop.body,
  };
  const type = argumentType(loop.value, filePath, state, site);
  const elements = iterableElements(type, state, new Set());
  const element = elements[0];
  if (
    element?.kind !== 'reference' ||
    !element.sourceId ||
    !elements.every((other) => sameJavaType(element, other) === 'yes')
  )
    return;
  const declaration = indexes.defs.get(element.sourceId);
  if (!declaration) return;
  const fact = typeFact(declaration, state);
  if (!fact) return;
  const anchor = makeScopeId({
    filePath: declaration.filePath,
    range: fact.range,
    kind: 'Class',
  });
  if (indexes.scopeTree.has(anchor))
    (scope.typeBindings as Map<string, TypeRef>).set(loop.name, {
      rawName: fact.simpleName,
      declaredAtScope: anchor,
      source: 'assignment-inferred',
    });
}

function staticImportOwnerAccess(
  owner: SymbolDefinition,
  filePath: string,
  state: State,
): JavaVerdict {
  const fact = typeFact(owner, state);
  if (fact === undefined) return 'unknown';
  if (owner.isSynthetic) return 'no';
  const samePackage = packageName(owner.filePath) === packageName(filePath);
  // Imports are outside every class body. Check the named type and all its
  // enclosing types; nestmate/subclass privileges do not apply here.
  for (const enclosing of getJavaOverloadFacts(owner.filePath)?.types ?? []) {
    if (!javaRangeContains(enclosing.range, fact.range)) continue;
    if (enclosing.modifiers === undefined) return 'unknown';
    if (enclosing.modifiers.includes('private')) return 'no';
    if (!enclosing.modifiers.includes('public') && !samePackage) return 'no';
  }
  return 'yes';
}

export function resolveJavaUnqualifiedCall(
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | undefined {
  if (site.kind !== 'call' || site.callForm === 'constructor') return undefined;
  let scopeId: string | null = site.inScope;
  const visited = new Set<string>();
  while (scopeId !== null && !visited.has(scopeId)) {
    visited.add(scopeId);
    const scope = scopes.scopeTree.getScope(scopeId);
    if (scope === undefined) break;
    if (scope.kind === 'Class') {
      const owner = scope.ownedDefs.find((definition) => isClassLike(definition.type));
      if (
        owner !== undefined &&
        [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)].some(
          (id) => model.methods.lookupAllByOwner(id, site.name).length > 0,
        )
      ) {
        return resolveJavaReceiverMember(owner, site.name, site, scopes, model);
      }
    }
    scopeId = scope.parent;
  }
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  const imported =
    filePath === undefined
      ? []
      : (getJavaOverloadFacts(filePath)?.imports.filter(
          (item) => item.static && (item.wildcard || item.name.split('.').at(-1) === site.name),
        ) ?? []);
  if (imported.length > 0) {
    const state = stateFor(scopes, model);
    const call = getJavaOverloadCall(filePath!, site.atRange, site.name);
    const claim = lookupNameClaim(site.inScope, site.name, scopes);
    const candidates = new Map<
      string,
      { candidate: JavaOverloadCandidate<SymbolDefinition>; explicit: boolean }
    >();
    let complete = true;
    for (const item of imported) {
      const ownerName = item.wildcard ? item.name : item.name.slice(0, item.name.lastIndexOf('.'));
      const type = qualifiedReference(ownerName, state);
      const owner =
        type.kind === 'reference' && type.sourceId !== undefined
          ? scopes.defs.get(type.sourceId)
          : undefined;
      if (owner === undefined) {
        complete = false;
        continue;
      }
      const ownerAccess = staticImportOwnerAccess(owner, filePath!, state);
      if (ownerAccess !== 'yes') {
        if (ownerAccess === 'unknown') complete = false;
        continue;
      }
      const inventory = receiverInventory(owner, site.name, site, call, state);
      complete &&= inventory.complete;
      for (const candidate of inventory.normalized) {
        const fact = methodFact(candidate.definition, state);
        if (fact === undefined) {
          complete = false;
          continue;
        }
        if (!fact.modifiers.includes('static') || fact.modifiers.includes('private')) continue;
        // Static-import access is checked at the compilation unit, outside
        // a subclass body (JLS 7.5.3), so protected does not grant cross-package access.
        if (
          !fact.modifiers.includes('public') &&
          packageName(candidate.definition.filePath) !== packageName(filePath!)
        )
          continue;
        const previous = candidates.get(candidate.definition.nodeId);
        candidates.set(candidate.definition.nodeId, {
          candidate,
          explicit: !item.wildcard || previous?.explicit === true,
        });
      }
    }
    const all = [...candidates.values()];
    const visible = all.filter(
      ({ candidate, explicit }) =>
        explicit ||
        !all.some(
          (other) =>
            other.explicit &&
            other.candidate.parameters.length === candidate.parameters.length &&
            other.candidate.parameters.every(
              (parameter, index) => sameJavaType(parameter, candidate.parameters[index]!) === 'yes',
            ),
        ),
    );
    const candidateIds = [
      ...new Set([
        ...all.map(({ candidate }) => candidate.definition.nodeId),
        ...claim.bindings
          .filter((binding) => binding.def.type === 'Method' || binding.def.type === 'Function')
          .map((binding) => binding.def.nodeId),
      ]),
    ];
    if (complete && call !== undefined) {
      const decision = selectCallOverload(
        visible.map(({ candidate }) => candidate),
        call,
        filePath!,
        site,
        state,
      );
      if (decision.kind === 'resolved')
        return { kind: 'resolved', definition: decision.definition };
      if (decision.kind === 'unknown' && all.length === 1) return undefined;
      return { kind: decision.kind, candidateIds, candidateSetComplete: true };
    }
    return {
      kind: 'unknown',
      candidateIds,
      candidateSetComplete: false,
      detail: 'Incomplete static-import overload inventory or argument evidence',
    };
  }
  return undefined;
}

/** The call whose selected declaration types this site's receiver. Its result
 * may reach the receiver through array accesses only when every index step
 * trails the chain (`make()[0].save()`), so the shared selected-call path peels
 * one element per step; an index anywhere else keeps the structural fold. */
export function resolveJavaReceiverCallSite(
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
): { readonly name: string; readonly range: Range } | undefined {
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  const producer =
    filePath === undefined
      ? undefined
      : getJavaOverloadCall(filePath, site.atRange, site.name)?.receiverCall;
  const steps = decodeReceiverChain(site.receiverChain)?.steps ?? [];
  let end = steps.length;
  while (end > 0 && steps[end - 1]!.kind === 'index') end--;
  if (end === steps.length)
    return steps.some((step) => step.kind === 'index') ? undefined : producer;
  const last = steps[end - 1];
  return last?.kind === 'call' &&
    last.name === producer?.name &&
    steps.slice(0, end).every((step) => step.kind !== 'index')
    ? producer
    : undefined;
}

/** Ground only a whole formal owner type variable from explicit source
 * heritage. This preserves generic interface fan-out without treating a
 * concrete implementation's competing overload as the selected signature.
 * Nested substitutions and generic method inference remain unknown. */
function signatureForImplementation(
  primary: SymbolDefinition,
  owner: SymbolDefinition,
  state: State,
): JavaOverloadCandidate<SymbolDefinition> {
  const signature = normalizedCandidate(primary, state);
  const method = methodFact(primary, state);
  const primaryOwner =
    primary.ownerId === undefined ? undefined : state.scopes.defs.get(primary.ownerId);
  const declaration = primaryOwner === undefined ? undefined : typeFact(primaryOwner, state);
  if (
    method === undefined ||
    method.typeParameters.length > 0 ||
    declaration === undefined ||
    declaration.typeParameters.length === 0
  )
    return signature;
  const witnesses: (readonly JavaType[])[] = [];
  for (const id of [owner.nodeId, ...state.scopes.methodDispatch.mroFor(owner.nodeId)]) {
    const implementation = state.scopes.defs.get(id);
    const fact = implementation === undefined ? undefined : typeFact(implementation, state);
    if (implementation === undefined || fact === undefined) continue;
    for (const spelling of fact.bases) {
      const base = parseType(
        spelling,
        { filePath: implementation.filePath, at: fact.range },
        state,
      );
      if (
        base.kind === 'reference' &&
        base.sourceId === primary.ownerId &&
        base.arguments.length === declaration.typeParameters.length
      )
        witnesses.push(base.arguments);
    }
  }
  const arguments_ = witnesses[0];
  if (
    arguments_ === undefined ||
    !witnesses.every((witness) =>
      witness.every((type, i) => sameJavaType(type, arguments_[i]!) === 'yes'),
    )
  )
    return signature;
  return {
    ...signature,
    parameters: signature.parameters.map((parameter, index) => {
      const position = declaration.typeParameters.indexOf(
        method.parameterTypes[index]?.trim() ?? '',
      );
      return position < 0
        ? parameter
        : signature.variadic && index === signature.parameters.length - 1
          ? { kind: 'array', component: arguments_[position]! }
          : arguments_[position]!;
    }),
  };
}

export function resolveJavaSelectedMethodImplementation(
  primary: SymbolDefinition,
  owner: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | undefined {
  const state = stateFor(scopes, model);
  const primaryFact = methodFact(primary, state);
  if (
    primaryFact?.modifiers.some(
      (modifier) => modifier === 'static' || modifier === 'private' || modifier === 'final',
    )
  )
    return undefined;
  const signature = signatureForImplementation(primary, owner, state);
  const candidates: SymbolDefinition[] = [];
  for (const ownerId of [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)]) {
    for (const candidate of model.methods.lookupAllByOwner(ownerId, methodName(primary))) {
      if (candidate.nodeId === primary.nodeId) continue;
      const fact = methodFact(candidate, state);
      const declaredOwner =
        candidate.ownerId === undefined ? undefined : scopes.defs.get(candidate.ownerId);
      if (
        fact?.modifiers.includes('abstract') ||
        (declaredOwner !== undefined &&
          typeFact(declaredOwner, state)?.kind === 'interface_declaration' &&
          !fact?.modifiers.includes('default'))
      )
        continue;
      const other = normalizedCandidate(candidate, state);
      if (other.parameters.length !== signature.parameters.length) continue;
      const comparisons = other.parameters.map((parameter, i) =>
        sameJavaType(parameter, signature.parameters[i]!),
      );
      if (comparisons.includes('no')) continue;
      if (!comparisons.includes('unknown') && candidates.length === 0)
        return { kind: 'resolved', definition: candidate };
      candidates.push(candidate);
    }
  }
  return candidates.length === 0
    ? undefined
    : {
        kind: 'unknown',
        candidateIds: candidates.map((candidate) => candidate.nodeId),
        candidateSetComplete: true,
        detail: 'Generic override signature could not be established',
      };
}
