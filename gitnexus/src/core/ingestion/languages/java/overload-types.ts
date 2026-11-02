/** Java method-invocation conversions (JLS 5.3) and the phase ordering and
 * specificity rules of JLS 15.12.2. Unknown evidence is never a conversion. */
export type JavaVerdict = 'yes' | 'no' | 'unknown';
export type JavaPrimitive =
  | 'boolean'
  | 'byte'
  | 'short'
  | 'char'
  | 'int'
  | 'long'
  | 'float'
  | 'double';
export type JavaType =
  | { readonly kind: 'primitive'; readonly name: JavaPrimitive }
  | {
      readonly kind: 'reference';
      readonly name: string;
      readonly arguments: readonly JavaType[];
      readonly sourceId?: string;
    }
  | { readonly kind: 'array'; readonly component: JavaType }
  | { readonly kind: 'null' }
  | { readonly kind: 'unknown' };

export type JavaReferenceType = Extract<JavaType, { kind: 'reference' }>;
export type JavaInvocationPhase = 'strict' | 'loose' | 'variable';
export interface JavaTypeRelations {
  readonly sourceSubtype: (from: JavaReferenceType, to: JavaReferenceType) => JavaVerdict;
}

export interface JavaOverloadCandidate<T> {
  readonly definition: T;
  /** A variadic declaration's final entry is its ARRAY type. */
  readonly parameters: readonly JavaType[];
  readonly variadic: boolean;
  readonly unsupportedGeneric?: boolean;
}

export type JavaOverloadDecision<T> =
  | { readonly kind: 'resolved'; readonly definition: T; readonly phase: JavaInvocationPhase }
  | { readonly kind: 'ambiguous' | 'unknown' | 'inapplicable'; readonly candidates: readonly T[] };

export const UNKNOWN_JAVA_TYPE: JavaType = { kind: 'unknown' };
export const MAX_JAVA_TYPE_DEPTH = 32;
export const JAVA_PRIMITIVES = new Set<JavaPrimitive>([
  'boolean',
  'byte',
  'short',
  'char',
  'int',
  'long',
  'float',
  'double',
]);

const widening: Readonly<Record<JavaPrimitive, readonly JavaPrimitive[]>> = {
  boolean: [],
  byte: ['short', 'int', 'long', 'float', 'double'],
  short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'],
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
  double: [],
};
const boxes: Readonly<Record<JavaPrimitive, string>> = {
  boolean: 'java.lang.Boolean',
  byte: 'java.lang.Byte',
  short: 'java.lang.Short',
  char: 'java.lang.Character',
  int: 'java.lang.Integer',
  long: 'java.lang.Long',
  float: 'java.lang.Float',
  double: 'java.lang.Double',
};
const unboxes = new Map(
  Object.entries(boxes).map(([primitive, box]) => [box, primitive as JavaPrimitive]),
);

/** These summaries are only used after a provider proves qualified JDK type
 * identity. Collection edges preserve their invariant element arguments. */
const jdkParents: Readonly<Record<string, readonly string[]>> = {
  'java.lang.Object': [],
  'java.lang.String': ['java.lang.Object', 'java.lang.CharSequence', 'java.io.Serializable'],
  'java.lang.Number': ['java.lang.Object', 'java.io.Serializable'],
  'java.lang.Byte': ['java.lang.Number'],
  'java.lang.Short': ['java.lang.Number'],
  'java.lang.Integer': ['java.lang.Number'],
  'java.lang.Long': ['java.lang.Number'],
  'java.lang.Float': ['java.lang.Number'],
  'java.lang.Double': ['java.lang.Number'],
  'java.lang.Boolean': ['java.lang.Object', 'java.io.Serializable'],
  'java.lang.Character': ['java.lang.Object', 'java.io.Serializable'],
  'java.lang.CharSequence': ['java.lang.Object'],
  'java.lang.Cloneable': ['java.lang.Object'],
  'java.io.Serializable': ['java.lang.Object'],
  'java.lang.Iterable': ['java.lang.Object'],
  'java.lang.Runnable': ['java.lang.Object'],
  'java.util.Collection': ['java.lang.Iterable'],
  'java.util.List': ['java.util.Collection'],
  'java.util.Set': ['java.util.Collection'],
  'java.util.ArrayList': ['java.util.List', 'java.lang.Cloneable', 'java.io.Serializable'],
  'java.util.LinkedList': ['java.util.List', 'java.lang.Cloneable', 'java.io.Serializable'],
  'java.util.HashSet': ['java.util.Set', 'java.lang.Cloneable', 'java.io.Serializable'],
  'java.util.Map': ['java.lang.Object'],
  'java.util.HashMap': ['java.util.Map', 'java.lang.Cloneable', 'java.io.Serializable'],
};
const parameterizedJdk = new Set([
  'java.lang.Iterable',
  'java.util.Collection',
  'java.util.List',
  'java.util.Set',
  'java.util.ArrayList',
  'java.util.LinkedList',
  'java.util.HashSet',
  'java.util.Map',
  'java.util.HashMap',
]);
const finalJdk = new Set(['java.lang.String', ...Object.values(boxes)]);
export const KNOWN_JAVA_PLATFORM_TYPES = new Set([
  ...Object.keys(jdkParents),
  'java.util.Arrays',
  'java.util.Collections',
]);

function all(verdicts: readonly JavaVerdict[]): JavaVerdict {
  return verdicts.includes('no') ? 'no' : verdicts.includes('unknown') ? 'unknown' : 'yes';
}

export function sameJavaType(left: JavaType, right: JavaType, depth = 0): JavaVerdict {
  if (depth >= MAX_JAVA_TYPE_DEPTH) return 'unknown';
  if (left.kind === 'unknown' || right.kind === 'unknown') return 'unknown';
  if (left.kind !== right.kind) return 'no';
  if (left.kind === 'null') return 'yes';
  if (left.kind === 'primitive' && right.kind === 'primitive')
    return left.name === right.name ? 'yes' : 'no';
  if (left.kind === 'array' && right.kind === 'array')
    return sameJavaType(left.component, right.component, depth + 1);
  if (left.kind === 'reference' && right.kind === 'reference') {
    if (left.name !== right.name || left.sourceId !== right.sourceId) return 'no';
    if (left.arguments.length !== right.arguments.length) return 'unknown';
    return all(
      left.arguments.map((argument, i) => sameJavaType(argument, right.arguments[i]!, depth + 1)),
    );
  }
  return 'no';
}

export function javaSubtype(
  from: JavaType,
  to: JavaType,
  relations: JavaTypeRelations,
  depth = 0,
): JavaVerdict {
  if (depth >= MAX_JAVA_TYPE_DEPTH) return 'unknown';
  if (from.kind === 'unknown' || to.kind === 'unknown') return 'unknown';
  if (sameJavaType(from, to, depth) === 'yes') return 'yes';
  if (from.kind === 'null') return to.kind === 'reference' || to.kind === 'array' ? 'yes' : 'no';
  if (from.kind === 'primitive' || to.kind === 'primitive') {
    return from.kind === 'primitive' &&
      to.kind === 'primitive' &&
      widening[from.name].includes(to.name)
      ? 'yes'
      : 'no';
  }
  if (from.kind === 'array') {
    if (to.kind === 'reference')
      return ['java.lang.Object', 'java.lang.Cloneable', 'java.io.Serializable'].includes(
        to.name,
      ) && to.sourceId === undefined
        ? 'yes'
        : 'no';
    if (to.kind !== 'array') return 'no';
    if (from.component.kind === 'primitive' || to.component.kind === 'primitive')
      return sameJavaType(from.component, to.component, depth + 1);
    return javaSubtype(from.component, to.component, relations, depth + 1);
  }
  if (from.kind !== 'reference' || to.kind !== 'reference') return 'no';
  if (to.name === 'java.lang.Object' && to.sourceId === undefined) return 'yes';
  if (from.name === to.name && from.sourceId === to.sourceId) {
    // Raw/unchecked conversions are deliberately not approximated by erasure.
    if (from.arguments.length !== to.arguments.length) return 'unknown';
    return all(
      from.arguments.map((argument, i) => sameJavaType(argument, to.arguments[i]!, depth + 1)),
    );
  }
  if (to.sourceId === undefined && finalJdk.has(to.name)) return 'no';
  if (from.sourceId !== undefined || to.sourceId !== undefined)
    return relations.sourceSubtype(from, to);
  const parents = Object.hasOwn(jdkParents, from.name) ? jdkParents[from.name] : undefined;
  if (parents === undefined) return 'unknown';
  let uncertain = false;
  for (const parent of parents) {
    const result = javaSubtype(
      {
        kind: 'reference',
        name: parent,
        arguments: parameterizedJdk.has(parent) ? from.arguments : [],
      },
      to,
      relations,
      depth + 1,
    );
    if (result === 'yes') return 'yes';
    if (result === 'unknown') uncertain = true;
  }
  return uncertain || !Object.hasOwn(jdkParents, to.name) ? 'unknown' : 'no';
}

export function javaInvocationConversion(
  from: JavaType,
  to: JavaType,
  phase: JavaInvocationPhase,
  relations: JavaTypeRelations,
): JavaVerdict {
  const strict = javaSubtype(from, to, relations);
  if (phase === 'strict' || strict !== 'no') return strict;
  if (from.kind === 'primitive' && to.kind === 'reference') {
    return javaSubtype({ kind: 'reference', name: boxes[from.name], arguments: [] }, to, relations);
  }
  if (from.kind === 'reference' && to.kind === 'primitive') {
    const primitive = from.sourceId === undefined ? unboxes.get(from.name) : undefined;
    return primitive === undefined
      ? 'no'
      : javaSubtype({ kind: 'primitive', name: primitive }, to, relations);
  }
  return 'no';
}

export function boxedJavaType(type: JavaType): JavaType {
  return type.kind === 'primitive'
    ? { kind: 'reference', name: boxes[type.name], arguments: [] }
    : type;
}

function effectiveParameters<T>(
  candidate: JavaOverloadCandidate<T>,
  phase: JavaInvocationPhase,
  arity: number,
): readonly JavaType[] | undefined {
  if (phase !== 'variable')
    return candidate.parameters.length === arity ? candidate.parameters : undefined;
  if (!candidate.variadic || arity < candidate.parameters.length - 1) return undefined;
  const last = candidate.parameters.at(-1);
  if (last?.kind !== 'array') return undefined;
  return [
    ...candidate.parameters.slice(0, -1),
    ...Array.from({ length: arity - candidate.parameters.length + 1 }, () => last.component),
  ];
}

function moreSpecific<T>(
  left: JavaOverloadCandidate<T>,
  right: JavaOverloadCandidate<T>,
  phase: JavaInvocationPhase,
  arity: number,
  relations: JavaTypeRelations,
): JavaVerdict {
  const compareArity =
    phase === 'variable' ? Math.max(arity, left.parameters.length, right.parameters.length) : arity;
  const a = effectiveParameters(left, phase, compareArity);
  const b = effectiveParameters(right, phase, compareArity);
  if (a === undefined || b === undefined) return 'unknown';
  return all(a.map((type, i) => javaSubtype(type, b[i]!, relations)));
}

/** The provider evaluates poly expressions against the candidate's parameter;
 * the selector must not replace that callback with one frozen argument type. */
export function selectJavaOverload<T>(
  candidates: readonly JavaOverloadCandidate<T>[],
  arity: number,
  argumentConversion: (index: number, target: JavaType, phase: JavaInvocationPhase) => JavaVerdict,
  relations: JavaTypeRelations,
): JavaOverloadDecision<T> {
  for (const phase of ['strict', 'loose', 'variable'] as const) {
    const applicable: JavaOverloadCandidate<T>[] = [];
    const uncertain: JavaOverloadCandidate<T>[] = [];
    for (const candidate of candidates) {
      const parameters = effectiveParameters(candidate, phase, arity);
      if (parameters === undefined) continue;
      const verdict = all(
        parameters.map((parameter, i) => argumentConversion(i, parameter, phase)),
      );
      if (verdict === 'no') continue;
      if (verdict === 'unknown' || candidate.unsupportedGeneric === true) uncertain.push(candidate);
      else applicable.push(candidate);
    }
    // An unknown candidate in an earlier phase can beat any later-phase
    // declaration. Even a currently unique applicable method is not a proof.
    if (uncertain.length > 0)
      return {
        kind: 'unknown',
        candidates: [...applicable, ...uncertain].map((candidate) => candidate.definition),
      };
    if (applicable.length === 0) continue;
    if (applicable.length === 1)
      return { kind: 'resolved', definition: applicable[0]!.definition, phase };
    const winners = applicable.filter((candidate) =>
      applicable.every(
        (other) =>
          candidate === other || moreSpecific(candidate, other, phase, arity, relations) === 'yes',
      ),
    );
    if (winners.length === 1)
      return { kind: 'resolved', definition: winners[0]!.definition, phase };
    if (winners.length > 1) {
      // JLS 15.12.2.5 can choose a preferred declaration among inherited
      // override-equivalent methods. Abstract/default and return-type facts
      // are outside this bounded selector; this is not proven ambiguity.
      return { kind: 'unknown', candidates: applicable.map((candidate) => candidate.definition) };
    }
    const unknown = applicable.some((candidate) =>
      applicable.some(
        (other) =>
          candidate !== other &&
          moreSpecific(candidate, other, phase, arity, relations) === 'unknown',
      ),
    );
    return {
      kind: unknown ? 'unknown' : 'ambiguous',
      candidates: applicable.map((candidate) => candidate.definition),
    };
  }
  return { kind: 'inapplicable', candidates: candidates.map((candidate) => candidate.definition) };
}

/** Split only balanced top-level arguments; unsupported wildcards/type uses
 * remain unknown in the provider rather than losing generic information. */
export function splitJavaTypeArguments(text: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') {
      if (--depth < 0) return undefined;
    } else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(text.slice(start).trim());
  return parts.every(Boolean) ? parts : undefined;
}
