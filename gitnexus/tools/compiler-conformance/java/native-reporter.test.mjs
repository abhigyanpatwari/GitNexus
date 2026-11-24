import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('native conformance fails on skipped cases, todos, and empty suites or files', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitnexus-conformance-reporter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = path.join(dir, 'cases.mjs');
  const empty = path.join(dir, 'empty.mjs');
  writeFileSync(empty, '');
  writeFileSync(
    cases,
    [
      "import { describe, it } from 'node:test';",
      "it('executed', () => {});",
      "it.skip('skipped case', () => {});",
      "it.todo('pending case');",
      "describe('empty suite', () => {});",
      "describe('populated suite', () => { it('child', () => {}); });",
    ].join('\n'),
  );
  const env = { ...process.env, GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify([cases, empty]) };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=' + new URL('./native-reporter.mjs', import.meta.url).href,
      cases,
      empty,
    ],
    { env, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Empty suite: populated suite/);
  for (const failure of [
    'Skipped or todo: skipped case',
    'Skipped or todo: pending case',
    'Empty suite: empty suite',
    'No tests executed: ' + empty,
  ])
    assert.ok(result.stderr.includes(failure), result.stderr);
});
