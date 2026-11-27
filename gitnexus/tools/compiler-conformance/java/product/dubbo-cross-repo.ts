import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseGroupConfig } from '../../../../dist/core/group/config-parser.js';
import { syncGroup } from '../../../../dist/core/group/sync.js';
import { closeLbug, executeParameterized } from '../../../../dist/core/lbug/pool-adapter.js';
import { DUBBO_SYMBOL_QUERY } from '../../../../dist/core/group/extractors/dubbo-extractor.js';
import { closeAllCachedBridges, closeBridgeDb } from '../../../../dist/core/group/bridge-db.js';
import {
  ensureBridgeReady,
  resolveBridgeNeighbors,
} from '../../../../dist/core/group/cross-impact.js';
import { LocalBackend } from '../../../../dist/mcp/local/local-backend.js';
import type { GroupImpactResult } from '../../../../src/core/group/types.js';

const CLI = fileURLToPath(new URL('../../../../dist/cli/index.js', import.meta.url));
const SOURCES = {
  api: `package api;
public interface Account {
  String get(Long id);
  <T> String get(T id, String tenant);
}`,
  provider: `package impl;
import api.Account;
import org.apache.dubbo.config.annotation.DubboService;
@DubboService(interfaceClass = Account.class, group = "accounts", version = "1")
public class AccountService implements Account {
  public String get(Long id) { return "account"; }
  public <T> String get(T id, String tenant) { return tenant; }
}`,
  consumer: `package app;
import api.Account;
import org.apache.dubbo.config.annotation.DubboReference;
public class Facade {
  @DubboReference(group = "accounts", version = "1") private Account account;
  public String load(Long id) {
    String result = account.get(id);
    Account account = null;
    return result;
  }
}`,
};
// Persisted graph coordinates are zero-based, including declaration annotations.
const EXPECTED_START_LINES: Record<string, Record<string, number>> = {
  api: { Account: 1, get: 2 },
  provider: { AccountService: 3, get: 5 },
  consumer: { load: 5 },
};

test(
  'Dubbo: index three Git repos, sync real contracts, traverse the persisted bridge',
  { timeout: 180_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-dubbo-'));
    const previousHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = path.join(root, 'home');
    const env = { ...process.env, GITNEXUS_SHARED_STORE: 'off', GITNEXUS_MEMORY: 'off' };
    try {
      for (const [repo, source] of Object.entries(SOURCES)) {
        const cwd = path.join(root, repo);
        await fs.mkdir(cwd);
        const name = repo === 'api' ? 'Account' : repo === 'provider' ? 'AccountService' : 'Facade';
        await fs.writeFile(path.join(cwd, `${name}.java`), source);
        execFileSync('git', ['init', '-q'], { cwd });
        execFileSync('git', ['add', '.'], { cwd });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '-qm',
            'fixture',
          ],
          { cwd },
        );
        execFileSync(
          process.execPath,
          [
            CLI,
            'analyze',
            '--name',
            `dubbo-${repo}`,
            '--index-only',
            '--skip-fts',
            '--skip-skills',
          ],
          {
            cwd,
            env,
            timeout: 60_000,
            stdio: 'pipe',
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      }
      const groupDir = path.join(root, 'home', 'groups', 'dubbo-demo');
      await fs.mkdir(groupDir, { recursive: true });
      const yaml = `version: 1
name: dubbo-demo
repos:
  api: dubbo-api
  provider: dubbo-provider
  consumer: dubbo-consumer
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  dubbo: true
`;
      await fs.writeFile(path.join(groupDir, 'group.yaml'), yaml);
      const config = parseGroupConfig(yaml);
      const synced = await syncGroup(config, { groupDir });
      assert.deepEqual(synced.missingRepos, []);
      assert.deepEqual(synced.unreadableRepos, []);
      const methods = synced.contracts.filter((c) => c.meta.method === 'get');
      assert.equal(methods.length, 3, 'one interface method, one implementation, one real caller');
      assert.ok(methods.every((c) => c.symbolUid && !c.symbolUid.startsWith('source-scan::')));
      const caller = methods.find((c) => c.repo === 'consumer');
      assert.ok(caller);
      assert.equal(caller.symbolRef.name, 'load');
      assert.equal(new Set(methods.map((c) => c.contractId)).size, 1);
      assert.equal(synced.crossLinks.filter((l) => l.contractId === caller.contractId).length, 2);

      for (const contract of synced.contracts) {
        const poolId = `dubbo-${contract.repo}`;
        const [symbol] = await executeParameterized(
          poolId,
          'MATCH (n) WHERE n.id = $uid RETURN label(n) AS label, n.startLine AS line',
          { uid: contract.symbolUid },
        );
        // LadybugDB returns a scalar label; graph symbols use zero-based source lines.
        assert.ok(['Method', 'Function', 'Class', 'Interface'].includes(symbol.label));
        assert.equal(
          Number(symbol.line),
          EXPECTED_START_LINES[contract.repo][contract.symbolRef.name],
        );
        const params = { ...contract.symbolRef, line: Number(symbol.line) };
        assert.deepEqual(await executeParameterized(poolId, DUBBO_SYMBOL_QUERY, params), [
          { uid: contract.symbolUid },
        ]);
        assert.deepEqual(
          await executeParameterized(poolId, DUBBO_SYMBOL_QUERY, { ...params, line: -1 }),
          [],
        );
      }

      const bridge = await ensureBridgeReady(groupDir);
      if ('error' in bridge) assert.fail(bridge.error);
      try {
        for (const repo of ['api', 'provider']) {
          const target = methods.find((c) => c.repo === repo);
          assert.ok(target);
          const neighbors = await resolveBridgeNeighbors(bridge.handle, {
            localRepo: repo,
            uids: [target.symbolUid],
            direction: 'upstream',
          });
          assert.ok(
            neighbors.some(
              (n) => n.neighborRepo === 'consumer' && n.neighborUid === caller.symbolUid,
            ),
          );
        }
        const downstream = await resolveBridgeNeighbors(bridge.handle, {
          localRepo: 'consumer',
          uids: [caller.symbolUid],
          direction: 'downstream',
        });
        assert.deepEqual([...new Set(downstream.map((n) => n.neighborRepo))].sort(), [
          'api',
          'provider',
        ]);
        const backend = new LocalBackend();
        try {
          assert.equal(await backend.init(), true);
          for (const repo of ['api', 'provider']) {
            for (const method of ['get', '']) {
              const target = synced.contracts.find(
                (c) => c.repo === repo && c.meta.method === method,
              );
              assert.ok(target, `missing ${repo} ${method || 'type'} anchor`);
              const result = (await backend.callTool('impact', {
                repo: `@dubbo-demo/${repo}`,
                target_uid: target.symbolUid,
                direction: 'upstream',
              })) as GroupImpactResult | { error: string };
              if ('error' in result) assert.fail(result.error);
              assert.ok(
                result.cross.some((c) => c.repo_path === 'consumer' && c.contract.type === 'dubbo'),
              );
            }
          }
        } finally {
          await backend.dispose();
        }
      } finally {
        await closeBridgeDb(bridge.handle);
      }
      // The default-off flag must bypass automatic extraction for existing groups.
      config.detect.dubbo = false;
      const disabled = await syncGroup(config, { skipWrite: true });
      assert.equal(disabled.contracts.length, 0);
    } finally {
      await closeLbug();
      await closeAllCachedBridges();
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
