import type { Range, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ReceiverMemberResolution } from '../../scope-resolution/contract/scope-resolver.js';
import {
  findEnclosingClassDef,
  isClassLike,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { getJavaPackageFact } from './package-facts.js';
import {
  getJavaOverloadCall,
  getJavaOverloadFacts,
  javaRangeContains,
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

interface TypeContext {
  readonly filePath: string;
  readonly at: Range;
}
interface FileFactIndex {
  readonly methods: Map<string, JavaOverloadMethodFact[]>;
  readonly ownedMethods: Map<string, Map<string, JavaOverloadMethodFact[]>>;
  readonly typeParameters: Map<string, { starts: Range[]; widest: Range[] }>;
}
interface State {
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

function typeFact(definition: SymbolDefinition, state: State): JavaOverloadTypeFact | undefined {
  if (state.typeFacts.has(definition.nodeId)) return state.typeFacts.get(definition.nodeId);
  const facts = getJavaOverloadFacts(definition.filePath)?.types ?? [];
  const candidates = facts.filter(
    (type) => definition.nodeId.endsWith(`:${type.name}`) || definition.qualifiedName === type.name,
  );
  const byPosition =
    definition.declarationRange === undefined
      ? undefined
      : candidates.find((type) => javaRangeContains(type.range, definition.declarationRange!));
  const fact = byPosition ?? (candidates.length === 1 ? candidates[0] : undefined);
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
  };
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
      const ranges = index.typeParameters.get(name) ?? { starts: [], widest: [] };
      ranges.starts.push(declaration.range);
      index.typeParameters.set(name, ranges);
    }
  }
  for (const ranges of index.typeParameters.values()) {
    ranges.starts.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
    let widest = ranges.starts[0]!;
    for (const range of ranges.starts) {
      if (
        range.endLine > widest.endLine ||
        (range.endLine === widest.endLine && range.endCol > widest.endCol)
      )
        widest = range;
      ranges.widest.push(widest);
    }
  }
  state.files.set(facts, index);
  return index;
}

function hasTypeParameter(index: FileFactIndex, name: string, at: Range): boolean {
  const ranges = index.typeParameters.get(name);
  if (ranges === undefined) return false;
  // Find declarations starting before this context. The greatest end in that
  // prefix answers containment, including nested and same-named parameters.
  let low = 0,
    high = ranges.starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const start = ranges.starts[mid]!;
    if (
      start.startLine < at.startLine ||
      (start.startLine === at.startLine && start.startCol <= at.startCol)
    )
      low = mid + 1;
    else high = mid;
  }
  return low > 0 && javaRangeContains(ranges.widest[low - 1]!, at);
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
  const byPosition =
    definition.declarationRange === undefined
      ? undefined
      : candidates.find((method) => javaRangeContains(method.range, definition.declarationRange!));
  const exact = candidates.filter(
    (method) => method.parameterTypes.join('\0') === (definition.parameterTypes ?? []).join('\0'),
  );
  const fact =
    byPosition ??
    (exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined);
  state.methodFacts.set(definition.nodeId, fact);
  return fact;
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

function sourceDefinitions(name: string, state: State): readonly SymbolDefinition[] {
  // Scope and graph identities are distinct. Use the finalized name index,
  // whose definitions share the inheritance and owner lookup key space.
  const qualifiedNames = new Set([
    name,
    ...state.model.types
      .lookupClassByName(name)
      .flatMap((definition) =>
        definition.qualifiedName === undefined ? [] : [definition.qualifiedName],
      ),
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
  const matches = sourceDefinitions(name.split('.').at(-1)!, state).filter(
    (definition) => sourceQualifiedName(definition) === name,
  );
  const unique = [
    ...new Map(matches.map((definition) => [definition.nodeId, definition])).values(),
  ];
  if (unique.length > 1) return UNKNOWN_JAVA_TYPE;
  if (unique.length === 1) return sourceReference(unique[0]!);
  return { kind: 'reference', name, arguments: [] };
}

function resolveTypeName(name: string, context: TypeContext, state: State): JavaType {
  const facts = getJavaOverloadFacts(context.filePath);
  if (facts === undefined)
    return name.includes('.') ? qualifiedReference(name, state) : UNKNOWN_JAVA_TYPE;
  if (hasTypeParameter(fileFactIndex(facts, state), name, context.at)) return UNKNOWN_JAVA_TYPE;
  const first = name.split('.')[0]!;
  const lexical = facts.types.filter(
    (type) => type.simpleName === first && javaRangeContains(type.visible, context.at),
  );
  let nearest: JavaOverloadTypeFact | undefined;
  for (const type of lexical)
    if (nearest === undefined || javaRangeContains(nearest.visible, type.visible)) nearest = type;
  if (nearest !== undefined) {
    if (name.includes('.')) return UNKNOWN_JAVA_TYPE; // qualified nested lookup needs a proven identity
    const matches = [
      ...sourceDefinitions(nearest.name, state),
      ...sourceDefinitions(nearest.simpleName, state),
    ].filter(
      (definition) =>
        definition.filePath === context.filePath &&
        (definition.nodeId.endsWith(`:${nearest!.name}`) ||
          definition.qualifiedName === nearest!.name),
    );
    const unique = [
      ...new Map(matches.map((definition) => [definition.nodeId, definition])).values(),
    ];
    return unique.length === 1 ? sourceReference(unique[0]!) : UNKNOWN_JAVA_TYPE;
  }
  if (name.includes('.')) return qualifiedReference(name, state);
  // A static import can introduce a member TYPE as well as a value or method.
  // Without proof of its namespace, it must not silently become java.lang.Long
  // (or another platform type) solely because the simple spelling matches.
  if (
    facts.imports.some(
      (item) => item.static && (item.wildcard || item.name.split('.').at(-1) === name),
    )
  )
    return UNKNOWN_JAVA_TYPE;
  for (const enclosing of facts.types.filter((type) => javaRangeContains(type.range, context.at))) {
    for (const owner of sourceDefinitions(enclosing.name, state).filter(
      (definition) => definition.filePath === context.filePath,
    )) {
      for (const ancestorId of state.scopes.methodDispatch.mroFor(owner.nodeId)) {
        const ancestor = state.scopes.defs.get(ancestorId);
        const ancestorFact = ancestor === undefined ? undefined : typeFact(ancestor, state);
        if (
          ancestor !== undefined &&
          ancestorFact !== undefined &&
          getJavaOverloadFacts(ancestor.filePath)?.types.some(
            (type) =>
              type.simpleName === name &&
              type.name !== ancestorFact.name &&
              javaRangeContains(ancestorFact.range, type.range),
          )
        )
          return UNKNOWN_JAVA_TYPE;
      }
    }
  }
  const explicit = facts.imports.filter(
    (item) => !item.static && !item.wildcard && item.name.split('.').at(-1) === name,
  );
  if (explicit.length > 0)
    return explicit.length === 1 ? qualifiedReference(explicit[0]!.name, state) : UNKNOWN_JAVA_TYPE;
  const inPackage = facts.packageName === '' ? name : `${facts.packageName}.${name}`;
  const local = sourceDefinitions(name, state).filter(
    (definition) => sourceQualifiedName(definition) === inPackage,
  );
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
  for (const item of facts.imports) {
    if (item.static || !item.wildcard) continue;
    const qualified = `${item.name}.${name}`;
    const candidates = sourceDefinitions(name, state).filter(
      (definition) => sourceQualifiedName(definition) === qualified,
    );
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
  let text = spelling
    .trim()
    .replace(/@[\w.]+(?:\([^()]*\))?\s*/g, '')
    .replaceAll(/\s+/g, '');
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
    if (
      !/^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(name) ||
      (open >= 0 && !text.endsWith('>'))
    )
      type = UNKNOWN_JAVA_TYPE;
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

function argumentType(fact: JavaArgumentFact, filePath: string, state: State): JavaType {
  return fact.kind === 'typed'
    ? parseType(fact.spelling, { filePath, at: fact.at }, state)
    : fact.kind === 'null'
      ? { kind: 'null' }
      : UNKNOWN_JAVA_TYPE;
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
  let elements = fact.arguments.map((argument) => argumentType(argument, filePath, state));
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
    const base = parseType(raw, { filePath: owner.filePath, at: fact.range }, state);
    if (base.kind !== 'reference') return false;
    if (base.sourceId === undefined) {
      if (base.name === 'java.lang.Object' && (!objectMethods.has(memberName) || objectCovered))
        continue;
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

function selectCallOverload(
  candidates: readonly JavaOverloadCandidate<SymbolDefinition>[],
  call: JavaOverloadCallFact,
  filePath: string,
  site: ReferenceSite,
  state: State,
) {
  return selectJavaOverload(
    candidates,
    call.arguments.length,
    (index, target, phase) => {
      const argument = call.arguments[index]!;
      return argument.kind === 'factory'
        ? factoryConversion(argument, target, filePath, site, state)
        : javaInvocationConversion(
            argumentType(argument, filePath, state),
            target,
            phase,
            state.relations,
          );
    },
    state.relations,
  );
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
  if (!inventory.complete)
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
  const decision = selectCallOverload(
    runnableReceiver
      ? inventory.normalized.filter(
          (candidate) => candidate.parameters.length === 0 && !candidate.variadic,
        )
      : inventory.normalized,
    call,
    filePath,
    site,
    state,
  );
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

export function resolveJavaReceiverCallSite(
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
): { readonly name: string; readonly range: Range } | undefined {
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  return filePath === undefined
    ? undefined
    : getJavaOverloadCall(filePath, site.atRange, site.name)?.receiverCall;
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
