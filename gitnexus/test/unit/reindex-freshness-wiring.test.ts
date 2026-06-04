import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('reindex freshness wiring', () => {
  const readApiSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  const readBackendSource = () =>
    fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'mcp', 'local', 'local-backend.ts'),
      'utf-8',
    );

  it('reindex completion uses explicit repo refresh instead of plain backend init', async () => {
    const source = await readApiSource();
    const helper = source.match(
      /const startReindexJob = [\s\S]{0,26000}const finalizeCompletedWorker = async[\s\S]{0,10000}catch \(err\)/,
    );

    expect(helper?.[0]).toMatch(/refreshRepoIndex\(target\.name\)/);
    expect(helper?.[0]).not.toMatch(/backend\s*\.\s*init\(\)/);
  });

  it('keeps the repo lock held until refresh completes', async () => {
    const source = await readApiSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);
    const completePath = helper?.[0].match(
      /const finalizeCompletedWorker = async[\s\S]{0,1400}jobManager\.updateJob/,
    );

    expect(completePath?.[0]).toMatch(/await backend\.refreshRepoIndex\(target\.name\)/);
    expect(completePath?.[0]).toMatch(/releaseRepoLock\(reindexLockKey\)[\s\S]{0,220}jobManager\.updateJob/);
    expect(completePath?.[0]).not.toMatch(/releaseRepoLock\(reindexLockKey\)[\s\S]{0,120}await backend\.refreshRepoIndex/);
  });

  it('closes the singleton HTTP lbug handle before reporting reindex completion', async () => {
    const source = await readApiSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);
    const completePath = helper?.[0].match(
      /const finalizeCompletedWorker = async[\s\S]{0,1800}jobManager\.updateJob/,
    );

    expect(completePath?.[0]).toMatch(/await closeLbug\(\)/);
    expect(completePath?.[0]).toMatch(
      /await closeLbug\(\)[\s\S]{0,520}await backend\.refreshRepoIndex\(target\.name\)/,
    );
    expect(completePath?.[0]).toMatch(
      /await backend\.refreshRepoIndex\(target\.name\)[\s\S]{0,220}releaseRepoLock\(reindexLockKey\)/,
    );
  });

  it('settles the rebuilt LadybugDB store in writable mode before HTTP reads resume', async () => {
    const source = await readApiSource();
    const helper = source.match(/const startReindexJob = [\s\S]{0,16000}return job;\s*};/);
    const completePath = helper?.[0].match(
      /const finalizeCompletedWorker = async[\s\S]{0,1800}jobManager\.updateJob/,
    );

    expect(completePath?.[0]).toMatch(/await initLbug\(path\.join\(target\.storagePath, 'lbug'\)\)/);
    expect(completePath?.[0]).toMatch(
      /await initLbug\(path\.join\(target\.storagePath, 'lbug'\)\)[\s\S]{0,160}await closeLbug\(\)/,
    );
    expect(completePath?.[0]).toMatch(
      /await initLbug\(path\.join\(target\.storagePath, 'lbug'\)\)[\s\S]{0,300}await backend\.refreshRepoIndex\(target\.name\)/,
    );
  });

  it('LocalBackend refreshRepoIndex closes and invalidates the repo-specific pool without eager reopen', async () => {
    const source = await readBackendSource();
    const method = source.match(/async refreshRepoIndex\(repoParam: string\)[\s\S]{0,1800}^\s*}/m);

    expect(method?.[0]).toMatch(/await this\.refreshRepos\(\)/);
    expect(method?.[0]).toMatch(/await closeLbug\(handle\.id\)/);
    expect(method?.[0]).toMatch(/this\.initializedRepos\.delete\(handle\.id\)/);
    expect(method?.[0]).toMatch(/this\.lastStalenessCheck\.delete\(handle\.id\)/);
    expect(method?.[0]).not.toMatch(/await initLbug\(handle\.id, handle\.lbugPath\)/);
    expect(method?.[0]).not.toMatch(/this\.initializedRepos\.add\(handle\.id\)/);
  });

  it('pool adapter treats read-only shadow replay as retryable during immediate reopen', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'pool-adapter.ts'),
      'utf-8',
    );
    const method = source.match(
      /for \(let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt\+\+\) \{[\s\S]{0,2600}if \(!isRetryableOpenError \|\| attempt === LOCK_RETRY_ATTEMPTS\) break;/,
    );

    expect(method?.[0]).toMatch(/isReadOnlyShadowReplayError\(lastError\)/);
  });
});
