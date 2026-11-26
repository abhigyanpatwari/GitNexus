import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';

// The checker returns recovery signatures for conflicting star exports and a
// structural function type for the wrapped default. Node can observe the
// actual exported values without guessing a declaration from that signature.
export async function checkModuleValues() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-module-values-'));
  const project = path.join(scratch, 'src');
  const emitted = path.join(scratch, 'out');
  const barrels = 'compiler-conformance/typescript-module-ownership';
  const entry = 'typescript-module-values/entry.ts';
  try {
    for (const dir of [barrels, path.dirname(entry)]) {
      cpSync(new URL('../../../test/fixtures/' + dir, import.meta.url), path.join(project, dir), {
        recursive: true,
      });
    }
    writeFileSync(
      path.join(project, 'tsconfig.json'),
      JSON.stringify({
        files: [entry],
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          types: [],
          target: 'es2022',
          rootDir: project,
          outDir: emitted,
          strict: true,
          noEmitOnError: false,
        },
      }),
    );
    const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
    const build = spawnSync(process.execPath, [cli, '--project', project, '--pretty', 'false'], {
      encoding: 'utf8',
    });
    if (build.error) throw build.error;
    assert.equal(build.status, 2, build.stderr || build.stdout);
    const codes = [...build.stdout.matchAll(/error TS(\d+):/g)].map((m) => m[1]).sort();
    assert.deepEqual(codes, ['2308', '2308', '2308', '2308', '2308', '2693'], build.stdout);
    writeFileSync(path.join(emitted, 'package.json'), '{"type":"module"}');
    const load = (module) =>
      import(pathToFileURL(path.join(emitted, barrels, module + '.js')).href);
    const { graph } = await runPipelineFromRepo(project, () => {});
    const calls = [...graph.iterRelationshipsByType('CALLS')];
    function targets(file, caller) {
      return calls
        .filter((edge) => {
          const source = graph.getNode(edge.sourceId)?.properties;
          return source?.filePath === file && source.name === caller;
        })
        .map((edge) => graph.getNode(edge.targetId));
    }
    const origins = new Map();
    for (const module of ['left', 'right'])
      origins.set((await load(module)).publish, barrels + '/' + module + '.ts');
    for (const [caller, module] of [
      ['useValueBesideType', 'direct-mixed'],
      ['useRuntimeStar', 'mixed-owners'],
      ['ambiguousCall', 'ambiguous'],
      ['reversedCall', 'reversed'],
    ]) {
      const actual = targets(entry, caller);
      const namespace = await load(module);
      if (!Object.hasOwn(namespace, 'publish')) assert.deepEqual(actual, []);
      else {
        assert.ok(origins.has(namespace.publish));
        assert.deepEqual(
          actual.map((target) => [target.properties.filePath, target.properties.name]),
          [[origins.get(namespace.publish), 'publish']],
        );
      }
    }
    const wrapper = await load('wrapped');
    assert.notEqual(wrapper.default, wrapper.exposed);
    const wrapped = targets(entry, 'wrapperDefault');
    const aliases = targets(barrels + '/entry.ts', 'wrapperAlias');
    assert.equal(wrapped.length, 1);
    assert.equal(aliases.length, 1);
    assert.notEqual(wrapped[0].id, aliases[0].id);
    const { filePath, startLine, startColumn } = wrapped[0].properties;
    assert.equal(filePath, barrels + '/wrapped.ts');
    const source = readFileSync(path.join(project, filePath), 'utf8').split('\n');
    assert.ok(
      source[startLine].slice(startColumn).startsWith('function ' + wrapper.default.name + '('),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
