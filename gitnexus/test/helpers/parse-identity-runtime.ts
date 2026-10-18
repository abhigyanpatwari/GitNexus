import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const exec = promisify(execFile);
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Independent mutable artifacts; only immutable installed dependencies are shared. */
export async function copyAnalysisRuntime(directory: string): Promise<string> {
  const runtime = path.join(directory, 'gitnexus');
  await mkdir(runtime, { recursive: true });
  for (const entry of [
    'src',
    'dist',
    'vendor',
    'scripts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]) {
    await cp(path.join(PACKAGE_ROOT, entry), path.join(runtime, entry), { recursive: true });
  }
  await cp(path.join(PACKAGE_ROOT, '../gitnexus-shared'), path.join(directory, 'gitnexus-shared'), {
    recursive: true,
    filter: (candidate) => !candidate.split(path.sep).includes('node_modules'),
  });
  await symlink(
    path.join(PACKAGE_ROOT, 'node_modules'),
    path.join(runtime, 'node_modules'),
    'junction',
  );
  return runtime;
}

export interface IdentityAnalysis {
  interrupted?: boolean;
  error?: string;
  alreadyUpToDate?: boolean;
  rebuildReasons?: string[];
  reparsed?: number;
  hits?: number;
  meta: RepoMeta | null;
  storagePath: string;
  facts?: Array<{ kind: string; name: string }>;
  logs: string[];
}

export async function analyzeRuntime(
  runtime: string,
  repo: string,
  home: string,
  request: {
    source?: boolean;
    sharedStore?: boolean;
    options?: Record<string, unknown>;
    mutate?: string;
    failCacheSave?: boolean;
    /** Pause at the post-parse JS callback; no store or indexing mocks. */
    barrier?: string;
    interruptAfterParse?: boolean;
  } = {},
): Promise<IdentityAnalysis> {
  const requestPath = path.join(home, `request-${randomUUID()}.json`);
  await mkdir(home, { recursive: true });
  await writeFile(requestPath, JSON.stringify({ runtime, repo, ...request }));
  const { stdout } = await exec(
    process.execPath,
    [
      ...(request.source
        ? ['--import', path.join(PACKAGE_ROOT, 'node_modules/tsx/dist/loader.mjs')]
        : []),
      fileURLToPath(new URL('./parse-identity-child.mjs', import.meta.url)),
      requestPath,
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        GITNEXUS_HOME: home,
        GITNEXUS_MEMORY: 'off',
        GITNEXUS_LBUG_BUFFER_POOL_SIZE: '134217728',
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
        GITNEXUS_SHARED_STORE: request.sharedStore ? '' : 'off',
        GITNEXUS_LANG: 'en',
      },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).finally(() => rm(requestPath, { force: true }));
  const result = stdout.split('\n').find((line) => line.startsWith('PARSE_IDENTITY_RESULT='));
  if (!result) throw new Error(`Analysis child returned no receipt: ${stdout}`);
  return JSON.parse(result.slice('PARSE_IDENTITY_RESULT='.length));
}
