import type { LanguageProvider } from '../../language-provider.js';
import {
  csharpArraySuffix,
  csharpParameterMode,
  renderCsharpHeritageType,
} from './heritage-type-shape.js';
import { canonicalName, isCsharpReservedTypeKeyword } from './identifiers.js';
import { isStableCsharpTypeName } from './qualified-type-names.js';

function formalPositions(formals?: ReadonlySet<string>) {
  if (!formals) return undefined;
  return new Map(Array.from(formals, (name, i) => [canonicalName(name), '!!' + i]));
}

function tupleSignature(spelling: string, formals?: ReadonlyMap<string, string>) {
  const labels: (string | undefined)[] = [];
  const mode = csharpParameterMode.exec(spelling)?.[0] ?? '';
  let grounded = true;
  const type = renderCsharpHeritageType(
    spelling.slice(mode.length),
    (name) => {
      const formal = formals?.get(canonicalName(name));
      if (formal) return { name: formal };
      if (!isStableCsharpTypeName(name)) grounded = false;
      return { name, reference: name === 'string' || name === 'object' };
    },
    false,
    {
      omitLabels: true,
      visit(label) {
        labels.push(label);
      },
    },
  );
  return { type: type && mode + type, labels, grounded };
}

const containsTuple = (type: string) => type.includes('(');

function invariantReturn(type: string) {
  const operand = type.endsWith('?') ? type.slice(0, -1) : type;
  return (
    (operand.startsWith('(') && operand.endsWith(')')) ||
    (isCsharpReservedTypeKeyword(operand) && operand !== 'string' && operand !== 'object')
  );
}

function incompatibleReturns(result: string, expected: string): boolean {
  if (invariantReturn(result) || invariantReturn(expected)) return true;
  if (!result.endsWith(']') || !expected.endsWith(']')) return false;
  const from = csharpArraySuffix(result);
  const to = csharpArraySuffix(expected);
  if (!from || !to) return false;
  const depth = Math.min(from.ranks.length, to.ranks.length);
  for (let i = 0; i < depth; i++) if (from.ranks[i] !== to.ranks[i]) return true;
  // Equal ranks allow covariance only through reference elements. An array
  // may itself widen to object at any depth.
  if (
    from.ranks.length < to.ranks.length &&
    (from.element === 'object' ||
      from.element === 'string' ||
      from.element === 'global::System.Array')
  )
    return true;
  return (
    (from.ranks.length === depth && invariantReturn(from.element)) ||
    (to.ranks.length === depth && invariantReturn(to.element))
  );
}

export const csharpTupleOverride: NonNullable<LanguageProvider['overrideSignature']> = {
  applies(types, returnType) {
    return returnType?.includes('(') === true || types.some(containsTuple);
  },
  compare({
    overriding,
    inherited,
    ownMethod,
    baseMethod,
    ownFormals,
    baseFormals,
    specializeReturns,
  }) {
    if (overriding.length !== inherited.length || ownFormals?.size !== baseFormals?.size)
      return 'different';
    const [ownReturn, baseReturn] = specializeReturns();
    const ownPositions = formalPositions(ownFormals);
    const basePositions = formalPositions(baseFormals);
    const own = [...overriding, ownReturn ?? ''].map((type) => tupleSignature(type, ownPositions));
    const base = [...inherited, baseReturn ?? ''].map((type) =>
      tupleSignature(type, basePositions),
    );
    const hasNames = (items: typeof own) =>
      items.some((item) => item.labels.some((name) => name !== undefined));
    const hasOwnNames = hasNames(own);
    if (!hasOwnNames && !hasNames(base)) return undefined;
    for (let index = 0; index < overriding.length; index++) {
      if (
        !own[index].type ||
        !own[index].grounded ||
        !base[index].grounded ||
        own[index].type !== base[index].type
      )
        return 'different';
    }
    // A private declaration is invisible to a derived class. An accessible
    // nonvirtual or sealed declaration hides all deeper slots (CS0506/CS0239).
    if (baseMethod.visibility === 'private') return 'different';
    if (
      !ownMethod.isOverride ||
      baseMethod.isFinal ||
      !(baseMethod.isAbstract || baseMethod.isVirtual || baseMethod.isOverride)
    )
      return 'blocked';
    // A protected override of protected internal requires a different assembly.
    // Distinct files alone cannot establish that boundary.
    const assemblyDependent =
      ownMethod.visibility === 'protected' &&
      baseMethod.visibility === 'protected internal' &&
      ownMethod.filePath !== baseMethod.filePath;
    if (
      !assemblyDependent &&
      ownMethod.visibility &&
      baseMethod.visibility &&
      ownMethod.visibility !== baseMethod.visibility
    )
      return 'blocked';
    const result = own.at(-1);
    const expected = base.at(-1);
    if (!result?.grounded || !expected?.grounded || !result.type || !expected.type)
      return undefined;
    if (result.type !== expected.type) {
      // CS0508 permits reference covariance. Boxing or converting between
      // distinct value types cannot make the nearer signature overridable.
      return incompatibleReturns(result.type, expected.type) ? 'blocked' : undefined;
    }
    // CS8139 permits omitting every name in the overriding signature. Once
    // any name is present, all element positions in parameters and return agree.
    const namesMatch =
      !hasOwnNames ||
      own.every(
        (item, index) =>
          item.labels.length === base[index].labels.length &&
          item.labels.every((name, i) => name === base[index].labels[i]),
      );
    if (!namesMatch) return 'blocked';
    return assemblyDependent ? undefined : 'match';
  },
};
