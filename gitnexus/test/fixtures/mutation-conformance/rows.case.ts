// Conformance fixture (gate 2): `it.each` rows whose titles truncate to the same name (Vitest
// truncates `$label` at 40 characters), so their ids need the row ordinal.
import { expect, it } from 'vitest';
import { total } from './src/rows.js';

const PREFIX = 'a row label long enough for Vitest to truncate it: ';

it.each([
  { label: `${PREFIX}first`, values: [1, 2], sum: 3 },
  { label: `${PREFIX}second`, values: [2, 3], sum: 5 },
])('totals $label', ({ values, sum }) => {
  expect(total(values)).toBe(sum);
});
