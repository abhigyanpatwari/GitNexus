import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { GraphqlExtractor } from '../../../src/core/group/extractors/graphql-extractor.js';
import { syncGroup } from '../../../src/core/group/sync.js';
import { closeLbug, executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import type { GroupConfig, RepoHandle } from '../../../src/core/group/types.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';

const SEED = [
  `CREATE (:Method {id:'method:health', name:'health', filePath:'src/health.resolver.ts', startLine:5, endLine:5, content:'', description:''})`,
  `CREATE (:Const {id:'const:health-document', name:'HealthDocument', filePath:'src/generated.ts', startLine:1, endLine:1, content:'', description:''})`,
];

withTestLbugDB(
  'graphql-resolve-symbol',
  (handle) => {
    let providerRoot = '';
    let consumerRoot = '';

    afterAll(async () => {
      try {
        await closeLbug(handle.repoId);
      } catch {
        /* best-effort */
      }
    });

    it('anchors provider and generated Document consumer through real LadybugDB queries', async () => {
      providerRoot = path.join(handle.tmpHandle.dbPath, 'provider-repo');
      consumerRoot = path.join(handle.tmpHandle.dbPath, 'consumer-repo');
      await fs.mkdir(path.join(providerRoot, 'src'), { recursive: true });
      await fs.mkdir(path.join(consumerRoot, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(providerRoot, 'src/health.resolver.ts'),
        `import { Query, Resolver } from '@nestjs/graphql';\n@Resolver()\nclass HealthResolver {\n  @Query()\n  health() { return 'ok'; }\n}`,
        'utf8',
      );
      await fs.writeFile(
        path.join(consumerRoot, 'src/health.graphql'),
        'query Health { health }',
        'utf8',
      );
      await fs.writeFile(
        path.join(consumerRoot, 'src/generated.ts'),
        `export const HealthDocument = {
  kind: 'Document',
  definitions: [{
    kind: 'OperationDefinition',
    operation: 'query',
    name: { kind: 'Name', value: 'Health' },
    selectionSet: {
      kind: 'SelectionSet',
      selections: [{ kind: 'Field', name: { kind: 'Name', value: 'health' } }]
    }
  }]
};`,
        'utf8',
      );
      const providerRepo: RepoHandle = {
        id: handle.repoId,
        path: 'api',
        repoPath: providerRoot,
        storagePath: handle.tmpHandle.dbPath,
      };
      const consumerRepo: RepoHandle = {
        id: handle.repoId,
        path: 'web',
        repoPath: consumerRoot,
        storagePath: handle.tmpHandle.dbPath,
      };

      const execute = (query: string, params: Record<string, unknown> = {}) =>
        executeParameterized(handle.repoId, query, params);
      const contracts = [
        ...(await new GraphqlExtractor().extract(execute, providerRoot, providerRepo)),
        ...(await new GraphqlExtractor().extract(execute, consumerRoot, consumerRepo)),
      ];

      expect(contracts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contractId: 'graphql::query::health',
            role: 'provider',
            symbolUid: 'method:health',
          }),
          expect.objectContaining({
            contractId: 'graphql::query::health',
            role: 'consumer',
            symbolUid: 'const:health-document',
          }),
        ]),
      );

      const repoManager = await import('../../../src/storage/repo-manager.js');
      const registrySpy = vi.spyOn(repoManager, 'readRegistryStrict').mockResolvedValue([]);
      const config: GroupConfig = {
        version: 1,
        name: 'graphql-production-wiring',
        description: '',
        repos: { api: 'api', web: 'web' },
        links: [],
        packages: {},
        detect: {
          http: false,
          graphql: true,
          grpc: false,
          thrift: false,
          topics: false,
          includes: false,
          workspace_deps: false,
        },
        matching: {},
      };
      try {
        const synced = await syncGroup(config, {
          resolveRepoHandle: async (_regName, groupPath) =>
            groupPath === 'api' ? providerRepo : consumerRepo,
          skipWrite: true,
        });
        expect(
          synced.contracts.map((contract) => [
            contract.contractId,
            contract.role,
            contract.symbolUid,
          ]),
        ).toEqual([
          ['graphql::query::health', 'provider', 'method:health'],
          ['graphql::query::health', 'consumer', 'const:health-document'],
        ]);
        expect(synced.crossLinks).toEqual([
          expect.objectContaining({
            contractId: 'graphql::query::health',
            matchType: 'exact',
            from: expect.objectContaining({ repo: 'web', symbolUid: 'const:health-document' }),
            to: expect.objectContaining({ repo: 'api', symbolUid: 'method:health' }),
          }),
        ]);
      } finally {
        registrySpy.mockRestore();
      }
    });
  },
  { seed: SEED, poolAdapter: true },
);
