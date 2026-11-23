import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepare, execute, readOnly, loadVector } = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
  readOnly: vi.fn(() => false),
  loadVector: vi.fn(async () => false),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Connection: vi.fn(function (this: any) {
      this.prepare = prepare;
      this.execute = execute;
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: readOnly,
  loadFTSExtension: async () => false,
  loadVectorExtension: loadVector,
}));
vi.mock('../../src/core/lbug/query-memory-guard.js', () => ({
  queryMemoryGuard: { begin: () => ({}), end: () => {} },
}));

import {
  closeLbug,
  engineExceptionFault,
  ensureVectorExtension,
  executeParameterized,
  initLbugWithDb,
} from '../../src/core/lbug/pool-adapter.js';
import { SymbolIdentityError } from '../../src/core/lbug/query-result-integrity.js';
import { engineFaultOf, faultOf, queryStageOf } from '../../src/core/fault-class.js';

const REPO = 'fault-class-pool';
const query = () => executeParameterized(REPO, 'RETURN 1 AS n', {}).catch((e) => e);

describe('read pool fault marks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    readOnly.mockReturnValue(false);
    loadVector.mockResolvedValue(false);
    prepare.mockResolvedValue({ isSuccess: () => true });
    execute.mockResolvedValue({ getAll: async () => [{ n: 1 }], close: vi.fn() });
    await initLbugWithDb(REPO, {} as any, '/tmp/fault-class-pool-db');
  });

  afterEach(async () => {
    await closeLbug();
    vi.useRealTimers();
  });

  it('marks an uninitialized pool as a server fault without a query stage', async () => {
    const error = await executeParameterized('missing-repo', 'RETURN 1', {}).catch((e) => e);
    expect(error.message).toBe(
      'LadybugDB not initialized for repo "missing-repo". Call initLbug first.',
    );
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
  });

  it('marks a native prepare failure with the prepare stage', async () => {
    prepare.mockResolvedValueOnce({
      isSuccess: () => false,
      getErrorMessage: async () => 'Parser exception: bad',
    });
    const error = await query();
    expect(error.message).toBe('Prepare failed: Parser exception: bad');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('prepare');
  });

  it('rethrows the same native execute error with the execute stage', async () => {
    const native = new Error('IO exception: synthetic');
    execute.mockRejectedValueOnce(native);
    const error = await query();
    expect(error).toBe(native);
    expect(error.message).toBe('IO exception: synthetic');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('execute');
  });

  it('keeps the read-only wrapper text and stages it as execute', async () => {
    const native = new Error('Cannot execute write operations in a read-only database!');
    readOnly.mockReturnValueOnce(true);
    execute.mockRejectedValueOnce(native);
    const error = await query();
    expect(error.message).toBe('Write operations are not allowed. The pool adapter is read-only.');
    expect(error.cause).toBe(native);
    expect(queryStageOf(error)).toBe('execute');
  });

  it('stages the adapter timeout as execute', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    execute.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = query();
    await vi.advanceTimersByTimeAsync(30_001);
    release({ getAll: async () => [], close: vi.fn() });
    const error = await pending;
    expect(error.message).toBe('Query timed out after 30000ms');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('execute');
  });

  it('stages a timeout during prepare as prepare', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    prepare.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = query();
    await vi.advanceTimersByTimeAsync(30_001);
    release({ isSuccess: () => true });
    const error = await pending;
    expect(error.message).toBe('Query timed out after 30000ms');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('prepare');
  });

  const vectorQuery = () =>
    executeParameterized(
      REPO,
      "CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', [0.1], 3) RETURN *",
      {},
    ).catch((e) => e);

  it('stages a vector query failure when VECTOR is loaded on its Database', async () => {
    loadVector.mockResolvedValue(true);
    execute.mockRejectedValueOnce(new Error('Runtime exception: synthetic'));
    const error = await vectorQuery();
    expect(error.message).toBe('Runtime exception: synthetic');
    expect(queryStageOf(error)).toBe('execute');
  });

  it('does not stage a vector query whose pool was re-initialized after the VECTOR preflight', async () => {
    // The preflight loads VECTOR on the original Database, then a re-init
    // replaces the pool with one on a Database that never loaded it.
    loadVector.mockImplementationOnce(async () => {
      await closeLbug(REPO);
      await initLbugWithDb(REPO, {} as never, '/tmp/fault-class-pool-db-reopened');
      return true;
    });
    execute.mockRejectedValueOnce(
      new Error('Catalog exception: QUERY_VECTOR_INDEX does not exist'),
    );
    const error = await vectorQuery();
    expect(error.message).toBe('Catalog exception: QUERY_VECTOR_INDEX does not exist');
    expect(queryStageOf(error)).toBeUndefined();
    expect(faultOf(error)).toBe('server');
  });

  it('marks vector extension failures as server faults', async () => {
    const error = await ensureVectorExtension('missing-repo').catch((e) => e);
    expect(error.message).toBe(
      'LadybugDB not initialized for repo "missing-repo". Call initLbug first.',
    );
    expect(faultOf(error)).toBe('server');
  });

  it('marks an invalid symbol identity as a server fault', () => {
    const error = new SymbolIdentityError();
    expect(error.name).toBe('SymbolIdentityError');
    expect(faultOf(error)).toBe('server');
  });
});

describe('engine exception categories', () => {
  it.each([
    ['Parser', 'client'],
    ['Binder', 'client'],
    ['Catalog', 'client'],
    ['Conversion', 'client'],
    ['Runtime', 'client'],
    ['Overflow', 'client'],
    ['IO', 'server'],
    ['Buffer manager', 'server'],
    ['Storage', 'server'],
    ['Connection', 'server'],
    ['Copy', 'server'],
  ] as const)('a %s exception is a %s fault', (category, fault) => {
    expect(engineExceptionFault(`${category} exception: synthetic`)).toBe(fault);
  });

  it.each([
    'Unknown exception: synthetic',
    'parser exception: lower-case category',
    'Error: Parser exception: not at the start',
    'Parser exception without the separator',
    'Query timed out after 30000ms',
    '',
    'Connection Exception: We do not support prepare multiple statements.',
    'Parameter nmae not found.',
  ])('%j names no known category', (message) => {
    expect(engineExceptionFault(message)).toBe('unrecognized');
  });

  it('a message that is not a string names no known category', () => {
    expect(engineExceptionFault(undefined)).toBe('unrecognized');
    expect(engineExceptionFault(42)).toBe('unrecognized');
  });
});

describe('engine classes on read pool errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    readOnly.mockReturnValue(false);
    loadVector.mockResolvedValue(false);
    prepare.mockResolvedValue({ isSuccess: () => true });
    execute.mockResolvedValue({ getAll: async () => [{ n: 1 }], close: vi.fn() });
    await initLbugWithDb(REPO, {} as never, '/tmp/fault-class-pool-db');
  });

  afterEach(async () => {
    await closeLbug();
    vi.useRealTimers();
  });

  it.each([
    ['execute', () => execute.mockRejectedValueOnce(new Error('IO exception: disk')), 'server'],
    ['prepare', () => prepare.mockRejectedValueOnce(new Error('Binder exception: x')), 'client'],
    [
      'getAll',
      () =>
        execute.mockResolvedValueOnce({
          getAll: () => Promise.reject(new Error('Storage exception: page')),
          close: vi.fn(),
        }),
      'server',
    ],
  ] as const)('a native %s rejection carries its engine class', async (_call, fail, fault) => {
    fail();
    const error = await query();
    expect(engineFaultOf(error)).toBe(fault);
  });

  it('an engine error without a recognized category is a server fault', async () => {
    execute.mockRejectedValueOnce(new Error('Parameter nmae not found.'));
    expect(engineFaultOf(await query())).toBe('server');
  });

  it.each([
    [
      'isSuccess',
      {
        isSuccess: () => {
          throw new Error('native isSuccess failed');
        },
      },
    ],
    [
      'getErrorMessage',
      {
        isSuccess: () => false,
        getErrorMessage: () => {
          throw new Error('native getErrorMessage failed');
        },
      },
    ],
  ] as const)('a throwing native %s is a server fault', async (method, statement) => {
    prepare.mockResolvedValueOnce(statement);
    const error = await query();
    expect(error.message).toBe(`native ${method} failed`);
    expect(engineFaultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('prepare');
  });

  it('a failed prepare carries the class of the engine message it wraps', async () => {
    prepare.mockResolvedValueOnce({
      isSuccess: () => false,
      getErrorMessage: async () => 'Catalog exception: no such table',
    });
    const error = await query();
    expect(error.message).toBe('Prepare failed: Catalog exception: no such table');
    expect(engineFaultOf(error)).toBe('client');
  });

  it('errors the adapter raises carry no engine class', async () => {
    readOnly.mockReturnValueOnce(true);
    execute.mockRejectedValueOnce(
      new Error('Connection exception: Cannot execute write operations in a read-only database!'),
    );
    const readOnlyError = await query();
    expect(readOnlyError.message).toBe(
      'Write operations are not allowed. The pool adapter is read-only.',
    );
    expect(engineFaultOf(readOnlyError)).toBeUndefined();
    expect(engineFaultOf(readOnlyError.cause)).toBe('server');

    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    execute.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = query();
    await vi.advanceTimersByTimeAsync(30_001);
    release({ getAll: async () => [], close: vi.fn() });
    const timeout = await pending;
    expect(timeout.message).toBe('Query timed out after 30000ms');
    expect(engineFaultOf(timeout)).toBeUndefined();
  });
});
