import { it } from 'node:test';
import { expect } from 'expect';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpRouteExtractor } from '../../../../src/core/group/extractors/http-route-extractor.js';
import { runExactMatch } from '../../../../src/core/group/matching.js';
import type { StoredContract } from '../../../../src/core/group/types.js';

async function pair(fixture: string) {
  const root = fileURLToPath(
    new URL('../../../../test/fixtures/typescript-products/http-route-pairing/', import.meta.url),
  );
  const extractor = new HttpRouteExtractor();
  const contracts: StoredContract[] = [];
  for (const id of ['backend', 'web']) {
    const repoPath = path.join(root, fixture, id);
    const rows = await extractor.extract(null, repoPath, {
      id,
      path: id,
      repoPath,
      storagePath: path.join(repoPath, '.gitnexus'),
    });
    contracts.push(...rows.map((row) => ({ ...row, repo: id })));
  }
  return runExactMatch(contracts).matched;
}

it('cross-links a grouped method-value route to a ${API_BASE}-prefixed fetch', async () => {
  const matched = await pair('gin');
  const link = matched.find(
    (l) => l.contractId === 'http::POST::/api/v1/admin/seasons/{param}/rounds/{param}/unfinalize',
  );
  expect(link).toMatchObject({
    from: { repo: 'web', symbolRef: { filePath: 'src/pages/AdminMatchesPage.tsx' } },
    to: {
      repo: 'backend',
      symbolRef: { filePath: 'internal/handlers/routes.go', name: 'UnfinalizeRoundHandle' },
    },
    matchType: 'exact',
  });
});

it('links consumers of every verb to a method-agnostic ServeMux route', async () => {
  const matched = await pair('nethttp');
  expect(
    matched
      .map((l) => ({ consumer: l.from.repo, provider: l.to.repo, contractId: l.contractId }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId)),
  ).toEqual([
    { consumer: 'web', provider: 'backend', contractId: 'http::GET::/api/users' },
    { consumer: 'web', provider: 'backend', contractId: 'http::POST::/api/users' },
  ]);
});
