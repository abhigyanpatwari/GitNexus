import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/build.js` must not build the web UI on the default path.
 *
 * gitnexus-web is a separate ~650-package tree (React, Vite, LangChain,
 * Mermaid). While `prepare` built it, every `npm ci` in gitnexus/ installed
 * and Vite-built a second product — uncached on CI, inside an execSync
 * timeout that SIGTERM'd healthy installs (`spawnSync /bin/sh ETIMEDOUT`,
 * killing the node-floor-compat job, which only import-links the CLI dist).
 * The web UI is only needed inside the published tarball, so it belongs to
 * prepack. Jobs that pack or publish install those deps in their own step.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUILD_JS = readFileSync(path.join(REPO_ROOT, 'gitnexus/scripts/build.js'), 'utf8');
const PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'gitnexus/package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

interface WorkflowStep {
  name?: string;
  run?: unknown;
  uses?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}

function jobs(workflowPath: string): Record<string, { steps?: WorkflowStep[] }> {
  const doc = load(readFileSync(path.join(REPO_ROOT, workflowPath), 'utf8')) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };
  return doc.jobs ?? {};
}

const ciJobs = jobs('.github/workflows/ci-tests.yml');
const publishJobs = jobs('.github/workflows/publish.yml');

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

const installsWeb = (step: WorkflowStep) =>
  step['working-directory'] === 'gitnexus-web' && String(step.run ?? '').includes('npm ci');

describe('gitnexus build scripts', () => {
  it('keeps the default build CLI-only', () => {
    expect(PACKAGE_JSON.scripts?.build).toBe('node scripts/build.js');
    expect(PACKAGE_JSON.scripts?.prepare).toBe('node scripts/build.js');
    expect(PACKAGE_JSON.scripts?.prepare).not.toContain('--web');
  });

  it('builds the web UI from prepack, which is what ships the tarball', () => {
    expect(PACKAGE_JSON.scripts?.prepack).toContain('scripts/build.js --web');
    expect(PACKAGE_JSON.scripts?.['build:web']).toBe('node scripts/build.js --web');
  });

  it('gates the web build behind an explicit opt-in', () => {
    expect(BUILD_JS).toContain("process.argv.includes('--web')");
    expect(BUILD_JS).toContain("process.env.GITNEXUS_BUILD_WEB === '1'");
  });

  it('never puts an execSync timeout on the fallback gitnexus-web install', () => {
    // A partially-killed `npm ci` leaves a broken tree and reports ETIMEDOUT
    // from /bin/sh, which reads as a build failure rather than a slow install.
    const webInstall = BUILD_JS.match(/execSync\('npm ci',[^)]*\)/);
    expect(webInstall, 'build.js should still be able to install gitnexus-web').toBeTruthy();
    expect(webInstall?.[0]).not.toContain('timeout');
  });
});

describe('workflows that need the web UI install it themselves', () => {
  it('packaged install smoke installs gitnexus-web before npm pack', () => {
    const steps = ciJobs['packaged-install-smoke']?.steps ?? [];
    const webIdx = stepIndex(steps, installsWeb);
    const packIdx = stepIndex(steps, (step) => String(step.run ?? '').includes('npm pack'));
    expect(webIdx).toBeGreaterThanOrEqual(0);
    expect(packIdx).toBeGreaterThan(webIdx);
  });

  it('publish installs gitnexus-web before it packs the tarball', () => {
    const steps = publishJobs['publish']?.steps ?? [];
    const webIdx = stepIndex(steps, installsWeb);
    const publishIdx = stepIndex(steps, (step) =>
      String(step.run ?? '').includes('npm publish --dry-run'),
    );
    expect(webIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThan(webIdx);
  });

  it('node floor compat stays CLI-only — it never installs the web tree', () => {
    const steps = ciJobs['node-floor-compat']?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter(installsWeb)).toHaveLength(0);
  });
});
