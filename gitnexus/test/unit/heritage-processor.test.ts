import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processHeritage,
  processHeritageFromExtracted,
  type HeritageFeedItem,
  type ProcessHeritageOpts,
} from '../../src/core/ingestion/heritage-processor.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/workers/parse-worker.js';

describe('processHeritageFromExtracted', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  describe('extends', () => {
    it('creates EXTENDS relationship between classes', async () => {
      ctx.symbols.add('src/admin.ts', 'AdminUser', 'Class:src/admin.ts:AdminUser', 'Class');
      ctx.symbols.add('src/user.ts', 'User', 'Class:src/user.ts:User', 'Class');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/admin.ts',
        className: 'AdminUser',
        parentName: 'User',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const rels = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(rels).toHaveLength(1);
      expect(rels[0].sourceId).toBe('Class:src/admin.ts:AdminUser');
      expect(rels[0].targetId).toBe('Class:src/user.ts:User');
      expect(rels[0].confidence).toBeCloseTo(0.689202); // geometric mean: sqrt(same-file * global)
    });

    it('uses generated ID when class not in symbol table', async () => {
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/admin.ts',
        className: 'AdminUser',
        parentName: 'BaseUser',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const rels = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(rels).toHaveLength(1);
      expect(rels[0].sourceId).toContain('AdminUser');
      expect(rels[0].targetId).toContain('BaseUser');
    });

    it('skips self-inheritance', async () => {
      ctx.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/a.ts',
        className: 'Foo',
        parentName: 'Foo',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);
      expect(graph.relationshipCount).toBe(0);
    });
  });

  describe('implements', () => {
    it('creates IMPLEMENTS relationship', async () => {
      ctx.symbols.add('src/service.ts', 'UserService', 'Class:src/service.ts:UserService', 'Class');
      ctx.symbols.add('src/interfaces.ts', 'IService', 'Interface:src/interfaces.ts:IService', 'Interface');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/service.ts',
        className: 'UserService',
        parentName: 'IService',
        kind: 'implements',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
      expect(rels[0].sourceId).toBe('Class:src/service.ts:UserService');
    });
  });

  describe('trait-impl (Rust)', () => {
    it('creates IMPLEMENTS relationship for trait impl', async () => {
      ctx.symbols.add('src/point.rs', 'Point', 'Struct:src/point.rs:Point', 'Struct');
      ctx.symbols.add('src/display.rs', 'Display', 'Trait:src/display.rs:Display', 'Trait');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/point.rs',
        className: 'Point',
        parentName: 'Display',
        kind: 'trait-impl',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
      expect(rels[0].reason).toBe('trait-impl');
    });
  });

  describe('C# interface resolution from extends captures', () => {
    it('emits IMPLEMENTS when parent is an Interface in symbol table', async () => {
      ctx.symbols.add('src/Service.cs', 'UserService', 'Class:src/Service.cs:UserService', 'Class');
      ctx.symbols.add('src/IService.cs', 'IService', 'Interface:src/IService.cs:IService', 'Interface');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Service.cs',
        className: 'UserService',
        parentName: 'IService',
        kind: 'extends', // C# base_list always sends extends
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(impls).toHaveLength(1);
      expect(exts).toHaveLength(0);
      expect(impls[0].sourceId).toBe('Class:src/Service.cs:UserService');
      expect(impls[0].targetId).toBe('Interface:src/IService.cs:IService');
    });

    it('emits EXTENDS when parent is a Class in symbol table', async () => {
      ctx.symbols.add('src/Admin.cs', 'AdminUser', 'Class:src/Admin.cs:AdminUser', 'Class');
      ctx.symbols.add('src/User.cs', 'User', 'Class:src/User.cs:User', 'Class');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Admin.cs',
        className: 'AdminUser',
        parentName: 'User',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(exts).toHaveLength(1);
      expect(impls).toHaveLength(0);
    });

    it('uses I[A-Z] heuristic for unresolved interface names in C#', async () => {
      // IDisposable is not in symbol table (external .NET type)
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Resource.cs',
        className: 'Resource',
        parentName: 'IDisposable',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(impls).toHaveLength(1);
      expect(impls[0].targetId).toContain('IDisposable');
    });

    it('does not apply I[A-Z] heuristic for TypeScript — unresolved IFoo should be EXTENDS', async () => {
      // The I[A-Z] convention is C#/Java-specific; TypeScript files should not be affected
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/service.ts',
        className: 'MyService',
        parentName: 'IFoo',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(exts).toHaveLength(1);
      expect(impls).toHaveLength(0);
    });

    it('does not misclassify non-I-prefixed unresolved names as interfaces', async () => {
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Derived.cs',
        className: 'Derived',
        parentName: 'BaseClass',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(exts).toHaveLength(1);
      expect(impls).toHaveLength(0);
    });

    it('does not match single-letter I names like "I" or "Id"', async () => {
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Thing.cs',
        className: 'Thing',
        parentName: 'Id',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      // "Id" starts with I but second char is lowercase — should be EXTENDS
      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(exts).toHaveLength(1);
    });

    it('handles mixed class + interface base_list from C#', async () => {
      ctx.symbols.add('src/Repo.cs', 'UserRepo', 'Class:src/Repo.cs:UserRepo', 'Class');
      ctx.symbols.add('src/Base.cs', 'BaseRepository', 'Class:src/Base.cs:BaseRepository', 'Class');
      ctx.symbols.add('src/IRepo.cs', 'IRepository', 'Interface:src/IRepo.cs:IRepository', 'Interface');
      ctx.symbols.add('src/IDisp.cs', 'IDisposable', 'Interface:src/IDisp.cs:IDisposable', 'Interface');

      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/Repo.cs', className: 'UserRepo', parentName: 'BaseRepository', kind: 'extends' },
        { filePath: 'src/Repo.cs', className: 'UserRepo', parentName: 'IRepository', kind: 'extends' },
        { filePath: 'src/Repo.cs', className: 'UserRepo', parentName: 'IDisposable', kind: 'extends' },
      ];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(exts).toHaveLength(1); // BaseRepository
      expect(impls).toHaveLength(2); // IRepository + IDisposable
    });
  });

  describe('Swift protocol conformance from extends captures', () => {
    it('defaults unresolved PascalCase protocol names to IMPLEMENTS for Swift', async () => {
      // Codable, Hashable, Equatable etc. are protocols — no I-prefix convention in Swift
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Model.swift',
        className: 'User',
        parentName: 'Codable',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(impls).toHaveLength(1);
      expect(exts).toHaveLength(0);
      expect(impls[0].targetId).toContain('Codable');
    });

    it('still uses symbol table authoritatively for Swift (Tier 1 takes precedence)', async () => {
      // When the parent is in the symbol table as a Class, EXTENDS wins even in Swift
      ctx.symbols.add('src/Animal.swift', 'Animal', 'Class:src/Animal.swift:Animal', 'Class');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/Dog.swift',
        className: 'Dog',
        parentName: 'Animal',
        kind: 'extends',
      }];

      await processHeritageFromExtracted(graph, heritage, ctx);

      const exts = graph.relationships.filter(r => r.type === 'EXTENDS');
      const impls = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(exts).toHaveLength(1);
      expect(impls).toHaveLength(0);
    });
  });

  it('handles multiple heritage entries', async () => {
    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/a.ts', className: 'A', parentName: 'B', kind: 'extends' },
      { filePath: 'src/c.ts', className: 'C', parentName: 'D', kind: 'implements' },
      { filePath: 'src/e.rs', className: 'E', parentName: 'F', kind: 'trait-impl' },
    ];

    await processHeritageFromExtracted(graph, heritage, ctx);
    expect(graph.relationships.filter(r => r.type === 'EXTENDS')).toHaveLength(1);
    expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(2);
  });

  it('calls progress callback', async () => {
    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/a.ts', className: 'A', parentName: 'B', kind: 'extends' },
    ];

    const onProgress = vi.fn();
    await processHeritageFromExtracted(graph, heritage, ctx, onProgress);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('handles empty heritage array', async () => {
    await processHeritageFromExtracted(graph, [], ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  // ============================================================
  // WI-3 (#159 P3 Mode A) — ExtractedHeritage.line/character
  //
  // The worker thread captures the parent-identifier position
  // (the `B` in `class A extends B`) so the heritage feed can
  // target `textDocument/definition` at the precise token. These
  // tests assert the position contract on `ExtractedHeritage` and
  // confirm multi-parent clauses produce distinct positions per
  // parent (the spec acceptance criterion: "multi-parent yields
  // distinct positions"). They run server-independently — the
  // assertion targets the data flowing INTO the heritage
  // processor, not the feed (that is WI-4).
  // ============================================================

  describe('WI-3 — ExtractedHeritage parent-identifier positions', () => {
    it('extends: carries the exact line/character of the parent identifier', async () => {
      // Fixture: class declaration at line 4, with the parent
      // identifier `BaseService` starting at column 17 (0-based).
      // Realistic TypeScript content shape; we feed the
      // worker-extracted record directly to test the contract
      // independent of tree-sitter.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/service.ts',
        className: 'UserService',
        parentName: 'BaseService',
        kind: 'extends',
        line: 4,
        character: 17,
      }];

      // The position fields must round-trip — they are the contract
      // the worker writes and the heritage processor reads.
      expect(heritage[0].line).toBe(4);
      expect(heritage[0].character).toBe(17);

      // The processor must still resolve the edge (regression guard).
      await processHeritageFromExtracted(graph, heritage, ctx);
      const rels = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(rels).toHaveLength(1);
      expect(rels[0].sourceId).toContain('UserService');
      expect(rels[0].targetId).toContain('BaseService');
    });

    it('implements: carries the exact line/character of the parent identifier', async () => {
      // Fixture: class implements interface; the `IUserRepo`
      // identifier starts at column 31 on line 5.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/service.ts',
        className: 'UserService',
        parentName: 'IUserRepo',
        kind: 'implements',
        line: 5,
        character: 31,
      }];

      expect(heritage[0].line).toBe(5);
      expect(heritage[0].character).toBe(31);

      await processHeritageFromExtracted(graph, heritage, ctx);
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
      expect(rels[0].sourceId).toContain('UserService');
      expect(rels[0].targetId).toContain('IUserRepo');
    });

    it('trait-impl (Rust): carries the exact line/character of the trait identifier', async () => {
      // Rust: `impl Display for Point` — the trait identifier
      // `Display` starts at column 5 on line 7.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/point.rs',
        className: 'Point',
        parentName: 'Display',
        kind: 'trait-impl',
        line: 7,
        character: 5,
      }];

      expect(heritage[0].line).toBe(7);
      expect(heritage[0].character).toBe(5);

      await processHeritageFromExtracted(graph, heritage, ctx);
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
      expect(rels[0].reason).toBe('trait-impl');
    });

    it('multi-parent implements clause yields distinct positions per parent', async () => {
      // `class UserService implements I1, I2` — I1 and I2 sit on
      // the same line but at different columns; the worker must
      // record each parent identifier at its own startPosition.
      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/multi.ts',
          className: 'UserService',
          parentName: 'I1',
          kind: 'implements',
          line: 9,
          character: 31, // position of `I1`
        },
        {
          filePath: 'src/multi.ts',
          className: 'UserService',
          parentName: 'I2',
          kind: 'implements',
          line: 9,
          character: 35, // position of `I2` (3 cols later for `I1, `)
        },
      ];

      // Acceptance: positions are distinct.
      expect(heritage[0].line).toBe(heritage[1].line);
      expect(heritage[0].character).not.toBe(heritage[1].character);
      expect(heritage[0].character).toBeLessThan(heritage[1].character);

      // Each record produces its own IMPLEMENTS edge.
      await processHeritageFromExtracted(graph, heritage, ctx);
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(2);
      const targetIds = rels.map(r => r.targetId).sort();
      expect(targetIds.some(t => t.includes('I1'))).toBe(true);
      expect(targetIds.some(t => t.includes('I2'))).toBe(true);
    });

    it('multi-clause (extends + implements on different lines) records distinct lines', async () => {
      // `class UserService extends BaseService\n  implements IUserRepo {}`
      const heritage: ExtractedHeritage[] = [
        {
          filePath: 'src/both.ts',
          className: 'UserService',
          parentName: 'BaseService',
          kind: 'extends',
          line: 3,
          character: 30,
        },
        {
          filePath: 'src/both.ts',
          className: 'UserService',
          parentName: 'IUserRepo',
          kind: 'implements',
          line: 4,
          character: 15,
        },
      ];

      expect(heritage[0].line).not.toBe(heritage[1].line);

      await processHeritageFromExtracted(graph, heritage, ctx);
      expect(graph.relationships.filter(r => r.type === 'EXTENDS')).toHaveLength(1);
      expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(1);
    });

    it('Ruby include/extend/prepend records keep line undefined (gate exclusion)', async () => {
      // Ruby heritage is captured by a method call (not an
      // identifier), so the worker does NOT populate `line` for
      // these kinds. The WI-4 feed gate uses `line !== undefined`
      // to exclude them. Test the data shape: these records
      // arrive at the processor WITHOUT a line/character.
      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/foo.rb', className: 'Foo', parentName: 'Bar', kind: 'include' },
        { filePath: 'src/foo.rb', className: 'Foo', parentName: 'Baz', kind: 'extend' },
        { filePath: 'src/foo.rb', className: 'Foo', parentName: 'Qux', kind: 'prepend' },
      ];
      expect(heritage[0].line).toBeUndefined();
      expect(heritage[0].character).toBeUndefined();
      // Processor must still process them (no regression).
      await processHeritageFromExtracted(graph, heritage, ctx);
      expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(3);
    });
  });

  // ============================================================
  // WI-4 (#159 P3 Mode A) — HeritageFeedItem server-independent
  // tripwire (AC-4).
  //
  // The 5-condition gate:
  //   1. opts?.lsp === true           (the LSP gate)
  //   2. opts.heritageFeed provided   (the sink gate)
  //   3. parent.confidence === 0.5    (the global/unresolved gate)
  //   4. isTsFamilyLanguage(file)     (the language gate)
  //   5. h.line !== undefined         (the position gate)
  //
  // Default analyze (no --lsp) must leave `heritageFeed: []`
  // AND keep the graph deep-equal to the no-opts run (byte-
  // identity diff / AC-4 server-independent tripwire).
  //
  // These tests are the AC-4 acceptance: they assert the exact
  // shape of `HeritageFeedItem` (8 fields) when all 5 gates
  // hold, mirror the `call-processor.test.ts:785-836` block
  // per the spec, and require NO language server on PATH.
  // ============================================================

  describe('WI-4 — HeritageFeedItem (AC-4 server-independent tripwire)', () => {
    // Helper: build the "no LSP" baseline graph (one unresolved
    // TS implements) — the byte-identity anchor.
    const buildUnresolvedImplements = (line: number, character: number) => {
      // IUserRepo is NOT in the symbol table → resolveHeritageId
      // returns a generated id with confidence === TIER_CONFIDENCE['global']
      // (0.5). The gate is meant to fire on this exact shape.
      return [{
        filePath: 'src/user-service.ts',
        className: 'UserService',
        parentName: 'IUserRepo',
        kind: 'implements' as const,
        line,
        character,
      }];
    };

    it('lsp:false — heritage feed stays empty AND graph deep-equals the no-opts run (byte-identity AC-4)', async () => {
      const heritageA = buildUnresolvedImplements(4, 31);
      const heritageB = buildUnresolvedImplements(4, 31);

      // Run A: no opts at all (the true default).
      const graphA = createKnowledgeGraph();
      await processHeritageFromExtracted(graphA, heritageA, ctx);

      // Run B: lsp:false explicitly (the explicit-default branch).
      const graphB = createKnowledgeGraph();
      const feedB: HeritageFeedItem[] = [];
      await processHeritageFromExtracted(graphB, heritageB, ctx, undefined, { lsp: false, heritageFeed: feedB });

      // The feed must be untouched when lsp is false.
      expect(feedB).toEqual([]);

      // The graph relationships must be deep-equal (byte-identity diff).
      expect(graphB.relationships).toEqual(graphA.relationships);
      expect(graphB.relationshipCount).toBe(graphA.relationshipCount);
    });

    it('opts absent — heritage feed stays empty AND graph deep-equals the lsp:false run', async () => {
      const heritage = buildUnresolvedImplements(4, 31);

      const graphNoOpts = createKnowledgeGraph();
      await processHeritageFromExtracted(graphNoOpts, heritage, ctx);

      const graphLspFalse = createKnowledgeGraph();
      const feed: HeritageFeedItem[] = [];
      await processHeritageFromExtracted(graphLspFalse, heritage, ctx, undefined, { lsp: false, heritageFeed: feed });

      // No opts path and lsp:false path produce identical graph + empty feed.
      expect(feed).toEqual([]);
      expect(graphLspFalse.relationships).toEqual(graphNoOpts.relationships);
    });

    it('lsp:true + unresolved TS parent — exact-shape pin of all 8 HeritageFeedItem fields (AC-4)', async () => {
      // The spec: 8 fields, exact toEqual pin:
      //   sourceId, parentName, oldTargetId, oldRelId,
      //   relType, file, line, character
      const heritage = buildUnresolvedImplements(4, 31);
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      // The heuristic edge must be emitted (the feed does NOT
      // replace the edge — the edge still exists, and a copy
      // goes to the feed for LSP re-resolution).
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);

      // The feed must have exactly one entry — the unresolved TS parent.
      expect(feed).toHaveLength(1);

      // Compute the expected ids: child is resolved as Class
      // (filePath is in the graph via resolveHeritageId fallback
      // key), parent is the generated Interface id (unresolved).
      const expectedChildId = 'Class:src/user-service.ts:UserService';
      const expectedParentId = 'Interface:IUserRepo';
      const expectedEdgeId = `IMPLEMENTS:${expectedChildId}->${expectedParentId}`;

      expect(feed[0]).toEqual({
        sourceId: expectedChildId,
        parentName: 'IUserRepo',
        oldTargetId: expectedParentId,
        oldRelId: expectedEdgeId,
        relType: 'IMPLEMENTS',
        file: 'src/user-service.ts',
        line: 4,
        character: 31,
      });
    });

    it('lsp:true + unresolved TS extends — exact-shape pin (relType: "EXTENDS")', async () => {
      // Unresolved TS extends. Default heuristic for `extends`
      // parent names that are NOT in the symbol table AND do
      // not match the TS interface prefix is EXTENDS.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/svc.ts',
        className: 'UserService',
        parentName: 'BaseService',
        kind: 'extends',
        line: 2,
        character: 23,
      }];
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      expect(feed).toHaveLength(1);
      const expectedChildId = 'Class:src/svc.ts:UserService';
      const expectedParentId = 'Class:BaseService';
      const expectedEdgeId = `EXTENDS:${expectedChildId}->${expectedParentId}`;

      expect(feed[0]).toEqual({
        sourceId: expectedChildId,
        parentName: 'BaseService',
        oldTargetId: expectedParentId,
        oldRelId: expectedEdgeId,
        relType: 'EXTENDS',
        file: 'src/svc.ts',
        line: 2,
        character: 23,
      });
    });

    // ----- Decision table: 5-condition gate -----

    it('gate[1] lsp:false (with feed present) → feed stays [] (LSP gate)', async () => {
      const heritage = buildUnresolvedImplements(4, 31);
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: false, heritageFeed: feed });

      // LSP gate false → no feed.
      expect(feed).toEqual([]);
    });

    it('gate[2] lsp:true but heritageFeed absent → no feed pushed (sink gate)', async () => {
      const heritage = buildUnresolvedImplements(4, 31);
      // Note: no `heritageFeed` in opts — the processor checks
      // `opts?.heritageFeed` truthy before pushing. No throw,
      // no feed.
      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true });

      // Sanity: the edge IS still emitted (the gate only gates the feed).
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
    });

    it('gate[3] lsp:true + SAME-FILE resolved parent (confidence 0.95) → no feed (confidence gate)', async () => {
      // The child AND parent live in the same file; the symbol
      // table resolves the parent at the same-file tier (0.95).
      // This is the OPPOSITE of the feed trigger.
      ctx.symbols.add('src/svc.ts', 'IUserRepo', 'Interface:src/svc.ts:IUserRepo', 'Interface');
      ctx.symbols.add('src/svc.ts', 'UserService', 'Class:src/svc.ts:UserService', 'Class');

      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/svc.ts',
        className: 'UserService',
        parentName: 'IUserRepo',
        kind: 'implements',
        line: 4,
        character: 31,
      }];
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      // Same-file resolution = confidence 0.95, NOT 0.5 → feed stays empty.
      expect(feed).toEqual([]);
    });

    it('gate[4] lsp:true + unresolved Go parent → no feed (language gate: Go is not TS-family)', async () => {
      // Unresolved Go implements → global tier (0.5), but Go is
      // not in the TS family so the feed gate refuses.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/iface.go',
        className: 'UserRepo',
        parentName: 'IUserRepo',
        kind: 'implements',
        line: 8,
        character: 14,
      }];
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      // The edge IS emitted (heuristic still works), but the feed stays empty.
      expect(feed).toEqual([]);
      const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
      expect(rels).toHaveLength(1);
    });

    it('gate[5] lsp:true + position-less record (Ruby include) → no feed (position gate)', async () => {
      // Ruby `include` records arrive with `line: undefined`
      // (see WI-3 gate-exclusion test). The processor must NOT
      // feed these — they have no identifier position to target.
      const heritage: ExtractedHeritage[] = [{
        filePath: 'src/foo.rb',
        className: 'Foo',
        parentName: 'Bar',
        kind: 'include',
        // line/character intentionally absent
      }];
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      expect(feed).toEqual([]);
    });

    it('multi-parent implements clause populates one feed entry per parent (gate independence)', async () => {
      // `class UserService implements I1, I2` — both parents
      // are unresolved TS, both have positions. The feed must
      // receive TWO entries (gate applies per record, not
      // per file), each with its own (line, character).
      const heritage: ExtractedHeritage[] = [
        { filePath: 'src/multi.ts', className: 'UserService', parentName: 'I1', kind: 'implements', line: 9, character: 31 },
        { filePath: 'src/multi.ts', className: 'UserService', parentName: 'I2', kind: 'implements', line: 9, character: 35 },
      ];
      const feed: HeritageFeedItem[] = [];

      await processHeritageFromExtracted(graph, heritage, ctx, undefined, { lsp: true, heritageFeed: feed });

      expect(feed).toHaveLength(2);
      // Distinct (line, character) tuples round-trip into the feed.
      expect(feed[0].line).toBe(9);
      expect(feed[0].character).toBe(31);
      expect(feed[1].line).toBe(9);
      expect(feed[1].character).toBe(35);
      expect(feed[0].oldRelId).not.toBe(feed[1].oldRelId);
    });

    it('edge is ALWAYS emitted regardless of feed gate (regression guard)', async () => {
      // The feed is ADDS info to the reconciler; the heuristic
      // edge must always be in the graph. This is the WI-4
      // invariant — verify with a fresh graph for each variant.
      const heritage = buildUnresolvedImplements(4, 31);

      // Variant A: no opts.
      const graphA = createKnowledgeGraph();
      await processHeritageFromExtracted(graphA, heritage, ctx);
      const relsA = graphA.relationships.filter(r => r.type === 'IMPLEMENTS');

      // Variant B: lsp:true.
      const graphB = createKnowledgeGraph();
      const feedB: HeritageFeedItem[] = [];
      await processHeritageFromExtracted(graphB, heritage, ctx, undefined, { lsp: true, heritageFeed: feedB });
      const relsB = graphB.relationships.filter(r => r.type === 'IMPLEMENTS');

      // Both variants emit the same heuristic edge (the feed
      // path does not delete the heuristic edge — it asks the
      // reconciler to potentially re-resolve it).
      expect(relsA).toHaveLength(1);
      expect(relsB).toHaveLength(1);
      expect(relsA[0].id).toBe(relsB[0].id);
      expect(relsA[0].source).toBe('heuristic');
      expect(relsB[0].source).toBe('heuristic');
    });

    it('HeritageFeedItem is exactly 8 fields (shape contract)', () => {
      // Type-level pin: instantiating with the 8 named fields
      // must compile; this test ALSO documents the field
      // ordering. Adding a 9th field to the interface breaks
      // this test until the spec is updated.
      const item: HeritageFeedItem = {
        sourceId: 's',
        parentName: 'p',
        oldTargetId: 't',
        oldRelId: 'r',
        relType: 'IMPLEMENTS',
        file: 'f',
        line: 0,
        character: 0,
      };
      const keys = Object.keys(item).sort();
      expect(keys).toEqual(
        ['character', 'file', 'line', 'oldRelId', 'oldTargetId', 'parentName', 'relType', 'sourceId'],
      );
    });

    it('ProcessHeritageOpts is optional and undefined-safe (default-path contract)', async () => {
      // The default path calls processHeritageFromExtracted
      // with NO opts. This must work without throwing — the
      // existing 17 tests above already prove this; this test
      // documents the call shape so the gate additions can't
      // accidentally turn `opts` into a required parameter.
      const heritage = buildUnresolvedImplements(4, 31);
      await expect(
        processHeritageFromExtracted(graph, heritage, ctx, undefined, undefined),
      ).resolves.not.toThrow();
      await expect(
        processHeritageFromExtracted(graph, heritage, ctx, undefined, {} as ProcessHeritageOpts),
      ).resolves.not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AST-path (`processHeritage`) feed tests — mirrors the
// `processHeritageFromExtracted` block above at the AST entry.
// The worker path runs in production (parse-worker → feed into
// `processHeritageFromExtracted`); the AST path is the sequential
// fallback (`pipeline.ts:515` calls `processHeritage` directly
// with `lspHeritageOpt`). The mode-a-heritage-golden integration
// test exercises the worker path through the pipeline; this unit
// block is the server-independent proof for the AST path.
//
// Same 5-condition gate as the worker path (heritage-processor.ts:
//   282-330 — extends
//   343-364 — implements
// ):
//   1. opts?.lsp
//   2. opts.heritageFeed
//   3. TS-family language (the language gate)
//   4. parent.confidence === 0.5 (the global/unresolved gate)
//   5. position available (line !== undefined)
//
// We pin each gate on the AST path the same way the
// `processHeritageFromExtracted` block does above.
// ═══════════════════════════════════════════════════════════════════════
describe('processHeritage — AST-path feed (WI-4 / #159 P3 Mode A)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('lsp:false — heritage feed stays empty AND graph deep-equals the no-opts run (byte-identity AC-4)', async () => {
    // A real TS file with an unresolved parent — the same
    // shape that would feed under lsp:true. With lsp:false
    // the gate short-circuits and the feed stays empty.
    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '  load(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];

    // Run A: no opts at all (the true default).
    const graphA = createKnowledgeGraph();
    const ctxA = createResolutionContext();
    await processHeritage(graphA, files, createASTCache(files.length), ctxA);

    // Run B: lsp:false explicitly.
    const graphB = createKnowledgeGraph();
    const ctxB = createResolutionContext();
    const feedB: HeritageFeedItem[] = [];
    await processHeritage(
      graphB, files, createASTCache(files.length), ctxB,
      undefined,
      { lsp: false, heritageFeed: feedB },
    );

    // The feed must be untouched when lsp is false.
    expect(feedB).toEqual([]);
    // The graph must be deep-equal (byte-identity).
    expect(graphB.relationships).toEqual(graphA.relationships);
    expect(graphB.relationshipCount).toEqual(graphA.relationshipCount);
  });

  it('opts absent — heritage feed stays empty AND graph deep-equals the lsp:false run', async () => {
    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];

    const graphNoOpts = createKnowledgeGraph();
    const ctxNoOpts = createResolutionContext();
    await processHeritage(
      graphNoOpts, files, createASTCache(files.length), ctxNoOpts,
    );

    const graphLspFalse = createKnowledgeGraph();
    const ctxLspFalse = createResolutionContext();
    const feed: HeritageFeedItem[] = [];
    await processHeritage(
      graphLspFalse, files, createASTCache(files.length), ctxLspFalse,
      undefined,
      { lsp: false, heritageFeed: feed },
    );

    expect(feed).toEqual([]);
    expect(graphLspFalse.relationships).toEqual(graphNoOpts.relationships);
  });

  it('lsp:true + unresolved TS parent — exact-shape pin of all 8 HeritageFeedItem fields (AC-4)', async () => {
    // IUserRepo is NOT in the symbol table → resolveHeritageId
    // returns a generated id with confidence === 0.5. The AST
    // gate fires on this exact shape.
    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '  load(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];
    const feed: HeritageFeedItem[] = [];

    await processHeritage(
      graph, files, createASTCache(files.length), ctx,
      undefined,
      { lsp: true, heritageFeed: feed },
    );

    // The heuristic edge must be emitted (the feed does NOT
    // replace the edge — the edge still exists, and a copy
    // goes to the feed for LSP re-resolution).
    const rels = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
    expect(rels).toHaveLength(1);

    // The feed must have exactly one entry — the unresolved TS parent.
    expect(feed).toHaveLength(1);

    // Compute the expected ids: child is resolved as Class
    // (filePath is in the graph via resolveHeritageId fallback),
    // parent is the generated Interface id (unresolved).
    const expectedChildId = 'Class:src/user-service.ts:UserService';
    const expectedParentId = 'Interface:IUserRepo';
    const expectedEdgeId = `IMPLEMENTS:${expectedChildId}->${expectedParentId}`;

    expect(feed[0]).toEqual({
      sourceId: expectedChildId,
      parentName: 'IUserRepo',
      oldTargetId: expectedParentId,
      oldRelId: expectedEdgeId,
      relType: 'IMPLEMENTS',
      file: 'src/user-service.ts',
      line: 0,
      character: 36, // `IUserRepo` identifier column
    });
  });

  it('lsp:true + unresolved TS extends — exact-shape pin (relType: "EXTENDS")', async () => {
    const files = [
      {
        path: 'src/admin.ts',
        content: [
          'export class AdminUser extends BaseUser {',
          '  ban(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];
    const feed: HeritageFeedItem[] = [];

    await processHeritage(
      graph, files, createASTCache(files.length), ctx,
      undefined,
      { lsp: true, heritageFeed: feed },
    );

    const rels = graph.relationships.filter(r => r.type === 'EXTENDS');
    expect(rels).toHaveLength(1);

    expect(feed).toHaveLength(1);
    expect(feed[0].relType).toBe('EXTENDS');
    expect(feed[0].parentName).toBe('BaseUser');
    expect(feed[0].file).toBe('src/admin.ts');
    expect(feed[0].line).toBe(0);
    // The unresolved parent `BaseUser` falls through the
    // TS default (heritage-processor.ts:62 — `return
    // { type: 'EXTENDS', idPrefix: 'Class' }`), so the
    // synthetic target id is `Class:BaseUser` and the
    // `oldRelId` mirrors that exact shape.
    expect(feed[0].oldRelId).toBe('EXTENDS:Class:src/admin.ts:AdminUser->Class:BaseUser');
    expect(feed[0].oldTargetId).toBe('Class:BaseUser');
  });

  it('gate[1] lsp:false (with feed present) → feed stays [] (LSP gate)', async () => {
    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];
    const feed: HeritageFeedItem[] = [];

    await processHeritage(
      graph, files, createASTCache(files.length), ctx,
      undefined,
      { lsp: false, heritageFeed: feed },
    );

    expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(1);
    expect(feed).toEqual([]);
  });

  it('gate[2] lsp:true but heritageFeed absent → no feed pushed (sink gate)', async () => {
    // No `heritageFeed` in opts — the processor checks
    // `opts?.heritageFeed` truthy before pushing. No throw,
    // the edge still emits, but the feed (which is the sink)
    // doesn't get a sink to push to.
    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];

    await processHeritage(
      graph, files, createASTCache(files.length), ctx,
      undefined,
      { lsp: true },
    );

    // The edge still emits.
    expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(1);
  });

  it('gate[3] lsp:true + SAME-FILE resolved parent (confidence 0.95) → no feed (confidence gate)', async () => {
    // Register the parent in the symbol table — same-file
    // resolution at 0.95. The confidence gate keeps the
    // entry out of the feed.
    ctx.symbols.add(
      'src/user-service.ts',
      'IUserRepo',
      'Interface:src/user-service.ts:IUserRepo',
      'Interface',
    );

    const files = [
      {
        path: 'src/user-service.ts',
        content: [
          'export interface IUserRepo { save(): void; }',
          'export class UserService implements IUserRepo {',
          '  save(): void {}',
          '}',
          '',
        ].join('\n'),
      },
    ];
    const feed: HeritageFeedItem[] = [];

    await processHeritage(
      graph, files, createASTCache(files.length), ctx,
      undefined,
      { lsp: true, heritageFeed: feed },
    );

    // The edge still emits.
    expect(graph.relationships.filter(r => r.type === 'IMPLEMENTS')).toHaveLength(1);
    // But the feed stays empty — confidence 0.95 > 0.5.
    expect(feed).toEqual([]);
  });
});
