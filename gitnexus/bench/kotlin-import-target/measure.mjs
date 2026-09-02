/**
 * Declared-package correctness and scaling gate for Kotlin import resolution.
 *
 * The production resolver indexes the parsed workspace once per pass. This
 * benchmark pins the semantic cases path matching cannot express and verifies
 * that work remains linear as files and imports grow together.
 *
 * Run:
 *   node --import tsx bench/kotlin-import-target/measure.mjs
 *   node --import tsx bench/kotlin-import-target/measure.mjs --check
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'baselines.json'), 'utf8'));
const CHECK = process.argv.includes('--check');
const SMALL = 400;
const LARGE = 1600;
const IMPORTS_PER_FILE = 4;
const WARMUP = 2;
const REPS = 7;

function parsedFile(filePath, packageName, exports, imported = []) {
  const moduleScope = `module:${filePath}`;
  const localDefs = exports.map((name, i) => ({
    nodeId: `Declaration:${filePath}:${i}`,
    filePath,
    type: i === 0 ? 'Class' : 'Function',
    qualifiedName: name,
  }));
  const bindings = new Map(localDefs.map((def) => [def.qualifiedName, [{ def, origin: 'local' }]]));
  for (const name of imported) {
    bindings.set(name, [
      {
        def: {
          nodeId: `Declaration:dependency.kt:${name}`,
          filePath: 'dependency.kt',
          type: 'Class',
          qualifiedName: name,
        },
        origin: 'import',
      },
    ]);
  }
  return {
    filePath,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        filePath,
        bindings,
        ownedDefs: localDefs,
        imports: [],
        typeBindings: new Map(),
      },
    ],
    parsedImports: [],
    localDefs,
    referenceSites: [],
    captureSideChannel: {
      kind: 'kotlin',
      companionScopes: [],
      packageFact: packageName === null ? { status: 'unknown' } : { status: 'known', packageName },
      classAnnotations: [],
    },
  };
}

function prepare(parsedFiles) {
  kotlinScopeResolver.loadResolutionConfig?.('');
  for (const parsed of parsedFiles) kotlinScopeResolver.applyCaptureSideChannel?.(parsed);
  return {
    parsedFiles,
    allFilePaths: new Set(parsedFiles.map((file) => file.filePath)),
  };
}

function resolve(targetRaw, pass) {
  return kotlinScopeResolver.resolveImportTarget(
    targetRaw,
    pass.parsedFiles[0]?.filePath ?? 'app/Main.kt',
    pass.allFilePaths,
    undefined,
    {
      parsedFiles: pass.parsedFiles,
      parsedImport: { kind: 'named', localName: 'X', importedName: 'X', targetRaw },
      filesSkipped: 0,
    },
  );
}

function render(answer) {
  if (answer === null) return 'null';
  return typeof answer === 'string' ? answer : JSON.stringify(answer);
}

const correctness = [
  [
    [
      parsedFile('app/Main.kt', 'app', ['main']),
      parsedFile('src/main/kotlin/vendor/Assert.kt', 'vendor', ['Assert']),
    ],
    ['org.junit.Assert', 'vendor.Assert'],
  ],
  [
    [
      parsedFile('flat/UserSource.kt', 'com.example.model', ['User', 'loadUser']),
      parsedFile('other/Order.kt', 'com.example.model', ['Order']),
      parsedFile('odd/ToolsFile.kt', 'com.example', ['Tools']),
    ],
    [
      'com.example.model.User',
      'com.example.model.loadUser',
      'com.example.model.*',
      'com.example.Tools.format',
      'com.example.Tools.*',
      'com.example.model.Missing',
    ],
  ],
  [
    [
      parsedFile('one.kt', 'dup', ['parse']),
      parsedFile('two.kt', 'dup', ['parse']),
      parsedFile('Root.kt', '', ['Root']),
      parsedFile('Broken.kt', null, ['Broken']),
      parsedFile('app.kt', 'app', ['main'], ['External']),
    ],
    ['dup.parse', 'Root', 'broken.Broken', 'app.External'],
  ],
];

const records = [];
let nonNull = 0;
for (const [files, targets] of correctness) {
  for (const ordered of [files, [...files].reverse()]) {
    const pass = prepare(ordered);
    for (const target of targets) {
      const answer = render(resolve(target, pass));
      if (answer !== 'null') nonNull++;
      records.push(`${ordered.map((file) => file.filePath).join(',')}|${target}->${answer}`);
    }
  }
}
const fingerprint = crypto.createHash('sha256').update(records.sort().join('\n')).digest('hex');

function buildCorpus(fileCount, padDepth = 0) {
  const pad = Array.from({ length: padDepth }, (_, i) => `deep${i}`).join('/');
  const files = [];
  const packages = Math.max(1, Math.floor(fileCount / 8));
  for (let i = 0; i < fileCount; i++) {
    const pkg = i % packages;
    const prefix = pad === '' ? `mod${pkg}` : `mod${pkg}/${pad}`;
    files.push(
      parsedFile(
        `${prefix}/src/main/kotlin/com/example/pkg${pkg}/Source${i}.kt`,
        `com.example.pkg${pkg}`,
        [`File${i}`, `topLevel${i}`],
      ),
    );
  }
  return files;
}

function buildImports(fileCount) {
  const packages = Math.max(1, Math.floor(fileCount / 8));
  return Array.from({ length: fileCount * IMPORTS_PER_FILE }, (_, i) => {
    const file = i % fileCount;
    const pkg = file % packages;
    switch (i % 4) {
      case 0:
        return `com.example.pkg${pkg}.File${file}`;
      case 1:
        return `com.example.pkg${pkg}.topLevel${file}`;
      case 2:
        return `com.example.pkg${pkg}.*`;
      default:
        return `org.external.pkg${pkg}.Missing${i}`;
    }
  });
}

function timeResolution(fileCount, padDepth = 0) {
  const workspaces = Array.from({ length: WARMUP + REPS }, () => buildCorpus(fileCount, padDepth));
  const imports = buildImports(fileCount);
  const samples = [];
  for (let run = 0; run < workspaces.length; run++) {
    const pass = prepare(workspaces[run]);
    const start = performance.now();
    let sink = 0;
    for (const target of imports) if (resolve(target, pass) !== null) sink++;
    const elapsed = performance.now() - start;
    if (sink === 0) throw new Error('benchmark workload resolved nothing');
    if (run >= WARMUP) samples.push(elapsed);
  }
  return Math.min(...samples);
}

const smallMs = timeResolution(SMALL);
const largeMs = timeResolution(LARGE);
const deepMs = timeResolution(SMALL, 16);
const report = {
  fingerprint,
  cases: records.length,
  non_null: nonNull,
  small: { files: SMALL, imports: SMALL * IMPORTS_PER_FILE, ms: Number(smallMs.toFixed(3)) },
  large: { files: LARGE, imports: LARGE * IMPORTS_PER_FILE, ms: Number(largeMs.toFixed(3)) },
  scaling_ratio: Number((largeMs / smallMs / (LARGE / SMALL)).toFixed(3)),
  depth_ratio: Number((deepMs / smallMs).toFixed(3)),
};

console.log(JSON.stringify(report, null, 2));
if (!CHECK) process.exit(0);

const failures = [];
for (const key of ['fingerprint', 'cases', 'non_null']) {
  if (report[key] !== baseline[key]) failures.push(`${key}: ${report[key]} != ${baseline[key]}`);
}
if (report.scaling_ratio > baseline.scaling_budget) {
  failures.push(`scaling_ratio ${report.scaling_ratio} > ${baseline.scaling_budget}`);
}
if (report.depth_ratio > baseline.depth_budget) {
  failures.push(`depth_ratio ${report.depth_ratio} > ${baseline.depth_budget}`);
}
if (report.small.ms > baseline.small_ms_ceiling) {
  failures.push(`small.ms ${report.small.ms} > ${baseline.small_ms_ceiling}`);
}

if (failures.length > 0) {
  console.error(`[kotlin-import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[kotlin-import-target --check] PASS');
