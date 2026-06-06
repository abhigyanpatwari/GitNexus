/**
 * WI-K23 + WI-K34 — context() IMPLEMENTS walk for Class targets (Issues #23, #34)
 *
 * Verifies that when `context(name="UserServiceImpl")` is called:
 *   1. `incoming.calls` contains the controller method that calls the
 *      interface method (method-level CALLS via IMPLEMENTS walk).
 *   2. `incoming.imports` still contains the controller file (regression
 *      for the file-level IMPORTS path that was the only visibility before).
 *   3. Same fix covers OrderService (#34 regression).
 *   4. The 4th query does NOT match a non-Class target (regression guard).
 *
 * Uses the in-process SEED approach (mirrors batch-k-impl-calls.test.ts) so
 * the test is hermetic and doesn't depend on the full pipeline running on
 * a real fixture. A separate fixture exists for future end-to-end runs.
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

// Graph mirrors the Spring pattern from #23 and #34:
// - UserService interface (Interface) called by UserController (Method)
//   via method-level CALLS that D5 resolves to the INTERFACE method.
// - UserServiceImpl class implements UserService (IMPLEMENTS).
// - OrderService / OrderServiceImpl / OrderController for the #34 regression.
const SEED = [
  // ── UserService (interface) ──────────────────────────────────────────
  `CREATE (f1:File {id: 'file:UserService.java', name: 'UserService.java', filePath: 'service/UserService.java', content: ''})`,
  `CREATE (iface:Interface {id: 'interface:UserService', name: 'UserService', filePath: 'service/UserService.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (m_get:Method {id: 'method:UserService.getUsers', name: 'getUsers', filePath: 'service/UserService.java', startLine: 5, endLine: 8, isExported: true, content: '', description: ''})`,
  `CREATE (m_create:Method {id: 'method:UserService.createUser', name: 'createUser', filePath: 'service/UserService.java', startLine: 9, endLine: 12, isExported: true, content: '', description: ''})`,
  `MATCH (i:Interface {id:'interface:UserService'}), (m:Method {id:'method:UserService.getUsers'}) CREATE (i)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'interface-method', step:0}]->(m)`,
  `MATCH (i:Interface {id:'interface:UserService'}), (m:Method {id:'method:UserService.createUser'}) CREATE (i)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'interface-method', step:0}]->(m)`,
  `MATCH (f:File {id:'file:UserService.java'}), (i:Interface {id:'interface:UserService'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(i)`,

  // ── UserServiceImpl (class) ──────────────────────────────────────────
  `CREATE (f2:File {id: 'file:UserServiceImpl.java', name: 'UserServiceImpl.java', filePath: 'service/UserServiceImpl.java', content: ''})`,
  `CREATE (impl:Class {id: 'class:UserServiceImpl', name: 'UserServiceImpl', filePath: 'service/UserServiceImpl.java', startLine: 1, endLine: 25, isExported: true, content: '', description: ''})`,
  `MATCH (c:Class {id:'class:UserServiceImpl'}), (i:Interface {id:'interface:UserService'}) CREATE (c)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.95, reason:'implements-keyword', step:0}]->(i)`,
  `MATCH (f:File {id:'file:UserServiceImpl.java'}), (c:Class {id:'class:UserServiceImpl'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,

  // ── UserController (caller) ──────────────────────────────────────────
  `CREATE (f3:File {id: 'file:UserController.java', name: 'UserController.java', filePath: 'controller/UserController.java', content: ''})`,
  `CREATE (ctrl:Class {id: 'class:UserController', name: 'UserController', filePath: 'controller/UserController.java', startLine: 1, endLine: 25, isExported: true, content: '', description: ''})`,
  `CREATE (m_list:Method {id: 'method:listUsers', name: 'listUsers', filePath: 'controller/UserController.java', startLine: 15, endLine: 18, isExported: true, content: '', description: ''})`,
  `CREATE (m_reg:Method {id: 'method:register', name: 'register', filePath: 'controller/UserController.java', startLine: 20, endLine: 23, isExported: true, content: '', description: ''})`,
  // Method-level CALLS edges — they point at the INTERFACE method (D5).
  `MATCH (a:Method {id:'method:listUsers'}), (b:Method {id:'method:UserService.getUsers'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'interface-typed-receiver', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:register'}), (b:Method {id:'method:UserService.createUser'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'interface-typed-receiver', step:0}]->(b)`,
  // File-level IMPORTS — the only visibility before the fix.
  `MATCH (a:File {id:'file:UserController.java'}), (b:File {id:'file:UserService.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:UserController.java'}), (b:File {id:'file:UserServiceImpl.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (c:Class {id:'class:UserController'}), (m:Method {id:'method:listUsers'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (c:Class {id:'class:UserController'}), (m:Method {id:'method:register'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f:File {id:'file:UserController.java'}), (c:Class {id:'class:UserController'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,

  // ── OrderService (interface) ─────────────────────────────────────────
  `CREATE (f4:File {id: 'file:OrderService.java', name: 'OrderService.java', filePath: 'order/OrderService.java', content: ''})`,
  `CREATE (o_iface:Interface {id: 'interface:OrderService', name: 'OrderService', filePath: 'order/OrderService.java', startLine: 1, endLine: 15, isExported: true, content: '', description: ''})`,
  `CREATE (m_getOrd:Method {id: 'method:OrderService.getOrder', name: 'getOrder', filePath: 'order/OrderService.java', startLine: 5, endLine: 7, isExported: true, content: '', description: ''})`,
  `CREATE (m_delOrd:Method {id: 'method:OrderService.deleteOrder', name: 'deleteOrder', filePath: 'order/OrderService.java', startLine: 8, endLine: 10, isExported: true, content: '', description: ''})`,
  `MATCH (i:Interface {id:'interface:OrderService'}), (m:Method {id:'method:OrderService.getOrder'}) CREATE (i)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'interface-method', step:0}]->(m)`,
  `MATCH (i:Interface {id:'interface:OrderService'}), (m:Method {id:'method:OrderService.deleteOrder'}) CREATE (i)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'interface-method', step:0}]->(m)`,
  `MATCH (f:File {id:'file:OrderService.java'}), (i:Interface {id:'interface:OrderService'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(i)`,

  // ── OrderServiceImpl (class) ────────────────────────────────────────
  `CREATE (f5:File {id: 'file:OrderServiceImpl.java', name: 'OrderServiceImpl.java', filePath: 'order/OrderServiceImpl.java', content: ''})`,
  `CREATE (o_impl:Class {id: 'class:OrderServiceImpl', name: 'OrderServiceImpl', filePath: 'order/OrderServiceImpl.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `MATCH (c:Class {id:'class:OrderServiceImpl'}), (i:Interface {id:'interface:OrderService'}) CREATE (c)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.95, reason:'implements-keyword', step:0}]->(i)`,
  `MATCH (f:File {id:'file:OrderServiceImpl.java'}), (c:Class {id:'class:OrderServiceImpl'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,

  // ── OrderController (caller) ────────────────────────────────────────
  `CREATE (f6:File {id: 'file:OrderController.java', name: 'OrderController.java', filePath: 'controller/OrderController.java', content: ''})`,
  `CREATE (o_ctrl:Class {id: 'class:OrderController', name: 'OrderController', filePath: 'controller/OrderController.java', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (m_show:Method {id: 'method:show', name: 'show', filePath: 'controller/OrderController.java', startLine: 12, endLine: 15, isExported: true, content: '', description: ''})`,
  `CREATE (m_cancel:Method {id: 'method:cancel', name: 'cancel', filePath: 'controller/OrderController.java', startLine: 17, endLine: 20, isExported: true, content: '', description: ''})`,
  `MATCH (a:Method {id:'method:show'}), (b:Method {id:'method:OrderService.getOrder'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'interface-typed-receiver', step:0}]->(b)`,
  `MATCH (a:Method {id:'method:cancel'}), (b:Method {id:'method:OrderService.deleteOrder'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'interface-typed-receiver', step:0}]->(b)`,
  `MATCH (a:File {id:'file:OrderController.java'}), (b:File {id:'file:OrderService.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (a:File {id:'file:OrderController.java'}), (b:File {id:'file:OrderServiceImpl.java'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  `MATCH (c:Class {id:'class:OrderController'}), (m:Method {id:'method:show'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (c:Class {id:'class:OrderController'}), (m:Method {id:'method:cancel'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(m)`,
  `MATCH (f:File {id:'file:OrderController.java'}), (c:Class {id:'class:OrderController'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,
];

withTestLbugDB('java-class-impl-calls', (handle) => {

  describe('graph shape (precondition)', () => {
    it('UserServiceImpl IMPLEMENTS UserService', async () => {
      const rows = await executeQuery(handle.repoId,
        `MATCH (c:Class {name:'UserServiceImpl'})-[r:CodeRelation {type:'IMPLEMENTS'}]->(i:Interface {name:'UserService'}) RETURN c.name AS impl, i.name AS iface`,
      );
      expect(rows).toHaveLength(1);
    });

    it('UserController method calls interface method (D5 resolution)', async () => {
      const rows = await executeQuery(handle.repoId,
        `MATCH (a:Method {name:'listUsers'})-[r:CodeRelation {type:'CALLS'}]->(b:Method {name:'getUsers'}) RETURN a.name AS caller, b.name AS target`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ─── #23 fix: context(UserServiceImpl) returns method-level CALLS via IMPLEMENTS walk ──

  describe('#23 fix: context(name="UserServiceImpl") returns method-level CALLS', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('incoming.calls contains UserController method that calls interface method', async () => {
      const result = await backend.callTool('context', {
        name: 'UserServiceImpl',
        file_path: 'service/UserServiceImpl.java',
      });

      expect(result.status).toBe('found');
      expect(result.incoming).toBeDefined();

      const calls = result.incoming.calls || [];
      // The 4th IMPLEMENTS-walk query must surface at least one controller method.
      const callerNames = calls.map((c: any) => c.name);
      expect(callerNames).toContain('listUsers');

      // The caller must carry method-level fields.
      const listUsersCaller = calls.find((c: any) => c.name === 'listUsers');
      expect(listUsersCaller).toBeDefined();
      expect(listUsersCaller.uid).toBe('method:listUsers');
      expect(listUsersCaller.filePath).toBe('controller/UserController.java');
      // And the targetMethod identifies which interface method was called.
      expect(listUsersCaller.targetMethod).toBe('getUsers');
    });

    it('incoming.imports still contains the controller file (regression for existing IMPORTS path)', async () => {
      const result = await backend.callTool('context', {
        name: 'UserServiceImpl',
        file_path: 'service/UserServiceImpl.java',
      });

      expect(result.incoming).toBeDefined();
      const imports = result.incoming.imports || [];
      const importNames = imports.map((i: any) => i.name);
      // The file-level IMPORTS path must remain visible.
      expect(importNames).toContain('UserController.java');
    });
  });

  // ─── #34 fix: context(OrderServiceImpl) also returns method-level CALLS ──

  describe('#34 fix: context(name="OrderServiceImpl") returns method-level CALLS', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('incoming.calls contains OrderController show() (caller of getOrder interface method)', async () => {
      const result = await backend.callTool('context', {
        name: 'OrderServiceImpl',
        file_path: 'order/OrderServiceImpl.java',
      });

      expect(result.status).toBe('found');
      const calls = result.incoming.calls || [];
      const callerNames = calls.map((c: any) => c.name);
      expect(callerNames).toContain('show');

      const showCaller = calls.find((c: any) => c.name === 'show');
      expect(showCaller).toBeDefined();
      expect(showCaller.targetMethod).toBe('getOrder');
      expect(showCaller.filePath).toBe('controller/OrderController.java');
    });
  });

  // ─── #34 query-on-interface: context(name="OrderService") also sees method-level CALLS ──

  describe('#34 fix: context(name="OrderService") (interface) also returns method-level CALLS', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('incoming.calls contains OrderController methods (interface target sees its own callers)', async () => {
      const result = await backend.callTool('context', {
        name: 'OrderService',
        file_path: 'order/OrderService.java',
      });

      expect(result.status).toBe('found');
      const calls = result.incoming.calls || [];
      const callerNames = calls.map((c: any) => c.name);
      // The interface's own incoming CALLS — surfaced via the existing methodIncoming path.
      expect(callerNames).toContain('show');
      expect(callerNames).toContain('cancel');
    });
  });

  // ─── Regression guard: non-class target does not run the 4th query ──

  describe('regression: non-class target unaffected by the IMPLEMENTS walk', () => {
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('context(name="show") (Method) does not error and returns well-formed incoming', async () => {
      const result = await backend.callTool('context', {
        name: 'show',
        file_path: 'controller/OrderController.java',
      });

      // Should not error — the 4th query is guarded by isClassTarget (Class-only).
      expect(result.status).toBe('found');
      expect(result.incoming).toBeDefined();
      // Incoming may be empty for an isolated method — assert that the
      // response shape is intact (categorize() returns an object, possibly
      // with no category keys if there are zero rows).
      expect(typeof result.incoming).toBe('object');
    });
  });

  // ─── M4: Class WITHOUT any IMPLEMENTS edge must not error in the 4th query ──

  describe('M4: context(name="UserController") (Class, no IMPLEMENTS) does not error', () => {
    // UserController is a Class but the SEED does not create an
    // IMPLEMENTS edge FROM UserController (it does not implement any
    // interface). The 4th IMPLEMENTS-walk query is Class-only; it
    // must run, find no IMPLEMENTS edges, and return [] without
    // raising. Incoming is empty for this isolated Class because no
    // node has an incoming edge to `class:UserController` in the SEED
    // (File-level IMPORTS point at other Files, not at this Class).
    let backend: LocalBackend;
    beforeAll(async () => { backend = (handle as any)._backend; });

    it('does not error and returns a well-formed incoming object', async () => {
      const result = await backend.callTool('context', {
        name: 'UserController',
        file_path: 'controller/UserController.java',
      });

      expect(result.status).toBe('found');
      expect(result.incoming).toBeDefined();
      expect(typeof result.incoming).toBe('object');
    });

    it('incoming bucket is empty (no edges target class:UserController in the SEED)', async () => {
      const result = await backend.callTool('context', {
        name: 'UserController',
        file_path: 'controller/UserController.java',
      });

      // All incoming buckets must be empty arrays — this is the
      // contract for the M4 case: the 4th query runs, finds nothing,
      // and contributes zero rows. No fallback, no error.
      const incoming = result.incoming;
      for (const key of ['calls', 'imports', 'extends', 'implements', 'has_method'] as const) {
        const bucket = incoming[key] || [];
        expect(bucket).toEqual([]);
      }
    });

    it('precondition: UserController has no outgoing IMPLEMENTS edges in the graph', async () => {
      // Verify the SEED really has no IMPLEMENTS FROM UserController —
      // this is what makes the 4th query a no-op for this target.
      const rows = await executeQuery(handle.repoId,
        `MATCH (c:Class {name:'UserController'})-[:CodeRelation {type:'IMPLEMENTS'}]->(i) RETURN i.name AS iface`,
      );
      expect(rows).toHaveLength(0);
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
        stats: { files: 10, nodes: 30, communities: 0, processes: 0 },
      },
    ]);
    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
  },
});
