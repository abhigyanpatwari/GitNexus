import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Return one reference report per fixture, in input order, using one JVM. */
export function javacReports(fixtures) {
  const oracle = fileURLToPath(new URL('./OverloadOracle.java', import.meta.url));
  const args = fixtures.flatMap(({ dir, families }) => [dir, families.join(',')]);
  const output = execFileSync('java', [oracle, ...args], { encoding: 'utf8' });
  const reports = fixtures.map(() => ({ producer: 'javac', sites: [], edges: [] }));
  // Paths and signatures can contain tabs and newlines.
  const fields = output.split('\0');
  assert.equal(fields.pop(), '', 'Truncated javac record');
  const width = 7;
  assert.equal(fields.length % width, 0, 'Malformed javac record');
  for (let i = 0; i < fields.length; i += width) {
    const [fixture, file, start, end, caller, target, signature] = fields.slice(i, i + width);
    const report = reports[fixture];
    if (target === 'ambiguous') {
      report.sites.push({ file, start, end, status: 'ambiguous' });
    } else {
      report.sites.push({ file, start, end, status: 'resolved', target, description: signature });
      report.edges.push({ from: caller, to: target });
    }
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, ...families] = process.argv.slice(2);
  if (!dir || !families.length) {
    console.error(
      'Usage: node javac-report.mjs <fixture-directory> <method-name> [method-name ...]',
    );
    process.exitCode = 1;
  } else {
    const [report] = javacReports([{ dir, families }]);
    console.log(JSON.stringify(report, null, 2));
  }
}
