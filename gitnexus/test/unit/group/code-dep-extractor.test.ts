import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeDepExtractor } from '../../../src/core/group/extractors/code-dep-extractor.js';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('CodeDepExtractor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-codedep-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  const makeMockExecutor = (rows: Record<string, unknown>[]): CypherExecutor => {
    return vi.fn().mockResolvedValue(rows);
  };

  describe('canExtract', () => {
    it('returns true when repo has package.json', async () => {
      writeFile('package.json', JSON.stringify({ name: '@acme/shared' }));
      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const result = await extractor.canExtract(makeRepo(tmpDir));
      expect(result).toBe(true);
    });

    it('returns true when packageMap is non-empty', async () => {
      const extractor = new CodeDepExtractor(new Map([['@acme/other', 'libs/other']]), null);
      const result = await extractor.canExtract(makeRepo(tmpDir));
      expect(result).toBe(true);
    });

    it('returns false when no package.json and no packageMap', async () => {
      const extractor = new CodeDepExtractor(new Map(), null);
      const result = await extractor.canExtract(makeRepo(tmpDir));
      expect(result).toBe(false);
    });
  });

  describe('provider extraction', () => {
    it('creates provider contracts from exported symbols', async () => {
      writeFile('package.json', JSON.stringify({ name: '@acme/shared' }));

      const executor = makeMockExecutor([
        { uid: 'fn-1', name: 'formatDate', filePath: 'src/utils.ts' },
        { uid: 'class-1', name: 'Logger', filePath: 'src/logger.ts' },
      ]);

      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(2);

      expect(providers[0].contractId).toBe('lib::@acme/shared::formatDate');
      expect(providers[0].type).toBe('lib');
      expect(providers[0].role).toBe('provider');
      expect(providers[0].symbolUid).toBe('fn-1');
      expect(providers[0].symbolRef).toEqual({ filePath: 'src/utils.ts', name: 'formatDate' });
      expect(providers[0].confidence).toBe(0.9);

      expect(providers[1].contractId).toBe('lib::@acme/shared::Logger');
      expect(providers[1].symbolUid).toBe('class-1');
    });

    it('deduplicates provider contracts by contractId', async () => {
      const executor = makeMockExecutor([
        { uid: 'fn-1', name: 'formatDate', filePath: 'src/utils.ts' },
        { uid: 'fn-2', name: 'formatDate', filePath: 'src/index.ts' },
      ]);

      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(1);
      expect(providers[0].symbolUid).toBe('fn-1'); // first wins
    });

    it('skips providers when no ownPackageName', async () => {
      const executor = makeMockExecutor([
        { uid: 'fn-1', name: 'formatDate', filePath: 'src/utils.ts' },
      ]);

      const extractor = new CodeDepExtractor(new Map(), null);
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(0);
    });

    it('skips providers when no dbExecutor', async () => {
      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(0);
    });

    it('handles db query failure gracefully', async () => {
      const executor = vi.fn().mockRejectedValue(new Error('DB error'));

      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(0);
    });

    it('skips rows with empty names', async () => {
      const executor = makeMockExecutor([
        { uid: 'fn-1', name: '', filePath: 'src/utils.ts' },
        { uid: 'fn-2', name: 'validFn', filePath: 'src/utils.ts' },
      ]);

      const extractor = new CodeDepExtractor(new Map(), '@acme/shared');
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers).toHaveLength(1);
      expect(providers[0].symbolName).toBe('validFn');
    });
  });

  describe('consumer extraction', () => {
    it('creates consumer contracts from named imports', async () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      writeFile('src/app.ts', `import { formatDate, Logger } from '@acme/shared';`);

      const extractor = new CodeDepExtractor(packageMap, null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers).toHaveLength(2);

      expect(consumers[0].contractId).toBe('lib::@acme/shared::formatDate');
      expect(consumers[0].type).toBe('lib');
      expect(consumers[0].role).toBe('consumer');
      expect(consumers[0].symbolRef.filePath.replace(/\\/g, '/')).toBe('src/app.ts');
      expect(consumers[0].confidence).toBe(0.9);

      expect(consumers[1].contractId).toBe('lib::@acme/shared::Logger');
    });

    it('creates wildcard consumer for namespace imports', async () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      writeFile('src/app.ts', `import * as Shared from '@acme/shared';`);

      const extractor = new CodeDepExtractor(packageMap, null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::@acme/shared::*');
      expect(consumers[0].confidence).toBe(0.7);
      expect(consumers[0].meta.importType).toBe('namespace');
    });

    it('creates default consumer for default imports', async () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      writeFile('src/app.ts', `import SharedLib from '@acme/shared';`);

      const extractor = new CodeDepExtractor(packageMap, null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::@acme/shared::default');
      expect(consumers[0].confidence).toBe(0.8);
      expect(consumers[0].meta.importType).toBe('default');
    });

    it('includes subpath in meta', async () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      writeFile('src/app.ts', `import { helper } from '@acme/shared/utils';`);

      const extractor = new CodeDepExtractor(packageMap, null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers).toHaveLength(1);
      expect(consumers[0].meta.subpath).toBe('/utils');
    });

    it('returns empty consumers when no packageMap entries', async () => {
      writeFile('src/app.ts', `import { Foo } from '@acme/shared';`);

      const extractor = new CodeDepExtractor(new Map(), null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });

    it('deduplicates consumers from same file', async () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      writeFile(
        'src/app.ts',
        `
import { formatDate } from '@acme/shared';
import { formatDate } from '@acme/shared/utils';
      `,
      );

      const extractor = new CodeDepExtractor(packageMap, null);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      // Same symbol from same file — deduped by contractId|filePath
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers).toHaveLength(1);
    });
  });

  describe('combined extraction', () => {
    it('returns both providers and consumers', async () => {
      const packageMap = new Map([['@acme/ui-kit', 'libs/ui-kit']]);
      writeFile('package.json', JSON.stringify({ name: '@acme/shared' }));
      writeFile('src/app.ts', `import { Button } from '@acme/ui-kit';`);

      const executor = makeMockExecutor([
        { uid: 'fn-1', name: 'formatDate', filePath: 'src/utils.ts' },
      ]);

      const extractor = new CodeDepExtractor(packageMap, '@acme/shared');
      const contracts = await extractor.extract(executor, tmpDir, makeRepo(tmpDir));

      const providers = contracts.filter((c) => c.role === 'provider');
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('lib::@acme/shared::formatDate');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::@acme/ui-kit::Button');
    });
  });
});
