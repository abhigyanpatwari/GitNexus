import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeQuery } from '../../../../dist/mcp/core/lbug-adapter.js';
import { withIndexedBackend } from '../spring-support.mjs';

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

test('Java class impact and context traverse constructors and importers', async (t) => {
  await withIndexedBackend('test-repo', SEED, async (_handle, backend) => {
    await t.test(
      'CALLS edges go to Constructor, not Class — so naive Class traversal finds 0',
      async () => {
        const onClass = await executeQuery(
          'test-repo',
          `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b:Class {name:'SessionTracker'}) RETURN a.name AS name`,
        );
        assert.equal(onClass.length, 0); // this is the bug — Class has no CALLS edges

        const onCtor = await executeQuery(
          'test-repo',
          `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b:Constructor {name:'SessionTracker'}) RETURN a.name AS name`,
        );
        assert.equal(onCtor.length, 5); // all 5 callers are on Constructor
      },
    );
    await t.test('IMPORTS edges go to File, not Class', async () => {
      const onClass = await executeQuery(
        'test-repo',
        `MATCH (a)-[r:CodeRelation {type:'IMPORTS'}]->(b:Class {name:'SessionTracker'}) RETURN a.name AS name`,
      );
      assert.equal(onClass.length, 0);

      const onFile = await executeQuery(
        'test-repo',
        `MATCH (a)-[r:CodeRelation {type:'IMPORTS'}]->(b:File {name:'SessionTracker.java'}) RETURN a.name AS name`,
      );
      assert.equal(onFile.length, 1); // ServerBootstrap.java
    });
    await t.test(
      'default call (no includeTests) finds the 1 production caller and excludes test callers',
      async () => {
        // Exact call from the issue: gitnexus_impact({target: "SessionTracker", direction: "upstream"})
        // Before fix: impactedCount: 0, risk: LOW, byDepth: {}
        const result = await backend.callTool('impact', {
          target: 'SessionTracker',
          direction: 'upstream',
        });

        assert.ok(!Object.hasOwn(result, 'error'));
        // At minimum: 1 production caller (registerSessionTracker) + 1 file
        // importer (ServerBootstrap.java discovered via BFS from the seeded File)
        assert.ok(result.impactedCount >= 2);

        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);

        // Production caller must be present
        assert.ok(names.includes('registerSessionTracker'));

        // Test callers must be excluded (paths match /test/ via isTestFilePath)
        assert.ok(!names.includes('setUp'));
        assert.ok(!names.includes('constructor_nullGameMode_accepted'));
        assert.ok(!names.includes('constructor_nullServerId_accepted'));
        assert.ok(!names.includes('startPlayerSession_passesGameModeAndServerId'));
      },
    );
    await t.test('with includeTests finds all 5 callers (1 prod + 4 tests)', async () => {
      const result = await backend.callTool('impact', {
        target: 'SessionTracker',
        direction: 'upstream',
        includeTests: true,
      });

      assert.ok(!Object.hasOwn(result, 'error'));
      assert.ok(result.impactedCount >= 5);

      const d1 = result.byDepth[1] || result.byDepth['1'] || [];
      const names = d1.map((d: any) => d.name);
      assert.ok(names.includes('registerSessionTracker'));
      assert.ok(names.includes('setUp'));
      assert.ok(names.includes('constructor_nullGameMode_accepted'));
      assert.ok(names.includes('constructor_nullServerId_accepted'));
      assert.ok(names.includes('startPlayerSession_passesGameModeAndServerId'));

      // Owning file (SessionTracker.java) must NOT appear — it is the
      // definition container, not an upstream dependent (#480 Copilot review)
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat()
        .map((d: any) => d.name);
      assert.ok(!allNames.includes('SessionTracker.java'));
    });
    await t.test(
      'RankPermissionHandler: 1 caller via Constructor + 10 importers via File (was 0 before fix)',
      async () => {
        const result = await backend.callTool('impact', {
          target: 'RankPermissionHandler',
          direction: 'upstream',
          includeTests: true,
        });

        assert.ok(!Object.hasOwn(result, 'error'));
        // 1 caller (depth 1 via Constructor) + 10 importers (depth 2 via File)
        assert.ok(result.impactedCount >= 11);

        const allNames = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((d: any) => d.name);
        assert.ok(allNames.includes('initRankHandler'));
        assert.ok(allNames.includes('RankCommand.java'));
        assert.ok(allNames.includes('RankManager.java'));

        // Owning file must NOT appear in results
        assert.ok(!allNames.includes('RankPermissionHandler.java'));
      },
    );
    await t.test(
      'RankPermissionHandler: default call (no includeTests) excludes test importers',
      async () => {
        const result = await backend.callTool('impact', {
          target: 'RankPermissionHandler',
          direction: 'upstream',
        });

        assert.ok(!Object.hasOwn(result, 'error'));

        const allNames = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((d: any) => d.name);

        // Production importers must be present
        assert.ok(allNames.includes('RankCommand.java'));

        // Test importers (src/test/java/... paths) must be excluded
        assert.ok(!allNames.includes('RankTest1.java'));
        assert.ok(!allNames.includes('RankTest2.java'));
        assert.ok(!allNames.includes('RankTest3.java'));
        assert.ok(!allNames.includes('RankTest4.java'));
        assert.ok(!allNames.includes('RankTest5.java'));
      },
    );
    await t.test('incoming.calls contains Constructor callers (was empty before fix)', async () => {
      // Exact call from issue: gitnexus_context({name: "SessionTracker", file_path: "api/.../SessionTracker.java"})
      // Before fix: incoming: {}
      const result = await backend.callTool('context', {
        name: 'SessionTracker',
        file_path: 'api/session/SessionTracker.java',
      });

      assert.equal(result.status, 'found');
      assert.equal(result.symbol.kind, 'Class');
      assert.notEqual(result.incoming, undefined);

      // Should have calls from the Constructor callers
      const calls = result.incoming.calls || [];
      assert.ok(calls.length >= 1);
      const callerNames = calls.map((c: any) => c.name);
      assert.ok(callerNames.includes('registerSessionTracker'));
    });
    await t.test('incoming.imports contains File importers', async () => {
      const result = await backend.callTool('context', {
        name: 'SessionTracker',
        file_path: 'api/session/SessionTracker.java',
      });

      assert.equal(result.status, 'found');
      const imports = result.incoming.imports || [];
      assert.ok(imports.length >= 1);
      const importerNames = imports.map((c: any) => c.name);
      assert.ok(importerNames.includes('ServerBootstrap.java'));
    });
    await t.test('contrast: context() on a Method still works (regression check)', async () => {
      // The issue notes context() on methods worked before — must still work after fix
      const result = await backend.callTool('context', {
        name: 'registerSessionTracker',
      });
      assert.equal(result.status, 'found');
      // registerSessionTracker calls SessionTracker constructor — should appear in outgoing
      assert.notEqual(result.outgoing, undefined);
    });
    await t.test('RankPermissionHandler: incoming shows caller and importers', async () => {
      const result = await backend.callTool('context', {
        name: 'RankPermissionHandler',
        file_path: 'core/rank/RankPermissionHandler.java',
      });

      assert.equal(result.status, 'found');
      assert.equal(result.symbol.kind, 'Class');

      const calls = result.incoming.calls || [];
      assert.ok(calls.map((c: any) => c.name).includes('initRankHandler'));

      const imports = result.incoming.imports || [];
      assert.ok(imports.length >= 10);
    });
  });
});
