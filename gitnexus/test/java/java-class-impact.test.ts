/**
 * Integration Tests: Java Class node traversal fix (#480)
 *
 * Reproduces the exact scenario from the issue:
 * - SessionTracker class with 1 production caller + 4 test callers
 * - RankPermissionHandler class with 1 caller + 10 importers
 *
 * Before fix: impact(upstream) → impactedCount: 0, context() → incoming: {}
 * After fix:  both tools surface callers/importers correctly
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { executeQuery } from '../../src/mcp/core/lbug-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

// Mirrors the exact graph structure from issue #480:
// SessionTracker: 1 prod caller + 4 test callers via Constructor
//                 1 importer via File
// RankPermissionHandler: 1 caller via Constructor, 10 importers via File
const SEED = [
  // ── SessionTracker ──────────────────────────────────────────────────
  `CREATE (f:File {id: 'file:SessionTracker.java', name: 'SessionTracker.java', filePath: 'api/session/SessionTracker.java', content: ''})`,
  `CREATE (c:Class {id: 'class:SessionTracker', name: 'SessionTracker', filePath: 'api/session/SessionTracker.java', startLine: 1, endLine: 80, isExported: true, content: 'class SessionTracker {}', description: 'Session tracker'})`,
  `CREATE (ctor:Constructor {id: 'ctor:SessionTracker', name: 'SessionTracker', filePath: 'api/session/SessionTracker.java', startLine: 10, endLine: 15, content: 'SessionTracker() {}', description: ''})`,

  // 1 production caller
  `CREATE (m1:Method {id: 'method:registerSessionTracker', name: 'registerSessionTracker', filePath: 'core/bootstrap/ServerBootstrap.java', startLine: 20, endLine: 30, isExported: false, content: '', description: ''})`,
  // 4 test callers — use src/test/java/... paths so isTestFilePath() filters them
  `CREATE (m2:Method {id: 'method:setUp', name: 'setUp', filePath: 'src/test/java/api/session/SessionTrackerTest.java', startLine: 5, endLine: 10, isExported: false, content: '', description: ''})`,
  `CREATE (m3:Method {id: 'method:constructor_nullGameMode_accepted', name: 'constructor_nullGameMode_accepted', filePath: 'src/test/java/api/session/SessionTrackerTest.java', startLine: 15, endLine: 22, isExported: false, content: '', description: ''})`,
  `CREATE (m4:Method {id: 'method:constructor_nullServerId_accepted', name: 'constructor_nullServerId_accepted', filePath: 'src/test/java/api/session/SessionTrackerTest.java', startLine: 24, endLine: 31, isExported: false, content: '', description: ''})`,
  `CREATE (m5:Method {id: 'method:startPlayerSession_passesGameModeAndServerId', name: 'startPlayerSession_passesGameModeAndServerId', filePath: 'src/test/java/api/session/SessionTrackerTest.java', startLine: 33, endLine: 42, isExported: false, content: '', description: ''})`,

  // 1 importer file
  `CREATE (f2:File {id: 'file:ServerBootstrap.java', name: 'ServerBootstrap.java', filePath: 'core/bootstrap/ServerBootstrap.java', content: ''})`,

  // CALLS → Constructor (Java graph structure — NOT to Class)
  `MATCH (a:Method {id:'method:registerSessionTracker'}), (b:Constructor {id:'ctor:SessionTracker'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:setUp'}), (b:Constructor {id:'ctor:SessionTracker'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:constructor_nullGameMode_accepted'}), (b:Constructor {id:'ctor:SessionTracker'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:constructor_nullServerId_accepted'}), (b:Constructor {id:'ctor:SessionTracker'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:startPlayerSession_passesGameModeAndServerId'}), (b:Constructor {id:'ctor:SessionTracker'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,

  // IMPORTS → File (Java graph structure — NOT to Class)
  `MATCH (a:File {id:'file:ServerBootstrap.java'}), (b:File {id:'file:SessionTracker.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,

  // Class structure edges
  `MATCH (c:Class {id:'class:SessionTracker'}), (ctor:Constructor {id:'ctor:SessionTracker'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(ctor)`,
  `MATCH (f:File {id:'file:SessionTracker.java'}), (c:Class {id:'class:SessionTracker'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,

  // ── RankPermissionHandler ───────────────────────────────────────────
  `CREATE (f3:File {id: 'file:RankPermissionHandler.java', name: 'RankPermissionHandler.java', filePath: 'core/rank/RankPermissionHandler.java', content: ''})`,
  `CREATE (c2:Class {id: 'class:RankPermissionHandler', name: 'RankPermissionHandler', filePath: 'core/rank/RankPermissionHandler.java', startLine: 1, endLine: 60, isExported: true, content: 'class RankPermissionHandler {}', description: ''})`,
  `CREATE (ctor2:Constructor {id: 'ctor:RankPermissionHandler', name: 'RankPermissionHandler', filePath: 'core/rank/RankPermissionHandler.java', startLine: 5, endLine: 10, content: '', description: ''})`,

  // 1 caller via Constructor
  `CREATE (m6:Method {id: 'method:initRankHandler', name: 'initRankHandler', filePath: 'core/rank/RankService.java', startLine: 10, endLine: 20, isExported: false, content: '', description: ''})`,
  `MATCH (a:Method {id:'method:initRankHandler'}), (b:Constructor {id:'ctor:RankPermissionHandler'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,

  // 10 importers via File
  `CREATE (fi1:File {id:'file:imp1.java', name:'RankCommand.java', filePath:'core/rank/RankCommand.java', content:''})`,
  `CREATE (fi2:File {id:'file:imp2.java', name:'RankListener.java', filePath:'core/rank/RankListener.java', content:''})`,
  `CREATE (fi3:File {id:'file:imp3.java', name:'RankManager.java', filePath:'core/rank/RankManager.java', content:''})`,
  `CREATE (fi4:File {id:'file:imp4.java', name:'RankConfig.java', filePath:'core/rank/RankConfig.java', content:''})`,
  `CREATE (fi5:File {id:'file:imp5.java', name:'RankAPI.java', filePath:'core/rank/RankAPI.java', content:''})`,
  `CREATE (fi6:File {id:'file:imp6.java', name:'RankTest1.java', filePath:'src/test/java/core/rank/RankTest1.java', content:''})`,
  `CREATE (fi7:File {id:'file:imp7.java', name:'RankTest2.java', filePath:'src/test/java/core/rank/RankTest2.java', content:''})`,
  `CREATE (fi8:File {id:'file:imp8.java', name:'RankTest3.java', filePath:'src/test/java/core/rank/RankTest3.java', content:''})`,
  `CREATE (fi9:File {id:'file:imp9.java', name:'RankTest4.java', filePath:'src/test/java/core/rank/RankTest4.java', content:''})`,
  `CREATE (fi10:File {id:'file:imp10.java', name:'RankTest5.java', filePath:'src/test/java/core/rank/RankTest5.java', content:''})`,
  `MATCH (a:File {id:'file:imp1.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp2.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp3.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp4.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp5.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp6.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp7.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp8.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp9.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:imp10.java'}), (b:File {id:'file:RankPermissionHandler.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,

  `MATCH (c2:Class {id:'class:RankPermissionHandler'}), (ctor2:Constructor {id:'ctor:RankPermissionHandler'}) CREATE (c2)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(ctor2)`,
  `MATCH (f3:File {id:'file:RankPermissionHandler.java'}), (c2:Class {id:'class:RankPermissionHandler'}) CREATE (f3)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c2)`,
];

withTestLbugDB(
  'java-class-impact',
  (handle) => {
    // ─── Confirm root cause is present in graph ─────────────────────────

    describe('root cause confirmed: Java graph edge structure', () => {
      it('CALLS edges go to Constructor, not Class — so naive Class traversal finds 0', async () => {
        const onClass = await executeQuery(
          handle.repoId,
          `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b:Class {name:'SessionTracker'}) RETURN a.name AS name`,
        );
        expect(onClass).toHaveLength(0); // this is the bug — Class has no CALLS edges

        const onCtor = await executeQuery(
          handle.repoId,
          `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b:Constructor {name:'SessionTracker'}) RETURN a.name AS name`,
        );
        expect(onCtor).toHaveLength(5); // all 5 callers are on Constructor
      });

      it('IMPORTS edges go to File, not Class', async () => {
        const onClass = await executeQuery(
          handle.repoId,
          `MATCH (a)-[r:CodeRelation {type:'IMPORTS'}]->(b:Class {name:'SessionTracker'}) RETURN a.name AS name`,
        );
        expect(onClass).toHaveLength(0);

        const onFile = await executeQuery(
          handle.repoId,
          `MATCH (a)-[r:CodeRelation {type:'IMPORTS'}]->(b:File {name:'SessionTracker.java'}) RETURN a.name AS name`,
        );
        expect(onFile).toHaveLength(1); // ServerBootstrap.java
      });
    });

    // ─── Bug 1: impact() fix ────────────────────────────────────────────

    describe('Bug 1 fix: impact(upstream) on Class returns callers', () => {
      let backend: LocalBackend;
      beforeAll(async () => {
        backend = (handle as any)._backend;
      });

      it('default call (no includeTests) finds the 1 production caller and excludes test callers', async () => {
        // Exact call from the issue: gitnexus_impact({target: "SessionTracker", direction: "upstream"})
        // Before fix: impactedCount: 0, risk: LOW, byDepth: {}
        const result = await backend.callTool('impact', {
          target: 'SessionTracker',
          direction: 'upstream',
        });

        expect(result).not.toHaveProperty('error');
        // At minimum: 1 production caller (registerSessionTracker) + 1 file
        // importer (ServerBootstrap.java discovered via BFS from the seeded File)
        expect(result.impactedCount).toBeGreaterThanOrEqual(2);

        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);

        // Production caller must be present
        expect(names).toContain('registerSessionTracker');

        // Test callers must be excluded (paths match /test/ via isTestFilePath)
        expect(names).not.toContain('setUp');
        expect(names).not.toContain('constructor_nullGameMode_accepted');
        expect(names).not.toContain('constructor_nullServerId_accepted');
        expect(names).not.toContain('startPlayerSession_passesGameModeAndServerId');
      });

      it('with includeTests finds all 5 callers (1 prod + 4 tests)', async () => {
        const result = await backend.callTool('impact', {
          target: 'SessionTracker',
          direction: 'upstream',
          includeTests: true,
        });

        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBeGreaterThanOrEqual(5);

        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('registerSessionTracker');
        expect(names).toContain('setUp');
        expect(names).toContain('constructor_nullGameMode_accepted');
        expect(names).toContain('constructor_nullServerId_accepted');
        expect(names).toContain('startPlayerSession_passesGameModeAndServerId');

        // Owning file (SessionTracker.java) must NOT appear — it is the
        // definition container, not an upstream dependent (#480 Copilot review)
        const allNames = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((d: any) => d.name);
        expect(allNames).not.toContain('SessionTracker.java');
      });

      it('RankPermissionHandler: 1 caller via Constructor + 10 importers via File (was 0 before fix)', async () => {
        const result = await backend.callTool('impact', {
          target: 'RankPermissionHandler',
          direction: 'upstream',
          includeTests: true,
        });

        expect(result).not.toHaveProperty('error');
        // 1 caller (depth 1 via Constructor) + 10 importers (depth 2 via File)
        expect(result.impactedCount).toBeGreaterThanOrEqual(11);

        const allNames = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((d: any) => d.name);
        expect(allNames).toContain('initRankHandler');
        expect(allNames).toContain('RankCommand.java');
        expect(allNames).toContain('RankManager.java');

        // Owning file must NOT appear in results
        expect(allNames).not.toContain('RankPermissionHandler.java');
      });

      it('RankPermissionHandler: default call (no includeTests) excludes test importers', async () => {
        const result = await backend.callTool('impact', {
          target: 'RankPermissionHandler',
          direction: 'upstream',
        });

        expect(result).not.toHaveProperty('error');

        const allNames = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((d: any) => d.name);

        // Production importers must be present
        expect(allNames).toContain('RankCommand.java');

        // Test importers (src/test/java/... paths) must be excluded
        expect(allNames).not.toContain('RankTest1.java');
        expect(allNames).not.toContain('RankTest2.java');
        expect(allNames).not.toContain('RankTest3.java');
        expect(allNames).not.toContain('RankTest4.java');
        expect(allNames).not.toContain('RankTest5.java');
      });
    });

    // ─── Bug 2: context() fix ───────────────────────────────────────────

    describe('Bug 2 fix: context() on Class shows non-empty incoming', () => {
      let backend: LocalBackend;
      beforeAll(async () => {
        backend = (handle as any)._backend;
      });

      it('incoming.calls contains Constructor callers (was empty before fix)', async () => {
        // Exact call from issue: gitnexus_context({name: "SessionTracker", file_path: "api/.../SessionTracker.java"})
        // Before fix: incoming: {}
        const result = await backend.callTool('context', {
          name: 'SessionTracker',
          file_path: 'api/session/SessionTracker.java',
        });

        expect(result.status).toBe('found');
        expect(result.symbol.kind).toBe('Class');
        expect(result.incoming).toBeDefined();

        // Should have calls from the Constructor callers
        const calls = result.incoming.calls || [];
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const callerNames = calls.map((c: any) => c.name);
        expect(callerNames).toContain('registerSessionTracker');
      });

      it('incoming.imports contains File importers', async () => {
        const result = await backend.callTool('context', {
          name: 'SessionTracker',
          file_path: 'api/session/SessionTracker.java',
        });

        expect(result.status).toBe('found');
        const imports = result.incoming.imports || [];
        expect(imports.length).toBeGreaterThanOrEqual(1);
        const importerNames = imports.map((c: any) => c.name);
        expect(importerNames).toContain('ServerBootstrap.java');
      });

      it('contrast: context() on a Method still works (regression check)', async () => {
        // The issue notes context() on methods worked before — must still work after fix
        const result = await backend.callTool('context', {
          name: 'registerSessionTracker',
        });
        expect(result.status).toBe('found');
        // registerSessionTracker calls SessionTracker constructor — should appear in outgoing
        expect(result.outgoing).toBeDefined();
      });

      it('RankPermissionHandler: incoming shows caller and importers', async () => {
        const result = await backend.callTool('context', {
          name: 'RankPermissionHandler',
          file_path: 'core/rank/RankPermissionHandler.java',
        });

        expect(result.status).toBe('found');
        expect(result.symbol.kind).toBe('Class');

        const calls = result.incoming.calls || [];
        expect(calls.map((c: any) => c.name)).toContain('initRankHandler');

        const imports = result.incoming.imports || [];
        expect(imports.length).toBeGreaterThanOrEqual(10);
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
          stats: { files: 10, nodes: 20, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
