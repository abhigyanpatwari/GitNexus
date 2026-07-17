import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Regression guard for issue: "Cannot open file ... lbug.shadow - Error 2"
 *
 * Read-only HTTP endpoints (graph, search, grep) must open the LadybugDB with
 * `{ readOnly: true }` so the engine never engages the checkpoint machinery
 * (`.shadow` sidecar). Write-mode opens for read-only operations were the
 * trigger for the Windows-only "Cannot open file ... lbug.shadow" failures
 * observed in E2E runs.
 *
 * If you add another read-only endpoint and forget the option, this file
 * fails — keeping the contract explicit at the static-analysis layer.
 *
 * Companion: api-query-readonly-wiring.test.ts (covers /api/query).
 * Precedent: PR #1655 set the pattern for /api/query.
 */
describe('api read-only endpoint wiring', () => {
  const readSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  it('/api/graph stream path opens read-only', async () => {
    const source = await readSource();
    expect(source).toMatch(
      /streamGraphNdjson\(res, includeContent, abortController\.signal\)[\s\S]{0,200}readOnly:\s*true/,
    );
  });

  it('/api/graph non-stream path opens read-only', async () => {
    const source = await readSource();
    expect(source).toMatch(/buildGraph\(includeContent\)[\s\S]{0,80}readOnly:\s*true/);
  });

  it('/api/search opens read-only', async () => {
    const source = await readSource();
    // The /api/search handler ends its withLbugDb callback with
    // `return { searchResults: enriched, ftsAvailable };` immediately before
    // the closing brace + options object. Match that suffix to confirm the
    // search call site, not /api/query.
    expect(source).toMatch(/searchResults: enriched, ftsAvailable[\s\S]{0,80}readOnly:\s*true/);
  });

  it('/api/grep opens read-only', async () => {
    const source = await readSource();
    expect(source).toMatch(/MATCH \(n:File\)[\s\S]{0,300}readOnly:\s*true/);
  });

  it('/api/embed remains write-mode (writes embeddings — must not be flipped to readOnly)', async () => {
    const source = await readSource();
    // Negative assertion: no `readOnly: true` between the embed job's
    // `runEmbeddingPipeline` call site and its withLbugDb open. Embed writes
    // back vector rows; flipping this to readOnly would silently break it.
    const embedSection = source.match(/runEmbeddingPipeline[\s\S]{0,400}\}\s*\)\s*;[\s\S]{0,200}/);
    if (embedSection) {
      expect(embedSection[0]).not.toMatch(/readOnly:\s*true/);
    }
  });

  it('/api/embed keeps the repository lock until cancelled work actually stops', async () => {
    const source = await readSource();
    const timeoutSection = source.match(
      /const embedTimeout = setTimeout\([\s\S]*?\/\/ Run embedding pipeline asynchronously/,
    );
    expect(timeoutSection).not.toBeNull();
    expect(timeoutSection?.[0]).not.toContain('releaseRepoLock(repoLockPath)');
  });

  it('/api/embed persists and resumes bounded pending windows', async () => {
    const source = await readSource();
    const embedSection = source.match(
      /\/\/ Run embedding pipeline asynchronously[\s\S]*?res\.status\(202\)/,
    );
    expect(embedSection).not.toBeNull();
    expect(embedSection?.[0]).toContain('forceReembedNodeIds');
    expect(embedSection?.[0]).toContain('onCheckpointWindowStart');
    expect(embedSection?.[0]).toContain('pendingNodeIds');
    expect(embedSection?.[0]).toContain('saveMeta');
  });
});
