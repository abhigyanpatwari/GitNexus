import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('wiki auto-refresh API wiring', () => {
  const readApiSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  it('registers a read-only wiki auto-refresh status endpoint through the existing planner', async () => {
    const source = await readApiSource();

    expect(source).toMatch(/planWikiAutoRefresh/);
    expect(source).toMatch(/readWikiAutoRefreshMeta/);
    expect(source).toMatch(/planWikiProviderReadiness/);
    expect(source).toMatch(/loadCLIConfig/);

    const route = source.match(/app\.get\('\/api\/wiki\/auto-refresh'[\s\S]{0,3600}\}\);/);

    expect(route?.[0]).toMatch(/resolveRepo\(requestedRepo\(req\), false, req\)/);
    expect(route?.[0]).toMatch(/checkStalenessAsync\(entry\.path, entry\.lastCommit\)/);
    expect(route?.[0]).toMatch(/readWikiAutoRefreshMeta\(entry\.storagePath\)/);
    expect(route?.[0]).toMatch(/planWikiAutoRefresh\(/);
    expect(route?.[0]).toMatch(/planWikiProviderReadiness\(/);
    expect(route?.[0]).toMatch(/loadCLIConfig\(\)/);
    expect(route?.[0]).toMatch(/dryRun:\s*true/);
    expect(route?.[0]).toMatch(/mutateOutput:\s*false/);
    expect(route?.[0]).toMatch(/repoName:\s*entry\.name/);
    expect(route?.[0]).toMatch(/repoPath:\s*entry\.path/);
    expect(route?.[0]).toMatch(/storagePath:\s*entry\.storagePath/);
    expect(route?.[0]).not.toMatch(/runWikiAutoRefresh/);
    expect(route?.[0]).not.toMatch(/WikiGenerator/);
    expect(route?.[0]).not.toMatch(/detectLocalCLI/);
  });
});
