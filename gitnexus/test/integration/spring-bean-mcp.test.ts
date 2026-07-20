import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const BEAN_ID = 'Class:src/BillingService.java:BillingService';
const KOTLIN_BEAN_ID = 'Class:src/KotlinBillingService.kt:KotlinBillingService';
const PLAIN_ID = 'Class:src/PlainUtility.java:PlainUtility';
const NON_JAVA_ID = 'Class:src/AppProvider.ts:AppProvider';
const CONFLICT_ID = 'Class:src/ConflictingBean.java:ConflictingBean';
const SEED = [
  `CREATE (c:Class {id:'${BEAN_ID}', name:'BillingService', filePath:'src/BillingService.java', startLine:0, endLine:3, isExported:false, content:'class BillingService {}', description:'', frameworkAnnotations:['org.springframework.stereotype.Service']})`,
  `CREATE (c:Class {id:'${KOTLIN_BEAN_ID}', name:'KotlinBillingService', filePath:'src/KotlinBillingService.kt', startLine:0, endLine:3, isExported:false, content:'class KotlinBillingService', description:'', frameworkAnnotations:['org.springframework.stereotype.Service']})`,
  `CREATE (c:Class {id:'${PLAIN_ID}', name:'PlainUtility', filePath:'src/PlainUtility.java', startLine:0, endLine:1, isExported:false, content:'class PlainUtility {}', description:'', frameworkAnnotations:[]})`,
  `CREATE (c:Class {id:'${NON_JAVA_ID}', name:'AppProvider', filePath:'src/AppProvider.ts', startLine:0, endLine:1, isExported:true, content:'class AppProvider {}', description:'', frameworkAnnotations:['@nestjs/common.Injectable']})`,
  `CREATE (c:Class {id:'${CONFLICT_ID}', name:'ConflictingBean', filePath:'src/ConflictingBean.java', startLine:0, endLine:1, isExported:false, content:'class ConflictingBean {}', description:'', frameworkAnnotations:['org.springframework.stereotype.Service', 'org.springframework.stereotype.Component']})`,
];

withTestLbugDB(
  'spring-bean-mcp',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
    });

    describe('Bean metadata MCP enrichment', () => {
      it('returns the same nested Bean shape for Java and Kotlin from context and impact', async () => {
        const javaContext = await backend.callTool('context', { uid: BEAN_ID });
        const kotlinContext = await backend.callTool('context', { uid: KOTLIN_BEAN_ID });
        const kotlinImpact = await backend.callTool('impact', {
          target: 'KotlinBillingService',
          direction: 'upstream',
        });
        const javaImpact = await backend.callTool('impact', {
          target: 'BillingService',
          direction: 'upstream',
        });

        const expectedBean = {
          framework: 'spring',
          role: 'service',
          annotation: 'org.springframework.stereotype.Service',
        };
        expect(javaContext.symbol.bean).toEqual(expectedBean);
        expect(kotlinContext.symbol.bean).toEqual(expectedBean);
        expect(javaImpact.target.bean).toEqual(expectedBean);
        expect(kotlinImpact.target.bean).toEqual(expectedBean);
      });

      it('omits Bean metadata for an ordinary Class', async () => {
        const context = await backend.callTool('context', { uid: PLAIN_ID });
        const impact = await backend.callTool('impact', {
          target: 'PlainUtility',
          direction: 'upstream',
        });

        expect(context.symbol).not.toHaveProperty('bean');
        expect(impact.target).not.toHaveProperty('bean');
      });

      it('omits Spring Bean metadata for non-Spring and conflicting evidence', async () => {
        const nonJava = await backend.callTool('context', { uid: NON_JAVA_ID });
        const conflict = await backend.callTool('impact', {
          target: 'ConflictingBean',
          direction: 'upstream',
        });

        expect(nonJava.symbol).not.toHaveProperty('bean');
        expect(conflict.target).not.toHaveProperty('bean');
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
          stats: { files: 4, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
