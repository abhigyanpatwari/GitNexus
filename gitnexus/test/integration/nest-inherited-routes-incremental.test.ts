/**
 * Incremental indexing of NestJS routes inherited across files.
 *
 * An inherited route depends on two files: the controller that mounts it and
 * the base class that declares the handler. An incremental write replaces the
 * rows of the files that changed and of the files that import them, so the
 * route has to belong to the controller's file, while its handler edge starts
 * at the base method in the other one. Each stage below edits one side only
 * and compares the stored `Route` rows and their `HANDLES_ROUTE` edges with a
 * forced rebuild of the same tree in a second repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const BASE_FILE = 'src/shared/crud.controller.ts';
const USERS_FILE = 'src/users.controller.ts';
const ORGS_FILE = 'src/orgs.controller.ts';

const BASE_SOURCE = `import { Get } from '@nestjs/common';

export abstract class CrudController {
  @Get()
  findAll() {
    return [];
  }

  @Get(':id')
  findOne() {
    return {};
  }
}
`;
const BASE_WITH_DELETE = BASE_SOURCE.replace('{ Get }', '{ Delete, Get }').replace(
  /}\n$/,
  "\n  @Delete(':id')\n  remove() {\n    return {};\n  }\n}\n",
);
const BASE_RENAMED = BASE_WITH_DELETE.replace('findAll()', 'list()');
const USERS_SOURCE = `import { Controller } from '@nestjs/common';
import { CrudController } from './shared/crud.controller';

@Controller('users')
export class UsersController extends CrudController {}
`;
const USERS_WITHOUT_BASE = `import { Controller } from '@nestjs/common';

@Controller('users')
export class UsersController {}
`;
const ORGS_SOURCE = `import { Controller, Get } from '@nestjs/common';
import { CrudController } from './shared';

@Controller('orgs')
export class OrgsController extends CrudController {
  @Get('mine')
  mine() {
    return [];
  }
}
`;

/** One line per route: its id, its file, and the nodes with a `HANDLES_ROUTE` edge to it. */
async function readRoutes(repo: string): Promise<string[]> {
  await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
  try {
    const routes = await executeQuery(
      'MATCH (r:Route) RETURN r.id AS id, r.filePath AS filePath, r.handlerSymbolId AS handler ORDER BY id',
    );
    const edges = await executeQuery(
      "MATCH (h)-[e:CodeRelation]->(r:Route) WHERE e.type = 'HANDLES_ROUTE' RETURN r.id AS route, h.id AS source ORDER BY route, source",
    );
    return routes.map((row) => {
      const sources = edges
        .filter((edge) => edge.route === row.id)
        .map((edge) => String(edge.source));
      // The stamp on the row and the edge are written separately; a stale one
      // of either kind shows up as a line that differs from the rebuild.
      const stamped = sources.includes(String(row.handler))
        ? ''
        : ` (stamp ${String(row.handler)})`;
      return `${String(row.id)} in ${String(row.filePath)} <- ${sources.join(' + ')}${stamped}`;
    });
  } finally {
    await closeLbug();
  }
}

it('keeps inherited NestJS routes equal to a rebuild as either file changes', async () => {
  const temp = await createTempDir();
  try {
    const root = await fs.realpath(temp.dbPath);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    const repo = path.join(root, 'incremental');
    const coldRepo = path.join(root, 'cold');
    const targets = [repo, coldRepo];
    const write = async (file: string, source: string | null): Promise<void> => {
      for (const target of targets) {
        const filePath = path.join(target, file);
        if (source === null) {
          await fs.unlink(filePath);
        } else {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, source);
        }
      }
    };
    const commit = (message: string): void => {
      for (const target of targets) commitAll(target, message);
    };

    await write('.gitignore', '.gitnexus/\n');
    await write(BASE_FILE, BASE_SOURCE);
    await write('src/shared/index.ts', "export * from './crud.controller';\n");
    await write(USERS_FILE, USERS_SOURCE);
    await write(ORGS_FILE, ORGS_SOURCE);
    for (const target of targets) {
      initGitRepo(target);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: target });
    }
    commit('controllers that inherit their routes');

    const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
    const callbacks = { onProgress: () => {} };
    const expectColdParity = async (expected: string[]): Promise<void> => {
      await runFullAnalysis(coldRepo, { ...options, force: true, useParseCache: false }, callbacks);
      const cold = await readRoutes(coldRepo);
      expect(cold).toEqual(expected);
      expect(await readRoutes(repo)).toEqual(cold);
    };
    const expectIncremental = async (): Promise<void> => {
      const run = await runFullAnalysis(repo, options, callbacks);
      expect(run.incrementalStats).toMatchObject({ writeMode: 'incremental' });
    };

    // A route line: the route, the controller file that owns it, the file's own
    // edge and the method that handles it.
    const route = (id: string, filePath: string, handler: string): string =>
      `Route:${id} in ${filePath} <- File:${filePath} + ${handler}`;
    const inBase = (name: string): string => `Method:${BASE_FILE}:CrudController.${name}#0`;
    const MINE = `Method:${ORGS_FILE}:OrgsController.mine#0`;

    await runFullAnalysis(repo, options, callbacks);
    await expectColdParity([
      route('GET /orgs', ORGS_FILE, inBase('findAll')),
      route('GET /orgs/:id', ORGS_FILE, inBase('findOne')),
      route('GET /orgs/mine', ORGS_FILE, MINE),
      route('GET /users', USERS_FILE, inBase('findAll')),
      route('GET /users/:id', USERS_FILE, inBase('findOne')),
    ]);

    // Only the base class changes; both controllers gain the route.
    await write(BASE_FILE, BASE_WITH_DELETE);
    commit('the base class gains a route');
    await expectIncremental();
    await expectColdParity([
      route('DELETE /orgs/:id', ORGS_FILE, inBase('remove')),
      route('DELETE /users/:id', USERS_FILE, inBase('remove')),
      route('GET /orgs', ORGS_FILE, inBase('findAll')),
      route('GET /orgs/:id', ORGS_FILE, inBase('findOne')),
      route('GET /orgs/mine', ORGS_FILE, MINE),
      route('GET /users', USERS_FILE, inBase('findAll')),
      route('GET /users/:id', USERS_FILE, inBase('findOne')),
    ]);

    // Only the base class changes again: the routes keep their identity and
    // the rows in both controller files take the renamed handler.
    await write(BASE_FILE, BASE_RENAMED);
    commit('a base handler is renamed');
    await expectIncremental();
    await expectColdParity([
      route('DELETE /orgs/:id', ORGS_FILE, inBase('remove')),
      route('DELETE /users/:id', USERS_FILE, inBase('remove')),
      route('GET /orgs', ORGS_FILE, inBase('list')),
      route('GET /orgs/:id', ORGS_FILE, inBase('findOne')),
      route('GET /orgs/mine', ORGS_FILE, MINE),
      route('GET /users', USERS_FILE, inBase('list')),
      route('GET /users/:id', USERS_FILE, inBase('findOne')),
    ]);

    // Only one controller changes, and it no longer imports the base class:
    // nothing in the new graph links the two files any more.
    await write(USERS_FILE, USERS_WITHOUT_BASE);
    commit('a controller stops extending the base class');
    await expectIncremental();
    await expectColdParity([
      route('DELETE /orgs/:id', ORGS_FILE, inBase('remove')),
      route('GET /orgs', ORGS_FILE, inBase('list')),
      route('GET /orgs/:id', ORGS_FILE, inBase('findOne')),
      route('GET /orgs/mine', ORGS_FILE, MINE),
    ]);

    // The other controller is deleted; the base class file is untouched.
    await write(ORGS_FILE, null);
    commit('the other controller is deleted');
    await expectIncremental();
    await expectColdParity([]);
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 240_000);
