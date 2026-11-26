import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { compareReports } from '../../compare.mjs';
import { compareProject } from '../check.mjs';
import { runtimeCalls } from '../runtime-calls.mjs';

const manifest = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'));
const diagnostics = JSON.parse(
  readFileSync(new URL('../diagnostics.json', import.meta.url), 'utf8'),
);
for (const [project, entryPoint] of Object.entries(manifest.runtimeDispatch)) {
  test('GitNexus infers the methods invoked by Node in ' + project, async () => {
    const root = path.resolve(import.meta.dirname, '../../../../test/fixtures', project);
    const { runtime } = await compareProject(root, {}, diagnostics[project]);
    assert.ok(runtime, 'Expected compiler-unresolved call sites in ' + project);
    const trace = runtimeCalls(root, runtime.evidence, entryPoint);
    compareReports(
      { producer: 'Node.js', sites: trace.sites },
      { producer: 'GitNexus resolver', sites: runtime.observed.bindings },
    );
    compareReports(
      { producer: 'Node.js', ...trace },
      { producer: 'GitNexus', ...runtime.observed },
    );
    if (project === 'lang-resolution/typescript-double-cast-inference') {
      const [user, repo] = trace.sites;
      assert.equal(trace.sites.length, 2);
      assert.notEqual(user.target, repo.target);
      const swapped = [
        { ...user, target: repo.target },
        { ...repo, target: user.target },
      ];
      assert.throws(
        () => compareReports(trace, { ...trace, sites: swapped }),
        /Missing from actual/,
      );
    }
  });
}
