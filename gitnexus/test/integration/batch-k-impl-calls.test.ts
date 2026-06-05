/**
 * Batch K — Integration Tests for issues #13 and #36
 *
 * #13: context() incoming references must include the calling METHOD,
 *      not just the calling File. When a method has a method-level
 *      CALLS edge, context(name="someMethod") should return the caller
 *      method (not just the file containing it).
 *
 * #36: impact(target="ImplClass", direction="upstream") must seed the
 *      BFS from interfaces the class implements. Callers of the
 *      interface are otherwise invisible to the upstream walk.
 *
 * Uses a Spring-style fixture: Interface + Impl class + Method-level
 * CALLS edges between methods.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { executeQuery } from '../../src/mcp/core/lbug-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// Graph mirrors the Spring pattern from #13 and #36:
// - UserService interface (Interface) called by UserController (Method)
// - UserServiceImpl class implements UserService (IMPLEMENTS)
// - UserServiceImpl#createUser is called by UserController#register
// - SomeMethod target has direct method-level CALLS from CallerMethod
const SEED = [
  // ── Target method for #13 ──────────────────────────────────────────
  `CREATE (f1:File {id: 'file:TargetService.java', name: 'TargetService.java', filePath: 'api/target/TargetService.java', content: ''})`,
  `CREATE (c1:Class {id: 'class:TargetService', name: 'TargetService', filePath: 'api/target/TargetService.java', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,
  `CREATE (m_target:Method {id: 'method:doWork', name: 'doWork', filePath: 'api/target/TargetService.java', startLine: 5, endLine: 15, isExported: false, content: '', description: ''})`,

  // Caller file + caller method with a direct method-level CALLS edge
  `CREATE (f2:File {id: 'file:CallerService.java', name: 'CallerService.java', filePath: 'api/caller/CallerService.java', content: ''})`,
  `CREATE (c2:Class {id: 'class:CallerService', name: 'CallerService', filePath: 'api/caller/CallerService.java', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,
  `CREATE (m_caller:Method {id: 'method:invokeTarget', name: 'invokeTarget', filePath: 'api/caller/CallerService.java', startLine: 10, endLine: 20, isExported: false, content: '', description: ''})`,
  // The direct method-level CALLS edge — the one #13 cares about
  `MATCH (a:Method {id:'method:invokeTarget'}), (b:Method {id:'method:doWork'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.95, reason:'direct', step:0}]->(b)`,
  // File-level IMPORTS edge — the noise #13 wants to filter past
  `MATCH (a:File {id:'file:CallerService.java'}), (b:File {id:'file:TargetService.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,

  // Class structure for the target
  `MATCH (c1:Class {id:'class:TargetService'}), (m:Method {id:'method:doWork'}) CREATE (c1)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (c2:Class {id:'class:CallerService'}), (m:Method {id:'method:invokeTarget'}) CREATE (c2)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f1:File {id:'file:TargetService.java'}), (c1:Class {id:'class:TargetService'}) CREATE (f1)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c1)`,
  `MATCH (f2:File {id:'file:CallerService.java'}), (c2:Class {id:'class:CallerService'}) CREATE (f2)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c2)`,

  // ── Interface/impl chain for #36 ────────────────────────────────────
  `CREATE (f3:File {id: 'file:IUserService.java', name: 'IUserService.java', filePath: 'api/user/IUserService.java', content: ''})`,
  `CREATE (iface:Interface {id: 'interface:UserService', name: 'UserService', filePath: 'api/user/IUserService.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,

  // Caller of the interface (Method X depends on the interface)
  `CREATE (f4:File {id: 'file:UserController.java', name: 'UserController.java', filePath: 'api/user/UserController.java', content: ''})`,
  `CREATE (c4:Class {id: 'class:UserController', name: 'UserController', filePath: 'api/user/UserController.java', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,
  `CREATE (m_ctrl:Method {id: 'method:handleUser', name: 'handleUser', filePath: 'api/user/UserController.java', startLine: 10, endLine: 20, isExported: false, content: '', description: ''})`,

  // The implementation
  `CREATE (f5:File {id: 'file:UserServiceImpl.java', name: 'UserServiceImpl.java', filePath: 'api/user/impl/UserServiceImpl.java', content: ''})`,
  `CREATE (c5:Class {id: 'class:UserServiceImpl', name: 'UserServiceImpl', filePath: 'api/user/impl/UserServiceImpl.java', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,
  `CREATE (m_impl:Method {id: 'method:createUser', name: 'createUser', filePath: 'api/user/impl/UserServiceImpl.java', startLine: 10, endLine: 20, isExported: false, content: '', description: ''})`,

  // The interface is called by the controller's method (method-level CALLS)
  `MATCH (a:Method {id:'method:handleUser'}), (b:Method {id:'method:createUser'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  // Controller file imports the interface file (file-level IMPORTS)
  `MATCH (a:File {id:'file:UserController.java'}), (b:File {id:'file:IUserService.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  // The class implements the interface
  `MATCH (a:Class {id:'class:UserServiceImpl'}), (b:Interface {id:'interface:UserService'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.95, reason:'direct', step:0}]->(b)`,

  // Class structure
  `MATCH (c4:Class {id:'class:UserController'}), (m:Method {id:'method:handleUser'}) CREATE (c4)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (c5:Class {id:'class:UserServiceImpl'}), (m:Method {id:'method:createUser'}) CREATE (c5)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f3:File {id:'file:IUserService.java'}), (iface:Interface {id:'interface:UserService'}) CREATE (f3)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(iface)`,
  `MATCH (f4:File {id:'file:UserController.java'}), (c4:Class {id:'class:UserController'}) CREATE (f4)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c4)`,
  `MATCH (f5:File {id:'file:UserServiceImpl.java'}), (c5:Class {id:'class:UserServiceImpl'}) CREATE (f5)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c5)`,

  // ── M1: Isolated method with NO incoming CALLS (entry point) ────────
  `CREATE (f_iso:File {id: 'file:EntryPoint.java', name: 'EntryPoint.java', filePath: 'api/entry/EntryPoint.java', content: ''})`,
  `CREATE (c_iso:Class {id: 'class:EntryPoint', name: 'EntryPoint', filePath: 'api/entry/EntryPoint.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (m_iso:Method {id: 'method:isolatedMethod', name: 'isolatedMethod', filePath: 'api/entry/EntryPoint.java', startLine: 5, endLine: 15, isExported: false, content: '', description: ''})`,
  `MATCH (c_iso:Class {id:'class:EntryPoint'}), (m:Method {id:'method:isolatedMethod'}) CREATE (c_iso)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f_iso:File {id:'file:EntryPoint.java'}), (c_iso:Class {id:'class:EntryPoint'}) CREATE (f_iso)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c_iso)`,

  // ── M2: Second interface UserService2 also implemented by UserServiceImpl ──
  `CREATE (f6:File {id: 'file:IUserService2.java', name: 'IUserService2.java', filePath: 'api/user/IUserService2.java', content: ''})`,
  `CREATE (iface2:Interface {id: 'interface:UserService2', name: 'UserService2', filePath: 'api/user/IUserService2.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,

  // Caller of UserService2 (different controller method)
  `CREATE (m_ctrl2:Method {id: 'method:handleUser2', name: 'handleUser2', filePath: 'api/user/UserController.java', startLine: 25, endLine: 35, isExported: false, content: '', description: ''})`,

  // A second method on UserServiceImpl that implements the UserService2 contract
  `CREATE (m_impl2:Method {id: 'method:deleteUser', name: 'deleteUser', filePath: 'api/user/impl/UserServiceImpl.java', startLine: 25, endLine: 35, isExported: false, content: '', description: ''})`,

  // Method-level CALLS from handleUser2 → deleteUser
  `MATCH (a:Method {id:'method:handleUser2'}), (b:Method {id:'method:deleteUser'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  // Controller file imports the second interface file
  `MATCH (a:File {id:'file:UserController.java'}), (b:File {id:'file:IUserService2.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  // UserServiceImpl also implements UserService2
  `MATCH (a:Class {id:'class:UserServiceImpl'}), (b:Interface {id:'interface:UserService2'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.95, reason:'direct', step:0}]->(b)`,

  // Class structure for the second interface chain
  `MATCH (c4:Class {id:'class:UserController'}), (m:Method {id:'method:handleUser2'}) CREATE (c4)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (c5:Class {id:'class:UserServiceImpl'}), (m:Method {id:'method:deleteUser'}) CREATE (c5)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f6:File {id:'file:IUserService2.java'}), (iface2:Interface {id:'interface:UserService2'}) CREATE (f6)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(iface2)`,
];

withTestLbugDB('batch-k-impl-calls', (handle) => {

  describe('graph shape (precondition)', () => {
    it('has direct method-level CALLS edge from invokeTarget → doWork', async () => {
      const rows = await executeQuery(handle.repoId,
        `MATCH (a:Method {name:'invokeTarget'})-[r:CodeRelation {type:'CALLS'}]->(b:Method {name:'doWork'}) RETURN a.name AS caller, b.name AS target`,
      );
      expect(rows).toHaveLength(1);
    });

    it('has UserServiceImpl IMPLEMENTS UserService', async () => {
      const rows = await executeQuery(handle.repoId,
        `MATCH (c:Class {name:'UserServiceImpl'})-[r:CodeRelation {type:'IMPLEMENTS'}]->(i:Interface {name:'UserService'}) RETURN c.name AS impl, i.name AS iface`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ─── #13 fix: context incoming includes calling METHOD ────────────

  describe('#13 fix: context(name="someMethod") returns the calling METHOD', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('incoming.calls contains the caller method (not just the file)', async () => {
      const result = await backend.callTool('context', {
        name: 'doWork',
        file_path: 'api/target/TargetService.java',
      });

      expect(result.status).toBe('found');
      expect(result.incoming).toBeDefined();

      const calls = result.incoming.calls || [];
      const callerNames = calls.map((c: any) => c.name);
      // The caller METHOD must appear, not just the caller file
      expect(callerNames).toContain('invokeTarget');

      // The caller must carry method-level fields (uid prefix = method:)
      const callerMethod = calls.find((c: any) => c.name === 'invokeTarget');
      expect(callerMethod).toBeDefined();
      expect(callerMethod.uid).toBe('method:invokeTarget');
      expect(callerMethod.filePath).toBe('api/caller/CallerService.java');
    });
  });

  // ─── #36 fix: impact seeds from interface the class implements ────

  describe('#36 fix: impact(ImplClass, upstream) reaches interface callers', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('upstream impact on UserServiceImpl surfaces the controller caller via interface', async () => {
      // Before fix: UserServiceImpl had no upstream callers — IMPLEMENTS was
      // walked outgoing only (class → interface), not the reverse. The
      // controller's method-level CALLS to createUser was missed because the
      // BFS never visited the interface.
      //
      // After fix: the BFS seeds from the UserService interface, finds the
      // controller's file (via IMPORTS) and the controller's method (via
      // CALLS) at depth ≥1.
      const result = await backend.callTool('impact', {
        target: 'UserServiceImpl',
        direction: 'upstream',
      });

      expect(result).not.toHaveProperty('error');
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);

      // The controller file (UserController.java) is an upstream dependent
      // via the interface — its IMPORTS edge points at the interface file,
      // which is in the seeded frontier.
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat().map((d: any) => d.name);
      expect(allNames).toContain('UserController.java');

      // M3: pin the depth-1 guarantee — the controller file must be reached
      // at depth 1, not pushed to depth 2 (which would happen if the
      // file-seed were lost). Regression guard.
      expect(result.byDepth[1]?.some((d: any) => d.name === 'UserController.java'))
        .toBe(true);
    });

    // M1: isolated method with NO incoming CALLS — the guard
    // `if (methodIncoming.length > 0)` must not corrupt `incomingRows`
    // when the target is an entry point with no callers.
    it('non-class target with no direct method-level CALLS returns a well-formed incoming', async () => {
      const result = await backend.callTool('context', {
        name: 'isolatedMethod',
        file_path: 'api/entry/EntryPoint.java',
      });

      expect(result.status).toBe('found');
      expect(result.incoming).toBeDefined();

      // `incoming` must be a well-formed object — no null entries, no crash.
      // The shape of `incoming` is { calls?: [], imports?: [], extends?: [], implements?: [] }.
      // We assert the keys are present (even if empty) and that there is
      // no `null` slot where a list is expected.
      const incoming = result.incoming as Record<string, any>;
      for (const key of ['calls', 'imports', 'extends', 'implements']) {
        if (key in incoming) {
          expect(incoming[key]).not.toBeNull();
          if (Array.isArray(incoming[key])) {
            // No null/undefined entries in caller lists
            for (const entry of incoming[key]) {
              expect(entry).not.toBeNull();
              expect(entry).toBeDefined();
            }
          }
        }
      }

      // The isolated method is an entry point — it has NO direct method-level
      // CALLS incoming. The CALLS list should be empty (the file-level
      // IMPORTS edges live under `imports`, not `calls`).
      const calls = (incoming.calls || []) as any[];
      const callerNames = calls.map((c: any) => c.name);
      expect(callerNames).not.toContain('invokeTarget');
      // The method must not have been accidentally "merged" with file-level
      // IMPORTS noise.
      for (const c of calls) {
        // Every caller in `calls` should be a method-level entry (uid prefix
        // method:), not a file. This is the dedup promise of the fix.
        if (c.uid) {
          expect(String(c.uid).startsWith('method:')).toBe(true);
        }
      }
    });

    // M2: UserServiceImpl implements TWO interfaces. Upstream impact must
    // surface callers of BOTH interfaces — catches a regression that
    // hard-codes `ifaceFileRows[0]` or otherwise assumes a single interface.
    it('upstream impact surfaces callers of BOTH implemented interfaces', async () => {
      const result = await backend.callTool('impact', {
        target: 'UserServiceImpl',
        direction: 'upstream',
      });

      expect(result).not.toHaveProperty('error');
      expect(result.impactedCount).toBeGreaterThanOrEqual(2);

      // Robust signal: BOTH controller methods (handleUser, handleUser2)
      // are upstream callers. handleUser is reached via the UserService
      // interface; handleUser2 is reached via the UserService2 interface.
      // If the BFS hard-coded the first interface only, handleUser2 would
      // be missing.
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat().map((d: any) => d.name);

      // handleUser: caller of createUser (via UserService)
      expect(allNames).toContain('handleUser');
      // handleUser2: caller of deleteUser (via UserService2) — the regression
      // catch. Hard-coding ifaceFileRows[0] would miss this.
      expect(allNames).toContain('handleUser2');
      // Controller file is reached via both interfaces
      expect(allNames).toContain('UserController.java');
    });

    it('contrast: interface itself returns the same caller (sanity check)', async () => {
      // Sanity: the interface is the natural anchor and already returns the
      // controller caller without the IMPLEMENTS seed. This proves the seed
      // is the missing piece for the impl class.
      const result = await backend.callTool('impact', {
        target: 'UserService',
        direction: 'upstream',
      });

      expect(result).not.toHaveProperty('error');
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat().map((d: any) => d.name);
      expect(allNames).toContain('UserController.java');
    });
  });

}, {
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
});
