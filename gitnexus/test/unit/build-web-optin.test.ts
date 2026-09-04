import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebBuild, shouldBuildWeb, shouldPreserveWebOutput } from '../../scripts/build-web.js';

/** Default prepare/build stay CLI-only; the web UI ships only via prepack --web. */
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
  env?: Record<string, unknown>;
  'working-directory'?: string;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

function jobs(workflowPath: string): Record<string, WorkflowJob> {
  const doc = load(readFileSync(path.join(REPO_ROOT, workflowPath), 'utf8')) as {
    jobs?: Record<string, WorkflowJob>;
  };
  return doc.jobs ?? {};
}

function compositeAction(actionPath: string): {
  inputs?: Record<string, { default?: string }>;
  runs?: { steps?: WorkflowStep[] };
} {
  return load(readFileSync(path.join(REPO_ROOT, actionPath), 'utf8')) as {
    inputs?: Record<string, { default?: string }>;
    runs?: { steps?: WorkflowStep[] };
  };
}

const ciJobs = jobs('.github/workflows/ci-tests.yml');
const publishJobs = jobs('.github/workflows/publish.yml');
const qualityJobs = jobs('.github/workflows/ci-quality.yml');
const setupGitnexus = compositeAction('.github/actions/setup-gitnexus/action.yml');
const setupGitnexusWeb = compositeAction('.github/actions/setup-gitnexus-web/action.yml');

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

const installsWeb = (step: WorkflowStep) =>
  step['working-directory'] === 'gitnexus-web' && String(step.run ?? '').includes('npm ci');

function runWeb(
  fixture: ReturnType<typeof buildFixture>,
  overrides: {
    timeoutMs?: number;
    argv?: string[];
    env?: NodeJS.Dict<string>;
    exec?: (...args: unknown[]) => unknown;
  } = {},
) {
  return runWebBuild({
    root: fixture.root,
    dist: fixture.dist,
    timeoutMs: 600_000,
    argv: ['node', 'build.js'],
    env: {},
    exec: vi.fn(),
    ...overrides,
  });
}

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
    const result = runWeb(fixture, { exec });

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
      runWeb(fixture, {
        env: { npm_lifecycle_event: 'prepare', npm_command: npmCommand },
      });

      expect(readFileSync(path.join(fixture.webDest, 'index.html'), 'utf8')).toBe(npmCommand);
    }
  });

  it('fails closed when an explicit web build has no web package', () => {
    const fixture = buildFixture({ withWeb: false });
    expect(() => runWeb(fixture, { argv: ['node', 'build.js', '--web'] })).toThrow(
      'web UI requested, but gitnexus-web was not found',
    );
  });

  it('builds and copies the web UI with an untimed fallback install', () => {
    const fixture = buildFixture({ withNodeModules: false });
    const exec = vi.fn();
    const result = runWeb(fixture, {
      timeoutMs: 123_456,
      argv: ['node', 'build.js', '--web'],
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

    const missingIndex = spawnSync(
      process.execPath,
      [checker, path.join(fixture.webRoot, 'none')],
      {
        encoding: 'utf8',
      },
    );
    expect(missingIndex.status).toBe(1);
    expect(missingIndex.stderr).toContain('missing');
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

  it('packaged install smoke skips a pre-pack CLI build and keeps a 20-minute budget', () => {
    const job = ciJobs['packaged-install-smoke'];
    const setup = job?.steps?.find((step) => step.uses === './.github/actions/setup-gitnexus');
    expect(job?.['timeout-minutes']).toBe(20);
    expect(setup?.with?.['lifecycle-scripts']).toBe('false');
    expect(setup?.with?.build).toBeUndefined();
  });
});

describe('setup-gitnexus job budget', () => {
  it('npm-ci installs gitnexus-shared without hashing it into the CLI npm cache key', () => {
    const setupNode = setupGitnexus.runs?.steps?.find((step) =>
      String(step.uses ?? '').startsWith('actions/setup-node@'),
    );
    const shared = setupGitnexus.runs?.steps?.find((step) => step.name === 'Build gitnexus-shared');
    expect(String(setupNode?.with?.['cache-dependency-path'])).toBe('gitnexus/package-lock.json');
    expect(String(shared?.run)).toContain('npm ci');
    expect(String(shared?.run)).not.toContain('npm install');
    expect(setupGitnexus.inputs?.['lifecycle-scripts']?.default).toBe('true');
    expect(
      setupGitnexus.runs?.steps?.some((step) =>
        String(step.run ?? '').includes('--ignore-scripts'),
      ),
    ).toBe(true);
  });

  it('setup-gitnexus-web keeps the web npm cache key and skips Playwright browsers', () => {
    const setupNode = setupGitnexusWeb.runs?.steps?.find((step) =>
      String(step.uses ?? '').startsWith('actions/setup-node@'),
    );
    const shared = setupGitnexusWeb.runs?.steps?.find(
      (step) => step.name === 'Build gitnexus-shared',
    );
    const webInstall = setupGitnexusWeb.runs?.steps?.find(
      (step) => step.name === 'Install web dependencies',
    );
    expect(String(setupNode?.with?.['cache-dependency-path'])).toBe(
      'gitnexus-web/package-lock.json',
    );
    expect(String(shared?.run)).toContain('npm ci');
    expect(webInstall?.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
  });

  it('quality typecheck skips prepare/postinstall so tsc --noEmit fits in 10 minutes', () => {
    const job = qualityJobs.typecheck;
    const setup = job?.steps?.find((step) => step.uses === './.github/actions/setup-gitnexus');
    expect(job?.['timeout-minutes']).toBe(10);
    expect(setup?.with?.['lifecycle-scripts']).toBe('false');
  });

  it('quality typecheck-web can finish a cold web install instead of canceling before cache save', () => {
    expect(qualityJobs['typecheck-web']?.['timeout-minutes']).toBe(15);
  });

  it('quality format matches lint budget and skips husky during npm ci', () => {
    const formatCi = qualityJobs.format?.steps?.find((step) =>
      String(step.run ?? '').includes('npm ci'),
    );
    const lintCi = qualityJobs.lint?.steps?.find((step) =>
      String(step.run ?? '').includes('npm ci'),
    );
    expect(qualityJobs.format?.['timeout-minutes']).toBe(10);
    expect(qualityJobs.lint?.['timeout-minutes']).toBe(10);
    expect(String(formatCi?.run)).toContain('--ignore-scripts');
    expect(String(lintCi?.run)).toContain('--ignore-scripts');
  });
});
