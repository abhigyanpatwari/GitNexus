import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const workflow = new URL('../../../../../.github/workflows/sonarqube.yml', import.meta.url);
const { jobs } = load(readFileSync(workflow, 'utf8')) as {
  jobs: { build: { steps: Array<{ name: string; run?: string }> } };
};
const steps = jobs.build.steps;
const packages = ['gitnexus', 'gitnexus-web'];
for (const scenario of [
  'complete',
  'missing web',
  'empty web',
  'unknown source',
  'outside package',
]) {
  test(
    `prepares both package reports only for a complete checkout (${scenario})`,
    { skip: process.platform === 'win32' },
    (t) => {
      const temp = mkdtempSync(path.join(tmpdir(), 'sonar-coverage-'));
      t.after(() => rmSync(temp, { recursive: true, force: true }));
      for (const pkg of packages) {
        const source = path.join(temp, pkg, 'src');
        mkdirSync(source, { recursive: true });
        writeFileSync(path.join(source, 'index.ts'), 'export const n = 1;');
        if (pkg === 'gitnexus-web' && scenario === 'missing web') continue;
        const reports = path.join(temp, 'sonar-coverage', pkg, 'coverage');
        mkdirSync(reports, { recursive: true });
        let sf = pkg === 'gitnexus-web' && scenario === 'unknown source' ? 'absent.ts' : 'index.ts';
        if (pkg === 'gitnexus-web' && scenario === 'outside package')
          sf = '../../gitnexus/src/index.ts';
        const data = pkg === 'gitnexus-web' && scenario === 'empty web' ? '' : 'DA:1,0\n';
        writeFileSync(path.join(reports, 'lcov.info'), `SF:src/${sf}\n${data}end_of_record\n`);
      }
      const prepare = steps.find((step) => step.name === 'Prepare repository-relative LCOV')?.run;
      if (!prepare) throw new Error('The LCOV preparation step must run a shell script');
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', prepare], {
        cwd: temp,
        env: { ...process.env, RUNNER_TEMP: temp },
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (scenario === 'complete') {
        assert.equal(result.status, 0, result.stderr);
        const lcov = readFileSync(path.join(temp, 'coverage', 'lcov.info'), 'utf8');
        assert.deepEqual(
          lcov.match(/^SF:.*$/gm),
          packages.map((pkg) => `SF:${pkg}/src/index.ts`),
        );
        assert.equal(lcov.match(/^DA:1,0$/gm)?.length, 2);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /::error::/);
      }
    },
  );
}
