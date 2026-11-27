import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runRenameFixture } from '../../../../test/helpers/run-rename-fixture.js';

const root = path.resolve(import.meta.dirname, '../../../../test/fixtures/rename-integration/java');
const cases = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
assert.ok(cases.length, 'Missing Java rename fixtures');
for (const entry of cases) {
  test('persisted Java rename: ' + entry.name, { timeout: 180_000 }, () =>
    runRenameFixture(path.join(root, entry.name)),
  );
}
