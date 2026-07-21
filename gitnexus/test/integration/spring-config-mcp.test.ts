import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const CONSUMER_ID = 'Property:src/Config.java:DirectValues.timeout';
const CONFIG_ID = 'Property:spring-config:application.properties:payment.timeout';
const SEED = [
  `CREATE (p:\`Property\` {id:'${CONSUMER_ID}', name:'timeout', filePath:'src/Config.java', startLine:4, endLine:4, content:'', description:'', declaredType:'int'})`,
  `CREATE (p:\`Property\` {id:'${CONFIG_ID}', name:'payment.timeout', filePath:'application.properties', startLine:1, endLine:1, content:'', description:'Spring configuration property', declaredType:''})`,
  `MATCH (consumer:\`Property\` {id:'${CONSUMER_ID}'}), (config:\`Property\` {id:'${CONFIG_ID}'}) CREATE (consumer)-[:CodeRelation {type:'USES', confidence:1.0, reason:'spring-config:@Value payment.timeout'}]->(config)`,
];

withTestLbugDB(
  'spring-config-mcp',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
    });

    describe('Spring configuration context and impact visibility', () => {
      it('shows configuration dependencies in context without special query flags', async () => {
        const context = await backend.callTool('context', { uid: CONSUMER_ID });
        expect(context.outgoing.uses).toEqual([
          expect.objectContaining({
            uid: CONFIG_ID,
            name: 'payment.timeout',
            filePath: 'application.properties',
          }),
        ]);
      });

      it('shows consumers in upstream impact from a configuration key', async () => {
        const impact = await backend.callTool('impact', {
          target_uid: CONFIG_ID,
          target: 'payment.timeout',
          direction: 'upstream',
        });
        expect(impact.risk).not.toBe('UNKNOWN');
        expect(impact.byDepth[1]).toEqual([
          expect.objectContaining({
            id: CONSUMER_ID,
            name: 'timeout',
            relationType: 'USES',
          }),
        ]);
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 2, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
