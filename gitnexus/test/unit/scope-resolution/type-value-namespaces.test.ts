import { expect, it } from 'vitest';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';

it('distinguishes runtime class extension from type inheritance', () => {
  const captures = emitTsScopeCaptures(
    `
    class Child extends Value implements Shape {}
    interface More extends Shape {}
  `,
    'app.ts',
  ).filter((match) => match['@reference.inherits']);
  expect(
    captures
      .map((match) => [match['@reference.name']?.text, match['@reference.lookup-purpose']?.text])
      .sort(),
  ).toEqual([
    ['Shape', 'type'],
    ['Shape', 'type'],
    ['Value', 'value'],
  ]);
});
