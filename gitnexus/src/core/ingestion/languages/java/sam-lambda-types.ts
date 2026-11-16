import type {
  CaptureMatch,
  ParsedFile,
  Range,
  ReferenceSite,
  ScopeId,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
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
import { splitJavaTypeArguments } from './overload-types.js';
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';

/**
 * Implicitly typed lambda parameters typed by a workspace functional interface.
 *
 * Java gives `x` in `accept(x -> x.audit())` the type of the corresponding
 * parameter of the target's function type (JLS 15.27.3, 9.9). The target is
 * the parameter type of the method javac selects for the enclosing call, so the
 * fact is recorded at extraction as a call-result assignment on that call and
 * answered only from the exactly selected declaration. Every uncertain step
 * leaves the parameter unbound, which keeps it from borrowing an outer name.
 */

const LAMBDA_ROUTE = /^lambda:(\d+):(\d+):(\d+):(\d+)$/;
const SIMPLE_NAME = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const GENERIC_NAME = /^([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:<([\s\S]*)>)?$/u;
const COMMENTS = new Set(['line_comment', 'block_comment']);
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

/** The names an implicitly typed lambda declares (`x`, `(x, y)`, `(var x)`);
 * `undefined` for an explicitly typed or empty parameter list. */
function implicitParameterNames(lambda: SyntaxNode): SyntaxNode[] | undefined {
  const parameters = lambda.childForFieldName('parameters');
  if (parameters === null) return undefined;
  if (parameters.type === 'identifier') return [parameters];
  const names: SyntaxNode[] = [];
  for (const parameter of parameters.namedChildren) {
    if (COMMENTS.has(parameter.type)) continue;
    if (parameters.type === 'inferred_parameters' && parameter.type === 'identifier') {
      names.push(parameter);
      continue;
    }
    const name = parameter.childForFieldName('name');
    if (
      parameters.type !== 'formal_parameters' ||
      parameter.type !== 'formal_parameter' ||
      parameter.childForFieldName('type')?.text !== 'var' ||
      parameter.childForFieldName('dimensions') !== null ||
      name?.type !== 'identifier'
    )
      return undefined;
    names.push(name);
  }
  return names.length > 0 && new Set(names.map((name) => name.text)).size === names.length
    ? names
    : undefined;
}

/**
 * One call-result assignment per parameter of an implicitly typed lambda that
 * is a direct argument of a method invocation. The route records the
 * argument's position, the call's argument count and the lambda's arity; the
 * binding is anchored at the parameter, inside the lambda's own scope.
 */
export function synthesizeJavaSamLambdaCaptures(lambda: SyntaxNode): CaptureMatch[] {
  const argumentList = lambda.parent;
  const call = argumentList?.parent;
  if (
    argumentList?.type !== 'argument_list' ||
    call?.type !== 'method_invocation' ||
    call.childForFieldName('arguments')?.id !== argumentList.id
  )
    return [];
  const args = argumentList.namedChildren.filter((child) => !COMMENTS.has(child.type));
  const position = args.findIndex((child) => child.id === lambda.id);
  const names = implicitParameterNames(lambda);
  if (position < 0 || names === undefined) return [];
  return names.map((name, index) => ({
    '@call-result-assignment.call': nodeToCapture('@call-result-assignment.call', call),
    '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
    '@call-result-assignment.scope': nodeToCapture('@call-result-assignment.scope', name),
    '@call-result-assignment.element': {
      ...nodeToCapture('@call-result-assignment.element', lambda),
      text: `lambda:${position}:${args.length}:${index}:${names.length}`,
    },
  }));
}

interface AbstractMethod {
  readonly fact: JavaOverloadMethodFact;
  readonly declaring: SymbolDefinition;
  readonly declaringFact: JavaOverloadTypeFact;
  /** The declaring interface's body scope: its parameter types are read there. */
  readonly scope: ScopeId;
}

interface SamIndex {
  /** Each workspace type's body scope, by its definition id. */
  readonly classScopes: ReadonlyMap<string, ScopeId>;
  /** Per call with implicitly typed lambda arguments: each argument's lambda
   * arity, `undefined` for any other argument. */
  readonly lambdaCalls: ReadonlyMap<string, readonly (number | undefined)[]>;
  readonly abstractMethods: Map<string, readonly AbstractMethod[] | null>;
  readonly types: Map<string, SymbolDefinition | null>;
  readonly ownedMethods: Map<string, ReadonlyMap<string, readonly JavaOverloadMethodFact[]>>;
  readonly typeParameters: Map<string, ReadonlyMap<string, readonly Range[]>>;
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
  const lambdaCalls = new Map<string, (number | undefined)[]>();
  for (const parsed of parsedFiles) {
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
    classScopes,
    lambdaCalls,
    abstractMethods: new Map(),
    types: new Map(),
    ownedMethods: new Map(),
    typeParameters: new Map(),
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

function methodFact(definition: SymbolDefinition): JavaOverloadMethodFact | undefined {
  const at = definition.declarationRange;
  if (at === undefined) return undefined;
  const name = definition.nodeId
    .slice(definition.nodeId.lastIndexOf(':') + 1)
    .split('#')[0]!
    .split('.')
    .at(-1)!;
  return innermost(
    (getJavaOverloadFacts(definition.filePath)?.methods ?? []).filter(
      (method) => method.name === name,
    ),
    at,
  );
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
 * The single class-like workspace declaration a simple type name denotes from
 * `scope`. A type parameter, an ambiguous name, or a lookup that a capped
 * same-package sibling could still shadow answers nothing.
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
    const definitions = new Map<string, SymbolDefinition>();
    for (const binding of lookupNameClaim(scope, name, scopes, { purpose: 'type' }).bindings)
      if (isClassLike(binding.def.type)) definitions.set(binding.def.nodeId, binding.def);
    const [only] = definitions.values();
    found =
      definitions.size !== 1 ||
      only === undefined ||
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
function isObjectMethod(method: JavaOverloadMethodFact): boolean {
  const types = method.parameterTypes.map((type) => type.trim());
  return (
    ((method.name === 'hashCode' || method.name === 'toString') && types.length === 0) ||
    (method.name === 'equals' &&
      types.length === 1 &&
      (types[0] === 'Object' || types[0] === 'java.lang.Object'))
  );
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
      isObjectMethod(method) ||
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
  const target = GENERIC_NAME.exec(written.trim());
  if (target === null) return undefined;
  const functional = resolveType(scope, target[1]!, filePath, at, scopes, index);
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
 * parameter of the single abstract method of the workspace interface that
 * `callee` declares for parameter `i`, read where that interface was written.
 * A type parameter of the interface is substituted only by a plain class name
 * written as its type argument; raw, wildcard and nested uses answer nothing.
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
  const callScope = returned.declaredAtScope;
  const target = functionalTarget(
    fact.parameterTypes[argument] ?? '',
    callScope,
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
  const written = samTypes[parameter]?.trim() ?? '';
  if (!SIMPLE_NAME.test(written) || PRIMITIVES.has(written)) return undefined;
  const typeParameter = sam.declaringFact.typeParameters.indexOf(written);
  if (typeParameter < 0) {
    if (isTypeParameterAt(sam.declaring.filePath, written, sam.fact.range, index)) return undefined;
    return { rawName: written, declaredAtScope: sam.scope, source: 'assignment-inferred' };
  }
  // Substitution needs the argument written for the declaring interface itself.
  if (sam.declaring.nodeId !== functional.nodeId || target.typeArguments === undefined)
    return undefined;
  const typeArguments = splitJavaTypeArguments(target.typeArguments);
  const chosen = typeArguments?.[typeParameter]?.trim() ?? '';
  if (
    typeArguments?.length !== sam.declaringFact.typeParameters.length ||
    !SIMPLE_NAME.test(chosen) ||
    PRIMITIVES.has(chosen) ||
    isTypeParameterAt(callee.filePath, chosen, fact.range, index) ||
    bindsTypeParameter(callScope, chosen, scopes)
  )
    return undefined;
  return { rawName: chosen, declaredAtScope: callScope, source: 'assignment-inferred' };
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
  const scope =
    definition?.ownerId === undefined ? undefined : index.classScopes.get(definition.ownerId);
  if (definition === undefined || fact === undefined || scope === undefined) return 'unknown';
  if (fact.parameterTypes.length !== arities.length) return 'no';
  let verdict: 'yes' | 'unknown' = 'yes';
  for (let i = 0; i < arities.length; i++) {
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
  if (
    arities === undefined ||
    call === undefined ||
    call.arguments.length !== arities.length ||
    (call.receiverSpelling !== undefined && call.receiver?.kind !== 'typed')
  )
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
  if (
    selected === undefined ||
    (call.receiverSpelling === undefined &&
      call.staticContext &&
      methodFact(selected)?.modifiers.includes('static') !== true)
  )
    return decision;
  return { kind: 'resolved', definition: selected };
}
