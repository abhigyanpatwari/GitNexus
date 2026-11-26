import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from 'expect';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ThriftExtractor } from '../../../../src/core/group/extractors/thrift-extractor.js';
import type { RepoHandle } from '../../../../src/core/group/types.js';

describe('ThriftExtractor', () => {
  let tmpDir: string;
  let extractor: ThriftExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-thrift-'));
    extractor = new ThriftExtractor();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
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

  it('test_extract_repo_without_thrift_returns_empty', async () => {
    writeFile('src/index.ts', 'console.log("hello")');

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts).toEqual([]);
  });
});
