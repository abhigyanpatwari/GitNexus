import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function position(value) {
  assert.ok(
    typeof value === 'string' && /^[1-9]\d*:(?:0|[1-9]\d*)$/.test(value),
    `Expected line:column, received ${JSON.stringify(value)}`,
  );
  const pair = value.split(':').map(Number);
  assert.ok(pair.every(Number.isSafeInteger), `Position out of range: ${value}`);
  return pair;
}

function facts(report) {
  assert.ok(Array.isArray(report?.sites), 'A report needs a sites array');
  const result = new Map();
  for (const { file, start, end, status, target, description } of report.sites) {
    assert.ok(text(file) && text(status), 'A site needs a file and status');
    const [line, col] = position(start);
    const [endLine, endCol] = position(end);
    assert.ok(
      line < endLine || (line === endLine && col < endCol),
      `Invalid range in ${file}: ${start}..${end}`,
    );
    if (status === 'resolved' || target !== undefined)
      assert.ok(text(target), 'Expected a declaration in target');
    const key = JSON.stringify(['site', file, start, end, status, target]);
    const detail = description ? ` (${description})` : '';
    result.set(key, `${file}:${start}..${end} ${status} ${target ?? ''}${detail}`.trimEnd());
  }
  if (report.edges !== undefined) {
    assert.ok(Array.isArray(report.edges), 'Expected an edges array');
    for (const { from, to } of report.edges) {
      assert.ok(text(from) && text(to), 'An edge needs from and to declarations');
      result.set(JSON.stringify(['edge', from, to]), `edge ${from} -> ${to}`);
    }
  }
  return result;
}

/** Compare source-site outcomes and, when supplied, the emitted call graph. */
export function compareReports(expected, actual) {
  const reference = facts(expected);
  const observed = facts(actual);
  assert.ok(expected.sites.length > 0, 'The reference report contains no call sites');
  assert.equal(
    expected.edges !== undefined,
    actual.edges !== undefined,
    'Supply edges in both reports or omit them in both',
  );
  const differences = [];
  for (const [key, display] of reference) {
    if (!observed.has(key))
      differences.push(`Missing from ${actual.producer ?? 'actual'}: ${display}`);
  }
  for (const [key, display] of observed) {
    if (!reference.has(key))
      differences.push(`Unexpected in ${actual.producer ?? 'actual'}: ${display}`);
  }
  if (differences.length) throw new Error(differences.sort().join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const paths = process.argv.slice(2);
    assert.equal(paths.length, 2, 'Usage: node compare.mjs expected.json actual.json');
    const [expected, actual] = paths.map((file) => JSON.parse(readFileSync(file, 'utf8')));
    compareReports(expected, actual);
    console.log('Conformance reports match.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
