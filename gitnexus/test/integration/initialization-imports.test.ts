import { expect, it } from 'vitest';
import { readInitializationImports } from '../../src/core/lbug/initialization-imports.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// Use persisted spellings, including the pre-module-hub visibility edge and
// imports from indexes that predate reason metadata.
const reasons = [
  'swift-scope: implicit module visibility',
  'dart-scope: package identity dependency',
  'markdown-link',
  'custom import (deferred)',
  'custom import (type-only)',
  null,
  'custom import',
];
const seed = [
  "CREATE (:File {id:'caller', name:'caller', filePath:'caller'})",
  ...reasons.flatMap((reason, index) => [
    `CREATE (:File {id:'f${index}', name:'f${index}', filePath:'f${index}'})`,
    `MATCH (a:File {id:'caller'}), (b:File {id:'f${index}'})
     CREATE (a)-[:CodeRelation {type:'IMPORTS', reason:${reason === null ? 'NULL' : `'${reason}'`}}]->(b)`,
  ]),
];

withTestLbugDB(
  'initialization-imports',
  (handle) => {
    it('excludes metadata, deferred and erased edges before applying the cycle scan limit', async () => {
      const rows = await readInitializationImports(handle.repoId, 3);
      expect(rows.map((row) => row.target).sort()).toEqual(['f5', 'f6']);
      expect(rows.every((row) => row.source === 'caller')).toBe(true);
    });
  },
  { poolAdapter: true, seed },
);
