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

describe('#2723 follow-up: callable member assignments', () => {
  const nodesFor = async (
    path: string,
    content: string,
  ): Promise<{ labels: string[]; ids: string[]; owners: string[] }> => {
    const { graph } = await parseFilesWithWorkers([{ path, content }]);
    return {
      labels: graph.nodes.map((n) => n.label).sort(),
      ids: graph.nodes.map((n) => n.id).sort(),
      owners: graph.relationships
        .filter((r) => r.type === 'HAS_METHOD')
        .map((r) => `${r.sourceId} -> ${r.targetId}`)
        .sort(),
    };
  };

  it('Foo.prototype.bar = fn is a Method owned by the constructor', async () => {
    const { ids, owners } = await nodesFor(
      'src/proto.js',
      'function Foo() {}\nFoo.prototype.bar = function (v) { return v; };\n',
    );
    expect(ids).toContain('Method:src/proto.js:Foo.bar');
    expect(owners).toEqual(['Function:src/proto.js:Foo -> Method:src/proto.js:Foo.bar']);
  });

  it('a class owner gets a Class-sourced owner edge', async () => {
    const { owners } = await nodesFor(
      'src/protocls.js',
      'class Ctl {}\nCtl.prototype.run = function () { return 1; };\n',
    );
    expect(owners).toEqual(['Class:src/protocls.js:Ctl -> Method:src/protocls.js:Ctl.run']);
  });

  // Two constructors defining the same member name must stay distinct nodes;
  // an unqualified `Method:<file>:bar` would collapse them into one.
  it('same-named prototype members on different owners do not collide', async () => {
    const { ids } = await nodesFor(
      'src/two.js',
      'function Foo() {}\nFoo.prototype.bar = function () { return 1; };\n' +
        'function Baz() {}\nBaz.prototype.bar = function () { return 2; };\n',
    );
    expect(ids).toContain('Method:src/two.js:Foo.bar');
    expect(ids).toContain('Method:src/two.js:Baz.bar');
  });

  // An owner the file does not declare cannot be resolved to a node, so no
  // owner edge is claimed rather than one pointing at a fabricated node.
  it('an undeclared prototype owner claims no owner edge', async () => {
    const { owners } = await nodesFor(
      'src/ext.js',
      'External.prototype.skipped = function () { return 1; };\n',
    );
    expect(owners).toEqual([]);
  });

  it('this.handler = fn in a constructor is a Method owned by it', async () => {
    const { owners } = await nodesFor(
      'src/this.js',
      'function Widget() {\n  this.handler = function (v) { return v; };\n}\n',
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatch(/^Function:src\/this\.js:Widget -> Method:src\/this\.js:Widget\./);
  });

  it('this.cb = fn in a class constructor is owned by the class', async () => {
    const { owners } = await nodesFor(
      'src/thiscls.js',
      'class Klass {\n  constructor() { this.cb = function () { return 1; }; }\n}\n',
    );
    expect(owners.some((o) => o.startsWith('Class:src/thiscls.js:Klass -> Method:'))).toBe(true);
  });

  // The scope declaration for a shadowed CJS export is suppressed, so its graph
  // node would be unreachable. With a `class` of the same name the labels
  // differ, so it does not even collapse — it lingers as an orphan.
  // The member-assignment rule matches ANY identifier receiver so an exports
  // alias can be recognised; everything else must be pruned emit-side. Without
  // that, every `obj.handler = fn` would emit a top-level `Function`.
  // `module.exports = fn` — the whole module is the callable, so there is no
  // property to name it after. Anonymous forms take the file-derived name
  // (`deriveDefaultExportHocName`), the convention already used for anonymous
  // default exports; a named function expression keeps its own name.
  it('module.exports = function () {} is named after the file', async () => {
    const { ids } = await nodesFor(
      'src/cjsdef.js',
      'module.exports = function (v) { return v; };\n',
    );
    expect(ids).toContain('Function:src/cjsdef.js:cjsdef');
  });

  it('module.exports = (v) => v is named after the file', async () => {
    const { ids } = await nodesFor('src/cjsarrow.js', 'module.exports = (v) => v;\n');
    expect(ids).toContain('Function:src/cjsarrow.js:cjsarrow');
  });

  // The member-assignment rule captures the LEFT property as the name, which
  // for this shape is the literal `exports`. That must not survive.
  it('a named module.exports function keeps its own name and emits no `exports` node', async () => {
    const { ids } = await nodesFor(
      'src/cjsnamed.js',
      'module.exports = function namedFn(v) { return v; };\n',
    );
    expect(ids).toContain('Function:src/cjsnamed.js:namedFn');
    expect(ids).not.toContain('Function:src/cjsnamed.js:exports');
  });

  // Reassigning `exports` does NOT export in CommonJS — it only breaks the
  // alias to `module.exports` — so indexing it would invent an export.
  it('exports = fn is not treated as a default export', async () => {
    const { labels } = await nodesFor('src/rebind.js', 'exports = function (v) { return v; };\n');
    expect(labels.filter((l) => l === 'Function')).toEqual([]);
  });

  it('a non-exports receiver emits no node', async () => {
    const { labels } = await nodesFor(
      'src/plain.js',
      'const obj = {};\nobj.notAnExport = function () { return 1; };\n' +
        'self.alsoNot = () => 1;\nlocalThing.nope = function () { return 2; };\n',
    );
    expect(labels.filter((l) => l === 'Function' || l === 'Method')).toEqual([]);
  });

  // Top-level `this` is `undefined` in ESM, so it exports nothing there. This
  // gate is what keeps the CJS rule above from mis-indexing every ESM file.
  it('module-level this.X = fn in an ESM file is not an export', async () => {
    const { ids } = await nodesFor(
      'src/esmmod.js',
      "import { helper } from './helper.js';\n" +
        'this.notAnExport = function (v) { return helper(v); };\n' +
        'export const real = 1;\n',
    );
    expect(ids).not.toContain('Function:src/esmmod.js:notAnExport');
  });

  it('a file with no CJS or ESM signal does not claim a this export', async () => {
    const { ids } = await nodesFor(
      'src/neither.js',
      'this.ambiguous = function () { return 1; };\n',
    );
    expect(ids).not.toContain('Function:src/neither.js:ambiguous');
  });

  it('a CJS export shadowing a class emits no orphan Function twin', async () => {
    const { labels, ids } = await nodesFor(
      'src/twin.js',
      'class Dup { run() { return 1; } }\nexports.Dup = function () { return 2; };\n',
    );
    expect(ids).not.toContain('Function:src/twin.js:Dup');
    expect(labels.filter((l) => l === 'Function')).toEqual([]);
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

  // A CJS export assignment must not shadow a same-named `function X(){}` in
  // the same file. Registering a second module-scope declaration for `dup`
  // makes the name ambiguous and the resolver drops the intra-module edge
  // entirely — a silently missing caller, which is worse than the gap #2723
  // set out to close. Verified against base ff86ccf1e, where this edge exists.
  it('an exports assignment does not shadow a same-named declared function', async () => {
    expect(
      await callersOf(
        [
          {
            path: 'src/collide.js',
            content:
              'function dup(v) { return v; }\n' +
              'exports.dup = function (v) { return !v; };\n' +
              'function callIt(v) { return dup(v); }\n',
          },
        ],
        'dup',
      ),
    ).toEqual(['callIt']);
  });

  it('an exports alias resolves like a direct export', async () => {
    const files = [
      {
        path: 'src/alias.js',
        content:
          'const e = exports;\n' +
          'const m = module.exports;\n' +
          'e.aliased = function (v) { return v; };\n' +
          'm.viaModule = (v) => v;\n',
      },
      {
        path: 'src/aliasuse.js',
        content:
          "const { aliased, viaModule } = require('./alias');\n" +
          'function drive(v) { return [aliased(v), viaModule(v)]; }\n',
      },
    ];
    expect(await callersOf(files, 'aliased')).toEqual(['drive']);
    expect(await callersOf(files, 'viaModule')).toEqual(['drive']);
  });

  // In CommonJS, module-level `this` IS `module.exports`.
  it('module-level this.X = fn in a CJS file is an export', async () => {
    expect(
      await callersOf(
        [
          {
            path: 'src/cjsmod.js',
            content:
              "const dep = require('./dep');\n" +
              'this.topExport = function (v) { return dep(v); };\n',
          },
          { path: 'src/dep.js', content: 'module.exports = function (v) { return v; };\n' },
          {
            path: 'src/usecjs.js',
            content:
              "const { topExport } = require('./cjsmod');\n" +
              'function drive(v) { return topExport(v); }\n',
          },
        ],
        'topExport',
      ),
    ).toEqual(['drive']);
  });

  // `exports.fwd = lib.imported` assigns an existing symbol rather than a
  // literal, so no definition rule reaches it. Modelled as a re-export, NOT a
  // plain import binding: an import is private to its module, so importers of
  // the forwarding module resolved to nothing.
  it('a CJS re-export forwards to the original definition', async () => {
    const files = [
      {
        path: 'src/lib.js',
        content:
          'exports.imported = function (v) { return v; };\n' +
          'exports.second = function (v) { return !v; };\n',
      },
      {
        path: 'src/fwd.js',
        content:
          "const lib = require('./lib');\n" +
          "const { second } = require('./lib');\n" +
          'exports.forwarded = lib.imported;\n' +
          'exports.alsoForwarded = second;\n',
      },
      {
        path: 'src/usefwd.js',
        content:
          "const { forwarded, alsoForwarded } = require('./fwd');\n" +
          'function drive(v) { return [forwarded(v), alsoForwarded(v)]; }\n',
      },
    ];
    expect(await callersOf(files, 'imported')).toEqual(['drive']);
    expect(await callersOf(files, 'second')).toEqual(['drive']);
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
