import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Return one reference report per fixture, in input order, using one JVM. */
export function javacReports(fixtures) {
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome && path.isAbsolute(javaHome), 'Set JAVA_HOME to an absolute JDK 21 path');
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const oracle = fileURLToPath(new URL('./OverloadOracle.java', import.meta.url));
  const args = fixtures.flatMap(({ dir, families, constructors }) => [
    dir,
    [...(families ?? ['*']), ...(constructors ? ['<init>'] : [])].join(','),
  ]);
  const output = execFileSync(java, [oracle, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const reports = fixtures.map(() => ({
    producer: 'javac',
    sites: [],
    edges: [],
    memberReferences: [],
    declarations: [],
    heritage: [],
    constructors: [],
    rejectedConstructors: [],
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
    if (kind === 'reference') {
      const [targetKind, file, start, end, from, to] = read(6);
      assert.ok(
        targetKind === 'Method' || targetKind === 'Constructor',
        'Unknown reference target',
      );
      report.memberReferences.push({ file, start, end, from, to, targetKind });
      // GitNexus publishes member references as aggregate CALLS edges.
      const edges = targetKind === 'Constructor' ? report.constructors : report.edges;
      edges.push({ from, to });
    } else if (kind === 'rejected-constructor') {
      const [file, start, status] = read(3);
      report.rejectedConstructors.push({ file, start, status });
    } else if (kind === 'constructor') {
      const [from, to] = read(2);
      report.constructors.push({ from, to });
    } else if (kind === 'heritage') {
      const [relation, from, to] = read(3);
      report.heritage.push({ relation, from, to });
    } else if (kind === 'declaration') {
      const [file, label, name, binaryName, qualifiedName] = read(5);
      report.declarations.push({
        file,
        kind: label,
        name,
        ...(binaryName && { binaryName, qualifiedName }),
      });
    } else {
      assert.ok(
        ['resolved', 'ambiguous', 'inapplicable', 'receiver-unresolved'].includes(kind),
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

// The standalone javac report uses binary names. Compare its type endpoints
// in the same spelling Java publishes for source types with a canonical name.
export function qualifiedJavacReport(report) {
  const names = new Map();
  for (const { file, kind, name, binaryName, qualifiedName } of report.declarations) {
    if (binaryName)
      names.set(
        file + '#' + binaryName,
        file + '#' + (kind === 'Annotation' ? '@' + name : qualifiedName),
      );
  }
  const qualify = (edge) => ({
    ...edge,
    from: names.get(edge.from) ?? edge.from,
    to: names.get(edge.to) ?? edge.to,
  });
  return {
    ...report,
    edges: report.edges.map(qualify),
    constructors: report.constructors.map(qualify),
    heritage: report.heritage.map(qualify),
    memberReferences: report.memberReferences.map(qualify),
  };
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
