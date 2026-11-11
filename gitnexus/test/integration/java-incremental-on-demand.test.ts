import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

it('keeps incremental Java chained calls equal to a full rebuild after an unmentioned type changes', async () => {
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
    for (const target of [repo, coldRepo]) {
      for (const [file, source] of sources) {
        await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await fs.writeFile(
          path.join(target, file),
          source.replaceAll('; ', ';\n').replaceAll('{ public', '{\n public'),
        );
      }
      initGitRepo(target);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: target });
      commitAll(target, 'baseline Java inheritance');
    }
    const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
    const callbacks = { onProgress: () => {} };
    const readCalls = async (target: string): Promise<Record<string, unknown>[]> => {
      await initLbug(getStoragePaths(target).lbugPath, { skipFts: true });
      try {
        return await executeQuery(
          "MATCH (s:Method)-[r:CodeRelation]->(t:Method) WHERE r.type = 'CALLS' " +
            "AND s.name = 'call' AND t.name = 'run' " +
            'RETURN s.filePath AS source, t.filePath AS target ORDER BY source, target',
        );
      } finally {
        await closeLbug();
      }
    };
    const expectColdParity = async (target: string): Promise<void> => {
      await runFullAnalysis(coldRepo, { ...options, force: true, useParseCache: false }, callbacks);
      const cold = await readCalls(coldRepo);
      expect(cold).toEqual([
        { source: 'app/Explicit.java', target },
        { source: 'app/Wildcard.java', target },
      ]);
      expect(await readCalls(repo)).toEqual(cold);
    };

    await runFullAnalysis(repo, options, callbacks);
    await expectColdParity('models/Base.java');
    for (const parent of ['Other', 'Base']) {
      for (const target of [repo, coldRepo]) {
        await fs.writeFile(
          path.join(target, 'alternate/Mid.java'),
          `package models;\npublic class Mid extends ${parent} {}`,
        );
        commitAll(target, `reparent Mid to ${parent}`);
      }
      const result = await runFullAnalysis(repo, options, callbacks);
      expect(result.incrementalStats).toMatchObject({ changedFiles: 1, writeMode: 'incremental' });
      await expectColdParity(parent === 'Other' ? 'models/Deep.java' : 'models/Base.java');
    }
  } finally {
    await closeLbug();
    vi.unstubAllEnvs();
    await temp.cleanup();
  }
}, 180_000);
