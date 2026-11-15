import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { getStoragePaths, listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const fixture = fileURLToPath(
  new URL('../fixtures/pdg-explicit-owner/program.cbl', import.meta.url),
);
const repoId = 'pdg-owner';
const filePath = 'program.cbl';
const outer = 'Module:program.cbl:Outer';
const inner = 'Module:program.cbl:Inner';
const savedEnvironment = new Map<string, string | undefined>();
let temporary: Awaited<ReturnType<typeof createTempDir>>;
let backend: LocalBackend;
let db: string;
let blocks: Array<{ id: string; ownerId: string; line: number; text: string | null }>;

beforeAll(async () => {
  temporary = await createTempDir();
  const root = path.join(temporary.dbPath, 'repo');
  await fs.mkdir(root);
  for (const [name, value] of Object.entries({
    GITNEXUS_HOME: path.join(temporary.dbPath, 'home'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_INDEX_LOCK_BACKEND: 'file',
    GITNEXUS_STORAGE_PATH: undefined,
    GITNEXUS_STORAGE_ROOT: undefined,
  })) {
    savedEnvironment.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.copyFile(fixture, path.join(root, filePath));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', filePath], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'PDG ownership fixture',
    ],
    { cwd: root },
  );
  await runFullAnalysis(
    root,
    {
      pdg: true,
      skipFts: true,
      skipAgentsMd: true,
      skipSkills: true,
      workerPoolSize: 1,
      registryName: repoId,
    },
    { onProgress: () => {} },
  );
  const storage = getStoragePaths(root);
  db = storage.lbugPath;
  expect((await loadMeta(storage.storagePath))?.pdg).toBeDefined();
  expect((await listRegisteredRepos()).map((entry) => entry.name)).toEqual([repoId]);
  await adapter.initLbug(db, { skipFts: true });
  blocks = await adapter.executeQuery(
    'MATCH (b:BasicBlock) RETURN b.id AS id, b.ownerId AS ownerId, b.startLine AS line, b.text AS text ORDER BY b.startLine, b.id',
  );
  await pool.initLbugWithDb(repoId, adapter.getDatabase()!, db);
  backend = new LocalBackend();
  await backend.init();
}, 180_000);

afterAll(async () => {
  await backend?.dispose();
  await pool.closeLbug(repoId);
  await adapter.closeLbug();
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await temporary?.cleanup();
});

const impact = (target: string, line?: number) =>
  backend.callTool('impact', {
    repo: repoId,
    target,
    mode: 'pdg',
    direction: 'downstream',
    maxDepth: 1,
    line,
  });

describe('explicit executable ownership from real indexing', () => {
  it('persists separate owners for nested COBOL programs', () => {
    expect(new Set(blocks.map((block) => block.ownerId))).toEqual(new Set([outer, inner]));
    expect(
      blocks
        .filter((block) => block.ownerId === outer)
        .some((block) => block.text?.includes('INNER-TOTAL')),
    ).toBe(false);
    expect(
      blocks
        .filter((block) => block.ownerId === inner)
        .some((block) => block.text?.includes('OUTER-TOTAL')),
    ).toBe(false);
  });

  it('excludes a nested executable owner from its enclosing source span', async () => {
    const result = await impact('Outer');
    expect(result.error).toBeUndefined();
    expect([...result.seedBlocks].sort()).toEqual(
      blocks
        .filter((block) => block.ownerId === outer)
        .map((block) => block.id)
        .sort(),
    );
  });

  it('does not seed a nested program statement for its enclosing program', async () => {
    expect(await impact('Outer', 25)).toMatchObject({
      seedBlocks: [],
      epistemic: 'pdg-no-block-at-line',
    });
  });

  it('retains paragraph selection and marks its program dependencies intra-procedural', async () => {
    const result = await impact('main', 10);
    expect(result.error).toBeUndefined();
    expect(result.seedBlocks.length).toBeGreaterThan(0);
    expect(result.affectedStatements.length).toBeGreaterThan(0);
    expect(
      result.affectedStatements.every(
        (statement: { scope: string; text: string }) =>
          statement.scope === 'intra' && !statement.text.includes('INNER-TOTAL'),
      ),
    ).toBe(true);
  });

  it.each(['controls', 'flows'])(
    'public %s queries exclude nested program dependencies',
    async (mode) => {
      const result = await backend.callTool('pdg_query', { repo: repoId, mode, target: 'Outer' });
      expect(result.error).toBeUndefined();
      expect(result.total).toBeGreaterThan(0);
      expect(JSON.stringify(result.results)).toContain('OUTER');
      expect(JSON.stringify(result.results)).not.toContain('INNER');
      const nested = await backend.callTool('pdg_query', { repo: repoId, mode, target: 'Inner' });
      expect(nested.total).toBeGreaterThan(0);
      expect(JSON.stringify(nested.results)).toContain('INNER');
      expect(JSON.stringify(nested.results)).not.toContain('OUTER');
      const fileResult = await backend.callTool('pdg_query', {
        repo: repoId,
        mode,
        target: filePath,
      });
      expect(fileResult.total).toBe(result.total + nested.total);
      const paragraph = await backend.callTool('pdg_query', { repo: repoId, mode, target: 'main' });
      expect(paragraph.total).toBe(result.total);
    },
  );

  it('public explain reads the indexed program without fabricating taint findings', async () => {
    const result = await backend.callTool('explain', { repo: repoId, target: 'Outer' });
    expect(result.error).toBeUndefined();
    expect(result.totalFindings).toBe(0);
  });

  it('rejects a ready legacy PDG index with explicit schema recovery guidance', async () => {
    await adapter.executeQuery('ALTER TABLE BasicBlock DROP ownerId');
    try {
      for (const line of [undefined, 10]) {
        expect(await impact('main', line)).toMatchObject({
          impactedCount: null,
          recoverySuggestion: expect.stringContaining('gitnexus analyze --pdg'),
        });
      }
      for (const tool of ['pdg_query', 'explain']) {
        const result = await backend.callTool(tool, {
          repo: repoId,
          mode: 'flows',
          target: 'Outer',
        });
        expect(result.recoverySuggestion).toContain('gitnexus analyze --pdg');
      }
      const columns = await adapter.executeQuery("CALL table_info('BasicBlock') RETURN name");
      expect(columns.some((row) => row.name === 'ownerId')).toBe(false);
    } finally {
      await adapter.executeQuery('ALTER TABLE BasicBlock ADD ownerId STRING');
    }
  });
});
