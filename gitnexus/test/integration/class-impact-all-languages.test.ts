/**
 * Integration Tests: Class impact/context traversal across all supported languages (#480)
 *
 * Ensures the fix for Java class traversal (CALLS->Constructor, IMPORTS->File)
 * does not regress for any supported language, and that each language's class
 * topology is handled correctly by impact() and context().
 *
 * Language topologies:
 *   JVM (Java, Kotlin):   CALLS -> Constructor, IMPORTS -> File
 *   Non-JVM with classes: CALLS -> Class directly, IMPORTS -> File
 *     (TypeScript, JavaScript, Python, C#, Ruby, PHP, Rust, Go, Swift, C, C++)
 *
 * All languages share a single DB instance (withTestLbugDB clears+reseeds per
 * file). Node IDs are namespaced by language to avoid collisions.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Seed builders ───────────────────────────────────────────────────────────

/** JVM topology: Class -HAS_METHOD-> Constructor, File -DEFINES-> Class.
 *  Callers CALL the Constructor; importers IMPORT the owning File. */
function jvmNodes(
  lang: string,
  ext: string,
  cls: string,
  caller: string,
  importer: string,
  clsPath: string,
  callerPath: string,
  importerPath: string,
): string[] {
  return [
    `CREATE (f:File {id:'${lang}:file:${cls}', name:'${cls}.${ext}', filePath:'${clsPath}', content:''})`,
    `CREATE (c:Class {id:'${lang}:class:${cls}', name:'${cls}', filePath:'${clsPath}', startLine:1, endLine:50, isExported:true, content:'', description:''})`,
    `CREATE (ctor:Constructor {id:'${lang}:ctor:${cls}', name:'${cls}', filePath:'${clsPath}', startLine:5, endLine:10, content:'', description:''})`,
    `CREATE (caller:Method {id:'${lang}:method:${caller}', name:'${caller}', filePath:'${callerPath}', startLine:1, endLine:10, isExported:false, content:'', description:''})`,
    `CREATE (imp:File {id:'${lang}:file:${importer}', name:'${importer}.${ext}', filePath:'${importerPath}', content:''})`,
    `MATCH (c:Class {id:'${lang}:class:${cls}'}), (ctor:Constructor {id:'${lang}:ctor:${cls}'}) CREATE (c)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'class-method', step:0}]->(ctor)`,
    `MATCH (f:File {id:'${lang}:file:${cls}'}), (c:Class {id:'${lang}:class:${cls}'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,
    `MATCH (a:Method {id:'${lang}:method:${caller}'}), (b:Constructor {id:'${lang}:ctor:${cls}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
    `MATCH (a:File {id:'${lang}:file:${importer}'}), (b:File {id:'${lang}:file:${cls}'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  ];
}

/** Non-JVM topology: CALLS -> Class directly, IMPORTS -> File. */
function nonJvmNodes(
  lang: string,
  ext: string,
  cls: string,
  caller: string,
  callerLabel: string,
  importer: string,
  clsPath: string,
  callerPath: string,
  importerPath: string,
): string[] {
  return [
    `CREATE (f:File {id:'${lang}:file:${cls}', name:'${cls}.${ext}', filePath:'${clsPath}', content:''})`,
    `CREATE (c:Class {id:'${lang}:class:${cls}', name:'${cls}', filePath:'${clsPath}', startLine:1, endLine:50, isExported:true, content:'', description:''})`,
    `CREATE (caller:${callerLabel} {id:'${lang}:fn:${caller}', name:'${caller}', filePath:'${callerPath}', startLine:1, endLine:10, isExported:false, content:'', description:''})`,
    `CREATE (imp:File {id:'${lang}:file:${importer}', name:'${importer}.${ext}', filePath:'${importerPath}', content:''})`,
    `MATCH (f:File {id:'${lang}:file:${cls}'}), (c:Class {id:'${lang}:class:${cls}'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(c)`,
    `MATCH (a:${callerLabel} {id:'${lang}:fn:${caller}'}), (b:Class {id:'${lang}:class:${cls}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
    `MATCH (a:File {id:'${lang}:file:${importer}'}), (b:File {id:'${lang}:file:${cls}'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:0.9, reason:'import', step:0}]->(b)`,
  ];
}

// ─── Combined seed for all languages ─────────────────────────────────────────

const SEED = [
  // Java — JVM topology
  ...jvmNodes(
    'java',
    'java',
    'PaymentService',
    'processPayment',
    'OrderController',
    'src/main/java/payments/PaymentService.java',
    'src/main/java/orders/OrderController.java',
    'src/main/java/orders/OrderController.java',
  ),

  // Kotlin — JVM topology
  ...jvmNodes(
    'kotlin',
    'kt',
    'UserRepository',
    'fetchUser',
    'UserService',
    'src/main/kotlin/data/UserRepository.kt',
    'src/main/kotlin/service/UserService.kt',
    'src/main/kotlin/service/UserService.kt',
  ),

  // TypeScript — non-JVM
  ...nonJvmNodes(
    'ts',
    'ts',
    'AuthService',
    'loginUser',
    'Function',
    'app',
    'src/auth/AuthService.ts',
    'src/routes/auth.ts',
    'src/app.ts',
  ),

  // JavaScript — non-JVM
  ...nonJvmNodes(
    'js',
    'js',
    'EventEmitter',
    'subscribe',
    'Function',
    'index',
    'src/events/EventEmitter.js',
    'src/handlers/handler.js',
    'src/index.js',
  ),

  // Python — non-JVM
  ...nonJvmNodes(
    'py',
    'py',
    'DatabaseClient',
    'connect',
    'Function',
    'app',
    'src/db/database_client.py',
    'src/services/service.py',
    'src/app.py',
  ),

  // C# — non-JVM
  ...nonJvmNodes(
    'cs',
    'cs',
    'OrderProcessor',
    'ProcessOrder',
    'Method',
    'Startup',
    'src/Orders/OrderProcessor.cs',
    'src/Controllers/OrderController.cs',
    'src/Startup.cs',
  ),

  // Ruby — non-JVM
  ...nonJvmNodes(
    'rb',
    'rb',
    'SessionManager',
    'create_session',
    'Function',
    'application',
    'lib/session/session_manager.rb',
    'lib/controllers/auth_controller.rb',
    'lib/application.rb',
  ),

  // PHP — non-JVM
  ...nonJvmNodes(
    'php',
    'php',
    'CacheService',
    'getCache',
    'Method',
    'bootstrap',
    'src/Cache/CacheService.php',
    'src/Controllers/HomeController.php',
    'src/bootstrap.php',
  ),

  // Rust — non-JVM
  ...nonJvmNodes(
    'rs',
    'rs',
    'HttpClient',
    'send_request',
    'Function',
    'main',
    'src/http/client.rs',
    'src/api/handler.rs',
    'src/main.rs',
  ),

  // Go — non-JVM
  ...nonJvmNodes(
    'go',
    'go',
    'Router',
    'handleRequest',
    'Function',
    'main',
    'pkg/router/router.go',
    'pkg/handlers/handler.go',
    'main.go',
  ),

  // Swift — non-JVM
  ...nonJvmNodes(
    'swift',
    'swift',
    'NetworkManager',
    'fetchData',
    'Method',
    'AppDelegate',
    'Sources/Network/NetworkManager.swift',
    'Sources/ViewControllers/HomeVC.swift',
    'Sources/AppDelegate.swift',
  ),

  // C — non-JVM
  ...nonJvmNodes(
    'c',
    'c',
    'MemoryPool',
    'allocate',
    'Function',
    'main',
    'src/memory/pool.c',
    'src/runtime/runtime.c',
    'src/main.c',
  ),

  // C++ — non-JVM
  ...nonJvmNodes(
    'cpp',
    'cpp',
    'ThreadPool',
    'enqueue',
    'Function',
    'main',
    'src/threading/thread_pool.cpp',
    'src/workers/worker.cpp',
    'src/main.cpp',
  ),
];

// ─── Shared assertion helper ──────────────────────────────────────────────────

function suiteFor(
  lang: string,
  topology: 'JVM (Constructor+File)' | 'direct CALLS',
  getBackend: () => LocalBackend,
  className: string,
  callerName: string,
  importerFileName: string,
  classFilePath: string,
) {
  describe(`${lang}: Class impact/context via ${topology}`, () => {
    it(`impact(upstream) surfaces the caller`, async () => {
      const result = await getBackend().callTool('impact', {
        target: className,
        direction: 'upstream',
        includeTests: true,
      });
      expect(result).not.toHaveProperty('error');
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat()
        .map((d: any) => d.name);
      expect(allNames).toContain(callerName);
    });

    it(`impact(upstream) surfaces the file importer`, async () => {
      const result = await getBackend().callTool('impact', {
        target: className,
        direction: 'upstream',
        includeTests: true,
      });
      expect(result).not.toHaveProperty('error');
      const allNames = Object.values(result.byDepth as Record<string, any[]>)
        .flat()
        .map((d: any) => d.name);
      expect(allNames).toContain(importerFileName);
    });

    it(`context() returns found with kind Class`, async () => {
      const result = await getBackend().callTool('context', {
        name: className,
        file_path: classFilePath,
      });
      expect(result.status).toBe('found');
      expect(result.symbol.kind).toBe('Class');
    });

    it(`context() has non-empty incoming containing the caller`, async () => {
      const result = await getBackend().callTool('context', {
        name: className,
        file_path: classFilePath,
      });
      expect(result.status).toBe('found');
      const allIncoming = [...(result.incoming.calls || []), ...(result.incoming.imports || [])];
      expect(allIncoming.length).toBeGreaterThanOrEqual(1);
      expect(allIncoming.map((r: any) => r.name)).toContain(callerName);
    });
  });
}

// ─── Single DB instance, all languages ───────────────────────────────────────

withTestLbugDB(
  'class-impact-all-languages',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    // JVM languages
    suiteFor(
      'Java',
      'JVM (Constructor+File)',
      () => backend,
      'PaymentService',
      'processPayment',
      'OrderController.java',
      'src/main/java/payments/PaymentService.java',
    );
    suiteFor(
      'Kotlin',
      'JVM (Constructor+File)',
      () => backend,
      'UserRepository',
      'fetchUser',
      'UserService.kt',
      'src/main/kotlin/data/UserRepository.kt',
    );

    // Non-JVM languages
    suiteFor(
      'TypeScript',
      'direct CALLS',
      () => backend,
      'AuthService',
      'loginUser',
      'app.ts',
      'src/auth/AuthService.ts',
    );
    suiteFor(
      'JavaScript',
      'direct CALLS',
      () => backend,
      'EventEmitter',
      'subscribe',
      'index.js',
      'src/events/EventEmitter.js',
    );
    suiteFor(
      'Python',
      'direct CALLS',
      () => backend,
      'DatabaseClient',
      'connect',
      'app.py',
      'src/db/database_client.py',
    );
    suiteFor(
      'C#',
      'direct CALLS',
      () => backend,
      'OrderProcessor',
      'ProcessOrder',
      'Startup.cs',
      'src/Orders/OrderProcessor.cs',
    );
    suiteFor(
      'Ruby',
      'direct CALLS',
      () => backend,
      'SessionManager',
      'create_session',
      'application.rb',
      'lib/session/session_manager.rb',
    );
    suiteFor(
      'PHP',
      'direct CALLS',
      () => backend,
      'CacheService',
      'getCache',
      'bootstrap.php',
      'src/Cache/CacheService.php',
    );
    suiteFor(
      'Rust',
      'direct CALLS',
      () => backend,
      'HttpClient',
      'send_request',
      'main.rs',
      'src/http/client.rs',
    );
    suiteFor(
      'Go',
      'direct CALLS',
      () => backend,
      'Router',
      'handleRequest',
      'main.go',
      'pkg/router/router.go',
    );
    suiteFor(
      'Swift',
      'direct CALLS',
      () => backend,
      'NetworkManager',
      'fetchData',
      'AppDelegate.swift',
      'Sources/Network/NetworkManager.swift',
    );
    suiteFor(
      'C',
      'direct CALLS',
      () => backend,
      'MemoryPool',
      'allocate',
      'main.c',
      'src/memory/pool.c',
    );
    suiteFor(
      'C++',
      'direct CALLS',
      () => backend,
      'ThreadPool',
      'enqueue',
      'main.cpp',
      'src/threading/thread_pool.cpp',
    );
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
          stats: { files: 20, nodes: 60, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
