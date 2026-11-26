import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import { fixtureGitExecutable } from '../../../../test/helpers/git-executable.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { closeLbug, executeQuery, initLbug } from '../../../../dist/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../../../dist/core/run-analyze.js';
import { getStoragePaths } from '../../../../dist/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../../../../test/helpers/temp-git-repo.js';
import { createTempDir } from '../../../../test/helpers/test-db.js';

const java = (source: string): string =>
  source.replaceAll('; ', ';\n').replaceAll('{ public', '{\n public');

it(
  'keeps incremental Java imports and chained calls equal to a full rebuild',
  { timeout: 300_000 },
  async () => {
    const temp = await createTempDir();
    try {
      const root = await fs.realpath(temp.dbPath);
      process.env.GITNEXUS_HOME = path.join(root, 'home');
      delete process.env.GITNEXUS_STORAGE_PATH;
      delete process.env.GITNEXUS_STORAGE_ROOT;
      process.env.GITNEXUS_SHARED_STORE = 'off';
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'load-only';
      const repo = path.join(root, 'incremental');
      const coldRepo = path.join(root, 'cold');
      const repos = [repo, coldRepo];
      const sources = new Map([
        ['.gitignore', '.gitnexus/\n'],
        [
          'models/Foo.java',
          'package models; public class Foo { public Bar make() { return new Bar(); } }',
        ],
        ['models/Bar.java', 'package models; public class Bar extends Mid {}'],
        // Java package identity is declared, not determined by the directory.
        ['alternate/Mid.java', 'package models; public class Mid extends Base {}'],
        ['models/Base.java', 'package models; public class Base { public void run() {} }'],
        ['models/Other.java', 'package models; public class Other extends Deep {}'],
        ['models/Deep.java', 'package models; public class Deep { public void run() {} }'],
        [
          'app/Wildcard.java',
          'package app; import models.*; public class Wildcard { public void call(Foo f) { f.make().run(); } }',
        ],
        [
          'app/Explicit.java',
          'package app; import models.Foo; public class Explicit { public void call(Foo f) { f.make().run(); } }',
        ],
      ]);
      const write = async (file: string, source: string): Promise<void> => {
        await Promise.all(
          repos.map(async (target) => {
            await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
            await fs.writeFile(path.join(target, file), java(source));
          }),
        );
      };
      const commit = (message: string): void =>
        repos.forEach((target) => commitAll(target, message));
      await Promise.all(Array.from(sources, ([file, source]) => write(file, source)));
      for (const target of repos) {
        initGitRepo(target);
        execFileSync(fixtureGitExecutable(), ['config', 'commit.gpgsign', 'false'], {
          cwd: target,
        });
      }
      commit('baseline Java inheritance');

      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      const callbacks = { onProgress: () => {} };
      const read = async (target: string) => {
        await initLbug(getStoragePaths(target).lbugPath, { skipFts: true });
        try {
          return {
            calls: await executeQuery(
              "MATCH (s:Method)-[r:CodeRelation]->(t:Method) WHERE r.type = 'CALLS' " +
                "AND s.name = 'call' AND t.name = 'run' " +
                'RETURN s.filePath AS source, t.filePath AS target ORDER BY source, target',
            ),
            imports: await executeQuery(
              "MATCH (s:File)-[r:CodeRelation]->(t:File) WHERE r.type = 'IMPORTS' " +
                'RETURN s.filePath AS source, t.filePath AS target ORDER BY source, target',
            ),
          };
        } finally {
          await closeLbug();
        }
      };
      /** Analyze the incremental repository, rebuild the cold one from scratch,
       * and require the same persisted calls and imports in both. */
      const analyzeBoth = async (explicitTarget: string, wildcardTarget: string) => {
        const result = await runFullAnalysis(repo, options, callbacks);
        await runFullAnalysis(
          coldRepo,
          { ...options, force: true, useParseCache: false },
          callbacks,
        );
        const cold = await read(coldRepo);
        assert.deepEqual(cold.calls, [
          { source: 'app/Explicit.java', target: explicitTarget },
          { source: 'app/Wildcard.java', target: wildcardTarget },
        ]);
        assert.ok(
          cold.imports.some((actual) =>
            isDeepStrictEqual(actual, {
              source: 'app/Explicit.java',
              target: 'models/Foo.java',
            }),
          ),
        );
        assert.deepEqual(await read(repo), cold);
        return result.incrementalStats;
      };

      await analyzeBoth('models/Base.java', 'models/Base.java');

      // A type neither importer spells changes its superclass, there and back.
      await runInSequence(
        [
          ['Other', 'models/Deep.java'],
          ['Base', 'models/Base.java'],
        ],
        async ([parent, runTarget]) => {
          await write(
            'alternate/Mid.java',
            `package models; public class Mid extends ${parent} {}`,
          );
          commit(`reparent Mid to ${parent}`);
          assert.partialDeepStrictEqual(await analyzeBoth(runTarget, runTarget), {
            changedFiles: 1,
            writeMode: 'incremental',
          });
        },
      );

      // A body edit changes no other file's rows: nothing else is rewritten.
      await write(
        'models/Deep.java',
        'package models; public class Deep { public void run() { int local = 1; } }',
      );
      commit('edit a method body');
      assert.partialDeepStrictEqual(await analyzeBoth('models/Base.java', 'models/Base.java'), {
        changedFiles: 1,
        affectedDependents: 0,
        writeMode: 'incremental',
      });

      // A new type in the wildcard importer's own directory shadows the
      // on-demand import; the unchanged importer's import and call both move.
      await write(
        'app/Foo.java',
        'package app; public class Foo { public models.Deep make() { return new models.Deep(); } }',
      );
      commit('add a same-package Foo');
      assert.partialDeepStrictEqual(await analyzeBoth('models/Base.java', 'models/Deep.java'), {
        changedFiles: 1,
        writeMode: 'incremental',
      });
      assert.ok(
        !(await read(repo)).imports.some((actual) =>
          isDeepStrictEqual(actual, {
            source: 'app/Wildcard.java',
            target: 'models/Foo.java',
          }),
        ),
      );

      // Deleting it restores both.
      await Promise.all(
        repos.map(async (target) => {
          await fs.rm(path.join(target, 'app/Foo.java'));
        }),
      );
      commit('delete the same-package Foo');
      assert.partialDeepStrictEqual(await analyzeBoth('models/Base.java', 'models/Base.java'), {
        changedFiles: 1,
        writeMode: 'incremental',
      });
      assert.ok(
        (await read(repo)).imports.some((actual) =>
          isDeepStrictEqual(actual, {
            source: 'app/Wildcard.java',
            target: 'models/Foo.java',
          }),
        ),
      );
    } finally {
      await closeLbug();

      await temp.cleanup();
    }
  },
);

it(
  'persists added and removed package annotation shadows without editing the Lombok model',
  { timeout: 180_000 },
  async () => {
    const temp = await createTempDir();
    try {
      const root = await fs.realpath(temp.dbPath);
      const repo = path.join(root, 'repo');
      process.env.GITNEXUS_HOME = path.join(root, 'home');
      delete process.env.GITNEXUS_STORAGE_PATH;
      delete process.env.GITNEXUS_STORAGE_ROOT;
      process.env.GITNEXUS_SHARED_STORE = 'off';
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'load-only';
      await fs.mkdir(path.join(repo, 'p'), { recursive: true });
      await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
      await fs.writeFile(
        path.join(repo, 'p/Repo.java'),
        `package p;
@org.springframework.stereotype.Repository public class Repo {}
`,
      );
      const model = `package p;
import lombok.*;
@org.springframework.stereotype.Service @Value public class Model { Repo repo; }
`;
      await fs.writeFile(path.join(repo, 'p/Model.java'), model);
      initGitRepo(repo);
      execFileSync(fixtureGitExecutable(), ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      commitAll(repo, 'baseline Lombok model');
      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      const read = async () => {
        await initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
        try {
          return {
            getters: await executeQuery(
              "MATCH (m:Method) WHERE m.filePath = 'p/Model.java' " +
                "AND m.name = 'getRepo' RETURN m.id AS id",
            ),
            injections: await executeQuery(
              'MATCH (s:Class)-[r:CodeRelation]->(t:Class) ' +
                "WHERE r.type = 'INJECTS' AND s.filePath = 'p/Model.java' " +
                'RETURN s.id AS source, t.id AS target ORDER BY source, target',
            ),
          };
        } finally {
          await closeLbug();
        }
      };
      const expected = {
        getters: [{ id: 'Method:p/Model.java:Model.getRepo#0' }],
        injections: [{ source: 'Class:p/Model.java:Model', target: 'Class:p/Repo.java:Repo' }],
      };
      await runFullAnalysis(repo, options, { onProgress: () => {} });
      assert.deepEqual(await read(), expected);

      await fs.writeFile(
        path.join(repo, 'p/Value.java'),
        'package p; public @interface Value {}\n',
      );
      commitAll(repo, 'add package annotation shadow');
      const added = await runFullAnalysis(repo, options, { onProgress: () => {} });
      assert.partialDeepStrictEqual(added.incrementalStats, {
        changedFiles: 1,
        writeMode: 'incremental',
      });
      assert.deepEqual(await read(), { getters: [], injections: [] });
      assert.equal(await fs.readFile(path.join(repo, 'p/Model.java'), 'utf8'), model);

      await fs.unlink(path.join(repo, 'p/Value.java'));
      commitAll(repo, 'remove package annotation shadow');
      const removed = await runFullAnalysis(repo, options, { onProgress: () => {} });
      assert.partialDeepStrictEqual(removed.incrementalStats, {
        changedFiles: 1,
        writeMode: 'incremental',
      });
      assert.deepEqual(await read(), expected);
    } finally {
      await closeLbug();

      await temp.cleanup();
    }
  },
);
