import assert from 'node:assert/strict';
import { compareCodeUnits, compareStringTuples } from '../compare.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { isCommonJsExportAssignment } from '../../../dist/core/ingestion/languages/typescript/cjs-export-receiver.js';
import { typescriptModuleExports } from '../../../dist/core/ingestion/languages/typescript/module-exports.js';

export async function checkCommonJsForwarding() {
  const project = fileURLToPath(
    new URL('../../../test/fixtures/typescript-commonjs-forwarding/', import.meta.url),
  );
  const emitted = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-cjs-forwarding-'));
  try {
    const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
    execFileSync(process.execPath, [cli, '--project', project, '--outDir', emitted]);
    const load = createRequire(path.join(emitted, 'consumer.js'));
    const source = load('./source.js');
    const forward = load('./forward.js');
    const names = new Map(Object.entries(source).map(([key, value]) => [value, key]));
    const whole = load('./callers/whole.js');
    const withImport = load('./callers/with-import.js');
    const shadow = load('./callers/shadow.cjs');
    const localModule = await import(
      pathToFileURL(path.join(emitted, 'callers/local-module.mjs')).href
    );
    const surfaces = new Map();
    const { graph } = await runPipelineFromRepo(project, () => {}, {
      onScopeResolved({ parsedFiles }) {
        for (const file of parsedFiles) {
          if (file.filePath.startsWith('callers/')) {
            surfaces.set(
              file.filePath.slice('callers/'.length),
              [...typescriptModuleExports(file)].map(([key, definition]) => [
                key,
                definition.qualifiedName,
              ]),
            );
          }
        }
      },
    });
    assert.equal(typeof whole, 'function');
    assert.deepEqual(surfaces.get('whole.ts'), [['default', whole.name]]);
    assert.deepEqual(surfaces.get('with-import.ts'), [['default', withImport.name]]);
    assert.deepEqual(surfaces.get('local-module.mts'), Object.entries(localModule));
    assert.deepEqual(surfaces.get('shadow.cts'), Object.entries(shadow));
    const observed = [];
    for (const edge of graph.iterRelationshipsByType('CALLS')) {
      const node = graph.getNode(edge.sourceId);
      if (node.label !== 'Function') continue;
      const caller = node.properties;
      if (caller.filePath !== 'consumer.ts' && caller.filePath !== 'direct.ts') continue;
      const target = graph.getNode(edge.targetId).properties;
      observed.push([caller.name, target.filePath, target.name]);
    }
    const expected = [];
    for (const [caller, value] of [
      ['callChanged', forward.changed],
      ['callStable', forward.stable],
      ['callRenamedChanged', forward.renamedChanged],
      ['callRenamedStable', forward.renamedStable],
      ['callArrow', source.arrow],
      ['callHidden', source.privateHelper],
    ]) {
      if (names.has(value)) expected.push([caller, 'source.ts', names.get(value)]);
    }
    assert.deepEqual(
      observed.toSorted(compareStringTuples),
      expected.toSorted(compareStringTuples),
    );
  } finally {
    rmSync(emitted, { recursive: true, force: true });
  }
}

/** Compare real ESM namespace keys and imported call targets across both grammar providers. */
export async function checkNativeEsmExports() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-native-esm-'));
  const src = path.join(root, 'src');
  const out = path.join(root, 'out');
  const formats = [
    ['mjs', 'mjs'],
    ['mts', 'mjs'],
    ['js', 'js'],
    ['ts', 'js'],
  ];
  try {
    mkdirSync(src);
    writeFileSync(path.join(src, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(src, 'globals.d.ts'), 'declare const module: { exports: any };');
    writeFileSync(
      path.join(src, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          target: 'es2022',
          types: [],
          allowJs: true,
          outDir: out,
        },
      }),
    );
    const fixture = new URL('../../../test/fixtures/typescript-native-esm/', import.meta.url);
    for (const [ext, target] of formats) {
      const directory = path.join(src, ext);
      mkdirSync(directory);
      for (const name of ['api', 'empty', 'barrel', 'use']) {
        const source = readFileSync(new URL(name + '.mjs', fixture), 'utf8');
        writeFileSync(
          path.join(directory, name + '.' + ext),
          source.replaceAll('.mjs', '.' + target),
        );
      }
    }
    for (const ext of ['cjs', 'cts']) {
      writeFileSync(
        path.join(src, 'legacy-' + ext + '.' + ext),
        'module.exports = function cjsOnly() {};',
      );
    }
    const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
    execFileSync(process.execPath, [cli, '--project', src]);
    cpSync(path.join(src, 'package.json'), path.join(out, 'package.json'));
    const exportsByFile = new Map();
    const { graph } = await runPipelineFromRepo(src, () => {}, {
      onScopeResolved({ parsedFiles, indexes }) {
        for (const file of parsedFiles) {
          exportsByFile.set(
            file.filePath,
            [...typescriptModuleExports(file).keys()].sort(compareCodeUnits),
          );
          if (!file.filePath.includes('/empty.')) continue;
          const writes = file.referenceSites.filter(
            (site) => site.kind === 'write' && site.name === 'value',
          );
          assert.equal(writes.length, 1, file.filePath);
          assert.equal(isCommonJsExportAssignment(writes[0], indexes, file), false, file.filePath);
        }
      },
    });
    for (const ext of ['cjs', 'cts']) {
      const legacy = await import(pathToFileURL(path.join(out, 'legacy-' + ext + '.cjs')).href);
      assert.equal(legacy.default.name, 'cjsOnly');
      assert.deepEqual(exportsByFile.get('legacy-' + ext + '.' + ext), ['default']);
    }
    for (const [ext, target] of formats) {
      const load = (name) => import(pathToFileURL(path.join(out, ext, name + '.' + target)).href);
      const api = await load('api');
      const barrel = await load('barrel');
      assert.deepEqual(exportsByFile.get(ext + '/empty.' + ext), Object.keys(await load('empty')));
      const consumer = await load('use');
      assert.deepEqual([consumer.probeDefault(), consumer.probeHidden()], [undefined, undefined]);
      const apiFile = ext + '/api.' + ext;
      assert.deepEqual(Object.keys(api), ['default', 'direct', 'renamed']);
      assert.deepEqual(Object.keys(barrel), ['direct', 'forwarded', 'renamed']);
      assert.deepEqual(exportsByFile.get(apiFile), Object.keys(api), apiFile);
      const actual = [];
      for (const edge of graph.iterRelationshipsByType('CALLS')) {
        const caller = graph.getNode(edge.sourceId);
        if (caller?.label !== 'Function' || caller.properties.filePath !== ext + '/use.' + ext)
          continue;
        const callee = graph.getNode(edge.targetId).properties;
        actual.push([caller.properties.name, callee.filePath, callee.name]);
      }
      assert.deepEqual(
        actual.toSorted(compareStringTuples),
        [
          ['useAlias', apiFile, api.renamed.name],
          ['useDefault', apiFile, api.default.name],
          ['useForward', apiFile, barrel.forwarded.name],
          ['useStar', apiFile, barrel.direct.name],
        ],
        apiFile,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function checkNodeModuleFormat() {
  const fixture = fileURLToPath(
    new URL('../../../test/fixtures/typescript-commonjs-forwarding/', import.meta.url),
  );
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-node-format-'));
  const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
  try {
    for (const type of ['commonjs', 'module']) {
      const project = path.join(root, type);
      const out = path.join(root, type + '-output');
      cpSync(path.join(fixture, 'callers'), project, { recursive: true });
      cpSync(path.join(fixture, 'globals.d.ts'), path.join(project, 'globals.d.ts'));
      writeFileSync(path.join(project, 'package.json'), JSON.stringify({ type }));
      writeFileSync(
        path.join(project, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'nodenext', target: 'es2022', types: [] },
          files: ['with-import.ts', 'helper.ts', 'globals.d.ts'],
        }),
      );
      execFileSync(process.execPath, [cli, '--project', project, '--outDir', out]);
      cpSync(path.join(project, 'package.json'), path.join(out, 'package.json'));
      const loaded = import(pathToFileURL(path.join(out, 'with-import.js')).href);
      let expected = [];
      if (type === 'commonjs') expected = [['default', (await loaded).default.name]];
      else await assert.rejects(loaded, /module is not defined/u);
      let actual;
      await runPipelineFromRepo(project, () => {}, {
        onScopeResolved({ parsedFiles }) {
          const file = parsedFiles.find((file) => file.filePath === 'with-import.ts');
          if (file)
            actual = [...typescriptModuleExports(file)].map(([name, def]) => [
              name,
              def.qualifiedName,
            ]);
        },
      });
      assert.deepEqual(actual, expected, type);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function emittedDiagnosticCodes(output) {
  return Array.from(output.matchAll(/error TS(\d+):/g), ([, code]) => Number(code)).sort(
    (left, right) => left - right,
  );
}

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
    assert.deepEqual(
      emittedDiagnosticCodes(build.stdout),
      [2308, 2308, 2308, 2308, 2308, 2693],
      build.stdout,
    );
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
