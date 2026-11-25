import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import {
  createIndexedDbFixture,
  type IndexedDBHandle,
  type WithTestLbugDBOptions,
} from '../../../../test/helpers/indexed-db-fixture.js';

export function withTestLbugDB(
  prefix: string,
  run: (db: IndexedDBHandle) => void,
  options?: WithTestLbugDBOptions,
) {
  const db = createIndexedDbFixture(prefix, options);
  describe(prefix, () => {
    before(
      async () => {
        await db.setup();
        assert.ok(!db.ftsUnavailable(), 'Compiler conformance requires the FTS extension');
      },
      { timeout: options?.timeout ?? 120_000 },
    );
    after(db.cleanup, { timeout: 120_000 });
    run(db.handle);
  });
}
