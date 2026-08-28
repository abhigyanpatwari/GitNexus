import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOutputManifest } from '../../src/core/wiki/document/output-manifest.js';
import { WikiPublisher } from '../../src/core/wiki/document/publisher.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';

const tempDirs: string[] = [];

async function tempWiki(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-publication-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

function fixture(generationId: string, entryContent = '# Architecture') {
  const profile = resolveTemplateProfile('arc42');
  const files = {
    'architecture-description.md': entryContent,
    'context-scope.md': '# Context',
    'coverage.json': '{"status":"passed"}\n',
    'document_plan.json': '{"status":"generated"}\n',
    'meta.json': '{"schemaVersion":2}\n',
  };
  const manifest = createOutputManifest({
    generationId,
    profile: {
      id: profile.profile.id,
      revision: profile.profile.revision,
      fingerprint: profile.fingerprint,
    },
    language: resolveLanguage('english', profile.profile),
    sourceCommit: 'abc123',
    generationSemanticsKey: 'a'.repeat(64),
    entry: {
      slug: 'overview',
      label: 'Architecture',
      file: 'architecture-description.md',
      content: files['architecture-description.md'],
    },
    pages: [
      {
        id: 'context-scope',
        slug: 'context-scope',
        label: 'Context & Scope',
        file: 'context-scope.md',
        order: 0,
        status: 'verified',
        content: files['context-scope.md'],
      },
    ],
    coverage: { file: 'coverage.json', content: files['coverage.json'] },
    supportingArtifacts: [
      {
        role: 'document-plan',
        file: 'document_plan.json',
        content: files['document_plan.json'],
      },
    ],
  });
  return { files, manifest };
}

describe('versioned wiki publication', () => {
  it('promotes a verified generation, atomically points current, and mirrors after commit', async () => {
    const wikiDir = await tempWiki();
    const first = fixture('generation-1');
    const publisher = new WikiPublisher();
    const result = await publisher.publish({
      wikiDir,
      ...first,
      mirrorFiles: ['architecture-description.md', 'meta.json'],
    });

    expect(result.mirrorFailures).toEqual([]);
    expect(
      JSON.parse(await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8')),
    ).toMatchObject({
      schemaVersion: 1,
      generationId: 'generation-1',
      manifestFile: 'manifest.json',
    });
    expect(await fs.readFile(path.join(result.generationDir, 'context-scope.md'), 'utf8')).toBe(
      '# Context',
    );
    expect(await fs.readFile(path.join(wikiDir, 'architecture-description.md'), 'utf8')).toBe(
      '# Architecture',
    );
    await expect(fs.access(path.join(wikiDir, '.state/generation.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains the previous generation and records it in the next current pointer', async () => {
    const wikiDir = await tempWiki();
    const publisher = new WikiPublisher();
    await publisher.publish({ wikiDir, ...fixture('generation-1') });
    const result = await publisher.publish({ wikiDir, ...fixture('generation-2') });

    expect(result.current.previousGenerationId).toBe('generation-1');
    await expect(
      fs.access(path.join(wikiDir, '.generations/generation-1/manifest.json')),
    ).resolves.toBeUndefined();
  });

  it('reuses an identical content-addressed generation idempotently', async () => {
    const wikiDir = await tempWiki();
    const publisher = new WikiPublisher();
    const input = { wikiDir, ...fixture('generation-1') };
    await publisher.publish(input);
    const second = await publisher.publish(input);

    expect(second.current.generationId).toBe('generation-1');
    expect(second.current.previousGenerationId).toBeUndefined();
    expect(await fs.readdir(path.join(wikiDir, '.generations'))).toEqual(['generation-1']);
  });

  it('rejects a generationId collision when the same id is republished with different content', async () => {
    const wikiDir = await tempWiki();
    await new WikiPublisher().publish({ wikiDir, ...fixture('generation-1') });

    // 相同 generationId 但不同内容应触发内容寻址冲突,publisher 不会用新内容覆盖既有身份
    await expect(
      new WikiPublisher().publish({
        wikiDir,
        ...fixture('generation-1', '# Different Architecture\n'),
      }),
    ).rejects.toThrow('Wiki generation identity collision');
    expect(await fs.readdir(path.join(wikiDir, '.generations'))).toEqual(['generation-1']);
  });

  it('preserves last-known-good current and removes the promoted generation on commit failure', async () => {
    const wikiDir = await tempWiki();
    await new WikiPublisher().publish({ wikiDir, ...fixture('generation-1') });
    const publisher = new WikiPublisher({
      beforeCurrentWrite: () => {
        throw new Error('injected current failure');
      },
    });

    await expect(publisher.publish({ wikiDir, ...fixture('generation-2') })).rejects.toThrow(
      'injected current failure',
    );
    expect(
      JSON.parse(await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8')),
    ).toMatchObject({
      generationId: 'generation-1',
    });
    await expect(fs.access(path.join(wikiDir, '.generations/generation-2'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports post-commit mirror failures without invalidating the committed generation', async () => {
    const wikiDir = await tempWiki();
    const publisher = new WikiPublisher({
      beforeMirrorWrite: (file) => {
        if (file === 'meta.json') throw new Error('injected mirror failure');
      },
    });
    const result = await publisher.publish({
      wikiDir,
      ...fixture('generation-1'),
      mirrorFiles: ['architecture-description.md', 'meta.json'],
    });

    expect(result.mirrorFailures).toEqual(['meta.json']);
    expect(result.current.generationId).toBe('generation-1');
    await expect(fs.access(path.join(result.generationDir, 'meta.json'))).resolves.toBeUndefined();
  });

  it('rejects contention, invalid previous pointers, missing files, and content hash drift', async () => {
    const lockedDir = await tempWiki();
    await fs.mkdir(path.join(lockedDir, '.state'), { recursive: true });
    // 使用当前进程 PID 模拟活跃锁，确保陈旧锁检测不会接管
    await fs.writeFile(
      path.join(lockedDir, '.state/generation.lock'),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await expect(
      new WikiPublisher().publish({ wikiDir: lockedDir, ...fixture('generation-1') }),
    ).rejects.toThrow('Wiki generation is locked by another publisher');

    const invalidCurrentDir = await tempWiki();
    await fs.mkdir(path.join(invalidCurrentDir, '.state'), { recursive: true });
    await fs.writeFile(
      path.join(invalidCurrentDir, '.state/current.json'),
      '{"generationId":"../x"}',
    );
    await expect(
      new WikiPublisher().publish({ wikiDir: invalidCurrentDir, ...fixture('generation-1') }),
    ).rejects.toThrow('Cannot read wiki current pointer');

    const missingDir = await tempWiki();
    const missing = fixture('generation-1');
    delete (missing.files as Partial<typeof missing.files>)['context-scope.md'];
    await expect(new WikiPublisher().publish({ wikiDir: missingDir, ...missing })).rejects.toThrow(
      'Wiki publication is missing context-scope.md',
    );

    const driftDir = await tempWiki();
    const drift = fixture('generation-1');
    drift.files['context-scope.md'] = '# Changed';
    await expect(new WikiPublisher().publish({ wikiDir: driftDir, ...drift })).rejects.toThrow(
      'Wiki publication hash mismatch: context-scope.md',
    );
  });
});

describe('WikiPublisher — 陈旧锁恢复', () => {
  it('不存在的 PID 的陈旧锁可被接管', async () => {
    const wikiDir = await tempWiki();
    // 预置一个陈旧锁文件，PID 为一个不存在的进程
    await fs.mkdir(path.join(wikiDir, '.state'), { recursive: true });
    const lockPath = path.join(wikiDir, '.state', 'generation.lock');
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() })}\n`,
    );

    const publisher = new WikiPublisher();
    const input = { wikiDir, ...fixture('generation-1') };
    const result = await publisher.publish(input);
    expect(result.current.generationId).toBe(input.manifest.generationId);
  });

  it('格式损坏的锁文件可被接管', async () => {
    const wikiDir = await tempWiki();
    await fs.mkdir(path.join(wikiDir, '.state'), { recursive: true });
    const lockPath = path.join(wikiDir, '.state', 'generation.lock');
    await fs.writeFile(lockPath, 'corrupted content');

    const publisher = new WikiPublisher();
    const input = { wikiDir, ...fixture('generation-1') };
    const result = await publisher.publish(input);
    expect(result.current.generationId).toBe(input.manifest.generationId);
  });

  it('活跃进程的锁仍被正确阻塞', async () => {
    const wikiDir = await tempWiki();
    await fs.mkdir(path.join(wikiDir, '.state'), { recursive: true });
    const lockPath = path.join(wikiDir, '.state', 'generation.lock');
    // 使用当前进程 PID 模拟活跃锁
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );

    const publisher = new WikiPublisher();
    const input = { wikiDir, ...fixture('generation-1') };
    await expect(publisher.publish(input)).rejects.toThrow(/locked by another publisher/);

    // 清理：手动删除锁，避免影响 afterEach 的 tempDirs 清理之外的残留
    await fs.unlink(lockPath).catch(() => {});
  });
});

describe('WikiPublisher — symlink 逃逸防护', () => {
  it('拒绝 .state 目录为符号链接', async () => {
    const wikiDir = await tempWiki();
    const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-escape-'));
    tempDirs.push(escapeDir);
    // 先创建 .state 再替换为指向外部的符号链接
    await fs.mkdir(path.join(wikiDir, '.state'), { recursive: true });
    await fs.rm(path.join(wikiDir, '.state'), { recursive: true });
    await fs.symlink(escapeDir, path.join(wikiDir, '.state'));

    const publisher = new WikiPublisher();
    await expect(publisher.publish({ wikiDir, ...fixture('generation-1') })).rejects.toThrow(
      /symbolic link|escapes/,
    );
  });

  it('拒绝 .staging 目录为符号链接', async () => {
    const wikiDir = await tempWiki();
    const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-escape-'));
    tempDirs.push(escapeDir);
    await fs.mkdir(path.join(wikiDir, '.staging'), { recursive: true });
    await fs.rm(path.join(wikiDir, '.staging'), { recursive: true });
    await fs.symlink(escapeDir, path.join(wikiDir, '.staging'));

    const publisher = new WikiPublisher();
    await expect(publisher.publish({ wikiDir, ...fixture('generation-1') })).rejects.toThrow(
      /symbolic link|escapes/,
    );
  });

  it('拒绝 .generations 目录为符号链接', async () => {
    const wikiDir = await tempWiki();
    const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-escape-'));
    tempDirs.push(escapeDir);
    await fs.mkdir(path.join(wikiDir, '.generations'), { recursive: true });
    await fs.rm(path.join(wikiDir, '.generations'), { recursive: true });
    await fs.symlink(escapeDir, path.join(wikiDir, '.generations'));

    const publisher = new WikiPublisher();
    await expect(publisher.publish({ wikiDir, ...fixture('generation-1') })).rejects.toThrow(
      /symbolic link|escapes/,
    );
  });
});
