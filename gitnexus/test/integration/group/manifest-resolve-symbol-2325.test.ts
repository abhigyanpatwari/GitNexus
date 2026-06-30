/**
 * Regression test for issue #2325:
 * manifest-extractor `resolveSymbol` used a multi-label Cypher disjunction
 * (`MATCH (n:Function|Method|Class|...)`). LadybugDB's parser rejects such a
 * disjunction only when a label is a reserved keyword (`Macro` and `Union` both
 * are) or names a missing node table — so the `custom` branch (reserved
 * keywords in its 21-label list) and the `lib` branch (no `Package` table)
 * genuinely threw, silently falling back to a synthetic UID with empty
 * `filePath`; the other branches happened to parse. The fix uses
 * `MATCH (n) WHERE labels(n) IN [...]` uniformly — immune to both failure modes
 * (LadybugDB returns a node's single label as a string, so `IN [...]` is an
 * exact allowlist).
 *
 * These cases run the REAL production query (via `extractFromManifest`) against a
 * real LadybugDB — the only layer that can catch a parser rejection, since the
 * unit tests mock the executor. Each per-branch case seeds a wrong-label decoy
 * whose `filePath` sorts BEFORE the target so a widened/broken allowlist would
 * surface the decoy under `ORDER BY n.filePath ASC LIMIT 1` and flip the
 * assertion — making the exclusion check non-vacuous.
 */
import { it, expect, afterEach } from 'vitest';
import {
  ManifestExtractor,
  CUSTOM_CONTRACT_RESOLVE_QUERY,
} from '../../../src/core/group/extractors/manifest-extractor.js';
import type { GroupManifestLink } from '../../../src/core/group/types.js';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import { initLbug, executeParameterized, closeLbug } from '../../../src/core/lbug/pool-adapter.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';

// Targets + sort-first wrong-label decoys for each link-type branch.
const SEED = [
  // custom → Class; decoy File (not in allowlist) sorts first.
  `CREATE (:Class {id:'cls:MyServiceFacade', name:'MyServiceFacade', filePath:'src/main/java/com/example/MyServiceFacade.java', startLine:1, endLine:42, content:'', description:''})`,
  `CREATE (:File {id:'file:MyServiceFacade', name:'MyServiceFacade', filePath:'aaa/MyServiceFacade.java'})`,
  // grpc/thrift method → Method; decoy Class (not in [Function,Method]) sorts first.
  `CREATE (:Method {id:'mth:Login', name:'Login', filePath:'src/auth_grpc.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Class {id:'cls:Login', name:'Login', filePath:'aaa/Login.java', startLine:1, endLine:9, content:'', description:''})`,
  // grpc/thrift service → Class; decoy Function (not in [Class,Interface]) sorts first.
  `CREATE (:Class {id:'cls:AuthService', name:'AuthService', filePath:'src/auth_service.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Function {id:'fn:AuthService', name:'AuthService', filePath:'aaa/AuthService.go', startLine:1, endLine:9, content:'', description:''})`,
  // lib → Module (there is NO Package node table); decoy Function sorts first.
  `CREATE (:Module {id:'mod:mylib', name:'mylib', filePath:'src/index.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:Function {id:'fn:mylib', name:'mylib', filePath:'aaa/mylib.ts', startLine:1, endLine:9, content:'', description:''})`,
  // topic → Function; decoy File sorts first.
  `CREATE (:Function {id:'fn:orders.created', name:'orders.created', filePath:'src/consumer.ts', startLine:1, endLine:9, content:'', description:''})`,
  `CREATE (:File {id:'file:orders.created', name:'orders.created', filePath:'aaa/orders.created.ts'})`,
];

/** Custom-branch `custom` query as emitted BEFORE the fix — kept to document
 *  the real failure: its label list contains the reserved keywords `Macro` and
 *  `Union`, which make LadybugDB's parser reject the whole disjunction. */
const MULTI_LABEL_CUSTOM_QUERY = `MATCH (n:Function|Method|Class|Interface|Struct|Enum|Trait|Constructor|TypeAlias|Impl|Macro|Union|Typedef|Property|Record|Delegate|Annotation|Template|Const|Static|CodeElement)
 WHERE n.name = $symbolName
 RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
 ORDER BY n.filePath ASC
 LIMIT 1`;

// Direct-query canary for the `labels(n)`-is-a-string assumption the whole fix
// relies on. Uses the EXACT production query (imported, not hand-copied) so the
// canary can never silently drift from the real allowlist.

withTestLbugDB(
  'issue-2325-manifest-resolveSymbol',
  (handle) => {
    afterEach(async () => {
      try {
        await closeLbug(handle.repoId);
      } catch {
        /* best-effort */
      }
    });

    // role:'consumer' → providerRepo = link.to = 'repo-b' (the seeded DB); the
    // resolved symbol lands in crossLinks[0].to. consumerRepo ('repo-a') has no
    // executor, so to.symbolRef carries the provider-side resolution.
    const resolveVia = async (
      type: GroupManifestLink['type'],
      contract: string,
    ): Promise<{ symbolUid: string; filePath: string; name: string }> => {
      await initLbug(handle.repoId, handle.dbPath);
      const executor: CypherExecutor = (query, params) =>
        executeParameterized(handle.repoId, query, params ?? {});
      const extractor = new ManifestExtractor();
      const result = await extractor.extractFromManifest(
        [{ from: 'repo-a', to: 'repo-b', type, contract, role: 'consumer' }],
        new Map([['repo-b', executor]]),
      );
      expect(result.crossLinks).toHaveLength(1);
      const to = result.crossLinks[0].to;
      return {
        symbolUid: to.symbolUid,
        filePath: to.symbolRef.filePath,
        name: to.symbolRef.name,
      };
    };

    it('LadybugDB rejects the custom-branch disjunction (its list names reserved keywords Macro/Union)', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      // The genuine #2325 trigger for the custom branch: `Macro` and `Union` are
      // reserved keywords, so the parser rejects the whole `(n:…|Macro|…|Union|…)`
      // disjunction — which the resolver's try/catch then swallowed.
      await expect(
        executeParameterized(handle.repoId, MULTI_LABEL_CUSTOM_QUERY, {
          symbolName: 'MyServiceFacade',
        }),
      ).rejects.toThrow(/Parser exception|Invalid input|Prepare failed/i);
    });

    it('direct labels(n) IN query resolves the symbol (canary for labels()-is-a-string)', async () => {
      await initLbug(handle.repoId, handle.dbPath);
      const rows = await executeParameterized(handle.repoId, CUSTOM_CONTRACT_RESOLVE_QUERY, {
        symbolName: 'MyServiceFacade',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].uid).toBe('cls:MyServiceFacade');
      expect(rows[0].filePath).toBe('src/main/java/com/example/MyServiceFacade.java');
    });

    it('custom contract resolves the real Class symbol, excluding a same-named File (#2325)', async () => {
      const r = await resolveVia('custom', 'custom::MyServiceFacade');
      expect(r.symbolUid).toBe('cls:MyServiceFacade');
      expect(r.filePath).toBe('src/main/java/com/example/MyServiceFacade.java');
      expect(r.name).toBe('MyServiceFacade');
      // real resolution, not the synthetic fallback the bug produced
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });

    it('grpc method contract resolves a Method, excluding a same-named Class', async () => {
      const r = await resolveVia('grpc', 'AuthService/Login');
      expect(r.symbolUid).toBe('mth:Login');
      expect(r.filePath).toBe('src/auth_grpc.ts');
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });

    it('grpc service contract resolves a Class, excluding a same-named Function', async () => {
      const r = await resolveVia('grpc', 'AuthService');
      expect(r.symbolUid).toBe('cls:AuthService');
      expect(r.filePath).toBe('src/auth_service.ts');
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });

    it('thrift service contract strips the package prefix before resolving the Class', async () => {
      // The thrift-only branch strips `package.` from the service name
      // (`com.example.AuthService` -> `AuthService`). Without the strip the
      // lookup would query for `com.example.AuthService`, match nothing, and
      // fall back to a synthetic `manifest::` uid — so this resolving to the
      // real Class is the load-bearing assertion for the package-strip path.
      const r = await resolveVia('thrift', 'com.example.AuthService');
      expect(r.symbolUid).toBe('cls:AuthService');
      expect(r.filePath).toBe('src/auth_service.ts');
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });

    it('lib contract resolves a Module, excluding a same-named Function', async () => {
      const r = await resolveVia('lib', 'mylib');
      expect(r.symbolUid).toBe('mod:mylib');
      expect(r.filePath).toBe('src/index.ts');
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });

    it('topic contract resolves a Function, excluding a same-named File', async () => {
      const r = await resolveVia('topic', 'orders.created');
      expect(r.symbolUid).toBe('fn:orders.created');
      expect(r.filePath).toBe('src/consumer.ts');
      expect(r.symbolUid.startsWith('manifest::')).toBe(false);
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
  },
);
