import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getDatabase } from '../../../../src/core/lbug/lbug-adapter.js';
import { createIndexedDbFixture } from '../../../../test/helpers/indexed-db-fixture.js';

test('failed fixture setup closes its database and removes the temporary directory', async () => {
  let directory: string;
  const failure = new Error('seed failed');
  const db = createIndexedDbFixture('interrupted-setup', {
    async beforeFTS(dbPath) {
      directory = path.dirname(dbPath);
      assert.ok(getDatabase());
      assert.ok(existsSync(directory));
      throw failure;
    },
  });
  await assert.rejects(db.setup, (error) => error === failure);
  assert.ok(directory!);
  assert.equal(existsSync(directory), false);
  assert.ok(!getDatabase());
  await db.cleanup();
});
