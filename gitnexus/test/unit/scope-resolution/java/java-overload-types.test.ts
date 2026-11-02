import { describe, expect, it } from 'vitest';
import {
  javaInvocationConversion,
  javaSubtype,
  selectJavaOverload,
  type JavaType,
  type JavaPrimitive,
  type JavaOverloadCandidate,
  type JavaTypeRelations,
} from '../../../../src/core/ingestion/languages/java/overload-types.js';

const relations: JavaTypeRelations = { sourceSubtype: () => 'unknown' };
function type(name: string): JavaType {
  if (name === '?') return { kind: 'unknown' };
  if (name === 'null') return { kind: 'null' };
  if (name.endsWith('[]')) return { kind: 'array', component: type(name.slice(0, -2)) };
  if (['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double'].includes(name))
    return { kind: 'primitive', name: name as JavaPrimitive };
  return {
    kind: 'reference',
    name: name.includes('.') ? name : `java.lang.${name}`,
    arguments: [],
  };
}
function select(signatures: readonly (readonly string[])[], arguments_: readonly string[]) {
  const candidates: JavaOverloadCandidate<string>[] = signatures.map((parameters) => ({
    definition: parameters.join(','),
    parameters: parameters.map((parameter) => type(parameter.replace('...', '[]'))),
    variadic: parameters.at(-1)?.endsWith('...') ?? false,
  }));
  return selectJavaOverload(
    candidates,
    arguments_.length,
    (index, target, phase) =>
      javaInvocationConversion(type(arguments_[index]!), target, phase, relations),
    relations,
  );
}

describe('Java overload invocation phases and specificity (JLS 15.12.2)', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'treats external name %s as unknown instead of consulting object prototypes',
    (name) => {
      expect(
        javaSubtype({ kind: 'reference', name, arguments: [] }, type('Number'), relations),
      ).toBe('unknown');
    },
  );
  it('returns unknown for adversarial type depth instead of overflowing the stack', () => {
    let left: JavaType = type('int');
    let right: JavaType = type('int');
    for (let index = 0; index < 12_000; index++) {
      left = { kind: 'array', component: left };
      right = { kind: 'array', component: right };
    }
    expect(javaSubtype(left, right, relations)).toBe('unknown');
  });
  it('keeps override-equivalent preferred declaration selection unknown rather than ambiguous', () => {
    expect(select([['String'], ['String'], ['Object']], ['String']).kind).toBe('unknown');
    expect(select([['int'], ['int']], ['int']).kind).toBe('unknown');
  });
  it.each([
    [[['String'], ['Long']], ['String'], 'String', 'strict'],
    [[['long'], ['Integer']], ['int'], 'long', 'strict'],
    [[['Object'], ['int']], ['Integer'], 'Object', 'strict'],
    [[['long']], ['Integer'], 'long', 'loose'],
    [[['String'], ['Object']], ['null'], 'String', 'strict'],
    [[['Object'], ['String...']], ['String'], 'Object', 'strict'],
    [[['Object'], ['String...']], ['String[]'], 'String...', 'strict'],
    [[['Integer'], ['int...']], ['int'], 'Integer', 'loose'],
    [[['Object...'], ['String...']], [], 'String...', 'variable'],
    [[['Object'], ['Object[]']], ['int[][]'], 'Object[]', 'strict'],
  ] as const)(
    'selects %s for %s without registration-order dependence',
    (signatures, arguments_, winner, phase) => {
      for (const order of [signatures, [...signatures].reverse()]) {
        expect(select(order, arguments_)).toMatchObject({
          kind: 'resolved',
          definition: winner,
          phase,
        });
      }
    },
  );

  it.each([
    [[['Long']], ['int']],
    [[['byte']], ['int']],
    [[['long[]']], ['int[]']],
    [[['Object[]']], ['int[]']],
    [[['boolean']], ['int']],
  ] as const)('rejects invocation conversion %s for %s', (signatures, arguments_) => {
    expect(select(signatures, arguments_).kind).toBe('inapplicable');
  });

  it.each([
    [[['String'], ['Long']], ['null']],
    [
      [
        ['int', 'Object'],
        ['long', 'String'],
      ],
      ['int', 'String'],
    ],
  ] as const)(
    'preserves incomparable applicable signatures %s for %s',
    (signatures, arguments_) => {
      expect(select(signatures, arguments_).kind).toBe('ambiguous');
    },
  );

  it('does not treat an unknown argument as null or a compatible wildcard', () => {
    expect(select([['String'], ['Long']], ['?']).kind).toBe('unknown');
  });

  it('does not jump past an uncertain strict-phase candidate', () => {
    const candidates: JavaOverloadCandidate<string>[] = [
      { definition: 'unknown reference', parameters: [{ kind: 'unknown' }], variadic: false },
      { definition: 'boxed', parameters: [type('Integer')], variadic: false },
    ];
    expect(
      selectJavaOverload(
        candidates,
        1,
        (_index, target, phase) => javaInvocationConversion(type('int'), target, phase, relations),
        relations,
      ).kind,
    ).toBe('unknown');
  });

  it('preserves invariant generic arguments across List to Collection widening', () => {
    const list = { kind: 'reference' as const, name: 'java.util.List', arguments: [type('Long')] };
    expect(
      javaSubtype(
        list,
        { kind: 'reference', name: 'java.util.Collection', arguments: [type('Long')] },
        relations,
      ),
    ).toBe('yes');
    expect(
      javaSubtype(
        list,
        { kind: 'reference', name: 'java.util.Collection', arguments: [type('Number')] },
        relations,
      ),
    ).toBe('no');
    expect(
      javaSubtype(
        list,
        { kind: 'reference', name: 'java.util.Collection', arguments: [{ kind: 'unknown' }] },
        relations,
      ),
    ).toBe('unknown');
  });
});
