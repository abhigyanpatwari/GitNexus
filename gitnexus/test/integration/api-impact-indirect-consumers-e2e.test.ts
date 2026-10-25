/**
 * #3644, end to end: a real analyze of a small repository, then `api_impact`
 * through LocalBackend. The requesting functions sit in src/client.ts; their
 * callers never mention the URL. One request shares its line with a helper
 * (`const decode = …; return fetch(…).then(decode);`), which a line-only
 * attribution handed to the helper, dropping the callers of fetchFile.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'lang-resolution',
  'api-impact-indirect-consumers',
);

describe('api_impact indirect consumers through a real analyze (#3644)', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let backend: LocalBackend;

  beforeAll(async () => {
    temp = await createTempDir();
    const root = await fs.realpath(temp.dbPath);
    const userHome = path.join(root, 'user-home');
    await fs.mkdir(userHome);
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('USERPROFILE', userHome);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_CONTENT_RETENTION', 'full');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    repo = path.join(root, 'repo');
    await fs.cp(FIXTURE, repo, { recursive: true });
    // A top-level request can share a line with a callable without belonging
    // to it. Also put a callable on the next line: wrapper sites use 1-based
    // lines, which must not make that callable an indirect consumer either.
    for (const [kind, request] of [
      ['fetch', "fetch('/api/top-level-fetch')"],
      ['wrapper', "apiFetch('/api/top-level-wrapper')"],
      ['client', "axios.head('/api/top-level-client')"],
    ]) {
      await fs.writeFile(
        path.join(repo, 'src', `top-level-${kind}.ts`),
        [
          "import { apiFetch } from './api';",
          "import axios from 'axios';",
          `export function decode(res: Response) { return res.json(); } ${request};`,
          "export function afterRequest() { return 'local'; }",
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(repo, 'src', `local-${kind}.ts`),
        [
          `import { decode, afterRequest } from './top-level-${kind}';`,
          'export function parseLocal(res: Response) { return decode(res); }',
          'export function describeLocal() { return afterRequest(); }',
        ].join('\n'),
      );
    }
    await fs.writeFile(
      path.join(repo, 'src', 'lambda_client.py'),
      "import requests\ncheck_health = lambda: requests.head('/api/lambda')\n",
    );
    for (const [kind, source] of [
      [
        'declaration',
        "export const select = (r: Response) => r.json(), data = fetch('/api/top-level-declaration');",
      ],
      [
        'argument',
        "export const select = wrap((r: Response) => r.json(), fetch('/api/top-level-argument'));",
      ],
    ]) {
      await fs.writeFile(path.join(repo, 'src', `top-level-${kind}.ts`), source);
      await fs.writeFile(
        path.join(repo, 'src', `local-${kind}.ts`),
        `import { select } from './top-level-${kind}';\nexport function parseLocal(r: Response) { return select(r); }\n`,
      );
    }
    await fs.writeFile(
      path.join(repo, 'src', 'top-level-server.ts'),
      [
        "import express from 'express';",
        'const app = express();',
        "app.get('/api/lambda', (_req, res) => res.json({ ok: true }));",
        ...['fetch', 'wrapper', 'client', 'declaration', 'argument'].map(
          (kind) => `app.get('/api/top-level-${kind}', (_req, res) => res.json({ ok: true }));`,
        ),
      ].join('\n'),
    );
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
    initGitRepo(repo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    commitAll(repo, 'indirect consumers fixture');
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    backend = new LocalBackend();
    await backend.init();
  }, 180_000);

  afterAll(async () => {
    await backend?.dispose();
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  async function impact(route: string) {
    const result = await backend.callTool('api_impact', { route, repo });
    expect(result).not.toHaveProperty('error');
    return result;
  }

  it('lists the callers of the requesting function, apart from the direct consumer', async () => {
    const result = await impact('/api/repos');
    expect(result.consumers.map((c: { file: string }) => c.file)).toEqual(['src/client.ts']);
    expect(result.indirectConsumers).toEqual([
      { name: 'loadApp', file: 'src/app.ts', via: 'fetchRepos' },
      { name: 'refreshHeader', file: 'src/header.ts', via: 'fetchRepos' },
    ]);
    expect(result.impactSummary.directConsumers).toBe(1);
    expect(result.impactSummary.indirectConsumers).toBe(2);
    expect(result.impactSummary.riskLevel).toBe('LOW');
  });

  it('keeps the callers of a request that shares its line with a helper', async () => {
    const result = await impact('/api/file');
    expect(result.indirectConsumers).toEqual([
      { name: 'openFile', file: 'src/viewer.ts', via: 'fetchFile' },
    ]);
    expect(result.impactSummary.indirectConsumers).toBe(1);
  });

  it('keeps the callers of a request made through a wrapper function', async () => {
    const result = await impact('/api/stats');
    expect(result.consumers.map((c: { file: string }) => c.file)).toEqual(['src/stats.ts']);
    expect(result.indirectConsumers).toEqual([
      { name: 'renderStatsPanel', file: 'src/stats-panel.ts', via: 'fetchStats' },
    ]);
  });

  it.each(['fetch', 'wrapper', 'client', 'declaration', 'argument'])(
    'does not invent indirect consumers for a module-scope %s request',
    async (kind) => {
      const result = await impact(`/api/top-level-${kind}`);
      expect(result.consumers.map((c: { file: string }) => c.file)).toEqual([
        `src/top-level-${kind}.ts`,
      ]);
      expect(result).not.toHaveProperty('indirectConsumers');
      expect(result.impactSummary).not.toHaveProperty('indirectConsumers');
    },
  );

  it('keeps attribution when a callable definition is known but the enclosing-id walk cannot name it', async () => {
    const result = await impact('/api/lambda');
    expect(result.consumers.map((c: { file: string }) => c.file)).toEqual(['src/lambda_client.py']);
    // An attributed request with no callers reports an empty list; a request
    // incorrectly classified as module scope omits the field altogether.
    expect(result.indirectConsumers).toEqual([]);
    expect(result.impactSummary.indirectConsumers).toBe(0);
  });
});
