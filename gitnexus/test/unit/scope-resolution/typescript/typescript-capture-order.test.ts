import { describe, expect, it } from 'vitest';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';

describe('TypeScript synthesized capture order', () => {
  describe('guards after writes to the receiver', () => {
    it.each([
      ['sequence', 'if (x instanceof A) { x.before(), x = b, x.after(); }', ['before']],
      ['unbraced loop', 'if (x instanceof A) for (; run(); x.after()) { x = b; }', []],
      [
        'type assertion',
        'if (x instanceof A) { x.before(); (<any>x) = b; x.after(); }',
        ['before'],
      ],
      [
        'satisfies',
        'if (x instanceof A) { x.before(); (x satisfies A) = b; x.after(); }',
        ['before'],
      ],
      [
        'closure',
        'function replace() { x = b; } if (x instanceof A) { replace(); x.after(); }',
        [],
      ],
      ['shadow', 'if (x instanceof A) { { let x = b; x.after(); } x.before(); }', ['before']],
      ['write before guard', 'x = b; if (x instanceof A) { x.before(); }', ['before']],
      ['hoisted write', 'if (x instanceof A) { x.before(); var x = b; x.after(); }', ['before']],
    ] as const)('keeps the proven member uses for %s', (_name, body, expected) => {
      const source = `function run(x: A | B, b: B) { ${body} }`;
      const names = emitTsScopeCaptures(source, 'guard.ts')
        .filter((match) => match['@type-binding.instanceof-narrow'])
        .map((match) => {
          const column = match['@type-binding.name'].range.endCol;
          return source.slice(column + 1, source.indexOf('(', column));
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
