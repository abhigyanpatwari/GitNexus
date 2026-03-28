/**
 * Integration Tests: Augmentation Engine
 *
 * augment() against a real indexed LadybugDB
 *   - Matching pattern returns non-empty string with callers/callees
 *   - Non-matching pattern returns empty string
 *   - Pattern shorter than 3 chars returns empty string
 */
import { describe, it, expect, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// ─── Seed data & FTS indexes for augmentation ────────

const AUGMENT_SEED_DATA = [
  // File nodes
  `CREATE (n:File {id: 'file:auth.ts', name: 'auth.ts', filePath: 'src/auth.ts', content: 'authentication module for user login'})`,
  `CREATE (n:File {id: 'file:utils.ts', name: 'utils.ts', filePath: 'src/utils.ts', content: 'utility functions for hashing'})`,

  // Function nodes
  `CREATE (n:Function {id: 'func:login', name: 'login', filePath: 'src/auth.ts', startLine: 1, endLine: 15, isExported: true, content: 'function login authenticates user credentials', description: 'user login'})`,
  `CREATE (n:Function {id: 'func:validate', name: 'validate', filePath: 'src/auth.ts', startLine: 17, endLine: 25, isExported: true, content: 'function validate checks user input', description: 'input validation'})`,
  `CREATE (n:Function {id: 'func:hash', name: 'hash', filePath: 'src/utils.ts', startLine: 1, endLine: 8, isExported: true, content: 'function hash computes bcrypt hash', description: 'password hashing'})`,

  // Class / Method / Interface nodes
  `CREATE (n:Class {id: 'class:AuthService', name: 'AuthService', filePath: 'src/auth.ts', startLine: 30, endLine: 60, isExported: true, content: 'class AuthService handles authentication', description: 'auth service'})`,
  `CREATE (n:Method {id: 'method:AuthService.login', name: 'loginMethod', filePath: 'src/auth.ts', startLine: 35, endLine: 50, isExported: false, content: 'method login in AuthService', description: 'login method'})`,
  `CREATE (n:Interface {id: 'iface:Creds', name: 'Credentials', filePath: 'src/auth.ts', startLine: 1, endLine: 5, isExported: true, content: 'interface Credentials for login authentication', description: 'credentials type'})`,

  // Community & Process nodes
  `CREATE (n:Community {id: 'comm:auth', label: 'Auth', heuristicLabel: 'Authentication', keywords: ['auth'], description: 'Auth cluster', enrichedBy: 'heuristic', cohesion: 0.8, symbolCount: 3})`,
  `CREATE (n:Process {id: 'proc:login-flow', label: 'LoginFlow', heuristicLabel: 'User Login', processType: 'intra_community', stepCount: 2, communities: ['auth'], entryPointId: 'func:login', terminalId: 'func:validate'})`,

  // Relationships
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:validate'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:hash'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'import-resolved', step: 0}]->(b)`,
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:login' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:login' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:validate' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 2}]->(p)`,
];

const AUGMENT_FTS_INDEXES = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'Interface', indexName: 'interface_fts', columns: ['name', 'content', 'description'] },
];

// Mock repo-manager so augment() finds our test DB
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
}));

let augment: (pattern: string, cwd?: string) => Promise<string>;

withTestLbugDB(
  'augment',
  (handle) => {
    describe('augment()', () => {
      it('returns non-empty string with relationship info for a matching pattern', async () => {
        const result = await augment('login', handle.dbPath);

        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain('[GitNexus]');
        expect(result).toContain('login');
      });

      it('returns empty string for a non-matching pattern', async () => {
        const result = await augment('nonexistent_xyz', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string for patterns shorter than 3 characters', async () => {
        const result = await augment('ab', handle.dbPath);
        expect(result).toBe('');
      });

      it('returns empty string for empty pattern', async () => {
        const result = await augment('', handle.dbPath);
        expect(result).toBe('');
      });

      // ─── Unhappy paths ────────────────────────────────────────────────

      it('returns empty string for whitespace-only pattern', async () => {
        const result = await augment('   ', handle.dbPath);
        expect(result).toBe('');
      });

      it('handles special regex characters in pattern without throwing', async () => {
        const result = await augment('func()', handle.dbPath);
        expect(typeof result).toBe('string');
      });

      it('handles very long pattern without throwing', async () => {
        const result = await augment('a'.repeat(500), handle.dbPath);
        expect(typeof result).toBe('string');
      });

      it('handles unicode pattern without throwing', async () => {
        const result = await augment('日本語テスト', handle.dbPath);
        expect(typeof result).toBe('string');
      });
    });
  },
  {
    seed: AUGMENT_SEED_DATA,
    ftsIndexes: AUGMENT_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      // Configure mock to return our test DB so augment() can find it
      const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
      (listRegisteredRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          name: handle.repoId,
          path: handle.dbPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
        },
      ]);

      // Dynamically import augment after mocks are in place
      const engine = await import('../../src/core/augmentation/engine.js');
      augment = engine.augment;
    },
  },
);
