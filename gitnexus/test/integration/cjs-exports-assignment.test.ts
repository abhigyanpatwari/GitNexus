/**
 * #2723 — `exports.foo = function () {}` must emit a callable `Function` node.
 *
 * CommonJS property-assignment exports are the dominant export style in
 * pre-ESM Node (Express apps, Firebase Functions). Declared functions were
 * indexed; the assignment form was not, so on a CJS codebase the graph held
 * the internals and missed the public API.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  DIST_WORKER_URL,
  distWorkerExists,
  parseFilesWithWorkers,
} from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const labelsFor = async (path: string, content: string, name: string): Promise<string[]> => {
  const { graph } = await parseFilesWithWorkers([{ path, content }]);
  return graph.nodes
    .filter((node) => node.properties.name === name)
    .map((node) => node.label)
    .sort();
};

describe('#2723 CommonJS export assignment emits a Function node', () => {
  it('exports.foo = function () {}', async () => {
    expect(
      await labelsFor(
        'src/a.js',
        'exports.areVariablesValid = function (variables) { return !!variables; };\n',
        'areVariablesValid',
      ),
    ).toEqual(['Function']);
  });

  it('exports.foo = async function () {}', async () => {
    expect(
      await labelsFor(
        'src/b.js',
        'exports.loadUser = async function (id) { return id; };\n',
        'loadUser',
      ),
    ).toEqual(['Function']);
  });

  it('exports.foo = (a) => {}', async () => {
    expect(await labelsFor('src/c.js', 'exports.toId = (a) => a.id;\n', 'toId')).toEqual([
      'Function',
    ]);
  });

  it('module.exports.foo = function () {}', async () => {
    expect(
      await labelsFor('src/d.js', 'module.exports.render = function () { return 1; };\n', 'render'),
    ).toEqual(['Function']);
  });

  it('module.exports = { foo } re-exports the declared function only once', async () => {
    expect(
      await labelsFor(
        'src/e.js',
        'function helper() { return 1; }\nmodule.exports = { helper };\n',
        'helper',
      ),
    ).toEqual(['Function']);
  });

  it('exports.foo = function* () {}', async () => {
    expect(
      await labelsFor('src/g.js', 'exports.walk = function* () { yield 1; };\n', 'walk'),
    ).toEqual(['Function']);
  });

  it('TS parity: exports.foo = function () {}', async () => {
    expect(
      await labelsFor(
        'src/f.ts',
        'exports.tsExport = function (x: number) { return x; };\n',
        'tsExport',
      ),
    ).toEqual(['Function']);
  });
});

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

describeIfWorkerBuilt('#2723 calls resolve to the CJS-exported function', () => {
  /** Names of the symbols that CALL `name`, resolved through the real pipeline. */
  const callersOf = async (
    files: { path: string; content: string }[],
    name: string,
  ): Promise<string[]> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-2723-'));
    try {
      for (const file of files) {
        const full = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.content, 'utf-8');
      }
      const { graph } = await runPipelineFromRepo(dir, () => {}, {
        workerPoolSize: 1,
        workerUrlForTest: DIST_WORKER_URL,
      });
      const target = graph.nodes.find((n) => n.properties.name === name && n.label === 'Function');
      expect(target).toBeDefined();
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      return graph.relationships
        .filter((rel) => rel.type === 'CALLS' && rel.targetId === target!.id)
        .map((rel) => String(byId.get(rel.sourceId)?.properties.name ?? rel.sourceId))
        .sort();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('same-file call resolves', async () => {
    expect(
      await callersOf(
        [
          {
            path: 'src/validate.js',
            content:
              'exports.areVariablesValid = function (v) { return !!v; };\n' +
              'exports.check = function (v) { return exports.areVariablesValid(v); };\n',
          },
        ],
        'areVariablesValid',
      ),
    ).toEqual(['check']);
  });

  it('cross-file require() member call resolves', async () => {
    expect(
      await callersOf(
        [
          {
            path: 'src/validate.js',
            content: 'exports.areVariablesValid = function (v) { return !!v; };\n',
          },
          {
            path: 'src/handler.js',
            content:
              "const validate = require('./validate');\n" +
              'function handle(v) { return validate.areVariablesValid(v); }\n',
          },
        ],
        'areVariablesValid',
      ),
    ).toEqual(['handle']);
  });

  // The graph-node rules accept `generator_function` for this form, so without
  // the matching scope declaration the node existed and nothing resolved to it.
  it('generator export resolves through both receiver forms', async () => {
    const files = [
      {
        path: 'src/gen.js',
        content:
          'exports.walk = function* () { yield 1; };\n' +
          'module.exports.crawl = function* () { yield 2; };\n',
      },
      {
        path: 'src/use.js',
        content:
          "const { walk, crawl } = require('./gen');\n" +
          'function drive() { return [...walk(), ...crawl()]; }\n',
      },
    ];
    expect(await callersOf(files, 'walk')).toEqual(['drive']);
    expect(await callersOf(files, 'crawl')).toEqual(['drive']);
  });

  it('cross-file destructured require() call resolves', async () => {
    expect(
      await callersOf(
        [
          {
            path: 'src/validate.js',
            content: 'exports.areVariablesValid = function (v) { return !!v; };\n',
          },
          {
            path: 'src/handler.js',
            content:
              "const { areVariablesValid } = require('./validate');\n" +
              'function handle(v) { return areVariablesValid(v); }\n',
          },
        ],
        'areVariablesValid',
      ),
    ).toEqual(['handle']);
  });
});
