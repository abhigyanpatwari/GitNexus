/**
 * Regression test for issue #2325 (http-route extractor half):
 * `RESOLVE_BY_NAME_QUERY` and `RESOLVE_IN_MODULE_QUERY` used the multi-label
 * disjunction `MATCH (n:Function|Method|CodeElement)` which LadybugDB rejects.
 * The surrounding try/catch swallowed the parser error, so cross-file handler
 * resolution silently returned null — and no test ran these query strings
 * against a real LadybugDB, which is why the bug shipped (#2275/#2277).
 *
 * These cases run the EXPORTED production query strings against a real
 * LadybugDB. The existing unit tests (test/unit/group/http-route-extractor.test.ts)
 * cover the resolution *logic* with a fake executor; these cover the query
 * *parsing + filtering* against the real parser.
 */
import { it, expect, afterEach } from 'vitest';
import {
  RESOLVE_BY_NAME_QUERY,
  RESOLVE_IN_MODULE_QUERY,
} from '../../../src/core/group/extractors/http-route-extractor.js';
import { initLbug, executeParameterized, closeLbug } from '../../../src/core/lbug/pool-adapter.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';

const SEED = [
  // BY_NAME: one real-file Function + a same-named File (label excluded) + a
  // same-named CodeElement with empty filePath (excluded by `n.filePath <> ''`).
  `CREATE (:Function {id:'fn:getOrders', name:'getOrders', filePath:'src/handlers/orders.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:File {id:'file:getOrders', name:'getOrders', filePath:'src/getOrders.ts'})`,
  `CREATE (:CodeElement {id:'ce:getOrders', name:'getOrders', filePath:''})`,
  // IN_MODULE: same name in two modules — only the prefixed one resolves.
  `CREATE (:Function {id:'fn:listUsers:handlers', name:'listUsers', filePath:'src/handlers/users.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Function {id:'fn:listUsers:admin', name:'listUsers', filePath:'src/admin/users.ts', startLine:1, endLine:9, content:'', description:''})`,
  // IN_MODULE label-allowlist decoy: same name, SAME module prefix, wrong label.
  // The STARTS-WITH prefix would match it, so only the `labels(n) IN [...]` filter
  // excludes it — drop the filter and this surfaces, flipping the row count.
  `CREATE (:File {id:'file:listUsers:handlers', name:'listUsers', filePath:'src/handlers/users.ts'})`,
  // LIMIT 2 cap: three same-named Functions — the uniqueness count must stay exact.
  `CREATE (:Function {id:'fn:dup:1', name:'dup', filePath:'src/a.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Function {id:'fn:dup:2', name:'dup', filePath:'src/b.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Function {id:'fn:dup:3', name:'dup', filePath:'src/c.ts', startLine:1, endLine:9, content:'', description:''})`,
];

withTestLbugDB(
  'issue-2325-http-route-resolveSymbol',
  (handle) => {
    afterEach(async () => {
      try {
        await closeLbug(handle.repoId);
      } catch {
        /* best-effort */
      }
    });

    it('RESOLVE_BY_NAME_QUERY resolves a handler by name, excluding a File and an empty-filePath node', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      const rows = await executeParameterized(handle.repoId, RESOLVE_BY_NAME_QUERY, {
        name: 'getOrders',
      });
      // File (wrong label) and the empty-filePath CodeElement are both excluded.
      expect(rows).toHaveLength(1);
      expect(rows[0].uid).toBe('fn:getOrders');
      expect(rows[0].filePath).toBe('src/handlers/orders.ts');
    });

    it('RESOLVE_IN_MODULE_QUERY resolves only the handler in the target module prefix', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      const rows = await executeParameterized(handle.repoId, RESOLVE_IN_MODULE_QUERY, {
        name: 'listUsers',
        fileDot: 'src/handlers/users.',
        fileSlash: 'src/handlers/users/',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].uid).toBe('fn:listUsers:handlers');
      expect(rows[0].filePath).toBe('src/handlers/users.ts');
    });

    it('RESOLVE_BY_NAME_QUERY caps materialization at 2 rows (uniqueness count stays exact)', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      const rows = await executeParameterized(handle.repoId, RESOLVE_BY_NAME_QUERY, {
        name: 'dup',
      });
      // Three matches exist; LIMIT 2 returns exactly two so the caller treats it
      // as ambiguous (>=2) without over-materializing.
      expect(rows).toHaveLength(2);
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
  },
);
