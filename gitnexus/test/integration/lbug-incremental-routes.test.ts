import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { gitCommitAll } from '../helpers/incremental-test-repo.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
const callbacks = { onProgress: () => {} };
const control = { id: 'Route:GET /health', filePath: 'health.ts' };

async function readRoutes(repo: string) {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const rows = await executeQuery('MATCH (r:Route) RETURN r.id AS id, r.filePath AS filePath');
    const handlers = await executeQuery(
      "MATCH (f:File)-[e:CodeRelation]->(r:Route) WHERE e.type = 'HANDLES_ROUTE' " +
        'RETURN r.id AS id, f.filePath AS filePath',
    );
    return {
      rows: rows.sort((a, b) => String(a.id).localeCompare(String(b.id))),
      handlers: handlers.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
  } finally {
    await closeLbug();
  }
}

it.each([
  { change: 'remove the mount and import', nested: false, after: '/list' },
  { change: 'delete the file mounting a nested router', nested: true, after: '/users/list' },
])(
  'keeps the incremental routes in sync when we $change',
  async ({ nested, after }) => {
    const temp = await createTempDir();
    try {
      const root = await fs.realpath(temp.dbPath);
      const repo = path.join(root, 'repo');
      await fs.mkdir(repo);
      vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
      vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
      vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');

      const write = (name: string, source: string) => fs.writeFile(path.join(repo, name), source);
      await write(
        'users.ts',
        "import { Router } from 'express';\n" +
          'export const users = Router();\n' +
          "users.get('/list', (_req, res) => res.json([]));\n",
      );
      await write(
        'health.ts',
        "import { Router } from 'express';\n" +
          'const health = Router();\n' +
          "health.get('/health', (_req, res) => res.json({ ok: true }));\n",
      );
      if (nested) {
        await write(
          'api.ts',
          "import { Router } from 'express';\n" +
            "import { users } from './users';\n" +
            'export const api = Router();\n' +
            "api.use('/users', users);\n",
        );
      }

      const base = "import express from 'express';\nconst app = express();\nexport default app;\n";
      const mount = nested
        ? "import { api } from './api';\napp.use('/api', api);\n"
        : "import { users } from './users';\napp.use('/api/users', users);\n";
      await write('app.ts', base + mount);
      initGitRepo(repo);
      gitCommitAll(repo, 'mount the users router');
      await runFullAnalysis(repo, options, callbacks);

      const expectRoutes = (url: string) =>
        [control, { id: 'Route:GET ' + url, filePath: 'users.ts' }].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
      const initial = expectRoutes('/api/users/list');
      expect(await readRoutes(repo)).toEqual({ rows: initial, handlers: initial });

      if (nested) await fs.unlink(path.join(repo, 'app.ts'));
      else await write('app.ts', base);
      gitCommitAll(repo, 'remove the outer mount');

      const refreshed = await runFullAnalysis(repo, options, callbacks);
      expect(refreshed.incrementalStats).toMatchObject({
        changedFiles: 1,
        writeMode: 'incremental',
      });
      const incremental = await readRoutes(repo);
      const expected = expectRoutes(after);
      expect(incremental).toEqual({ rows: expected, handlers: expected });

      await runFullAnalysis(repo, { ...options, force: true, useParseCache: false }, callbacks);
      expect(await readRoutes(repo)).toEqual(incremental);
    } finally {
      await closeLbug();
      vi.unstubAllEnvs();
      await temp.cleanup();
    }
  },
  180_000,
);
