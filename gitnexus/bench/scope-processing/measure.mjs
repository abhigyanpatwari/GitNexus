/** #3915: each cell runs in a fresh process; counts gate the repeated work
 * independently of timings. Run after npm run build:
 * node --import tsx bench/scope-processing/measure.mjs --check
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildScopeTree, createEagerImportVisibility, finalize } from 'gitnexus-shared';
import { createNamespaceTargetCache } from '../../src/core/ingestion/scope-resolution/scope/namespace-target-cache.ts';
import { dartScopeResolver } from '../../src/core/ingestion/languages/dart/scope-resolver.ts';
import { rubyScopeResolver } from '../../src/core/ingestion/languages/ruby/scope-resolver.ts';
import { emitDartScopeCaptures } from '../../src/core/ingestion/languages/dart/captures.ts';
import { emitRubyScopeCaptures } from '../../src/core/ingestion/languages/ruby/captures.ts';
import { captureWork } from '../dart-closure-binders/capture-work.mjs';

const script = fileURLToPath(import.meta.url);
const marker = 'SCOPE_PROCESSING_RESULT ';
const forms = ['namespace', 'dart-bindings', 'ruby-bindings', 'ruby-calls', 'dart-initializers'];
const sizes = [16, 32, 64, 128];

function prepare(form, n) {
  if (form === 'namespace') {
    const range = { startLine: 1, startCol: 0, endLine: 1000, endCol: 0 };
    const scope = (id, parent, imports = []) => ({
      id,
      parent,
      range,
      filePath: 'app.dart',
      kind: parent === null ? 'Module' : 'Function',
      imports,
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [],
    });
    const module = scope(
      'module',
      null,
      Array.from({ length: n }, (_, i) => ({
        kind: 'namespace',
        localName: `p${i}`,
        targetFile: `${i}.dart`,
        targetExportedName: '',
      })),
    );
    const functions = Array.from({ length: n }, (_, i) => ({
      ...scope(`f${i}`, module.id),
      range: { startLine: i + 2, startCol: 0, endLine: i + 2, endCol: 10 },
    }));
    const all = [module, ...functions];
    const indexes = {
      scopeTree: buildScopeTree(all),
      bindings: new Map(),
      bindingAugmentations: new Map(),
      imports: createEagerImportVisibility(new Map(all.map((s) => [s.id, s.imports]))),
    };
    return () => {
      let visits = 0;
      const cache = createNamespaceTargetCache(
        { moduleScope: module.id, scopes: all },
        indexes,
        {
          receiverPaths: () => {
            visits++;
          },
        },
        false,
      );
      const first = cache.at(module.id);
      assert.equal(first.size, n);
      for (const fn of functions) assert.equal(cache.at(fn.id), first);
      assert.equal(visits, n, 'one prefix visit per file, not per function');
      return { work: visits, outputs: first.size };
    };
  }
  if (form.endsWith('-bindings')) {
    // One same-spelled method per class; each scale unit adds eight classes
    // to the same module, so all incoming methods share one name bucket.
    const count = n * 8;
    const refs = Array.from({ length: count }, (_, i) => ({
      def: {
        nodeId: `m${String(i).padStart(5, '0')}`,
        type: 'Method',
        filePath: 'app',
        name: 'run',
        qualifiedName: `C${i}.run`,
        ownerId: `c${i}`,
      },
      origin: 'local',
    }));
    const file = {
      filePath: 'app',
      moduleScope: 'module',
      moduleBindings: new Map(),
      localDefs: refs.map((ref) => ref.def),
      parsedImports: [],
    };
    // The merge hook and its associativity opt-in are the provider's own, as
    // the pipeline forwards them: a provider that stops opting in fails here.
    const resolver = form === 'dart-bindings' ? dartScopeResolver : rubyScopeResolver;
    return () => {
      let visits = 0;
      const result = finalize(
        { files: [file], workspaceIndex: undefined },
        {
          resolveImportTarget: () => null,
          expandsWildcardTo: () => [],
          mergeBindingsAreAssociative: resolver.mergeBindingsAreAssociative,
          mergeBindings: (existing, incoming, scopeId) => {
            visits += existing.length + incoming.length;
            return resolver.mergeBindings(existing, incoming, scopeId);
          },
        },
      );
      const actual = result.bindings.get('module').get('run');
      assert.deepEqual(
        actual.map((ref) => ref.def.nodeId),
        refs.map((ref) => ref.def.nodeId),
      );
      assert.equal(visits, count, 'each binding enters its merge once');
      return { work: visits, outputs: actual.length };
    };
  }
  let source;
  let emit;
  let output;
  if (form === 'ruby-calls') {
    source = 'class Host\ndef run(target)\n';
    for (let i = 0; i < n; i++)
      source += `[1].each do |x${String(i).padStart(4, '0')}|\nhelper${String(i).padStart(4, '0')}()\n`;
    source += 'end\n'.repeat(n) + 'end\nend\n';
    emit = emitRubyScopeCaptures;
    output = (matches) =>
      matches.filter((m) => /^helper\d+$/.test(m['@reference.name']?.text ?? '')).length;
  } else {
    source = 'class Value {}\nvoid run() {\n';
    for (let i = 0; i < n; i++) source += `{ final v${String(i).padStart(4, '0')} = Value();\n`;
    source += '}\n'.repeat(n + 1);
    emit = emitDartScopeCaptures;
    output = (matches) =>
      matches.filter((m) => m['@type-binding.constructor'] !== undefined).length;
  }
  const file = { path: form === 'ruby-calls' ? 'app.rb' : 'app.dart', content: source };
  const run = () => {
    const matches = emit(source, file.path);
    assert.equal(output(matches), n, 'every surviving call/initializer must still be emitted');
    return { outputs: n, input_bytes: Buffer.byteLength(source) };
  };
  run.count = () => captureWork([file], emit);
  return run;
}

function cell(form, size) {
  const run = prepare(form, size);
  const counts = run.count?.();
  let result;
  const times = [];
  for (let round = 0; round < 8; round++) {
    const start = performance.now();
    for (let repeat = 0; repeat < 5; repeat++) result = run();
    if (round >= 2) times.push((performance.now() - start) / 5);
  }
  return {
    form,
    size,
    ...result,
    counts,
    ms: Math.min(...times),
    peak_rss_kib: process.resourceUsage().maxRSS,
  };
}

if (process.argv.includes('--cell')) {
  const offset = process.argv.indexOf('--cell');
  console.log(
    marker + JSON.stringify(cell(process.argv[offset + 1], Number(process.argv[offset + 2]))),
  );
} else {
  const results = [];
  for (const form of forms) {
    const cells = sizes.map((size) => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', script, '--cell', form, String(size)],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(child.status, 0, `${form}/${size}: ${child.error ?? child.stderr}`);
      const row = child.stdout.split('\n').find((line) => line.startsWith(marker));
      assert.ok(row, `${form}/${size}: no measurement receipt`);
      return JSON.parse(row.slice(marker.length));
    });
    const first = cells[0],
      last = cells.at(-1);
    const growth = last.size / first.size;
    const ratio = last.ms / first.ms / growth;
    if (process.argv.includes('--check')) {
      if (first.counts !== undefined) {
        for (const key of ['parent_reads', 'sibling_reads', 'child_reads', 'map_visits']) {
          assert.ok(
            last.counts[key] <= first.counts[key] * growth * 1.1,
            `${form}: ${key} grew faster than input: ${first.counts[key]} -> ${last.counts[key]}`,
          );
        }
      }
      // An eightfold size increase makes a quadratic pass about 8 here.
      // Counts above remain decisive even when timings are below the noise floor.
      assert.ok(ratio <= 2.5, `${form}: normalized timing growth ${ratio} > 2.5`);
    }
    results.push({ form, normalized_time_growth: ratio, cells });
  }
  console.log(marker + JSON.stringify({ node: process.version, results }));
}
