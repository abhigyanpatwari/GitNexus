// Conformance fixture (gate 2): the static mutant of src/boot.ts makes this file fail to import.
import { expect, it } from 'vitest';
import { BOOT_MODE } from './src/boot.js';

it('boots in strict mode', () => {
  expect(BOOT_MODE).toBe('strict');
});
