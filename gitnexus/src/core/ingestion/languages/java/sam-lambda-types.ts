import type {
  CallResultAssignmentSite,
  ParsedFile,
  Range,
  ReferenceSite,
  ScopeId,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { ReceiverMemberResolution } from '../../scope-resolution/contract/scope-resolver.js';
import {
  bindsTypeParameter,
  isClassLike,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import {
  getJavaOverloadCall,
  getJavaOverloadFacts,
  javaRangeContains,
  type JavaOverloadMethodFact,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';
import { KNOWN_JAVA_PLATFORM_TYPES, splitJavaTypeArguments } from './overload-types.js';
import { javaContainerProofHolds } from './qualified-contextual-bindings.js';
import {
  inheritsJavaMemberTypeNamed,
  javaQualifiedTypeLookupSpelling,
} from './qualified-type-bindings.js';
import {
  JAVA_SAM_LAMBDA_FALLBACK,
  JAVA_SAM_LAMBDA_ROUTE as LAMBDA_ROUTE,
} from './sam-lambda-captures.js';
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';
import { JAVA_IDENTIFIER } from './type-spelling.js';
import { platformPackageHasType } from './platform-packages.js';

/**
 * Implicitly typed lambda parameters typed by a workspace functional interface.
 *
 * Java gives `x` in `accept(x -> x.audit())` the type of the corresponding
 * parameter of the target's function type (JLS 15.27.3, 9.9). The target is
 * the parameter type of the method javac selects for the enclosing call, so the
 * fact is recorded at extraction as a call-result assignment on that call
 * (`sam-lambda-captures.ts`) and answered here only from the exactly selected
 * declaration. Every uncertain step leaves the parameter unbound, which keeps
 * it from borrowing an outer name.
 */

const SIMPLE_NAME = new RegExp(`^${JAVA_IDENTIFIER}$`, 'u');
const QUALIFIED_NAME = new RegExp(`^${JAVA_IDENTIFIER}(?:\\.${JAVA_IDENTIFIER})+$`, 'u');
const TYPE_NAME = new RegExp(
  String.raw`^(${JAVA_IDENTIFIER}(?:\s*\.\s*${JAVA_IDENTIFIER})*)\s*(?:<([\s\S]*)>)?$`,
  'u',
);
const IDENTIFIERS = new RegExp(JAVA_IDENTIFIER, 'gu');
const PRIMITIVES = new Set([
  'boolean',
  'byte',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'void',
  'var',
]);

interface AbstractMethod {
  readonly fact: JavaOverloadMethodFact;
  readonly declaring: SymbolDefinition;
  readonly declaringFact: JavaOverloadTypeFact;
  /** The declaring interface's body scope: its parameter types are read there. */
  readonly scope: ScopeId;
}

interface SamIndex {
  readonly sourcePackages: ReadonlySet<string>;
  /** Each workspace type's body scope, by its definition id. */
  readonly classScopes: ReadonlyMap<string, ScopeId>;
  /** Per call with implicitly typed lambda arguments: each argument's lambda
   * arity, `undefined` for any other argument. */
  readonly lambdaCalls: ReadonlyMap<string, readonly (number | undefined)[]>;
  /** A simple type name a file's on-demand imports supply, per file and name. */
  readonly onDemand: Map<string, SymbolDefinition | null>;
  /** A type body's method scopes, by the method declaration's start. */
  readonly methodScopes: Map<ScopeId, ReadonlyMap<string, ScopeId>>;
  readonly abstractMethods: Map<string, readonly AbstractMethod[] | null>;
  readonly types: Map<string, SymbolDefinition | null>;
  readonly ownedMethods: Map<string, ReadonlyMap<string, readonly JavaOverloadMethodFact[]>>;
  readonly typeParameters: Map<string, ReadonlyMap<string, readonly Range[]>>;
  /** Each file's type imports and its own declared types, by simple name. */
  readonly files: Map<string, FileTypeNames>;
}

interface FileTypeNames {
  /** Single-type import canonical names, by simple name. */
  readonly single: ReadonlyMap<string, readonly string[]>;
  /** Packages imported on demand. */
  readonly onDemand: ReadonlySet<string>;
  /** Whether a static import may bring in a member type of a simple name:
   * every name for a static import on demand. */
  readonly staticNames: ReadonlySet<string>;
  readonly staticOnDemand: boolean;
  /** Types this file declares, by simple name, with where each is in scope. */
  readonly declared: ReadonlyMap<string, readonly Range[]>;
}

const samIndexes = new WeakMap<ScopeResolutionIndexes, SamIndex>();

const lambdaCallKey = (filePath: string, range: Range): string =>
  `${filePath}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;

/** Record type body scopes and lambda-argument calls once per resolution pass. */
export function indexJavaSamLambdaTargets(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const classScopes = new Map<string, ScopeId>();
  const sourcePackages = new Set<string>();
  const lambdaCalls = new Map<string, (number | undefined)[]>();
  for (const parsed of parsedFiles) {
    const pkg = packageOf(parsed.filePath);
    if (pkg !== undefined) sourcePackages.add(pkg);
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const owner = scope.ownedDefs.find((definition) => isClassLike(definition.type));
      if (owner !== undefined) classScopes.set(owner.nodeId, scope.id);
    }
    for (const site of parsed.callResultAssignmentSites ?? []) {
      const route = site.element === undefined ? null : LAMBDA_ROUTE.exec(site.element);
      if (route === null) continue;
      const [argument, argumentCount, , arity] = route.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
      ];
      const key = lambdaCallKey(parsed.filePath, site.callSite);
      let arities = lambdaCalls.get(key);
      if (arities === undefined)
        lambdaCalls.set(key, (arities = Array.from({ length: argumentCount }, () => undefined)));
      if (argument < arities.length) arities[argument] = arity;
    }
  }
  samIndexes.set(indexes, {
    sourcePackages,
    classScopes,
    lambdaCalls,
    onDemand: new Map(),
    methodScopes: new Map(),
    abstractMethods: new Map(),
    types: new Map(),
    ownedMethods: new Map(),
    typeParameters: new Map(),
    files: new Map(),
  });
}

function ownedMethods(
  filePath: string,
  index: SamIndex,
): ReadonlyMap<string, readonly JavaOverloadMethodFact[]> {
  let owned = index.ownedMethods.get(filePath);
  if (owned === undefined) {
    const byOwner = new Map<string, JavaOverloadMethodFact[]>();
    for (const method of getJavaOverloadFacts(filePath)?.methods ?? []) {
      const methods = byOwner.get(method.owner) ?? [];
      methods.push(method);
      byOwner.set(method.owner, methods);
    }
    index.ownedMethods.set(filePath, (owned = byOwner));
  }
  return owned;
}

/** Whether `name` is a type parameter of a declaration enclosing `at`. */
function isTypeParameterAt(filePath: string, name: string, at: Range, index: SamIndex): boolean {
  let byName = index.typeParameters.get(filePath);
  if (byName === undefined) {
    const ranges = new Map<string, Range[]>();
    const facts = getJavaOverloadFacts(filePath);
    for (const declaration of [...(facts?.types ?? []), ...(facts?.methods ?? [])])
      for (const parameter of declaration.typeParameters) {
        const list = ranges.get(parameter) ?? [];
        list.push(declaration.range);
        ranges.set(parameter, list);
      }
    index.typeParameters.set(filePath, (byName = ranges));
  }
  return byName.get(name)?.some((range) => javaRangeContains(range, at)) === true;
}

/** The innermost fact of `facts` whose range contains `at`. */
function innermost<T extends { readonly range: Range }>(
  facts: readonly T[],
  at: Range,
): T | undefined {
  let found: T | undefined;
  for (const fact of facts)
    if (
      javaRangeContains(fact.range, at) &&
      (found === undefined || javaRangeContains(found.range, fact.range))
    )
      found = fact;
  return found;
}

/** Each file's method facts by name, in file order, built once per facts
 * array so a lookup scans only the same-named methods. */
const methodsByName = new WeakMap<
  readonly JavaOverloadMethodFact[],
  ReadonlyMap<string, readonly JavaOverloadMethodFact[]>
>();

function methodsNamed(
  methods: readonly JavaOverloadMethodFact[],
  name: string,
): readonly JavaOverloadMethodFact[] {
  let byName = methodsByName.get(methods);
  if (byName === undefined) {
    const grouped = new Map<string, JavaOverloadMethodFact[]>();
    for (const method of methods) {
      const named = grouped.get(method.name);
      if (named === undefined) grouped.set(method.name, [method]);
      else named.push(method);
    }
    methodsByName.set(methods, (byName = grouped));
  }
  return byName.get(name) ?? [];
}

function methodFact(definition: SymbolDefinition): JavaOverloadMethodFact | undefined {
  const at = definition.declarationRange;
  if (at === undefined) return undefined;
  const methods = getJavaOverloadFacts(definition.filePath)?.methods;
  if (methods === undefined) return undefined;
  const name = definition.nodeId
    .slice(definition.nodeId.lastIndexOf(':') + 1)
    .split('#')[0]!
    .split('.')
    .at(-1)!;
  return innermost(methodsNamed(methods, name), at);
}

function interfaceFact(definition: SymbolDefinition): JavaOverloadTypeFact | undefined {
  const at = definition.declarationRange;
  if (at === undefined) return undefined;
  const fact = innermost(getJavaOverloadFacts(definition.filePath)?.types ?? [], at);
  return fact?.kind === 'interface_declaration' ? fact : undefined;
}

function packageOf(filePath: string): string | undefined {
  return getJavaOverloadFacts(filePath)?.packageName;
}

/**
 * The workspace top-level type a file's type-import-on-demand declarations
 * supply for `name` (JLS 7.5.2), reached only when no declaration, single-type
 * import or same-package type claims it (JLS 6.4.1). Two candidates are
 * ambiguous. Check each competing wildcard against the indexed source
 * packages and known platform types. An unknown package leaves the lookup open.
 */
function onDemandType(
  name: string,
  filePath: string,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): SymbolDefinition | undefined {
  const key = `${filePath}\0${name}`;
  let found = index.onDemand.get(key);
  if (found === undefined) {
    found = null;
    const imports = getJavaOverloadFacts(filePath)?.imports ?? [];
    const candidates = new Map<string, SymbolDefinition>();
    let decidable =
      !KNOWN_JAVA_PLATFORM_TYPES.has(`java.lang.${name}`) &&
      !imports.some(
        (item) => item.static && (item.wildcard || item.name.split('.').at(-1) === name),
      );
    for (const item of imports) {
      if (!decidable) break;
      if (item.static || !item.wildcard) continue;
      let supplied = false;
      for (const id of scopes.qualifiedNames.get(name)) {
        const definition = scopes.defs.get(id);
        if (
          definition !== undefined &&
          isClassLike(definition.type) &&
          definition.ownerId === undefined &&
          packageOf(definition.filePath) === item.name
        ) {
          candidates.set(definition.nodeId, definition);
          supplied = true;
        }
      }
      const platformType = platformPackageHasType(item.name, name);
      if (
        platformType === true ||
        (!supplied && platformType === undefined && !index.sourcePackages.has(item.name))
      )
        decidable = false;
    }
    const [only] = candidates.values();
    if (decidable && candidates.size === 1 && only !== undefined) found = only;
    index.onDemand.set(key, found);
  }
  return found ?? undefined;
}

/**
 * The single class-like workspace declaration a simple type name denotes from
 * `scope`: the scope chain's own claim, else the file's on-demand imports. A
 * type parameter, an inherited member type, an ambiguous name, a top-level
 * type a single-type import of another type shadows, or a lookup that a
 * capped same-package sibling could still shadow answers nothing.
 */
function resolveType(
  scope: ScopeId,
  name: string,
  filePath: string,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): SymbolDefinition | undefined {
  if (!SIMPLE_NAME.test(name) || PRIMITIVES.has(name)) return undefined;
  if (isTypeParameterAt(filePath, name, at, index) || bindsTypeParameter(scope, name, scopes))
    return undefined;
  const key = `${scope}\0${name}`;
  let found = index.types.get(key);
  if (found === undefined) {
    const claim = lookupNameClaim(scope, name, scopes, { purpose: 'type' });
    // A single-type import shadows a top-level type another file declares,
    // from the same package or an on-demand import, unless it imports that
    // very type (JLS 6.4.1).
    const imported = fileTypeNames(filePath, index).single.get(name);
    const shadowed = (definition: SymbolDefinition): boolean =>
      imported !== undefined &&
      definition.ownerId === undefined &&
      definition.filePath !== filePath &&
      !imported.includes(`${packageOf(definition.filePath)}.${name}`);
    const definitions = new Map<string, SymbolDefinition>();
    for (const binding of claim.bindings)
      if (isClassLike(binding.def.type) && !shadowed(binding.def))
        definitions.set(binding.def.nodeId, binding.def);
    const [claimed] = definitions.values();
    const only = claim.status === 'absent' ? onDemandType(name, filePath, scopes, index) : claimed;
    found =
      (claim.status !== 'absent' && definitions.size !== 1) ||
      only === undefined ||
      shadowed(only) ||
      inheritsJavaMemberTypeNamed(scope, name, scopes) ||
      (isJavaPackageSiblingVisibilityIncomplete(filePath) &&
        hasJavaSamePackageType(filePath, name) !== false &&
        packageOf(only.filePath) !== packageOf(filePath))
        ? null
        : only;
    index.types.set(key, found);
  }
  return found ?? undefined;
}

/** Object's public methods do not count toward a functional interface (JLS 9.8). */
function isObjectMethod(
  method: JavaOverloadMethodFact,
  scope: ScopeId,
  filePath: string,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): boolean {
  if (method.name === 'hashCode' || method.name === 'toString')
    return method.parameterTypes.length === 0;
  if (method.name !== 'equals' || method.parameterTypes.length !== 1) return false;
  const name = compact(method.parameterTypes[0]!);
  if (name !== 'Object' && name !== 'java.lang.Object') return false;
  return provesJdkType(name, 'java.lang.Object', scope, filePath, method.range, scopes, index);
}

/**
 * Every abstract method a workspace interface has, declared or inherited from
 * workspace superinterfaces written without type arguments. `null` when the
 * set cannot be proven: an external, generic or unresolved superinterface, a
 * cycle, or a declared method that may override an inherited abstract one.
 */
function abstractMethodsOf(
  definition: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
  visiting: Set<string> = new Set(),
): readonly AbstractMethod[] | null {
  const cached = index.abstractMethods.get(definition.nodeId);
  if (cached !== undefined) return cached;
  if (visiting.has(definition.nodeId) || visiting.size >= 32) return null;
  visiting.add(definition.nodeId);
  const result = collectAbstractMethods(definition, scopes, index, visiting);
  visiting.delete(definition.nodeId);
  index.abstractMethods.set(definition.nodeId, result);
  return result;
}

function collectAbstractMethods(
  definition: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
  visiting: Set<string>,
): readonly AbstractMethod[] | null {
  const fact = interfaceFact(definition);
  const scope = index.classScopes.get(definition.nodeId);
  if (fact === undefined || scope === undefined) return null;
  const declared = ownedMethods(definition.filePath, index).get(fact.name) ?? [];
  const methods = new Map<string, AbstractMethod>();
  for (const method of declared) {
    if (
      isObjectMethod(method, scope, definition.filePath, scopes, index) ||
      method.modifiers.some((flag) => flag === 'default' || flag === 'static' || flag === 'private')
    )
      continue;
    methods.set(`${definition.filePath}:${method.range.startLine}:${method.range.startCol}`, {
      fact: method,
      declaring: definition,
      declaringFact: fact,
      scope,
    });
  }
  const outer = scopes.scopeTree.getScope(scope)?.parent ?? null;
  const ancestors = new Set(scopes.methodDispatch.mroFor(definition.nodeId));
  for (const written of fact.bases) {
    const base = written.trim();
    if (outer === null || !SIMPLE_NAME.test(base)) return null;
    const baseDefinition = resolveType(outer, base, definition.filePath, fact.range, scopes, index);
    if (baseDefinition?.type !== 'Interface' || !ancestors.has(baseDefinition.nodeId)) return null;
    const inherited = abstractMethodsOf(baseDefinition, scopes, index, visiting);
    if (inherited === null) return null;
    for (const method of inherited) {
      if (
        declared.some(
          (own) =>
            own.name === method.fact.name &&
            own.parameterTypes.length === method.fact.parameterTypes.length,
        )
      )
        return null;
      methods.set(
        `${method.declaring.filePath}:${method.fact.range.startLine}:${method.fact.range.startCol}`,
        method,
      );
    }
  }
  return [...methods.values()];
}

/** The scope of the method declared in type body `classScope` at `at`. */
function methodScope(
  classScope: ScopeId,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): ScopeId | undefined {
  let byStart = index.methodScopes.get(classScope);
  if (byStart === undefined) {
    const starts = new Map<string, ScopeId>();
    for (const child of scopes.scopeTree.getChildren(classScope)) {
      const scope = scopes.scopeTree.getScope(child);
      if (scope?.kind === 'Function')
        starts.set(`${scope.range.startLine}:${scope.range.startCol}`, scope.id);
    }
    index.methodScopes.set(classScope, (byStart = starts));
  }
  return byStart.get(`${at.startLine}:${at.startCol}`);
}

const compact = (spelling: string): string => spelling.replace(/\s+/g, '');

/** The declared type a method scope records for a parameter written `spelling`.
 * Parameters written alike in one declaration denote the same type. */
function parameterRef(
  scope: ScopeId,
  spelling: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  const written = compact(spelling);
  for (const ref of scopes.scopeTree.getScope(scope)?.typeBindings.values() ?? [])
    if (
      ref.source === 'parameter-annotation' &&
      compact(ref.declaredSpelling ?? ref.rawName) === written
    )
      return ref;
  return undefined;
}

/** The workspace type a method parameter's written type names, read in that
 * method's scope. A qualified spelling takes the provider's qualified lookup
 * for the parameter's own declared type, never its simple name. */
function parameterType(
  written: string,
  name: string,
  scope: ScopeId,
  filePath: string,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): SymbolDefinition | undefined {
  if (!name.includes('.')) return resolveType(scope, name, filePath, at, scopes, index);
  const ref = parameterRef(scope, written, scopes);
  const key = ref === undefined ? undefined : javaQualifiedTypeLookupSpelling(ref, scopes);
  if (typeof key !== 'string') return undefined;
  let module = scopes.scopeTree.getScope(scope);
  while (module !== undefined && module.kind !== 'Module')
    module = module.parent === null ? undefined : scopes.scopeTree.getScope(module.parent);
  const bindings =
    module === undefined ? undefined : scopes.bindingAugmentations.get(module.id)?.get(key);
  const definition = bindings?.length === 1 ? bindings[0]!.def : undefined;
  return definition !== undefined && isClassLike(definition.type) ? definition : undefined;
}

/** What a written parameter type offers an implicitly typed lambda. `sam`:
 * a workspace functional interface; `none`: a workspace type proven not to be
 * one; `undefined`: anything this provider cannot decide. */
type FunctionalTarget =
  | {
      readonly kind: 'sam';
      readonly functional: SymbolDefinition;
      readonly sam: AbstractMethod;
      /** The type arguments as written, without the angle brackets. */
      readonly typeArguments: string | undefined;
    }
  | { readonly kind: 'none' };

function functionalTarget(
  written: string,
  scope: ScopeId,
  filePath: string,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): FunctionalTarget | undefined {
  const target = TYPE_NAME.exec(written.trim());
  if (target === null) return undefined;
  const functional = parameterType(
    written,
    compact(target[1]!),
    scope,
    filePath,
    at,
    scopes,
    index,
  );
  if (functional === undefined) return undefined;
  if (functional.type !== 'Interface') return { kind: 'none' };
  const methods = abstractMethodsOf(functional, scopes, index);
  if (methods === null) return undefined;
  if (methods.length === 1)
    return { kind: 'sam', functional, sam: methods[0]!, typeArguments: target[2] };
  // Several abstract methods may still share one signature (JLS 9.8); only
  // distinct names prove the interface is not functional.
  return methods.length === 0 ||
    new Set(methods.map((method) => method.fact.name)).size === methods.length
    ? { kind: 'none' }
    : undefined;
}

/**
 * JDK functional interfaces (`java.util.function`), by canonical name: the
 * number of type arguments each takes, and for each parameter of its single
 * abstract method the type argument that parameter has, or `null` for a
 * primitive one. `UnaryOperator<T>` and `BinaryOperator<T>` take `apply` from
 * `Function<T,T>` and `BiFunction<T,T,T>`.
 */
interface JdkFunctionalInterface {
  readonly typeArguments: number;
  readonly parameters: readonly (number | null)[];
}

const JDK_FUNCTION_PACKAGE = 'java.util.function';
const JDK_FUNCTIONAL_INTERFACES: ReadonlyMap<string, JdkFunctionalInterface> = new Map(
  (
    [
      ['Consumer', 1, [0]],
      ['BiConsumer', 2, [0, 1]],
      ['Function', 2, [0]],
      ['BiFunction', 3, [0, 1]],
      ['Predicate', 1, [0]],
      ['BiPredicate', 2, [0, 1]],
      ['UnaryOperator', 1, [0]],
      ['BinaryOperator', 1, [0, 0]],
      ['ToIntFunction', 1, [0]],
      ['ToLongFunction', 1, [0]],
      ['ToDoubleFunction', 1, [0]],
      ['ObjIntConsumer', 1, [0, null]],
      ['ObjLongConsumer', 1, [0, null]],
      ['ObjDoubleConsumer', 1, [0, null]],
    ] as const
  ).map(([name, typeArguments, parameters]) => [
    `${JDK_FUNCTION_PACKAGE}.${name}`,
    { typeArguments, parameters },
  ]),
);

/** A file's type imports and declared type names, indexed once per file. */
function fileTypeNames(filePath: string, index: SamIndex): FileTypeNames {
  let names = index.files.get(filePath);
  if (names === undefined) {
    const facts = getJavaOverloadFacts(filePath);
    const single = new Map<string, string[]>();
    const onDemand = new Set<string>();
    const staticNames = new Set<string>();
    let staticOnDemand = false;
    for (const item of facts?.imports ?? []) {
      const simple = item.name.split('.').at(-1) ?? '';
      if (item.static) {
        if (item.wildcard) staticOnDemand = true;
        else staticNames.add(simple);
      } else if (item.wildcard) onDemand.add(item.name);
      else {
        const names = single.get(simple);
        if (names === undefined) single.set(simple, [item.name]);
        else names.push(item.name);
      }
    }
    const declared = new Map<string, Range[]>();
    for (const type of facts?.types ?? []) {
      const visible = declared.get(type.simpleName);
      if (visible === undefined) declared.set(type.simpleName, [type.visible]);
      else visible.push(type.visible);
    }
    index.files.set(
      filePath,
      (names = { single, onDemand, staticNames, staticOnDemand, declared }),
    );
  }
  return names;
}

/**
 * The JDK functional interface a parameter type written `name` (erased)
 * denotes in `scope`, the callee's own method scope, at `at`. The name must
 * be proven to denote the JDK type there, by the proofs a JDK container
 * spelling takes (`javaContainerProofHolds`): a canonical
 * `java.util.function.X` whose `java` root no type obscures; a single-type
 * import of it; or a `java.util.function.*` import with no type of that
 * simple name declared in the workspace and visible here, no single-type or
 * static import of it, no type parameter and no inherited member type
 * (JLS 6.4.1, 7.5). A type of this file in scope here shadows any import.
 */
function jdkFunctionalInterface(
  name: string,
  scope: ScopeId,
  filePath: string,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): JdkFunctionalInterface | undefined {
  const canonical = name.includes('.') ? name : `${JDK_FUNCTION_PACKAGE}.${name}`;
  const known = JDK_FUNCTIONAL_INTERFACES.get(canonical);
  return known !== undefined && provesJdkType(name, canonical, scope, filePath, at, scopes, index)
    ? known
    : undefined;
}

/** Prove the identity of a JDK type at the declaration that uses it. */
function provesJdkType(
  name: string,
  canonical: string,
  scope: ScopeId,
  filePath: string,
  at: Range,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): boolean {
  const position = { startLine: at.startLine, startCol: at.startCol };
  const root = name.includes('.') ? 'java' : name;
  if (isTypeParameterAt(filePath, root, at, index)) return false;
  const names = fileTypeNames(filePath, index);
  if (names.declared.get(root)?.some((visible) => javaRangeContains(visible, at))) return false;
  const single = names.single.get(root);
  if (name.includes('.'))
    return (
      name === canonical &&
      single === undefined &&
      !names.staticNames.has(root) &&
      javaContainerProofHolds({ kind: 'root', name: root, scope }, filePath, position, scopes)
    );
  if (single !== undefined)
    return (
      single.every((written) => written === canonical) &&
      !names.staticNames.has(name) &&
      javaContainerProofHolds({ kind: 'single', name, scope }, filePath, position, scopes)
    );
  if (names.staticOnDemand || names.staticNames.has(name)) return false;
  const pkg = canonical.slice(0, canonical.lastIndexOf('.'));
  if (pkg !== 'java.lang' && !names.onDemand.has(pkg)) return false;
  for (const imported of names.onDemand) {
    if (imported === pkg) continue;
    const platformType = platformPackageHasType(imported, name);
    if (
      platformType === true ||
      (platformType === undefined && !index.sourcePackages.has(imported))
    )
      return false;
    if (
      scopes.qualifiedNames.get(name).some((id) => {
        const def = scopes.defs.get(id);
        return (
          def !== undefined &&
          def.ownerId === undefined &&
          isClassLike(def.type) &&
          packageOf(def.filePath) === imported
        );
      })
    )
      return false;
  }
  return javaContainerProofHolds({ kind: 'on-demand', name, scope }, filePath, position, scopes);
}

/** A non-generic, fixed-arity method's written parameter types. */
function fixedParameters(definition: SymbolDefinition): JavaOverloadMethodFact | undefined {
  if (definition.type !== 'Method' || definition.isSynthetic === true) return undefined;
  const fact = methodFact(definition);
  return fact === undefined ||
    fact.typeParameters.length > 0 ||
    fact.parameterTypes.at(-1) === 'varargs'
    ? undefined
    : fact;
}

/**
 * The type of parameter `j` of an implicitly typed lambda passed as argument
 * `i` of a call whose exactly selected declaration is `callee`: the `j`-th
 * parameter of the single abstract method of the functional interface that
 * `callee` declares for parameter `i`. For a workspace interface it is read
 * where that interface was written; for a proven JDK `java.util.function`
 * interface it is the type argument that parameter takes. A type parameter
 * is substituted only by a plain class name written as its type argument;
 * raw, wildcard and nested uses answer nothing.
 */
export function javaSamLambdaParameterType(
  callee: SymbolDefinition,
  returned: TypeRef,
  route: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  const match = LAMBDA_ROUTE.exec(route);
  const index = samIndexes.get(scopes);
  if (match === null || index === undefined) return undefined;
  const [argument, argumentCount, parameter, arity] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const fact = fixedParameters(callee);
  if (fact === undefined || fact.parameterTypes.length !== argumentCount) return undefined;
  // `returned` is the selected callee's own declared return type, so its scope
  // is where the callee's parameter types (and their type arguments) were
  // written, never the scope of the call.
  const calleeScope = returned.declaredAtScope;
  const writtenTarget = fact.parameterTypes[argument] ?? '';
  const shape = TYPE_NAME.exec(writtenTarget.trim());
  // A single-type import of the JDK name shadows a same-package or on-demand
  // workspace type of that name (JLS 6.4.1). Any type that could shadow the
  // JDK name refutes its proof, and the workspace reading below applies.
  const jdk =
    shape === null
      ? undefined
      : jdkFunctionalInterface(
          compact(shape[1]!),
          calleeScope,
          callee.filePath,
          fact.range,
          scopes,
          index,
        );
  if (jdk !== undefined) {
    const chosen = jdk.parameters.length === arity ? jdk.parameters[parameter] : undefined;
    const typeArguments = shape?.[2] === undefined ? undefined : splitJavaTypeArguments(shape[2]);
    return chosen == null || typeArguments?.length !== jdk.typeArguments
      ? undefined
      : plainTypeArgument(typeArguments[chosen], callee, fact, calleeScope, scopes, index);
  }
  const target = functionalTarget(
    writtenTarget,
    calleeScope,
    callee.filePath,
    fact.range,
    scopes,
    index,
  );
  if (target?.kind !== 'sam') return undefined;
  const { functional, sam } = target;
  const samTypes = sam.fact.parameterTypes;
  if (
    sam.fact.typeParameters.length > 0 ||
    samTypes.at(-1) === 'varargs' ||
    samTypes.length !== arity
  )
    return undefined;
  const written = compact(samTypes[parameter] ?? '');
  if (written.length === 0 || PRIMITIVES.has(written)) return undefined;
  const typeParameter = sam.declaringFact.typeParameters.indexOf(written);
  if (typeParameter < 0) {
    // The parameter has the abstract method's own declared parameter type:
    // the same binding, read where it was written. A type variable anywhere
    // in it would need a substitution this does not make.
    if (
      (written.match(IDENTIFIERS) ?? []).some(
        (name) =>
          sam.declaringFact.typeParameters.includes(name) ||
          isTypeParameterAt(sam.declaring.filePath, name, sam.fact.range, index),
      )
    )
      return undefined;
    const samScope = methodScope(sam.scope, sam.fact.range, scopes, index);
    const declared = samScope === undefined ? undefined : parameterRef(samScope, written, scopes);
    if (declared === undefined)
      return SIMPLE_NAME.test(written)
        ? { rawName: written, declaredAtScope: sam.scope, source: 'assignment-inferred' }
        : undefined;
    return {
      rawName: declared.rawName,
      ...(declared.declaredSpelling === undefined
        ? {}
        : { declaredSpelling: declared.declaredSpelling }),
      declaredAtScope: declared.declaredAtScope,
      ...(declared.lookupPosition === undefined ? {} : { lookupPosition: declared.lookupPosition }),
      source: 'assignment-inferred',
    };
  }
  // Substitution needs the argument written for the declaring interface itself.
  if (sam.declaring.nodeId !== functional.nodeId || target.typeArguments === undefined)
    return undefined;
  const typeArguments = splitJavaTypeArguments(target.typeArguments);
  return typeArguments?.length === sam.declaringFact.typeParameters.length
    ? plainTypeArgument(typeArguments[typeParameter], callee, fact, calleeScope, scopes, index)
    : undefined;
}

/** Read a simple or qualified class name from the callee's functional
 * parameter, including the ground target type of a bounded wildcard. */
function plainTypeArgument(
  written: string | undefined,
  callee: SymbolDefinition,
  fact: JavaOverloadMethodFact,
  calleeScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): TypeRef | undefined {
  // JLS 9.9 and 15.27.3 ground an implicitly typed lambda against the
  // non-wildcard parameterization of its target functional interface.
  const chosen = written?.trim().replace(/^\?\s+(?:super|extends)\s+/, '') ?? '';
  // A qualified class name (`app.Other`) is looked up as written, where it was
  // written: `populateJavaQualifiedTypeBindings` registers its key there.
  const qualified = chosen.replaceAll(/\s+/g, '');
  if (QUALIFIED_NAME.test(qualified))
    return {
      rawName: qualified.slice(qualified.lastIndexOf('.') + 1),
      declaredSpelling: qualified,
      declaredAtScope: calleeScope,
      source: 'assignment-inferred',
    };
  return !SIMPLE_NAME.test(chosen) ||
    PRIMITIVES.has(chosen) ||
    isTypeParameterAt(callee.filePath, chosen, fact.range, index) ||
    bindsTypeParameter(calleeScope, chosen, scopes)
    ? undefined
    : { rawName: chosen, declaredAtScope: calleeScope, source: 'assignment-inferred' };
}

/**
 * Whether a lambda parameter's call-result site takes part in resolution. A
 * fallback route belongs to a lambda that capture also typed through a JDK
 * container reading (or a supertype field) of the call's receiver. It stands
 * only where `validateJavaQualifiedContextualBindings` removed that binding:
 * the receiver is then a workspace type whose selected method declares the
 * lambda's target type. A binding that survived keeps the parameter, and the
 * call's method is not a workspace declaration that could answer instead.
 */
export function javaCallResultAssignmentApplies(
  site: CallResultAssignmentSite,
  scopes: ScopeResolutionIndexes,
): boolean {
  return (
    site.element?.endsWith(JAVA_SAM_LAMBDA_FALLBACK) !== true ||
    scopes.scopeTree.getScope(site.inScope)?.typeBindings.has(site.lhs) !== true
  );
}

/** Whether `definition` is potentially applicable (JLS 15.12.2.1) to a call
 * whose arguments are all implicitly typed lambdas of these arities. */
function lambdaApplicable(
  definition: SymbolDefinition | undefined,
  arities: readonly number[],
  scopes: ScopeResolutionIndexes,
  index: SamIndex,
): 'yes' | 'no' | 'unknown' {
  const fact = definition === undefined ? undefined : fixedParameters(definition);
  const owner =
    definition?.ownerId === undefined ? undefined : index.classScopes.get(definition.ownerId);
  const scope =
    owner === undefined || fact === undefined
      ? undefined
      : methodScope(owner, fact.range, scopes, index);
  if (definition === undefined || fact === undefined || scope === undefined) return 'unknown';
  if (fact.parameterTypes.length !== arities.length) return 'no';
  let verdict: 'yes' | 'unknown' = 'yes';
  for (let i = 0; i < arities.length; i++) {
    const shape = TYPE_NAME.exec(fact.parameterTypes[i]!.trim());
    const jdk =
      shape &&
      jdkFunctionalInterface(
        compact(shape[1]!),
        scope,
        definition.filePath,
        fact.range,
        scopes,
        index,
      );
    if (jdk) {
      if (jdk.parameters.length !== arities[i]) return 'no';
      continue;
    }
    const target = functionalTarget(
      fact.parameterTypes[i]!,
      scope,
      definition.filePath,
      fact.range,
      scopes,
      index,
    );
    if (target?.kind === 'none') return 'no';
    const sam = target?.sam.fact;
    if (sam !== undefined && sam.parameterTypes.at(-1) !== 'varargs') {
      if (sam.parameterTypes.length !== arities[i]) return 'no';
      if (sam.typeParameters.length === 0) continue;
    }
    verdict = 'unknown';
  }
  return verdict;
}

/**
 * An implicitly typed lambda is not pertinent to applicability (JLS 15.12.2.2),
 * so a call whose every argument is one is decided by potential applicability
 * alone (JLS 15.12.2.1): the arity, and for each lambda a workspace functional
 * interface whose single abstract method has the lambda's arity. This refines
 * only an `unknown` answer over a complete candidate set, and only to the one
 * candidate that remains when every other is proven inapplicable. A free call
 * from a static context still needs a static method; a receiver must be a
 * value of a written type.
 */
export function selectJavaLambdaOverload(
  decision: ReceiverMemberResolution | undefined,
  site: ReferenceSite,
  scopes: ScopeResolutionIndexes,
): ReceiverMemberResolution | undefined {
  if (decision?.kind !== 'unknown' || decision.candidateSetComplete !== true) return decision;
  const index = samIndexes.get(scopes);
  const filePath = scopes.scopeTree.getScope(site.inScope)?.filePath;
  if (index === undefined || filePath === undefined) return decision;
  const arities = index.lambdaCalls.get(lambdaCallKey(filePath, site.atRange));
  const call = getJavaOverloadCall(filePath, site.atRange, site.name);
  if (arities === undefined || call === undefined || call.arguments.length !== arities.length)
    return decision;
  const lambdas: number[] = [];
  for (const arity of arities) {
    if (arity === undefined) return decision;
    lambdas.push(arity);
  }
  let selected: SymbolDefinition | undefined;
  for (const id of new Set(decision.candidateIds)) {
    const definition = scopes.defs.get(id);
    const verdict = lambdaApplicable(definition, lambdas, scopes, index);
    if (verdict === 'no') continue;
    if (verdict === 'unknown' || selected !== undefined) return decision;
    selected = definition;
  }
  if (selected === undefined)
    return {
      kind: 'inapplicable',
      candidateIds: decision.candidateIds,
      candidateSetComplete: true,
    };
  if (
    call.receiverSpelling === undefined &&
    call.staticContext &&
    methodFact(selected)?.modifiers.includes('static') !== true
  )
    return decision;
  return { kind: 'resolved', definition: selected };
}
