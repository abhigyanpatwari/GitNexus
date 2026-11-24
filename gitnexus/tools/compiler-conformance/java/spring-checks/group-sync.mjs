import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { syncGroup } from '../../../../dist/core/group/sync.js';
import * as database from '../../../../dist/core/lbug/lbug-adapter.js';
import * as pool from '../../../../dist/core/lbug/pool-adapter.js';
import { registerRepo, saveMeta } from '../../../../dist/storage/repo-manager.js';
import { createTempDir } from '../../../../test/helpers/test-db.ts';
import { springProject } from '../spring-support.mjs';

async function syncProjects(projects, detect, verify) {
  const tmp = await createTempDir('gitnexus-lbug-');
  const previous = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = tmp.dbPath;
  const repos = {};
  try {
    for (const [group, fixtures] of Object.entries(projects)) {
      const name = path.basename(group);
      const repo = path.join(tmp.dbPath, 'repos', name);
      const storage = path.join(repo, '.gitnexus');
      await cp(springProject(fixtures), repo, { recursive: true });
      await mkdir(storage);
      try {
        await database.initLbug(path.join(storage, 'lbug'));
        await database.flushWAL();
      } finally {
        await database.closeLbug();
      }
      const metadata = { repoPath: repo, indexedAt: new Date().toISOString(), lastCommit: '' };
      await saveMeta(storage, metadata);
      await registerRepo(repo, metadata, { name, storagePath: storage });
      repos[group] = name;
    }
    const result = await syncGroup(
      {
        version: 1,
        name: 'conformance',
        description: '',
        repos,
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          graphql: false,
          thrift: false,
          topics: false,
          includes: false,
          workspace_deps: false,
          ...detect,
        },
        matching: {},
      },
      { skipWrite: true },
    );
    assert.deepEqual(result.missingRepos, []);
    assert.deepEqual(result.failedRepos, []);
    await verify(result);
  } finally {
    try {
      for (const name of Object.values(repos)) await pool.closeLbug(name);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previous;
      await tmp.cleanup();
    }
  }
}

export async function verifyThriftMatchesDistinctJavaAndIdlProviders() {
  await syncProjects(
    {
      'app/provider': 'group-contracts/thrift/thrift-source-scan-contracts-have-stable',
      'app/consumer': 'group-contracts/thrift/java-thrift-consumer-without-idl-emits-weak',
    },
    { thrift: true },
    (result) => {
      assert.equal(result.crossLinks.length, 2);
      assert.deepEqual(
        result.crossLinks.map((link) => link.to.symbolRef.filePath).sort(compareCodeUnits),
        ['idl/order.thrift', 'src/main/java/example/IfaceOrderHandler.java'],
      );
      assert.equal(new Set(result.crossLinks.map((link) => link.to.symbolUid)).size, 2);
    },
  );
}

export async function verifyThriftInDiscoveredService() {
  await syncProjects(
    { 'services/billing': 'group-sync/billing' },
    { thrift: true },
    async (result) => {
      assert.equal(result.contracts.length, 1);
      assert.partialDeepStrictEqual(result.contracts[0], {
        contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
        type: 'thrift',
        role: 'provider',
        repo: 'services/billing',
        service: 'services/billing',
        symbolRef: {
          filePath: 'services/billing/idl/order.thrift',
          name: 'OrderService.PlaceOrder',
        },
      });
      assert.equal(pool.isLbugReady('billing'), true);
      assert.deepEqual(await pool.executeQuery('billing', 'RETURN 1 AS value'), [{ value: 1 }]);
    },
  );
}

export async function verifyMavenSharedParentLinks() {
  await syncProjects(
    {
      parent: 'group-sync/parent',
      'libs/shared-lib': 'group-sync/shared-lib',
      'services/service-a': 'group-sync/service-a',
      'services/service-b': 'group-sync/service-b',
    },
    { workspace_deps: true },
    (result) => {
      const links = result.crossLinks
        .filter((link) => link.matchType === 'manifest')
        .map((link) => ({ from: link.from.repo, to: link.to.repo, contractId: link.contractId }));
      assert.deepEqual(links, [
        {
          from: 'services/service-a',
          to: 'libs/shared-lib',
          contractId: 'custom::shared-lib::SharedType',
        },
        {
          from: 'services/service-b',
          to: 'libs/shared-lib',
          contractId: 'custom::shared-lib::SharedType',
        },
      ]);
    },
  );
}
