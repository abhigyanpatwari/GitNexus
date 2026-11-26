import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractRustWorkspaceLinks } from '../../../../src/core/group/extractors/rust-workspace-extractor.js';

it('skips repos without Cargo.toml', async () => {
  const root = fileURLToPath(
    new URL('../../../../test/fixtures/typescript-products/no-cargo/js-app/', import.meta.url),
  );
  const result = await extractRustWorkspaceLinks({ app: 'js-app' }, new Map([['app', root]]));
  assert.deepEqual(result.links, []);
  assert.equal(result.discoveredCrates.size, 0);
});
