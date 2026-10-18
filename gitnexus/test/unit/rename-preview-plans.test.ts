import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode, RenamePlan } from 'gitnexus-shared';
import {
  RenamePreviewPlans,
  renameSourceInventory,
} from '../../src/mcp/local/rename/preview-plans.js';
import {
  renameResolutionVersion,
  validateRenameResolution,
} from '../../src/mcp/local/rename/resolution-version.js';

describe('immutable rename preview capabilities', () => {
  let root: string;
  let store: RenamePreviewPlans;
  let plan: RenamePlan;
  const nodes: GraphNode[] = [
    {
      id: 'Function:a.ts:old',
      label: 'Function',
      properties: { name: 'old', filePath: 'a.ts', startLine: 0 },
    },
  ];
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rename-preview-capability-')),
    );
    store = new RenamePreviewPlans();
    await fs.writeFile(path.join(root, 'a.ts'), 'old();');
    plan = {
      symbol: { uid: nodes[0]!.id, name: 'old', filePath: 'a.ts', startLine: 1 },
      new_name: 'newName',
      coverage: {
        name: 'test',
        scope: 'indexed-repository',
        languages: ['typescript'],
        source_file_count: 1,
        limitations: [],
      },
      snapshots: new Map([[path.join(root, 'a.ts'), 'old();']]),
      edits: [{ file_path: 'a.ts', start: 0, length: 3, old_text: 'old', new_text: 'newName' }],
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = () => store.remember(root, plan, nodes, [], ['a.ts']);
  const take = (token: string) => store.take(token, root, plan.symbol, 'newName', nodes, []);

  it('retains independent immutable edit, coverage and snapshot values', async () => {
    const token = await save();
    plan.edits[0]!.new_text = 'unreviewed';
    plan.snapshots.set(path.join(root, 'a.ts'), 'unreviewed();');
    plan.coverage.limitations.push('unreviewed');
    const approved = await take(token);
    expect(approved.edits[0]!.new_text).toBe('newName');
    expect(approved.snapshots.get(path.join(root, 'a.ts'))).toBe('old();');
    expect(approved.coverage.limitations).toEqual([]);
    expect(approved.targets.get(path.join(root, 'a.ts'))).toBe(
      await fs.realpath(path.join(root, 'a.ts')),
    );
  });
  it('rejects an unedited inventory alias of an edited physical file before publishing a token', async () => {
    await fs.symlink(path.join(root, 'a.ts'), path.join(root, 'alias.ts'), 'file');
    await expect(store.remember(root, plan, nodes, [], ['a.ts', 'alias.ts'])).rejects.toMatchObject(
      { code: 'duplicate_file' },
    );
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('old();');
  });
  it('normalizes data-only provider classes and compares nested Maps without losing entries', async () => {
    class Config {
      constructor(readonly paths = new Map([['entry', 'a.ts']])) {}
    }
    let current = new Config();
    const version = renameResolutionVersion(current, async () => current);
    await expect(validateRenameResolution(version)).resolves.toBeUndefined();
    current = new Config(new Map([['entry', 'other.ts']]));
    await expect(validateRenameResolution(version)).rejects.toMatchObject({
      code: 'resolution_changed',
    });
  });
  it('consumes a capability when fresh provider configuration fails to load', async () => {
    let failed = false;
    const resolution = renameResolutionVersion(null, async () => {
      if (failed) throw new Error('injected configuration acquisition failure');
      return null;
    });
    const token = await store.remember(root, plan, nodes, [], ['a.ts'], resolution);
    failed = true;
    await expect(take(token)).rejects.toThrow('injected configuration acquisition failure');
    await expect(take(token)).rejects.toMatchObject({ code: 'invalid_plan' });
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('old();');
  });
  it('ignores optional context enrichment while preserving stable symbol identity', async () => {
    const enriched = { ...plan.symbol, methodMetadata: { returnType: 'number' } };
    const token = await store.remember(root, { ...plan, symbol: enriched }, nodes, [], ['a.ts']);
    expect((await take(token)).symbol.uid).toBe(plan.symbol.uid);
  });
  it('retains hashes instead of whole text for large unedited semantic evidence', async () => {
    const file = path.join(root, 'evidence.ts');
    const source = '/*' + 'x'.repeat(34 * 1024 * 1024) + '*/';
    await fs.writeFile(file, source);
    plan.snapshots.set(file, source);
    const token = await store.remember(root, plan, nodes, [], await renameSourceInventory(root));
    const retained = await take(token);
    expect(retained.snapshots.size).toBe(1);
    expect(retained.snapshots.has(file)).toBe(false);
    expect(retained.evidence.get(file)).toMatchObject({
      real: file,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      [...plan.snapshots.values()].reduce((sum, text) => sum + text.length * 2, 0),
    ).toBeGreaterThan(64 * 1024 * 1024);
    expect([...retained.snapshots.values()].reduce((sum, text) => sum + text.length * 2, 0)).toBe(
      12,
    );
  });
  it('permits only one concurrent application and rejects replay', async () => {
    const token = await save();
    const results = await Promise.allSettled([take(token), take(token)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'invalid_plan' },
    });
    await expect(take(token)).rejects.toMatchObject({ code: 'invalid_plan' });
  });
  it('retains and checks existing inventory sources absent from semantic snapshots', async () => {
    const file = path.join(root, 'unindexed.ts');
    await fs.writeFile(file, 'export const unrelated = 1;');
    const sources = await renameSourceInventory(root);
    const token = await store.remember(root, plan, nodes, [], sources);
    const retained = await take(token);
    expect(retained.evidence.get(file)).toMatchObject({
      real: file,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(retained.snapshots.has(file)).toBe(false);

    const changed = await store.remember(root, plan, nodes, [], sources);
    await fs.writeFile(file, 'old();');
    await expect(take(changed)).rejects.toMatchObject({ code: 'source_changed' });
  });
  it('checks the final bytes of an oversized unindexed source without retaining its text', async () => {
    const file = path.join(root, 'generated.ts');
    const bytes = 16 * 1024 * 1024;
    const handle = await fs.open(file, 'w');
    await handle.truncate(bytes);
    await handle.close();
    const sources = await renameSourceInventory(root);
    const token = await store.remember(root, plan, nodes, [], sources);
    const retained = await take(token);
    expect(retained.evidence.has(file)).toBe(true);
    expect(retained.snapshots.size).toBe(1);
    const changed = await store.remember(root, plan, nodes, [], sources);
    const update = await fs.open(file, 'r+');
    await update.write(Buffer.from('x'), 0, 1, bytes - 1);
    await update.close();
    await expect(take(changed)).rejects.toMatchObject({ code: 'source_changed' });
  });
  it('rejects expiry and capabilities from another server', async () => {
    const token = await save();
    await expect(
      new RenamePreviewPlans().take(token, root, plan.symbol, plan.new_name, nodes, []),
    ).rejects.toMatchObject({ code: 'invalid_plan' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    await expect(take(token)).rejects.toMatchObject({ code: 'invalid_plan' });
  });
  it('bounds retained plans and evicts the oldest capability', async () => {
    const first = await save();
    let last = '';
    for (let count = 0; count < 16; count++) last = await save();
    await expect(take(first)).rejects.toMatchObject({ code: 'invalid_plan' });
    expect(await take(last)).toMatchObject({ new_name: 'newName' });
  });
  it('keeps concurrent preview insertions within the count budget', async () => {
    const tokens = await Promise.all(Array.from({ length: 24 }, save));
    const results = await Promise.allSettled(tokens.map(take));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(16);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(8);
  });
  it('refuses oversized retained plans before cloning their source contents', async () => {
    plan.snapshots.set(path.join(root, 'a.ts'), 'x'.repeat(33 * 1024 * 1024));
    await expect(save()).rejects.toMatchObject({ code: 'plan_too_large' });
  });
  it('charges retained provider configuration against the same memory cap', async () => {
    const resolution = renameResolutionVersion(
      new Map([['scope', 'x'.repeat(17 * 1024 * 1024)]]),
      async () => null,
    );
    await expect(store.remember(root, plan, nodes, [], ['a.ts'], resolution)).rejects.toMatchObject(
      { code: 'plan_too_large' },
    );
  });
  it('rejects graph drift independently of unchanged source contents', async () => {
    const token = await save();
    const changed = [...nodes, { ...nodes[0]!, id: 'Function:a.ts:other' }];
    await expect(
      store.take(token, root, plan.symbol, plan.new_name, changed, []),
    ).rejects.toMatchObject({ code: 'stale_graph' });
  });
  it('includes newly added untracked and oversized sources in the inventory', async () => {
    await fs.writeFile(path.join(root, 'untracked.ts'), 'newName();');
    const oversized = await fs.open(path.join(root, 'generated.ts'), 'w');
    await oversized.truncate(16 * 1024 * 1024);
    await oversized.close();
    expect(await renameSourceInventory(root)).toEqual(['a.ts', 'generated.ts', 'untracked.ts']);
  });
  it('rejects newly added filename-only supported sources such as an untracked Rakefile', async () => {
    const token = await save();
    await fs.writeFile(path.join(root, 'Rakefile'), 'task :build do\nend\n');
    expect(await renameSourceInventory(root)).toEqual(['Rakefile', 'a.ts']);
    await expect(take(token)).rejects.toMatchObject({ code: 'source_set_changed' });
  });
  it('rejects a changed physical target with identical source bytes', async () => {
    for (const directory of ['.first', '.second']) {
      await fs.mkdir(path.join(root, directory));
      await fs.writeFile(path.join(root, directory, 'a.ts'), 'old();');
    }
    const link = path.join(root, 'linked');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(path.join(root, '.first'), link, kind);
    plan.snapshots = new Map([[path.join(link, 'a.ts'), 'old();']]);
    plan.edits[0]!.file_path = 'linked/a.ts';
    const unchanged = await store.remember(
      root,
      plan,
      nodes,
      [],
      await renameSourceInventory(root),
    );
    expect((await take(unchanged)).targets.get(path.join(link, 'a.ts'))).toBe(
      await fs.realpath(path.join(link, 'a.ts')),
    );
    const token = await store.remember(root, plan, nodes, [], await renameSourceInventory(root));
    await fs.unlink(link);
    await fs.symlink(path.join(root, '.second'), link, kind);
    await expect(take(token)).rejects.toMatchObject({ code: 'source_changed' });
  });
});
