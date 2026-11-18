import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const java = (source: string): string =>
  source.replaceAll('; ', ';\n').replaceAll('{ public', '{\n public');

it('keeps incremental Java imports and chained calls equal to a full rebuild', async () => {
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
      for (const target of repos) {
        await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await fs.writeFile(path.join(target, file), java(source));
      }
    };
    const commit = (message: string): void => repos.forEach((target) => commitAll(target, message));
    for (const [file, source] of sources) await write(file, source);
    for (const target of repos) {
      initGitRepo(target);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: target });
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
      await runFullAnalysis(coldRepo, { ...options, force: true, useParseCache: false }, callbacks);
      const cold = await read(coldRepo);
      expect(cold.calls).toEqual([
        { source: 'app/Explicit.java', target: explicitTarget },
        { source: 'app/Wildcard.java', target: wildcardTarget },
      ]);
      expect(cold.imports).toContainEqual({
        source: 'app/Explicit.java',
        target: 'models/Foo.java',
      });
      expect(await read(repo)).toEqual(cold);
      return result.incrementalStats;
    };

    await analyzeBoth('models/Base.java', 'models/Base.java');

    // A type neither importer spells changes its superclass, there and back.
    for (const [parent, runTarget] of [
      ['Other', 'models/Deep.java'],
      ['Base', 'models/Base.java'],
    ]) {
      await write('alternate/Mid.java', `package models; public class Mid extends ${parent} {}`);
      commit(`reparent Mid to ${parent}`);
      expect(await analyzeBoth(runTarget, runTarget)).toMatchObject({
        changedFiles: 1,
        writeMode: 'incremental',
      });
    }

    // A body edit changes no other file's rows: nothing else is rewritten.
    await write(
      'models/Deep.java',
      'package models; public class Deep { public void run() { int local = 1; } }',
    );
    commit('edit a method body');
    expect(await analyzeBoth('models/Base.java', 'models/Base.java')).toMatchObject({
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
    expect(await analyzeBoth('models/Base.java', 'models/Deep.java')).toMatchObject({
      changedFiles: 1,
      writeMode: 'incremental',
    });
    expect((await read(repo)).imports).not.toContainEqual({
      source: 'app/Wildcard.java',
      target: 'models/Foo.java',
    });

    // Deleting it restores both.
    for (const target of repos) await fs.rm(path.join(target, 'app/Foo.java'));
    commit('delete the same-package Foo');
    expect(await analyzeBoth('models/Base.java', 'models/Base.java')).toMatchObject({
      changedFiles: 1,
      writeMode: 'incremental',
    });
    expect((await read(repo)).imports).toContainEqual({
      source: 'app/Wildcard.java',
      target: 'models/Foo.java',
    });
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 300_000);

it('persists added and removed package annotation shadows without editing the Lombok model', async () => {
  const temp = await createTempDir();
  try {
    const root = await fs.realpath(temp.dbPath);
    const repo = path.join(root, 'repo');
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
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
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
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
    expect(await read()).toEqual(expected);

    await fs.writeFile(path.join(repo, 'p/Value.java'), 'package p; public @interface Value {}\n');
    commitAll(repo, 'add package annotation shadow');
    const added = await runFullAnalysis(repo, options, { onProgress: () => {} });
    expect(added.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'incremental' });
    expect(await read()).toEqual({ getters: [], injections: [] });
    expect(await fs.readFile(path.join(repo, 'p/Model.java'), 'utf8')).toBe(model);

    await fs.unlink(path.join(repo, 'p/Value.java'));
    commitAll(repo, 'remove package annotation shadow');
    const removed = await runFullAnalysis(repo, options, { onProgress: () => {} });
    expect(removed.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'incremental' });
    expect(await read()).toEqual(expected);
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 180_000);
