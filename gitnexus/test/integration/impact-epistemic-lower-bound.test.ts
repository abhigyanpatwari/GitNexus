/**
 * Integration test: epistemic lower-bound flag (#1858)
 *
 * When a symbol sits behind an interface / indirection boundary, callers that
 * bind via a DI container or dynamic dispatch are not traced to the concrete
 * symbol — so impact()/context() report a *lower bound*, not an exact figure.
 * Instead of a silent confident zero, the result is annotated
 * `epistemic: 'lower-bound'` with a human-readable boundary note. A fully
 * resolved leaf with no indirection stays `epistemic: 'exact'`.
 *
 * Graph shape (the canonical Symfony/DI case from #1858 / the #1589 comment):
 *   SignupController --CALLS--> Logger (interface)
 *   EmailLogger --IMPLEMENTS--> Logger
 *   FileLogger  --IMPLEMENTS--> Logger
 * The controller binds to the *interface*; the concrete impl is wired by the
 * container, so impact("EmailLogger", upstream) finds no direct caller — but
 * must flag that the true blast radius is higher.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import {
  MAX_UNRESOLVED_RECEIVER_MEMBERS,
  summarizeUnresolvedReceivers,
} from '../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import type { ResolutionOutcome } from '../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
  loadMeta: vi.fn().mockResolvedValue({ scopeExtractionReceipt: 1 }),
}));

const SEED = [
  // Interface + two implementations + an interface-level consumer.
  `CREATE (iface:Interface {id: 'Interface:src/Logger.ts:Logger', name: 'Logger', filePath: 'src/Logger.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `CREATE (email:Class {id: 'Class:src/EmailLogger.ts:EmailLogger', name: 'EmailLogger', filePath: 'src/EmailLogger.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (file:Class {id: 'Class:src/FileLogger.ts:FileLogger', name: 'FileLogger', filePath: 'src/FileLogger.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (ctrl:Class {id: 'Class:src/SignupController.ts:SignupController', name: 'SignupController', filePath: 'src/SignupController.ts', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,

  `MATCH (a:Class {id:'Class:src/EmailLogger.ts:EmailLogger'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.85, reason:'implements', step:0}]->(b)`,
  `MATCH (a:Class {id:'Class:src/FileLogger.ts:FileLogger'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.85, reason:'implements', step:0}]->(b)`,
  `MATCH (a:Class {id:'Class:src/SignupController.ts:SignupController'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'interface-call', step:0}]->(b)`,

  // A fully-resolved leaf with no indirection — must stay `exact`.
  `CREATE (leaf:Function {id: 'Function:src/util.ts:formatDate', name: 'formatDate', filePath: 'src/util.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (caller:Function {id: 'Function:src/page.ts:renderHeader', name: 'renderHeader', filePath: 'src/page.ts', startLine: 1, endLine: 10, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/page.ts:renderHeader'}), (b:Function {id:'Function:src/util.ts:formatDate'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  ...['noKnownCallers', 'constructor', 'toString', '__proto__'].map(
    (name) =>
      `CREATE (:Function {id: 'Function:src/util.ts:${name}', name: '${name}', filePath: 'src/util.ts', startLine: 5, endLine: 7, isExported: true, content: '', description: ''})`,
  ),

  ...[
    ['listOrders', 'query'],
    ['createOrder', 'mutation'],
    ['syncOrders', 'action'],
    ['readInternal', 'internalQuery'],
    ['writeInternal', 'internalMutation'],
    ['runInternal', 'internalAction'],
  ].map(
    ([name, factory]) =>
      `CREATE (:Const {id: 'Const:src/convex.ts:${name}', name: '${name}', filePath: 'src/convex.ts', startLine: 1, endLine: 3, content: '', description: '', convexEndpointFactory: '${factory}'})`,
  ),
  `CREATE (:Const {id: 'Const:src/negative.ts:localQuery', name: 'localQuery', filePath: 'src/negative.ts', startLine: 1, endLine: 1, content: '', description: '', convexEndpointFactory: ''})`,
  `CREATE (:Const {id: 'Const:src/negative.ts:nestedQuery', name: 'nestedQuery', filePath: 'src/negative.ts', startLine: 2, endLine: 2, content: '', description: '', convexEndpointFactory: ''})`,
  `CREATE (:Const {id: 'Const:src/negative.ts:memberQuery', name: 'memberQuery', filePath: 'src/negative.ts', startLine: 3, endLine: 3, content: '', description: '', convexEndpointFactory: ''})`,
];

withTestLbugDB(
  'impact-epistemic-lower-bound',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });
    beforeEach(() => {
      // One query can read metadata for both freshness and epistemic boundaries.
      // Keep each fixture snapshot stable for every read in that test.
      vi.mocked(loadMeta).mockResolvedValue({
        scopeExtractionReceipt: 1,
      } as Awaited<ReturnType<typeof loadMeta>>);
    });

    it('flags impact() on a concrete impl behind an interface as lower-bound', async () => {
      const result = await backend.callTool('impact', {
        target: 'EmailLogger',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('lower-bound');
      expect(Array.isArray(result.boundaries)).toBe(true);
      expect(result.boundaries.join(' ')).toContain('Logger');
    });

    it('publishes causes.dispatchBoundary as untraced SYMBOLS, not the note count', async () => {
      const result = await backend.callTool('impact', {
        target: 'EmailLogger',
        direction: 'upstream',
      });
      // One boundary node (Logger) produces exactly one note, so publishing
      // `boundaries.length` here would print `1` — the number of SENTENCES —
      // next to a `receiverTyping` that counts call sites, and a consumer
      // branching on the two would read the smaller cause as the dominant one.
      // The magnitude behind this boundary is 2 implementations (EmailLogger,
      // FileLogger) + 1 interface-level consumer (SignupController) = 3.
      expect(result.boundaries).toHaveLength(1);
      expect(result.causes).toMatchObject({
        receiverTyping: 0,
        dispatchBoundary: 3,
        externalBoundary: 0,
      });
    });

    it('flags impact() on the interface itself as lower-bound', async () => {
      const result = await backend.callTool('impact', {
        target: 'Logger',
        direction: 'upstream',
      });
      expect(result.epistemic).toBe('lower-bound');
    });

    it('keeps a fully-resolved leaf exact (no false boundary)', async () => {
      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });
      expect(result.epistemic).toBe('exact');
      expect(result.boundaries).toBeUndefined();
      // The real caller is still reported — the flag is additive, not lossy.
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
    });

    describe.each(['impact', 'context'] as const)('%s() receiver summary', (tool) => {
      const query = (name: string) =>
        backend.callTool(
          tool,
          tool === 'impact'
            ? { target: name, file_path: 'src/util.ts', direction: 'upstream' }
            : { name, file_path: 'src/util.ts' },
        );

      it.each([
        ['noKnownCallers', 0],
        ['formatDate', 1],
      ] as const)('hedges an omitted %s with %i known callers', async (name, callers) => {
        vi.mocked(loadMeta).mockResolvedValue({
          repoPath: '',
          lastCommit: '',
          indexedAt: '',
          scopeExtractionReceipt: 1,
          unresolvedReceiverMembers: {
            counts: { anotherMember: 3 },
            totalSites: 10,
            omittedNames: 2,
          },
        } as Awaited<ReturnType<typeof loadMeta>>);

        const result = await query(name);

        expect(result).not.toHaveProperty('error');
        expect(result.epistemic).toBe('lower-bound');
        expect(result.boundaries.join(' ')).toContain('truncated');
        expect(result.boundaries.join(' ')).toContain(`\`${name}\``);
        expect(result.boundaries.join(' ')).toContain('dropped-call count');
        expect(result.boundaries.join(' ')).toContain('cannot be determined');
        expect(result.causes).toMatchObject({ receiverTyping: 0, externalBoundary: 0 });
        if (tool === 'impact') {
          expect(result.impactedCount).toBe(callers);
        } else {
          expect(result.status).toBe('found');
          expect(result.incoming.calls?.length ?? 0).toBe(callers);
        }
      });

      it('keeps actual retained call-site counts when other names were omitted', async () => {
        vi.mocked(loadMeta).mockResolvedValue({
          repoPath: '',
          lastCommit: '',
          indexedAt: '',
          scopeExtractionReceipt: 1,
          unresolvedReceiverMembers: {
            counts: { formatDate: 3 },
            totalSites: 10,
            omittedNames: 2,
            externalCounts: { formatDate: 4 },
            externalSites: 4,
          },
        } as Awaited<ReturnType<typeof loadMeta>>);

        const result = await query('formatDate');

        expect(result.epistemic).toBe('lower-bound');
        expect(result.causes).toMatchObject({ receiverTyping: 3, externalBoundary: 4 });
        expect(result.boundaries).toHaveLength(1);
        expect(result.boundaries[0]).toContain('3 call sites invoking `formatDate` were dropped');
        expect(result.boundaries[0]).not.toContain('truncated');
      });

      it.each([
        ['uncapped', { counts: { anotherMember: 1 }, totalSites: 1 }],
        [
          'external-only capped',
          {
            counts: {},
            totalSites: 0,
            externalCounts: { formatDate: 4 },
            externalSites: 10,
            externalOmittedNames: 2,
          },
        ],
      ])('leaves an absent name exact with an %s summary', async (_label, summary) => {
        vi.mocked(loadMeta).mockResolvedValue({
          repoPath: '',
          lastCommit: '',
          indexedAt: '',
          scopeExtractionReceipt: 1,
          unresolvedReceiverMembers: summary,
        } as Awaited<ReturnType<typeof loadMeta>>);

        const result = await query('formatDate');

        expect(result.epistemic).toBe('exact');
        expect(result.boundaries).toBeUndefined();
        expect(result.causes?.receiverTyping ?? 0).toBe(0);
        expect(result.causes?.externalBoundary ?? 0).toBe(
          'externalCounts' in summary ? summary.externalCounts.formatDate : 0,
        );
      });

      it.each(['in-program', 'external'] as const)(
        'consumes a persisted summary actually capped after 501 %s names',
        async (receiverOrigin) => {
          const outcomes: ResolutionOutcome[] = [
            ...Array.from({ length: MAX_UNRESOLVED_RECEIVER_MEMBERS }, (_, i) => `aaa_member${i}`),
            'noKnownCallers',
          ].map((name, i) => ({
            kind: 'suppressed',
            reason: 'receiver-unresolved',
            candidateIds: [],
            phase: 'receiver-bound-calls',
            filePath: 'src/caller.py',
            name,
            range: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: 30 },
            siteKind: 'call',
            receiverOrigin,
          }));
          const summary = JSON.parse(JSON.stringify(summarizeUnresolvedReceivers(outcomes)));
          const external = receiverOrigin === 'external';
          expect(Object.keys(external ? summary.externalCounts : summary.counts)).toHaveLength(
            MAX_UNRESOLVED_RECEIVER_MEMBERS,
          );
          expect(external ? summary.externalSites : summary.totalSites).toBe(501);
          expect(external ? summary.externalOmittedNames : summary.omittedNames).toBe(1);
          expect(external ? summary.externalCounts : summary.counts).not.toHaveProperty(
            'noKnownCallers',
          );
          vi.mocked(loadMeta).mockResolvedValue({
            scopeExtractionReceipt: 1,
            unresolvedReceiverMembers: summary,
          } as Awaited<ReturnType<typeof loadMeta>>);

          const result = await query('noKnownCallers');

          expect(result.epistemic).toBe(external ? 'exact' : 'lower-bound');
          expect(result.causes?.receiverTyping ?? 0).toBe(0);
          expect(result.causes?.externalBoundary ?? 0).toBe(0);
          if (external) expect(result.boundaries).toBeUndefined();
          else expect(result.boundaries.join(' ')).toContain('truncated');
        },
      );

      it.each([undefined, null, 0, -1, NaN, Infinity, 1.5, '2', '<invalid>', {}, true])(
        'does not infer truncation from malformed or nonpositive omittedNames=%j',
        async (omittedNames) => {
          vi.mocked(loadMeta).mockResolvedValue({
            scopeExtractionReceipt: 1,
            unresolvedReceiverMembers: { counts: {}, totalSites: 0, omittedNames },
          } as Awaited<ReturnType<typeof loadMeta>>);

          const result = await query('formatDate');

          expect(result.epistemic).toBe('exact');
          expect(result.boundaries).toBeUndefined();
          expect(result.causes).toBeUndefined();
        },
      );

      it.each(['constructor', 'toString', '__proto__'])(
        'never invents a count for omitted prototype-like member %s',
        async (name) => {
          vi.mocked(loadMeta).mockResolvedValue({
            scopeExtractionReceipt: 1,
            unresolvedReceiverMembers: { counts: {}, totalSites: 3, omittedNames: 2 },
          } as Awaited<ReturnType<typeof loadMeta>>);

          const result = await query(name);

          expect(result.epistemic).toBe('lower-bound');
          expect(result.causes).toMatchObject({ receiverTyping: 0, externalBoundary: 0 });
          expect(result.boundaries.join(' ')).toContain('truncated');
          expect(result.boundaries.join(' ')).not.toMatch(/native code|NaN|undefined|\[object/);
        },
      );

      it.each(['constructor', 'toString', '__proto__'])(
        'preserves a genuinely recorded prototype-like member %s',
        async (name) => {
          vi.mocked(loadMeta).mockResolvedValue({
            scopeExtractionReceipt: 1,
            unresolvedReceiverMembers: JSON.parse(
              JSON.stringify({ counts: { [name]: 3 }, totalSites: 5, omittedNames: 2 }),
            ),
          } as Awaited<ReturnType<typeof loadMeta>>);

          const result = await query(name);

          expect(result.epistemic).toBe('lower-bound');
          expect(result.causes.receiverTyping).toBe(3);
          expect(result.boundaries.join(' ')).toContain(`3 call sites invoking \`${name}\``);
          expect(result.boundaries.join(' ')).not.toContain('truncated');
        },
      );
    });

    it('marks impact as a lower bound when scope extraction omitted files', async () => {
      vi.mocked(loadMeta).mockResolvedValue({
        repoPath: '/test/repo',
        lastCommit: 'abc123',
        indexedAt: new Date().toISOString(),
        scopeExtractionReceipt: 1,
        scopeExtractionFailures: {
          total: 2,
          paths: ['src/broken-a.ts', 'src/broken-b.ts'],
        },
      });

      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain('Scope extraction failed for 2 files');
      expect(result.causes).toMatchObject({ scopeExtractionFiles: 2 });
    });

    it('never renders repository-controlled failure paths in boundary prose', async () => {
      vi.mocked(loadMeta).mockResolvedValue({
        repoPath: '/test/repo',
        lastCommit: 'abc123',
        indexedAt: new Date().toISOString(),
        scopeExtractionReceipt: 1,
        scopeExtractionFailures: {
          total: 1,
          paths: ['src/`break`\n\u001b[31m\u202e\u200binject.ts'],
        },
      });

      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });
      const prose = result.boundaries.join(' ');

      expect(prose).toContain('Scope extraction failed for 1 file');
      expect(prose).not.toMatch(/[\n\u001b\u202e\u200b`]/u);
      expect(result.causes).toMatchObject({ scopeExtractionFiles: 1 });
    });

    it.each([
      ['missing receipt', {}],
      ['missing metadata', null],
      ['malformed summary', { scopeExtractionReceipt: 1, scopeExtractionFailures: 'invalid' }],
    ])('treats %s as an unknown lower bound', async (_label, metadata) => {
      vi.mocked(loadMeta).mockResolvedValue(metadata as Awaited<ReturnType<typeof loadMeta>>);

      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain(
        'Scope-extraction completeness was not recorded',
      );
      expect(result.causes).toMatchObject({ scopeExtractionFiles: 0 });
    });

    it('treats a metadata read failure as an unknown lower bound', async () => {
      vi.mocked(loadMeta).mockRejectedValue(new Error('metadata unavailable'));

      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain(
        'Scope-extraction completeness was not recorded',
      );
    });

    it.each([
      ['listOrders', 'query'],
      ['createOrder', 'mutation'],
      ['syncOrders', 'action'],
      ['readInternal', 'internalQuery'],
      ['writeInternal', 'internalMutation'],
      ['runInternal', 'internalAction'],
    ])('marks Convex %s/%s runtime dispatch as a lower bound', async (target, factory) => {
      const result = await backend.callTool('impact', {
        target,
        file_path: 'src/convex.ts',
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain(`Convex ${factory}`);
      expect(result.boundaries.join(' ')).toContain('anyApi');
      expect(result.causes.dispatchBoundary).toBe(0);
    });

    it.each(['localQuery', 'nestedQuery', 'memberQuery'])(
      'keeps non-wrapper control %s exact',
      async (target) => {
        const result = await backend.callTool('impact', {
          target,
          file_path: 'src/negative.ts',
          direction: 'upstream',
        });

        expect(result.epistemic).toBe('exact');
        expect(result.boundaries).toBeUndefined();
      },
    );

    it('context() carries the same epistemic signal', async () => {
      const result = await backend.callTool('context', {
        name: 'EmailLogger',
        file_path: 'src/EmailLogger.ts',
      });
      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
    });

    it('context() reports persisted scope extraction omissions as a lower bound', async () => {
      vi.mocked(loadMeta).mockResolvedValue({
        repoPath: '/test/repo',
        lastCommit: 'abc123',
        indexedAt: new Date().toISOString(),
        scopeExtractionReceipt: 1,
        scopeExtractionFailures: {
          total: 2,
          paths: ['src/broken-a.ts', 'src/broken-b.ts'],
        },
      });

      const result = await backend.callTool('context', {
        name: 'formatDate',
        file_path: 'src/util.ts',
      });

      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain('Scope extraction failed for 2 files');
      expect(result.causes).toMatchObject({ scopeExtractionFiles: 2 });
    });

    it('context() on a leaf interface itself is lower-bound (#1858 review F3)', async () => {
      // Logger is a leaf interface — it implements/extends nothing, so the only
      // boundary signal is computeEpistemicBoundary's symType==='Interface'
      // self-branch. Before the F3 fix, context() collapsed symKind to 'Class'
      // and this returned 'exact'.
      const result = await backend.callTool('context', { name: 'Logger' });
      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 6, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
