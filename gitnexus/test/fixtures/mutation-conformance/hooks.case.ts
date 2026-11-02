// Conformance fixture (gate 2): mutants hit only in suite hooks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertClosed, assertOpen, loadRecords } from './src/hooks.js';

describe('records loaded in beforeAll', () => {
  let records: string[] = [];

  beforeAll(() => {
    records = loadRecords();
  });

  it('loads one record', () => {
    expect(records).toHaveLength(1);
  });

  it('names the record', () => {
    expect(records[0]).toBe('record');
  });
});

describe('a suite whose beforeAll checks the connection', () => {
  beforeAll(() => {
    assertOpen(true);
  });

  it('runs after the opening check', () => {
    expect(true).toBe(true);
  });

  it('runs a second test after the opening check', () => {
    expect(false).toBe(false);
  });
});

describe('a suite whose afterAll checks the connection', () => {
  afterAll(() => {
    assertClosed(true);
  });

  it('runs before the closing check', () => {
    expect(true).toBe(true);
  });
});

it('runs outside every suite with hooks', () => {
  expect(loadRecords).toBeTypeOf('function');
});
