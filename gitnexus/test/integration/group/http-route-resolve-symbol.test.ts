/**
 * Issue #2325 (http-route extractor half): `RESOLVE_BY_NAME_QUERY` and
 * `RESOLVE_IN_MODULE_QUERY` were converted from the `MATCH (n:A|B)` multi-label
 * disjunction to the `labels(n) IN [...]` allowlist form, for consistency with
 * the manifest custom-branch fix.
 *
 * IMPORTANT nuance (verified against the real parser): the actual #2325 failure
 * was triggered by *reserved-keyword* labels. LadybugDB's parser rejects a
 * disjunction that names a reserved keyword — `Macro` and `Union` both are — so
 * the manifest custom branch (whose 21-label list contains `Macro`/`Union`)
 * genuinely threw, and the resolver's try/catch swallowed it. The http-route
 * 3-label disjunction `(n:Function|Method|CodeElement)` contains no reserved
 * keyword and actually PARSES — so this half was a consistency conversion, not a
 * parser fix. The value of these cases is verifying the EXPORTED production
 * queries resolve and filter correctly against a real LadybugDB (the unit tests
 * cover the resolution *logic* with a fake executor; these cover *parsing +
 * filtering*). The last case pins the real reserved-keyword trigger so a future
 * query that reintroduces a `MATCH (n:…|Macro|…)` disjunction is caught.
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

    it('LadybugDB rejects a disjunction naming a reserved-keyword label (the real #2325 trigger)', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      // The genuine #2325 failure: a `MATCH (n:A|B)` disjunction whose label set
      // includes a reserved keyword (`Macro`/`Union`) is a parser error the
      // resolver's try/catch silently swallowed. The exported queries avoid this
      // by using the `labels(n) IN [...]` allowlist form. (The http-route
      // `Function|Method|CodeElement` form parses — this guards the real cause.)
      await expect(
        executeParameterized(
          handle.repoId,
          `MATCH (n:Function|Macro|Union) WHERE n.name = $name RETURN n.id AS uid LIMIT 2`,
          { name: 'getOrders' },
        ),
      ).rejects.toThrow(/Parser exception|Invalid input|Prepare failed/i);
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
  },
);
