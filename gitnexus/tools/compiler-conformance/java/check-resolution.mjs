import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateLargePackages } from './large-packages.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-resolution-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const corpus = fileURLToPath(new URL('../../../test/fixtures/java-resolution/', import.meta.url));
const dirs = globSync('*/resolution.json', { cwd: corpus })
  .map((filename) => path.join(corpus, path.dirname(filename)))
  .filter((dir) => !process.argv[2] || path.basename(dir).includes(process.argv[2]))
  .sort(compareCodeUnits);
const recovered = new Map(
  Object.entries(
    JSON.parse(readFileSync(path.join(corpus, 'recovered-projects.json'), 'utf8')),
  ).map(([name, config]) => [path.resolve(corpus, '..', name), config]),
);
dirs.push(
  ...[...recovered.keys()].filter(
    (dir) => !process.argv[2] || path.basename(dir).includes(process.argv[2]),
  ),
);
dirs.push(...generateLargePackages(work, corpus, process.argv[2]));
const contracts = ['graph-contracts', 'lombok-contracts', 'overload-contracts'].filter(
  (name) => !process.argv[2] || name.includes(process.argv[2]),
);
assert.ok(dirs.length || contracts.length, 'No matching Java resolution projects');
assert.ok(path.isAbsolute(process.env.JAVA_HOME ?? ''), 'Set JAVA_HOME to an absolute JDK 21 path');
const java = path.join(
  process.env.JAVA_HOME,
  'bin',
  process.platform === 'win32' ? 'java.exe' : 'java',
);
const oracle = fileURLToPath(
  new URL('./org/gitnexus/conformance/RecoveryOracle.java', import.meta.url),
);
const fields = (
  dirs.length
    ? execFileSync(java, ['-Xmx512m', oracle, ...dirs], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
    : ''
).split('\0');
assert.equal(fields.pop(), '', 'Truncated javac report');
const references = new Map(
  dirs.map((dir) => [dir, { diagnostics: {}, methods: new Map(), calls: [], complete: false }]),
);
for (let i = 0; i < fields.length; ) {
  const dir = fields[i++];
  const kind = fields[i++];
  const ref = references.get(dir);
  assert.ok(ref, 'Unknown project in javac report');
  if (kind === 'error') {
    const code = fields[i++];
    ref.diagnostics[code] = (ref.diagnostics[code] ?? 0) + 1;
  } else if (kind === 'method') {
    const [location, filePath, , name] = fields.slice(i, i + 5);
    ref.methods.set(location, { filePath, name, label: 'Method' });
    i += 5;
  } else if (kind === 'call') {
    ref.calls.push({ from: fields[i++], name: fields[i++], to: fields[i++] });
  } else {
    assert.equal(kind, 'end', 'Unknown javac record');
    ref.complete = true;
  }
}

// Release the analysis workers and their native parsers between batches while reusing one javac report.
const runner = fileURLToPath(new URL('./resolution-batch.mjs', import.meta.url));
const input = path.join(work, 'batch.json');
const output = path.join(work, 'checks.json');
function runBatch(batch) {
  writeFileSync(input, JSON.stringify(batch));
  execFileSync(process.execPath, [runner, input, output], { stdio: 'inherit' });
  return JSON.parse(readFileSync(output, 'utf8'));
}
let checks = 0;
const batchSize = 12;
for (let i = 0; i < dirs.length; i += batchSize) {
  const projects = dirs.slice(i, i + batchSize).map((dir) => {
    const ref = references.get(dir);
    const spec =
      recovered.get(dir) ?? JSON.parse(readFileSync(path.join(dir, 'resolution.json'), 'utf8'));
    return { dir, ref: { ...ref, methods: [...ref.methods] }, spec };
  });
  checks += runBatch({ projects });
}
for (const contract of contracts) runBatch({ contract });
if (dirs.length) {
  console.log(dirs.length + ' Java resolution projects, ' + checks + ' compiler and graph checks');
}
