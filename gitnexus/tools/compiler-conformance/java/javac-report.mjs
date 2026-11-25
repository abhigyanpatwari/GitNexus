import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function appendJavacRecord(report, kind, read) {
  switch (kind) {
    case 'diagnostic': {
      const [code] = read(1);
      report.diagnostics[code] = (report.diagnostics[code] ?? 0) + 1;
      return;
    }
    case 'binary': {
      const [file, start, end, name, target] = read(5);
      report.binarySites.push({ file, start, end, name, target, status: 'external' });
      return;
    }
    case 'reference': {
      const [targetKind, file, start, end, from, to] = read(6);
      assert.ok(
        targetKind === 'Method' || targetKind === 'Constructor',
        'Unknown reference target',
      );
      report.memberReferences.push({ file, start, end, from, to, targetKind });
      // GitNexus publishes member references as aggregate CALLS edges.
      const edges = targetKind === 'Constructor' ? report.constructors : report.edges;
      edges.push({ from, to });
      return;
    }
    case 'rejected-constructor': {
      const [file, start, status] = read(3);
      report.rejectedConstructors.push({ file, start, status });
      return;
    }
    case 'implementation': {
      const [from, to] = read(2);
      report.implementations.push({ from, to });
      return;
    }
    case 'constructor': {
      const [from, to] = read(2);
      report.constructors.push({ from, to });
      return;
    }
    case 'heritage': {
      const [relation, from, to] = read(3);
      report.heritage.push({ relation, from, to });
      return;
    }
    case 'declaration': {
      const [file, label, name, binaryName, qualifiedName] = read(5);
      report.declarations.push({
        file,
        kind: label,
        name,
        ...(binaryName && { binaryName, qualifiedName }),
      });
      return;
    }
    default: {
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
}

/** Return one reference report per fixture, in input order, using one JVM. */
export function javacReports(fixtures) {
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome && path.isAbsolute(javaHome), 'Set JAVA_HOME to an absolute JDK 21 path');
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const oracle = fileURLToPath(
    new URL('./org/gitnexus/conformance/OverloadOracle.java', import.meta.url),
  );
  const args = fixtures.flatMap(({ dir, families, constructors, implementations }) => [
    dir,
    [
      ...(families ?? ['*']),
      ...(constructors ? ['<init>'] : []),
      ...(implementations !== undefined ? ['<implements>'] : []),
    ].join(','),
  ]);
  const options = fixtures.some((fixture) => fixture.diagnostics)
    ? ['-Dgitnexus.conformance.reportDiagnostics=true']
    : [];
  const output = execFileSync(java, [...options, oracle, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const reports = fixtures.map(() => ({
    producer: 'javac',
    diagnostics: {},
    sites: [],
    binarySites: [],
    edges: [],
    memberReferences: [],
    declarations: [],
    heritage: [],
    implementations: [],
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
    appendJavacRecord(report, kind, read);
  }
  for (const [i, report] of reports.entries()) {
    assert.deepEqual(
      report.diagnostics,
      fixtures[i].diagnostics ?? {},
      'javac diagnostics for ' + fixtures[i].dir,
    );
  }
  return reports;
}

/** Include binary targets in the same method families as the source comparison. */
export function selectedJavacCalls(report, families) {
  const names = new Set(families);
  const allFamilies = names.delete('*');
  if (!families || allFamilies) {
    for (const declaration of report.declarations)
      if (declaration.kind === 'Method') names.add(declaration.name);
  }
  if (allFamilies) {
    for (const site of report.binarySites) names.add(site.name);
  }
  const binarySites = report.binarySites.filter((site) => names.has(site.name));
  return { names, binarySites, sites: [...report.sites, ...binarySites] };
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
    const selected = families.length ? families : undefined;
    const [report] = javacReports([{ dir, families: selected }]);
    const { sites, binarySites } = selectedJavacCalls(report, selected);
    console.log(JSON.stringify({ ...report, sites, binarySites }, null, 2));
  }
}
