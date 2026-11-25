import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FixtureProfiler } from '../../../../scenario-map/facet/fixture-profile.js';

test('profiles a Java fixture with the ingestion provider', async () => {
  const file = 'Sample.java';
  const fixture = new URL(
    '../../../../../test/fixtures/compiler-conformance/java-fixture-profile/Sample.java',
    import.meta.url,
  );
  const profiler = new FixtureProfiler({
    list: () => [],
    read: (name) => (name === file ? readFileSync(fixture, 'utf8') : null),
  });
  const profile = await profiler.profile([file]);
  assert.deepEqual(profile.unresolved, []);
  assert.deepEqual(profile.languages, ['java']);
  assert.ok(profile.features.some(([feature]) => feature.startsWith('def:')));
  assert.notEqual(profile.contentKey, null);
});
