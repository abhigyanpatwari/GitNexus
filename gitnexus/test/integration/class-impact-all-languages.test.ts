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
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
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

const registryBytes = Buffer.from(
  '# coding: latin-1\nfrom db.database_client import DatabaseClient\nregistry = [DatabaseClient] # café',
  'latin1',
);
const pythonImporters = {
  'except.py':
    'from db.database_client import DatabaseClient\ntry: pass\nexcept DatabaseClient: pass',
  'registry.py': registryBytes.toString('utf8'), // File.content uses the ingestion decoder.
  'star_reexport.py': 'from db.database_client import\\\n  *',
  'method.py': 'from db.database_client import DatabaseClient as Client\nClient.from_dict({})',
  'enum_member.py': 'import db.database_client as m\nstatus = m.DatabaseClient.OPEN',
  'annotation.py':
    'from db.database_client import DatabaseClient\ndef check(x: DatabaseClient): pass',
  'public_api.py': 'from db.database_client import DatabaseClient as Public',
  'wild.py': 'from db.database_client import *',
  'sibling.py': 'from db.database_client import Order\nfrom elsewhere import DatabaseClient',
  'noise.py': 'from db.database_client import Order\ndef f(**kwargs): return (',
  'shadow.py': 'import db.database_client as m\ndef f(m): return m.ShadowOnly',
  'namespace_sibling.py': 'import db.database_client as m\ny = m.Order\n# m.DatabaseClient',
};

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

  `MATCH (f:File {id:'ts:file:app'}) SET f.content = 'use ALL'`,

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

  `MATCH (f:File {id:'py:file:DatabaseClient'}) SET f.content = "__all__ = ['DatabaseClient']\\nclass DatabaseClient: pass\nclass ShadowOnly: pass"`,
  `MATCH (f:File {id:'py:file:app'}) SET f.content = 'from db.database_client import Order'`,
  `CREATE (:File {id:'doc:guide', name:'guide.md', filePath:'guide.md', content:'The DatabaseClient API'})`,
  `MATCH (caller:File {id:'ts:file:app'}), (doc:File {id:'doc:guide'}) CREATE (caller)-[:CodeRelation {type:'IMPORTS', reason:'markdown-link'}]->(doc)`,
  `MATCH (doc:File {id:'doc:guide'}), (owner:File {id:'py:file:DatabaseClient'}) CREATE (doc)-[:CodeRelation {type:'IMPORTS', reason:'markdown-link'}]->(owner)`,
  `CREATE (:Class {id:'Class:src/ledger.py:账单记录', name:'账单记录', filePath:'src/ledger.py', startLine:0, endLine:0})`,
  `CREATE (:File {id:'File:src/ledger.py', name:'ledger.py', filePath:'src/ledger.py', content:'class 账单 单记 记录: pass'})`,
  `CREATE (:File {id:'File:src/consumer.py', name:'consumer.py', filePath:'src/consumer.py', content:'from ledger import 账单 单记 记录'})`,
  `MATCH (f:File {id:'File:src/ledger.py'}), (c:Class {id:'Class:src/ledger.py:账单记录'}) CREATE (f)-[:CodeRelation {type:'DEFINES'}]->(c)`,
  `MATCH (a:File {id:'File:src/consumer.py'}), (f:File {id:'File:src/ledger.py'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:1.0}]->(f)`,
  `CREATE (:Class {id:'py:class:ShadowOnly', name:'ShadowOnly', filePath:'src/db/database_client.py', startLine:3, endLine:3, isExported:true})`,
  `MATCH (f:File {id:'py:file:DatabaseClient'}), (c:Class {id:'py:class:ShadowOnly'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0}]->(c)`,
  ...Object.entries(pythonImporters).flatMap(([name, source]) => [
    `CREATE (:File {id:'py:file:${name}', name:'${name}', filePath:'src/${name}', content:${JSON.stringify(source)}})`,
    `MATCH (a:File {id:'py:file:${name}'}), (b:File {id:'py:file:DatabaseClient'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:1.0}]->(b)`,
  ]),

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
  `CREATE (:Function {id:'c:fn:unbound', name:'uses_pool', filePath:'src/other.c', startLine:0, endLine:2})`,
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
  `MATCH (a:Function {id:'c:fn:unbound'}), (b:Class {id:'c:class:MemoryPool'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.5, reason:'global-name-fallback'}]->(b)`,

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

    it('impact(upstream) surfaces the file importer', async () => {
      const result = await getBackend().callTool('impact', {
        target: className,
        direction: 'upstream',
        includeTests: true,
      });
      expect(result.byDepth[1].map((entry: { name: string }) => entry.name)).toContain(
        importerFileName,
      );
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

    it('finds an imported name when retained content uses Han bigrams', async () => {
      const result = await backend.callTool('impact', {
        target: '账单记录',
        direction: 'upstream',
        maxDepth: 1,
      });
      expect(result.partial).toBeUndefined();
      expect(result.byDepth[1]).toEqual(
        expect.arrayContaining([expect.objectContaining({ filePath: 'src/consumer.py' })]),
      );
    });

    it('counts bound C callers and discloses a name-only edge at the confidence floor', async () => {
      const result = await backend.callTool('impact', {
        target: 'MemoryPool',
        direction: 'upstream',
        maxDepth: 1,
        minConfidence: 0.5,
      });
      expect(result).toMatchObject({
        risk: 'UNKNOWN',
        epistemic: 'lower-bound',
        partial: true,
        omittedNameOnlyCalls: 1,
      });
      expect(result.byDepth[1].map((item: { name: string }) => item.name)).toContain('allocate');
      expect(result.byDepth[1].map((item: { name: string }) => item.name)).not.toContain(
        'uses_pool',
      );
    });

    it('dispatches type import attribution through the selected provider', async () => {
      const providers = await import('../../src/core/ingestion/languages/query-providers.js');
      const lookup = providers.getQueryProviderForFile;
      const owner = 'src/auth/AuthService.ts';
      const classify = vi.fn(
        async (_file: string, _source: string, _imports: ReadonlySet<string>) => false,
      );
      const createClassifier = vi.fn(async () => classify);
      const providerLookup = vi
        .spyOn(providers, 'getQueryProviderForFile')
        .mockImplementation((file) => {
          const registered = lookup(file);
          if (!registered || file !== owner) return registered;
          return {
            ...registered,
            typeImportAttribution: {
              supportsFile: (filePath) => filePath.endsWith('.ts'),
              implicitImportSyntax: { marker: 'ALL', pattern: 'ALL' },
              createClassifier,
            },
          };
        });
      try {
        const result = await backend.callTool('impact', {
          target: 'AuthService',
          direction: 'upstream',
          maxDepth: 1,
        });
        expect(createClassifier).toHaveBeenCalledWith(
          expect.objectContaining({ ownerPath: owner, name: 'AuthService' }),
        );
        expect(classify).toHaveBeenCalledWith('src/app.ts', 'use ALL', new Set([owner]));
        expect(result.byDepth[1].map((row: { name: string }) => row.name)).toEqual(['loginUser']);
      } finally {
        providerLookup.mockRestore();
      }
    });

    it('includes named, aliased, qualified and wildcard class imports and excludes sibling-only files', async () => {
      const result = await backend.callTool('impact', {
        target: 'DatabaseClient',
        direction: 'upstream',
        maxDepth: 1,
        includeTests: true,
      });
      expect(result).not.toHaveProperty('partial');
      const imports = result.byDepth[1].filter((row: { type: string }) => row.type === 'File');
      expect(imports.map((row: { name: string }) => row.name).sort()).toEqual([
        'annotation.py',
        'enum_member.py',
        'except.py',
        'method.py',
        'public_api.py',
        'registry.py',
        'star_reexport.py',
        'wild.py',
      ]);
      expect(result.risk).toBe('MEDIUM');
    });

    it('does not assign a shadowed namespace receiver to the imported class', async () => {
      const result = await backend.callTool('impact', {
        target: 'ShadowOnly',
        direction: 'upstream',
        maxDepth: 1,
      });
      expect(result).toMatchObject({ risk: 'UNKNOWN', partial: true, impactedCount: 0 });
    });

    it('withholds a changed importer even when both byte sequences decode to the same text', async () => {
      const file = path.join(handle.tmpHandle.dbPath, 'checkout/src/registry.py');
      const changed = Buffer.from(registryBytes);
      changed[changed.length - 1] = 0xe8;
      expect(changed.toString('utf8')).toBe(registryBytes.toString('utf8'));
      try {
        await fs.writeFile(file, changed);
        const result = await backend.callTool('impact', {
          target: 'DatabaseClient',
          direction: 'upstream',
          maxDepth: 1,
          includeTests: true,
        });
        expect(result).toMatchObject({ risk: 'UNKNOWN', partial: true, epistemic: 'lower-bound' });
        const names = result.byDepth[1].map((row: { name: string }) => row.name);
        expect(names).toContain('method.py');
        expect(names).not.toContain('registry.py');
      } finally {
        await fs.writeFile(file, registryBytes);
      }
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
      'annotation.py',
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
      const repoPath = path.join(handle.tmpHandle.dbPath, 'checkout');
      await fs.mkdir(path.join(repoPath, 'src/db'), { recursive: true });
      const indexedAt = new Date().toISOString();
      const fileHashes: Record<string, string> = {};
      const sources = {
        ...pythonImporters,
        'ledger.py': 'class 账单记录: pass',
        'consumer.py': 'from ledger import 账单记录',
        'registry.py': registryBytes,
        'db/database_client.py':
          "__all__ = ['DatabaseClient']\nclass DatabaseClient: pass\nclass ShadowOnly: pass",
        'app.py': 'from db.database_client import Order',
        'app.ts': 'use ALL',
      };
      for (const [name, source] of Object.entries(sources)) {
        const filePath = `src/${name}`;
        await fs.writeFile(path.join(repoPath, filePath), source);
        fileHashes[filePath] = createHash('sha256').update(source).digest('hex');
      }
      await fs.writeFile(
        path.join(handle.tmpHandle.dbPath, 'gitnexus.json'),
        JSON.stringify({
          indexedAt,
          repoPath,
          lastCommit: 'abc123',
          contentRetention: 'full',
          fileHashes,
        }),
      );
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: repoPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt,
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
