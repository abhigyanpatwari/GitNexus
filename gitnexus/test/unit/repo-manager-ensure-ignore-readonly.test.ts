/**
 * Read-only / permission-denied write paths for ensureGitNexusIgnored (#1549, PR #1550).
 * Separate from repo-manager.test.ts: Vitest cannot vi.spyOn ESM namespace exports of
 * fs/promises; a delegating vi.mock is required for cross-platform mock rejects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

const fswCtx = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  realWrite: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = actual.default;
  fswCtx.realWrite = d.writeFile.bind(d);
  fswCtx.writeFileMock.mockImplementation((...args) => fswCtx.realWrite!(...args));
  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'writeFile') return fswCtx.writeFileMock;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

import fs from 'fs/promises';
import { ensureGitNexusIgnored } from '../../src/storage/repo-manager.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDir } from '../helpers/test-db.js';

const samePath = (a: string, b: string) => path.normalize(a) === path.normalize(b);

describe('ensureGitNexusIgnored — mocked writeFile (EROFS / EACCES / EPERM)', () => {
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    tmpRepo = await createTempDir('gitnexus-ro-ignore-mock-');
    fswCtx.writeFileMock.mockClear();
    fswCtx.writeFileMock.mockImplementation((...args) => fswCtx.realWrite!(...args));
  });

  afterEach(async () => {
    await tmpRepo.cleanup();
  });

  it.each(['EROFS', 'EACCES', 'EPERM'] as const)(
    'tolerates %s on .git/info/exclude write and logs a warn',
    async (code) => {
      const gitignorePath = path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore');
      await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
      await fs.writeFile(gitignorePath, '*\n', 'utf-8');

      const excludePath = path.join(tmpRepo.dbPath, '.git', 'info', 'exclude');
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.writeFile(excludePath, '# empty\n', 'utf-8');

      const cap = _captureLogger();
      fswCtx.writeFileMock.mockRejectedValueOnce(Object.assign(new Error('mock ro'), { code }));

      try {
        await expect(ensureGitNexusIgnored(tmpRepo.dbPath)).resolves.not.toThrow();
        expect(fswCtx.writeFileMock).toHaveBeenCalled();
        expect(
          cap
            .records()
            .some(
              (r) =>
                r.level === 40 &&
                r.code === code &&
                typeof r.path === 'string' &&
                samePath(String(r.path), excludePath) &&
                String(r.msg ?? '').includes('.git/info/exclude'),
            ),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    },
  );

  it.each(['EROFS', 'EACCES', 'EPERM'] as const)(
    'tolerates %s on .gitnexus/.gitignore write and logs a warn',
    async (code) => {
      const cap = _captureLogger();
      const gitignorePath = path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore');

      fswCtx.writeFileMock.mockRejectedValueOnce(Object.assign(new Error('mock ro'), { code }));

      try {
        await expect(ensureGitNexusIgnored(tmpRepo.dbPath)).resolves.not.toThrow();
        expect(fswCtx.writeFileMock).toHaveBeenCalled();
        expect(
          cap
            .records()
            .some(
              (r) =>
                r.level === 40 &&
                r.code === code &&
                typeof r.path === 'string' &&
                samePath(String(r.path), gitignorePath) &&
                String(r.msg ?? '').includes('.gitnexus/.gitignore'),
            ),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    },
  );
});
