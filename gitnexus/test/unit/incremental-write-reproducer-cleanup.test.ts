import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../bench/incremental-write-integrity/reproduce.cjs', import.meta.url),
  'utf8',
);

type FailurePoint =
  | 'write:1'
  | 'write:2'
  | 'database:1'
  | 'database:2'
  | 'connection:1'
  | 'connection:2'
  | 'connection-close:1'
  | 'connection-close:2'
  | 'database-close:1'
  | 'database-close:2'
  | 'remove';

// Execute the actual entry point with controlled native and file APIs. Healthy
// scan tuples allow constructor and cleanup faults in both native sessions.
async function runReproducer(failures: FailurePoint[] = [], keep = false) {
  const directory = path.join(os.tmpdir(), 'ladybug-copy-identity-controlled');
  const events: string[] = [];
  const diagnostics: unknown[] = [];
  const injected = new Map(failures.map((point) => [point, new Error(point)]));
  let databases = 0;
  let connections = 0;
  let writes = 0;
  let indices = Array.from({ length: 8192 }, (_, i) => i);
  const output: string[] = [];
  const processDouble = {
    argv: keep ? ['node', 'reproduce.cjs', '--keep'] : ['node', 'reproduce.cjs'],
    version: process.version,
    exitCode: 0,
    stdout: { write: (value: string) => output.push(value) },
  };
  const fail = (point: FailurePoint) => {
    const error = injected.get(point);
    if (error) throw error;
  };
  class Database {
    readonly number = ++databases;
    constructor() {
      events.push(`database:${this.number}`);
      fail(`database:${this.number}` as FailurePoint);
    }
    async close() {
      events.push(`database-close:${this.number}`);
      fail(`database-close:${this.number}` as FailurePoint);
    }
  }
  class Connection {
    readonly number = ++connections;
    constructor(database: Database) {
      events.push(`connection:${this.number}`);
      expect(database.number).toBe(this.number);
      fail(`connection:${this.number}` as FailurePoint);
    }
    async query(cypher: string) {
      if (cypher.includes('DETACH DELETE')) {
        indices = indices.filter((i) => i >= 32 && i < 8192 - 32);
      } else if (cypher.startsWith('COPY')) {
        indices = Array.from({ length: 8192 }, (_, i) => i);
      }
      const rows = cypher.includes('RETURN id(n)')
        ? indices.map((i) => ({
            internalID: { offset: i },
            id: `Function:src/owner${Math.floor(i / 32)}.ts:fn${i}`,
            name: `fn${i}`,
            filePath: `src/owner${Math.floor(i / 32)}.ts`,
            startLine: (i % 32) * 4,
            endLine: (i % 32) * 4 + 2,
          }))
        : [];
      return { getAll: async () => rows, close: async () => {} };
    }
    async close() {
      events.push(`connection-close:${this.number}`);
      fail(`connection-close:${this.number}` as FailurePoint);
    }
  }
  const fsDouble = {
    mkdtemp: async () => directory,
    writeFile: async () => {
      const point = `write:${++writes}` as FailurePoint;
      events.push(point);
      fail(point);
    },
    rm: async (target: string, options: { recursive: boolean; force: boolean }) => {
      expect(target).toBe(directory);
      expect(options).toEqual({ recursive: true, force: true });
      events.push('remove');
      fail('remove');
    },
  };
  const modules: Record<string, unknown> = {
    'node:assert/strict': assert,
    'node:fs/promises': fsDouble,
    'node:os': os,
    'node:path': path,
    '@ladybugdb/core': { Database, Connection, VERSION: 'controlled' },
  };
  await vm.runInNewContext(source, {
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected require: ${name}`);
      return modules[name];
    },
    process: processDouble,
    console: { error: (error: unknown) => diagnostics.push(error) },
    AggregateError,
  });
  return { events, diagnostics, injected, output, exitCode: processDouble.exitCode, directory };
}

it.each([
  { point: 'write:1', closed: [] },
  { point: 'write:2', closed: [] },
  { point: 'database:1', closed: [] },
  { point: 'connection:1', closed: ['database-close:1'] },
  { point: 'database:2', closed: ['connection-close:1', 'database-close:1'] },
  {
    point: 'connection:2',
    closed: ['connection-close:1', 'database-close:1', 'database-close:2'],
  },
  { point: 'connection-close:1', closed: ['connection-close:1', 'database-close:1'] },
  { point: 'database-close:1', closed: ['connection-close:1', 'database-close:1'] },
  {
    point: 'connection-close:2',
    closed: ['connection-close:1', 'database-close:1', 'connection-close:2', 'database-close:2'],
  },
  {
    point: 'database-close:2',
    closed: ['connection-close:1', 'database-close:1', 'connection-close:2', 'database-close:2'],
  },
] satisfies { point: FailurePoint; closed: string[] }[])(
  'closes acquired resources and removes the directory when $point fails',
  async ({ point, closed }) => {
    const result = await runReproducer([point]);
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toEqual([result.injected.get(point)]);
    expect(result.events.filter((event) => event.includes('-close:'))).toEqual(closed);
    expect(result.events.at(-1)).toBe('remove');
    expect(result.events.filter((event) => event === 'remove')).toHaveLength(1);
  },
);

it('closes both native sessions and removes the directory after a healthy run', async () => {
  const result = await runReproducer();
  expect(result.exitCode).toBe(0);
  expect(result.diagnostics).toEqual([]);
  expect(result.events.slice(-5)).toEqual([
    'database:2',
    'connection:2',
    'connection-close:2',
    'database-close:2',
    'remove',
  ]);
  const report = JSON.parse(result.output.join(''));
  expect(report.phases).toHaveLength(5);
  expect(report.phases.every((phase: { wrong_tuples: number }) => phase.wrong_tuples === 0)).toBe(
    true,
  );
  expect(report.directory).toBeUndefined();
});

it('keeps the directory deliberately without retaining native handles for --keep', async () => {
  const result = await runReproducer([], true);
  expect(result.exitCode).toBe(0);
  expect(result.events).not.toContain('remove');
  expect(result.events.slice(-2)).toEqual(['connection-close:2', 'database-close:2']);
  expect(JSON.parse(result.output.join('')).directory).toBe(result.directory);
});

it('honors --keep when connection construction fails', async () => {
  const result = await runReproducer(['connection:1'], true);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics).toEqual([result.injected.get('connection:1')]);
  expect(result.events.at(-1)).toBe('database-close:1');
  expect(result.events).not.toContain('remove');
});

it('retains both close failures and still removes the directory', async () => {
  const result = await runReproducer(['connection-close:1', 'database-close:1']);
  expect(result.exitCode).toBe(1);
  const error = result.diagnostics[0] as AggregateError;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([
    result.injected.get('connection-close:1'),
    result.injected.get('database-close:1'),
  ]);
  expect(result.events.at(-1)).toBe('remove');
});

it('retains the original construction error when database cleanup also fails', async () => {
  const result = await runReproducer(['connection:1', 'database-close:1']);
  expect(result.exitCode).toBe(1);
  const error = result.diagnostics[0] as AggregateError;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([
    result.injected.get('connection:1'),
    result.injected.get('database-close:1'),
  ]);
  expect(result.events.at(-1)).toBe('remove');
});

it('reports directory-removal failures after closing the native handles', async () => {
  const result = await runReproducer(['remove']);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics).toEqual([result.injected.get('remove')]);
  expect(result.events.slice(-3)).toEqual(['connection-close:2', 'database-close:2', 'remove']);
});
