import { after, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTempDir } from '../../../../test/helpers/test-db.js';
import { createTestEnvironment } from '../support/environment.js';
import { resolveAnalysisResourceBudget } from '../../../../dist/core/analysis-resource-budget.js';
import { getStoragePaths, loadMeta, registerRepo } from '../../../../dist/storage/repo-manager.js';
import * as adapter from '../../../../dist/core/lbug/lbug-adapter.js';
import * as integrityModule from '../../../../dist/core/graph/relationship-integrity.js';

let injectInvalidReference = false;
const createCollector: typeof integrityModule.createRelationshipIntegrityCollector = (...args) => {
  const collector = integrityModule.createRelationshipIntegrityCollector(...args);
  if (!injectInvalidReference) return collector;
  return {
    ...collector,
    inspect: (rel, duplicate, conflict) =>
      collector.inspect(
        rel.type === 'CALLS' ? { ...rel, id: 'rel:CALLS:wrong->endpoints:1:0:1:1' } : rel,
        duplicate,
        conflict,
      ),
  };
};
const integrityMock = mock.module(
  new URL('../../../../dist/core/graph/relationship-integrity.js', import.meta.url).href,
  { namedExports: { ...integrityModule, createRelationshipIntegrityCollector: createCollector } },
);
after(() => integrityMock.restore());
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
const { LocalBackend } = await import('../../../../dist/mcp/local/local-backend.js');
const { runPipelineFromRepo } = await import('../../../../dist/core/ingestion/pipeline.js');
const REPO = 'query-integrity';

it('retains nested calls sharing a start position when their full source spans differ', async () => {
  const root = fileURLToPath(
    new URL(
      '../../../../test/fixtures/compiler-conformance/typescript-nested-call-sites/',
      import.meta.url,
    ),
  );
  const result = await runPipelineFromRepo(root, () => {}, {
    skipGraphPhases: true,
    workerPoolSize: 1,
  });
  const calls = result.graph.relationships.filter((r) => r.type === 'CALLS');
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((r) => `${r.sourceId}->${r.targetId}`)).size).toBe(1);
  expect(
    calls.map((r) => r.id.slice(r.id.lastIndexOf(r.targetId) + r.targetId.length)).sort(),
  ).toEqual([':3:2:3:16', ':3:2:3:23']);
  expect(result.relationshipIntegrity).toMatchObject({ unverifiedEdges: 0 });
});

for (const streamGraphEmit of [false, true]) {
  describe(`source-site integrity across indexing (streaming=${streamGraphEmit})`, () => {
    it(
      'preserves source sites, replaces receipts, and never accumulates edges on warm/repeated runs',
      { timeout: 300_000 },
      async () => {
        const temp = await createTempDir();
        const environment = createTestEnvironment();
        environment.set('GITNEXUS_HOME', path.join(temp.dbPath, 'home'));
        environment.set('GITNEXUS_STORAGE_PATH', path.join(temp.dbPath, '.gitnexus'));
        environment.set('GITNEXUS_SHARED_STORE', 'off');
        let backend: InstanceType<typeof LocalBackend> | undefined;
        const git = (...args: string[]) =>
          execFileSync('git', args, { cwd: temp.dbPath, stdio: 'pipe' });
        const writeSource = async (count: number) => {
          await fs.writeFile(
            path.join(temp.dbPath, 'sample.ts'),
            [
              'export class Service { ping() { return 1; } }',
              'export function caller(service: Service) {',
              `  ${Array.from({ length: count }, () => 'service.ping();').join(' ')}`,
              '}',
              '',
            ].join('\n'),
          );
          git('add', 'sample.ts');
          git(
            '-c',
            'user.name=test',
            '-c',
            'user.email=t@t',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-qm',
            `calls ${count}`,
          );
        };
        const options = {
          skipAgentsMd: true,
          skipSkills: true,
          skipFts: true,
          streamGraphEmit,
          resources: resolveAnalysisResourceBudget({
            effectiveMemoryBytes: 4 * 1024 ** 3,
            availableCpus: 2,
            totalMb: 2048,
            workers: 1,
            graphPoolBytes: 128 * 1024 ** 2,
            modelMemoryMb: 0,
          }),
        };
        const inspect = async (count: number) => {
          const meta = await loadMeta(getStoragePaths(temp.dbPath).storagePath);
          expect(meta?.relationshipIntegrity?.checkedSites).toBeGreaterThanOrEqual(count);
          await registerRepo(temp.dbPath, meta!, { name: REPO });
          backend = new LocalBackend();
          await backend.init();
          const refs = await backend.callTool('cypher', {
            repo: temp.dbPath,
            statement:
              "MATCH (a:Function {name: 'caller'})-[r:CodeRelation {type: 'CALLS'}]->(b:Method {name: 'ping'}) RETURN r",
          });
          expect(refs.row_count).toBe(count);
          expect(refs.graph_integrity).toMatchObject({
            checkedSites: meta!.relationshipIntegrity!.checkedSites,
          });
          const context = await backend.callTool('context', {
            repo: temp.dbPath,
            name: 'ping',
            file_path: 'sample.ts',
          });
          expect(context.incoming.calls).toHaveLength(1);
          expect(context.graph_integrity).toMatchObject({
            scope: 'source-reference-ingestion',
            checkedSites: meta!.relationshipIntegrity!.checkedSites,
          });
          const query = await backend.callTool('query', {
            repo: temp.dbPath,
            search_query: 'ping',
          });
          expect(query.error).toBeUndefined();
          expect(query.graph_integrity).toEqual(context.graph_integrity);
          const impact = await backend.callTool('impact', {
            repo: temp.dbPath,
            target: 'ping',
            direction: 'upstream',
          });
          expect(impact.error).toBeUndefined();
          expect(impact.target.name).toBe('ping');
          expect(impact.graph_integrity).toEqual(context.graph_integrity);
          await backend.dispose();
          backend = undefined;
          return meta!.relationshipIntegrity;
        };
        try {
          git('init', '-q');
          await fs.appendFile(
            path.join(temp.dbPath, '.git', 'info', 'exclude'),
            '\nhome/\n.gitnexus/\n',
          );
          await writeSource(2);
          const cold = await runFullAnalysis(
            temp.dbPath,
            { ...options, force: streamGraphEmit },
            { onProgress() {} },
          );
          expect(cold.pipelineResult?.reparsedFileCount).toBeGreaterThan(0);
          expect(Boolean(cold.pipelineResult?.graphEmitManifest)).toBe(streamGraphEmit);
          const firstReceipt = await inspect(2);
          // Inject an impossible emitted identity, independent of working-tree edits.
          injectInvalidReference = true;
          try {
            await expect(
              runFullAnalysis(temp.dbPath, { ...options, force: true }, { onProgress() {} }),
            ).rejects.toThrow(/Invalid graph reference/);
          } finally {
            injectInvalidReference = false;
          }
          expect(await inspect(2)).toEqual(firstReceipt);
          const warm = await runFullAnalysis(
            temp.dbPath,
            { ...options, force: true },
            { onProgress() {} },
          );
          expect(warm.pipelineResult?.parseCacheHitFileCount).toBeGreaterThan(0);
          expect(warm.pipelineResult?.reparsedFileCount).toBe(0);
          expect(await inspect(2)).toEqual(firstReceipt);
          await writeSource(3);
          const changed = await runFullAnalysis(
            temp.dbPath,
            { ...options, force: streamGraphEmit },
            { onProgress() {} },
          );
          expect(Boolean(changed.pipelineResult?.graphEmitManifest)).toBe(streamGraphEmit);
          const changedReceipt = await inspect(3);
          expect(changedReceipt!.checkedSites).toBeGreaterThan(firstReceipt!.checkedSites);
          const unchanged = await runFullAnalysis(temp.dbPath, options, { onProgress() {} });
          expect(unchanged.alreadyUpToDate).toBe(true);
          expect(await inspect(3)).toEqual(changedReceipt);
        } finally {
          await backend?.dispose();
          await adapter.closeLbug();
          environment.restore();
          await temp.cleanup();
        }
      },
    );
  });
}
