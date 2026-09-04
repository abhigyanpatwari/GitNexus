import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebBuild, shouldBuildWeb, shouldPreserveWebOutput } from '../../scripts/build-web.js';

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
const PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'gitnexus/package.json'), 'utf8'),
) as { scripts?: Record<string, string> };
const tempDirs: string[] = [];

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

function buildFixture({ withWeb = true, withNodeModules = true } = {}) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-build-web-'));
  tempDirs.push(workspace);

  const root = path.join(workspace, 'gitnexus');
  const dist = path.join(root, 'dist');
  const webRoot = path.join(workspace, 'gitnexus-web');
  mkdirSync(dist, { recursive: true });

  if (withWeb) {
    mkdirSync(path.join(webRoot, 'dist', 'assets'), { recursive: true });
    writeFileSync(path.join(webRoot, 'package.json'), '{}');
    writeFileSync(
      path.join(webRoot, 'dist', 'index.html'),
      '<script src="/assets/app.js"></script>',
    );
    writeFileSync(path.join(webRoot, 'dist', 'assets', 'app.js'), 'export {};');
    if (withNodeModules) mkdirSync(path.join(webRoot, 'node_modules'));
  }

  return { root, dist, webRoot, webDest: path.join(root, 'web') };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('gitnexus build scripts', () => {
  it('keeps the default build CLI-only', () => {
    expect(PACKAGE_JSON.scripts?.build).toBe('node scripts/build.js');
    expect(PACKAGE_JSON.scripts?.prepare).toBe('node scripts/build.js');
    expect(PACKAGE_JSON.scripts?.prepare).not.toContain('--web');
  });

  it('builds the web UI from prepack, which is what ships the tarball', () => {
    expect(PACKAGE_JSON.scripts?.prepack).toContain('scripts/build.js --web');
    expect(PACKAGE_JSON.scripts?.prepack).toContain('scripts/assert-web-assets.mjs web');
    expect(PACKAGE_JSON.scripts?.['build:web']).toBe('node scripts/build.js --web');
  });

  it('recognizes only explicit CLI or environment opt-ins', () => {
    expect(shouldBuildWeb(['node', 'build.js'], {})).toBe(false);
    expect(shouldBuildWeb(['node', 'build.js', '--web'], {})).toBe(true);
    expect(shouldBuildWeb(['node', 'build.js'], { GITNEXUS_BUILD_WEB: '1' })).toBe(true);
    expect(shouldBuildWeb(['node', 'build.js'], { GITNEXUS_BUILD_WEB: 'true' })).toBe(false);
  });

  it('removes stale packaged output from a default build', () => {
    const fixture = buildFixture();
    mkdirSync(fixture.webDest, { recursive: true });
    writeFileSync(path.join(fixture.webDest, 'index.html'), 'stale');

    const exec = vi.fn();
    const result = runWebBuild({
      root: fixture.root,
      dist: fixture.dist,
      timeoutMs: 600_000,
      argv: ['node', 'build.js'],
      env: {},
      exec,
    });

    expect(result.status).toBe('skipped');
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(fixture.webDest)).toBe(false);
  });

  it('preserves prepack output during npm prepare for pack and publish', () => {
    for (const npmCommand of ['pack', 'publish']) {
      const fixture = buildFixture();
      mkdirSync(fixture.webDest, { recursive: true });
      writeFileSync(path.join(fixture.webDest, 'index.html'), npmCommand);

      expect(
        shouldPreserveWebOutput({
          npm_lifecycle_event: 'prepare',
          npm_command: npmCommand,
        }),
      ).toBe(true);
      runWebBuild({
        root: fixture.root,
        dist: fixture.dist,
        timeoutMs: 600_000,
        argv: ['node', 'build.js'],
        env: { npm_lifecycle_event: 'prepare', npm_command: npmCommand },
        exec: vi.fn(),
      });

      expect(readFileSync(path.join(fixture.webDest, 'index.html'), 'utf8')).toBe(npmCommand);
    }
  });

  it('fails closed when an explicit web build has no web package', () => {
    const fixture = buildFixture({ withWeb: false });
    expect(() =>
      runWebBuild({
        root: fixture.root,
        dist: fixture.dist,
        timeoutMs: 600_000,
        argv: ['node', 'build.js', '--web'],
        env: {},
        exec: vi.fn(),
      }),
    ).toThrow('web UI requested, but gitnexus-web was not found');
  });

  it('builds and copies the web UI with an untimed fallback install', () => {
    const fixture = buildFixture({ withNodeModules: false });
    const exec = vi.fn();

    const result = runWebBuild({
      root: fixture.root,
      dist: fixture.dist,
      timeoutMs: 123_456,
      argv: ['node', 'build.js', '--web'],
      env: {},
      exec,
    });

    expect(exec).toHaveBeenNthCalledWith(1, 'npm ci', {
      cwd: fixture.webRoot,
      stdio: 'inherit',
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'npm run build', {
      cwd: fixture.webRoot,
      stdio: 'inherit',
      timeout: 123_456,
    });
    expect(result.status).toBe('built');
    expect(readFileSync(path.join(fixture.webDest, 'index.html'), 'utf8')).toContain('app.js');
  });

  it('rejects a packaged web UI with missing referenced assets', () => {
    const fixture = buildFixture();
    const checker = path.join(REPO_ROOT, 'gitnexus/scripts/assert-web-assets.mjs');

    expect(spawnSync(process.execPath, [checker, path.join(fixture.webRoot, 'dist')]).status).toBe(
      0,
    );
    rmSync(path.join(fixture.webRoot, 'dist', 'assets', 'app.js'));

    const invalid = spawnSync(process.execPath, [checker, path.join(fixture.webRoot, 'dist')], {
      encoding: 'utf8',
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('references missing assets');
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

  it('packaged install smoke validates web assets in the installed tarball', () => {
    const steps = ciJobs['packaged-install-smoke']?.steps ?? [];
    const artifactCheck = steps.find((step) =>
      String(step.run ?? '').includes('scripts/assert-web-assets.mjs'),
    );
    expect(artifactCheck).toBeTruthy();
    expect(String(artifactCheck?.run)).toContain('$INSTALLED/web');
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
