import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Return one reference report per fixture, in input order, using one JVM. */
export function javacReports(fixtures) {
  const oracle = fileURLToPath(new URL('./OverloadOracle.java', import.meta.url));
  const args = fixtures.flatMap(({ dir, families, constructors }) => [
    dir,
    [...(families ?? ['*']), ...(constructors ? ['<init>'] : [])].join(','),
  ]);
  const output = execFileSync('java', [oracle, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const reports = fixtures.map(() => ({
    producer: 'javac',
    sites: [],
    edges: [],
    declarations: [],
    heritage: [],
    constructors: [],
  }));
  // Paths and signatures can contain tabs and newlines.
  const fields = output.split('\0');
  assert.equal(fields.pop(), '', 'Truncated javac record');
  let cursor = 0;
  function read(count) {
    assert.ok(cursor + count <= fields.length, 'Truncated javac record');
    const record = fields.slice(cursor, cursor + count);
    cursor += count;
    return record;
  }
  while (cursor < fields.length) {
    const [fixture, kind] = read(2);
    const report = reports[fixture];
    assert.ok(report, 'Unknown javac fixture ' + fixture);
    if (kind === 'constructor') {
      const [from, to] = read(2);
      report.constructors.push({ from, to });
    } else if (kind === 'heritage') {
      const [relation, from, to] = read(3);
      report.heritage.push({ relation, from, to });
    } else if (kind === 'declaration') {
      const [file, label, name, binaryName] = read(4);
      report.declarations.push({ file, kind: label, name, ...(binaryName && { binaryName }) });
    } else {
      assert.ok(
        ['resolved', 'ambiguous', 'inapplicable'].includes(kind),
        'Unknown javac record ' + kind,
      );
      const [file, start, end, caller, target, description] = read(6);
      const site = { file, start, end, status: kind };
      if (kind === 'resolved') {
        report.sites.push({ ...site, target, description });
        report.edges.push({ from: caller, to: target });
      } else {
        report.sites.push(site);
      }
    }
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, ...families] = process.argv.slice(2);
  if (!dir) {
    console.error('Usage: node javac-report.mjs <fixture-directory> [method-name ...]');
    process.exitCode = 1;
  } else {
    const [report] = javacReports([{ dir, families: families.length ? families : undefined }]);
    console.log(JSON.stringify(report, null, 2));
  }
}
