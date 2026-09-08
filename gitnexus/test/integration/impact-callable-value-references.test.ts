/**
 * Integration test: a callable named in VALUE position makes `impact` a lower
 * bound (#3399).
 *
 * The rejected behaviour, in one sentence: `Element.getNamespaceUri` — the DOM
 * `Element.namespaceURI` accessor — is bound into a JS bridge table as
 * `bridge.accessor(Element.getNamespaceUri, null, .{})`, and `impact` answered
 * "2 callers, LOW risk, epistemic: exact". Everything about that answer except
 * the number 2 was wrong, and `exact` is the part that made it unusable: it
 * tells the reader not to look further.
 *
 * The seed below is the shape that matters, not the language. A registration
 * edge (`USES`, reason `scope-resolution: value-ref`) says a function was
 * handed somewhere as a value. Where the value goes next — a struct field, a
 * registry lookup, comptime reflection — is not modelled, so no CALLS edge
 * connects the eventual invocation back to the target. `tools.ts` defines
 * `lower-bound` as "the walk provably missed callers", and that is exactly this
 * situation.
 *
 * WHY the assertions are what they are:
 *   - `impactedCount` must NOT move. Hedging is not inventing callers; a fix
 *     that made the number go up would be a different (and unearned) claim.
 *   - a plain CALLS-only target in the SAME index must stay `exact`, or the
 *     hedge is noise sprayed over every query and carries no information.
 *   - the cause has its own slot rather than being folded into
 *     `dispatchBoundary`: an agent branching on the numbers would otherwise be
 *     told an interface boundary exists where there is none, and would draw the
 *     opposite conclusion about whether the gap is reducible.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { VALUE_REF_EDGE_REASON } from '../../src/core/ingestion/scope-resolution/value-ref-edges.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});
const { listRegisteredRepos, saveMeta } = await import('../../src/storage/repo-manager.js');

const SEED = [
  // The registered accessor, with one ordinary in-file caller so the walk has
  // something real to report. This mirrors Element.zig: `getNamespaceUri` genuinely
  // has internal callers, and it is the REGISTRATION that the answer omits.
  `CREATE (:Method {id: 'Method:webapi/Element.zig:Element.getNamespaceUri', name: 'getNamespaceUri', filePath: 'webapi/Element.zig', startLine: 439, endLine: 442, isExported: true, content: '', description: ''})`,
  `CREATE (:Method {id: 'Method:webapi/Element.zig:Element.lookupPrefixForElement', name: 'lookupPrefixForElement', filePath: 'webapi/Element.zig', startLine: 490, endLine: 520, isExported: true, content: '', description: ''})`,
  `MATCH (a:Method {id:'Method:webapi/Element.zig:Element.lookupPrefixForElement'}), (b:Method {id:'Method:webapi/Element.zig:Element.getNamespaceUri'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'scope-resolution: local-call', step:0}]->(b)`,

  // The binding table entry: `pub const namespaceURI = bridge.accessor(Element.getNamespaceUri, null, .{});`
  // A registration, NOT an invocation — hence USES, not CALLS (Kythe `ref` vs
  // `ref/call`; Joern METHOD_REF).
  `CREATE (:Struct {id: 'Struct:webapi/Element.zig:Element.JsApi', name: 'JsApi', filePath: 'webapi/Element.zig', startLine: 2281, endLine: 2400, content: '', description: ''})`,
  `MATCH (a:Struct {id:'Struct:webapi/Element.zig:Element.JsApi'}), (b:Method {id:'Method:webapi/Element.zig:Element.getNamespaceUri'}) CREATE (a)-[:CodeRelation {type:'USES', confidence:0.85, reason:'${VALUE_REF_EDGE_REASON}', step:0}]->(b)`,

  // Control: same file, same shape of caller, but nothing registers it as a
  // value. This is `getTagNameLower` — it must come back `exact`.
  `CREATE (:Method {id: 'Method:webapi/Element.zig:Element.getTagNameLower', name: 'getTagNameLower', filePath: 'webapi/Element.zig', startLine: 400, endLine: 410, isExported: true, content: '', description: ''})`,
  `MATCH (a:Method {id:'Method:webapi/Element.zig:Element.lookupPrefixForElement'}), (b:Method {id:'Method:webapi/Element.zig:Element.getTagNameLower'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'scope-resolution: local-call', step:0}]->(b)`,

  // Second control: an ordinary USES edge that is NOT a value registration (a
  // type reference). The probe keys on the reason, so this must not hedge —
  // otherwise every type mention in the repo would downgrade its target.
  `CREATE (:Method {id: 'Method:webapi/Element.zig:Element.getInnerText', name: 'getInnerText', filePath: 'webapi/Element.zig', startLine: 600, endLine: 610, isExported: true, content: '', description: ''})`,
  `MATCH (a:Struct {id:'Struct:webapi/Element.zig:Element.JsApi'}), (b:Method {id:'Method:webapi/Element.zig:Element.getInnerText'}) CREATE (a)-[:CodeRelation {type:'USES', confidence:0.85, reason:'scope-resolution: type-reference', step:0}]->(b)`,
];

withTestLbugDB(
  'impact-callable-value-references',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('downgrades a registered accessor to lower-bound without inventing callers', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'getNamespaceUri',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      // The registration is a real inbound edge, so it IS traversed and counted
      // — but the call THROUGH the registered value is not, which is why the
      // count still cannot be the whole story.
      expect(result.epistemic).toBe('lower-bound');
      expect(result.causes.callableValueReferences).toBe(1);
      // Its own slot: an agent must not read this as an interface boundary.
      expect(result.causes.dispatchBoundary).toBe(0);
      expect(result.boundaries.join(' ')).toContain('as a VALUE');
    });

    it('leaves a symbol with only ordinary calls exact', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'getTagNameLower',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('exact');
    });

    it('does not hedge on a USES edge that is not a value registration', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'getInnerText',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      // A type reference is a use, not an escape: nothing can be invoked
      // through it, so the answer stays complete.
      expect(result.epistemic).toBe('exact');
    });

    it('hedges context() for the same reason it hedges impact()', async () => {
      const result: any = await backend.callTool('context', { name: 'getNamespaceUri' });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('lower-bound');
      expect(result.causes.callableValueReferences).toBe(1);
    });

    it('stays exact downstream — a reference INTO a symbol says nothing about what it reaches', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'getNamespaceUri',
        direction: 'downstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('exact');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (h) => {
      // Without a completeness receipt EVERY answer is hedged ("scope-extraction
      // completeness was not recorded"), which would make the controls below
      // pass for the wrong reason and prove nothing about this probe.
      // `saveMeta` is the only writer production uses.
      await saveMeta(path.dirname(h.dbPath), { scopeExtractionReceipt: 1 } as any);
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: h.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 5, communities: 0, processes: 0 },
        },
      ] as any);
      const backend = new LocalBackend();
      await backend.init();
      (h as any)._backend = backend;
    },
  },
);
