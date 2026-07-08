/**
 * Integration test: context() expands Class symbols through typed properties.
 *
 * Reproduces EF-style usage where code reads a DbContext property
 * (`db.USER_INFO`) whose source type is `DbSet<USER_INFO>`. The direct
 * graph edge is Method -> Property, not Method -> Class, so context() must
 * use the same typed-property bridge that impact() uses.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SEED = [
  `CREATE (c:Class {id:'Class:Models/USER_INFO.cs:USER_INFO', name:'USER_INFO', filePath:'Models/USER_INFO.cs', startLine:1, endLine:5, content:'public class USER_INFO {}', description:''})`,
  `CREATE (p:\`Property\` {id:'Property:Data/UserDbContext.cs:UserDbContext.USER_INFO', name:'USER_INFO', filePath:'Data/UserDbContext.cs', startLine:10, endLine:10, content:'public DbSet<USER_INFO> USER_INFO { get; set; }', description:'', declaredType:'DbSet<USER_INFO>'})`,
  `CREATE (m:Method {id:'Method:Services/UserService.cs:UserService.GetUserInfo#1', name:'GetUserInfo', filePath:'Services/UserService.cs', startLine:20, endLine:30, isExported:false, content:'db.USER_INFO.FirstOrDefault();', description:'', parameterCount:1, returnType:'USER_INFO'})`,
  `MATCH (m:Method {id:'Method:Services/UserService.cs:UserService.GetUserInfo#1'}), (p:\`Property\` {id:'Property:Data/UserDbContext.cs:UserDbContext.USER_INFO'}) CREATE (m)-[:CodeRelation {type:'ACCESSES', confidence:1.0, reason:'read', step:1}]->(p)`,
];

withTestLbugDB(
  'context-typed-property',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(async () => {
      backend = (handle as any)._backend;
    });

    describe('context() typed-property expansion', () => {
      it('surfaces property callers and explains the typed property bridge', async () => {
        const result = await backend.callTool('context', {
          uid: 'Class:Models/USER_INFO.cs:USER_INFO',
        });

        expect(result.status).toBe('found');
        expect(result.symbol.kind).toBe('Class');

        const accesses = result.incoming.accesses || [];
        expect(accesses.map((r: any) => r.name)).toContain('GetUserInfo');

        expect(result.typed_properties).toEqual([
          expect.objectContaining({
            uid: 'Property:Data/UserDbContext.cs:UserDbContext.USER_INFO',
            name: 'USER_INFO',
            declaredType: 'DbSet<USER_INFO>',
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
          stats: { files: 3, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
