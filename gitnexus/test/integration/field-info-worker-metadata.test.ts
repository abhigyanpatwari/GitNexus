import { describe, expect, it } from 'vitest';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

describe('field declaration metadata through the parse worker', () => {
  it.each([
    ['static first', 'static p = new StaticTarget();\n  p = new InstanceTarget();'],
    ['instance first', 'p = new InstanceTarget();\n  static p = new StaticTarget();'],
    ['same line', 'static p = new StaticTarget(); p = new InstanceTarget();'],
  ])(
    'keeps static and instance initializers on their declarations: %s',
    async (_, fields) => {
      const pool = createWorkerPool(
        new URL('../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
        1,
      );
      try {
        const results = await pool.dispatch<{ path: string; content: string }, ParseWorkerResult>([
          { path: 'fields.ts', content: `class Holder {\n  ${fields}\n}` },
        ]);
        const properties = results
          .flatMap((result) => result.nodes)
          .filter((node) => node.label === 'Property');
        expect(properties).toHaveLength(2);
        expect(properties.filter((node) => node.properties.isStatic === true)).toHaveLength(1);
        expect(
          properties.find((node) => node.properties.isStatic === true)?.properties.initializerType,
        ).toBe('StaticTarget');
        expect(
          properties.find((node) => node.properties.isStatic === false)?.properties.initializerType,
        ).toBe('InstanceTarget');
      } finally {
        await pool.terminate();
      }
    },
    120000,
  );
  it('keeps readonly metadata when an accessor argument is on a later line', async () => {
    const pool = createWorkerPool(
      new URL('../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
      1,
    );
    try {
      const results = await pool.dispatch<{ path: string; content: string }, ParseWorkerResult>([
        {
          path: 'reader.rb',
          content: 'class Reader\n  attr_reader(\n    :foo\n  )\n  attr_reader :foo\nend\n',
        },
      ]);
      const properties = results
        .flatMap((result) => result.nodes)
        .filter((node) => node.label === 'Property');
      expect(
        properties.map((node) => ({
          name: node.properties.name,
          line: node.properties.startLine,
          readonly: node.properties.isReadonly,
        })),
      ).toEqual([
        { name: 'foo', line: 2, readonly: true },
        { name: 'foo', line: 4, readonly: true },
      ]);
    } finally {
      await pool.terminate();
    }
  }, 120000);
});
