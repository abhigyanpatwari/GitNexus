import { describe, expect, it } from 'vitest';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';

describe('TypeScript synthesized capture order', () => {
  it('invalidates a namespace-level guard when the namespace writes the binding', () => {
    const captures = emitTsScopeCaptures(
      `namespace Store {
         let repo: Key | Value;
         if (repo instanceof Key) {
           function later() { repo = other; }
           repo.before();
           repo = new Value();
           repo.after();
         }
       }`,
      'namespace-guard.ts',
    );
    expect(
      captures
        .filter((match) => match['@type-binding.instanceof-narrow'])
        .map((match) => [
          match['@type-binding.name'].range.startLine,
          match['@type-binding.type'].text,
        ]),
    ).toEqual([
      [5, 'Key'],
      [7, 'Value'],
    ]);
  });

  it.each([
    [
      'an unrelated initializer',
      'const unused = 1; function later() { make = replacement; }',
      true,
    ],
    [
      'an unrelated call',
      'function idle() {} idle(); function later() { make = replacement; }',
      true,
    ],
    [
      'an unconstructed field',
      'class Later { value = (make = replacement); read() { return this.value; } }',
      true,
    ],
    ['a constructed field', 'class Later { value = (make = replacement); } new Later();', false],
    ['a static initializer', 'class Eager { static value = (make = replacement); }', false],
    ['a static block', 'class Eager { static { make = replacement; } }', false],
    ['a computed field name', 'class Eager { [String(make = replacement)] = 1; }', false],
    ['a call to the writer', 'function later() { make = replacement; } later();', false],
    [
      'an indirect call to the writer',
      'function start() { later(); } function later() { make = replacement; } start();',
      false,
    ],
    [
      'a static self-construction',
      'class Eager { field = (make = replacement); static instance = new this(); }',
      false,
    ],
    [
      'a namespace method call',
      'namespace N { export function change() { make = replacement; } } N.change();',
      false,
    ],
    [
      'an exported writer in a dependency cycle',
      'import "./cycle"; function change() { make = replacement; } export {change};',
      false,
    ],
    ['a direct module write', 'make = replacement;', false],
  ] as const)('tracks the factory result across %s', (_case, beforeExport, expected) => {
    const captures = emitTsScopeCaptures(
      `function make() { return () => 1; }
       function replacement() { return () => 2; }
       ${beforeExport}
       export default make();`,
      'factory.ts',
    );
    expect(captures.some((match) => match['@declaration.is-default-export']?.text === 'true')).toBe(
      expected,
    );
  });

  it.each([
    ['an unused eval reference', 'void eval;', true],
    ['an indirect eval', '(0, eval)("later()");', true],
    ['an aliased eval', 'const other = eval; other("later()");', true],
    ['an optional eval call', 'eval?.("later()");', true],
    ['a tagged template', 'eval`later()`;', true],
    ['an empty eval call', 'eval(/* no argument */);', true],
    ['a non-string eval argument', 'eval(42);', true],
    ['an uncalled evaluator', 'function run() { eval("later()"); }', true],
    ['a direct eval', 'eval("later()");', false],
    ['a grouped eval', '(eval)("later()");', false],
    ['an asserted eval', '(eval as typeof eval)("later()");', false],
    ['a called evaluator', 'function run() { eval("later()"); } run();', false],
    ['a direct eval after export', '', true, 'eval("later()");'],
  ] as const)(
    'tracks the factory result across %s',
    (_case, expression, expected, afterExport = '') => {
      const captures = emitTsScopeCaptures(
        `function make() { return () => 1; }
       function later() { make = () => () => 2; }
       ${expression}
       export default make();
       ${afterExport}`,
        'factory-eval.ts',
      );
      expect(
        captures.some((match) => match['@declaration.is-default-export']?.text === 'true'),
      ).toBe(expected);
    },
  );

  describe('guards after writes to the receiver', () => {
    it.each([
      [
        'sequence',
        'if (x instanceof A) { x.before(), x = b, x.after(); }',
        ['A.before', 'B.after'],
      ],
      ['unbraced loop', 'if (x instanceof A) for (; run(); x.after()) { x = b; }', []],
      [
        'type assertion',
        'if (x instanceof A) { x.before(); (<any>x) = b; x.after(); }',
        ['A.before'],
      ],
      [
        'satisfies',
        'if (x instanceof A) { x.before(); (x satisfies A) = b; x.after(); }',
        ['A.before'],
      ],
      [
        'closure',
        'function replace() { x = b; } if (x instanceof A) { replace(); x.after(); }',
        ['A.after'],
      ],
      ['shadow', 'if (x instanceof A) { { let x = b; x.after(); } x.before(); }', ['A.before']],
      ['write before guard', 'x = b; if (x instanceof A) { x.before(); }', ['A.before']],
      ['hoisted write', 'if (x instanceof A) { x.before(); var x = b; x.after(); }', ['A.before']],
    ] as const)('keeps the proven receiver types for %s', (_name, body, expected) => {
      const source = `function run(x: A | B, b: B) { ${body} }`;
      const names = emitTsScopeCaptures(source, 'guard.ts')
        .filter((match) => match['@type-binding.instanceof-narrow'])
        .map((match) => {
          const column = match['@type-binding.name'].range.endCol;
          return (
            match['@type-binding.type'].text + source.slice(column, source.indexOf('(', column))
          );
        });
      expect(names).toEqual(expected);
    });
  });

  it('keeps parents before nested classes and visits sibling classes right to left', () => {
    const captures = emitTsScopeCaptures(
      `class First extends Left {}
       abstract class Outer extends Parent {
         method() {
           class InnerLeft extends NestedLeft {}
           class InnerRight extends NestedRight {}
         }
       }
       interface Last extends Right, Extra {}`,
      'inheritance-order.ts',
    );
    expect(
      captures
        .filter((capture) => capture['@reference.inherits'])
        .map((capture) => capture['@reference.name']?.text),
    ).toEqual(['Right', 'Extra', 'Parent', 'NestedRight', 'NestedLeft', 'Left']);
  });

  it('visits destructuring declarations right to left and fields left to right', () => {
    const captures = emitTsScopeCaptures(
      `const { left } = first;
       function nested() { const { middle, renamed: alias } = second; }
       const { right } = third;`,
      'destructuring-order.ts',
    );
    expect(
      captures
        .filter((capture) => capture['@type-binding.destructured'])
        .map((capture) => [
          capture['@type-binding.name']?.text,
          capture['@type-binding.type']?.text,
        ]),
    ).toEqual([
      ['right', 'third.right'],
      ['middle', 'second.middle'],
      ['alias', 'second.renamed'],
      ['left', 'first.left'],
    ]);
  });

  it('keeps outer Map tuple bindings ahead of inner loops', () => {
    const captures = emitTsScopeCaptures(
      `for (const [leftKey, leftValue] of left) {}
       for (const [outerKey, outerValue] of outer) {
         for (const [innerKey, innerValue] of inner) {}
       }
       for (const [rightKey, rightValue] of right) {}`,
      'map-order.ts',
    );
    expect(
      captures
        .filter((capture) => capture['@type-binding.map-tuple-entry'])
        .map((capture) => capture['@type-binding.name']?.text),
    ).toEqual([
      'rightKey',
      'rightValue',
      'outerKey',
      'outerValue',
      'innerKey',
      'innerValue',
      'leftKey',
      'leftValue',
    ]);
  });

  it('uses the nearest guard for each receiver and leaves sibling branches alone', () => {
    const captures = emitTsScopeCaptures(
      `function run(value: unknown) {
         if (value instanceof Outer) {
           value.outerBefore();
           if (value instanceof Inner) value.inner();
           value.outerAfter();
         } else value.notInBranch();
         value.afterBranch();
       }`,
      'narrowing-boundaries.ts',
    );
    expect(
      captures
        .filter((capture) => capture['@type-binding.instanceof-narrow'])
        .map((capture) => [
          capture['@type-binding.type'].text,
          capture['@type-binding.name'].range.startLine,
        ]),
    ).toEqual([
      ['Outer', 3],
      ['Outer', 5],
      ['Inner', 4],
    ]);
  });
});
