/**
 * Streaming structural graph-emit sink (issue #2680).
 *
 * `analyze` holds the whole `KnowledgeGraph` on the main thread for the entire
 * pipeline, so peak heap is O(repo) — ~2.1 KB/node at Linux-kernel scale
 * (#2649). Measurement on a kernel-shaped synthetic graph (400k nodes,
 * 2.7 edges/node) says where that goes:
 *
 *   nodes only .......  367 B/node
 *   nodes + edges .... 2075 B/node   <- reproduces the #2649 figure
 *
 * So **relationships are ~83% of graph heap** (~646 B/edge), and that is what
 * this sink removes. 646 B for an object holding four short strings is the cost
 * of storing every edge four times over — `relationshipMap`, a
 * `relationshipsByType` bucket, and both endpoints' `edgeIdsByNode` Sets — plus
 * an `id` that concatenates both endpoint ids. (Dropping just the two redundant
 * indexes was measured too: 174 of 648 B/edge, ~1.3x. Not enough on its own.)
 *
 * Nodes are deliberately NOT streamed: they are the other 17%, and two
 * scope-resolution index builders (`buildGraphNodeLookup`,
 * `buildGraphCallableAnchorIndex`) scan them.
 *
 * ## How much this actually saves — read this before quoting a number
 *
 * Measured A/B against the object-based graph, 400k nodes / 1.08M edges, all
 * edges streamable (the worst case for this design): **823 MB -> 626 MB, ~1.3x**,
 * with all 1.08M edges still visible through `iterRelationships`.
 *
 * That is well short of the ~2.9x a naive `0.17 + 0.83 * 0.21` retained-share
 * calculation suggests, and the gap is deliberate: this sink is *lossless*, so
 * it pays for the {@link streamedIds} dedup Set (one unique id string per
 * streamed edge) and the columns above. An earlier revision hit a bigger number
 * by disabling community detection, process extraction and the taint fixpoint —
 * which is why it could not be the default. 1.3x with nothing traded away is the
 * honest figure; if a future change needs more, the next lever is dedup keyed on
 * the interned column triple rather than on id strings (it must first be shown
 * not to alter the emitted row SET).
 *
 * ## What it costs — measured, not assumed
 *
 * Measured on the same 400k-node / 1.08M-edge graph, all edges streamable, each
 * arm running what its own consumers actually call:
 *
 *   heap  819 MB -> 584 MB   (1.40x better)
 *   scans  ~78 ms -> ~88 ms  (parity, within run-to-run noise)
 *
 * Linear in both: verified at 100k/200k/400k/800k nodes, per-edge scan cost flat
 * (~13 ns both arms) and the heap ratio drifting only 1.7x -> 1.5x as interner
 * indices gain digits. No super-linear term, so a larger repo costs
 * proportionally more, not disproportionately.
 *
 * The dedup key encodes its tail SEGMENT COUNT, which measurably costs ~66 MB
 * here versus omitting it. That is not optional: without it a one-segment tail
 * `:7` and a two-segment `:7:0` collapse onto one key and an edge is silently
 * dropped (regression test in graph-emit-sink.test.ts).
 *
 * Getting there took three measured steps, because the naive version was 6.8x
 * WORSE (651 ms) — reads rebuild objects, and a real analyze performs SIX full
 * relationship scans (the pruner, community detection x2, process extraction x2,
 * and the taint fixpoint's CALLS pass):
 *
 * 1. The ~150-character synthesized `id` was built eagerly on every read — 6.5M
 *    concatenations for a field no in-pipeline consumer reads. Isolating it
 *    showed 436 ms of the regression. It is now a lazy prototype getter on
 *    {@link StreamedRelationship}.
 * 2. Generator and iterator-protocol overhead: {@link forEachRelationship} loops
 *    the columns directly, and {@link iterRelationships} reuses one
 *    iterator-result record. Note a hand-rolled iterator allocating a fresh
 *    `{value, done}` per edge measured WORSE (252 ms) than the generator it
 *    replaced, so the obvious rewrite is not the one that shipped.
 * 3. The remaining ~90 ms was object allocation itself, irreducible while the
 *    read API returns objects — so the five whole-graph scans moved to
 *    `forEachRelationshipFields`, which passes the four fields they actually
 *    read as primitives and allocates nothing. See
 *    {@link GraphEmitSink.forEachRelationshipFields}.
 *
 * The last allocating scan is the taint fixpoint's `iterRelationshipsByType`
 * pass; it is one scan of six and accounts for the small residual. Give it a
 * by-type field variant only if a measurement says it matters.
 *
 * It is in any case NOT O(chunk) — node identity and the resolution registries
 * stay O(repo). True O(chunk) needs DB-side resolution and Leiden (#2337), at
 * which point this sink should be deleted rather than extended.
 *
 * ## Correctness contract
 *
 * Structural sibling of {@link PdgEmitSink}, and reuses its row builder
 * (`buildRelRow`), header (`REL_CSV_HEADER`) and pair classification
 * (`relPairKeyFor`, which is also what `RelPairRouter` routes and skips by), so
 * the streamed row SET equals the whole-graph emit's and the bulk COPY loads
 * the same rows. Set-level, not
 * byte-level: rows stream in emit order and are not re-sorted under
 * `GITNEXUS_SORT_GRAPH_OUTPUT`.
 */
import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { DECLARED_RELATION_PAIRS, REL_CSV_HEADER, buildRelRow } from './csv-generator.js';
import {
  VALID_NODE_TABLES,
  assertDeclaredPair,
  relPairKeyFor,
  splitRelPairKey,
} from './rel-pair-routing.js';
import { DEFAULT_EMIT_CHUNK_ROWS, SyncCsvWriter } from './sync-csv-writer.js';

/**
 * Relationship types that MUST stay in the in-memory graph because a phase
 * running while streaming is active reads them back.
 *
 * Derived from an exhaustive audit of every relationship read site under
 * `gitnexus/src/` (`iterRelationshipsByType` / `iterRelationships` /
 * `forEachRelationship` / `removeRelationship`), not from intuition — an
 * earlier draft of this list carried 14 types, 5 of which no reachable phase
 * reads. Every entry below names its reader:
 *
 *   EXTENDS, IMPLEMENTS  - mro-processor, scope-resolution/passes/mro,
 *                          receiver-bound-calls, pipeline/run.ts, cpp
 *                          member-lookup, and 9 language scope-resolvers
 *   HAS_METHOD           - mro-processor, di phase
 *   HAS_PROPERTY         - di phase, ruby scope-resolver, spring config-bindings
 *   METHOD_OVERRIDES,
 *   METHOD_IMPLEMENTS    - mro-processor
 *   DEFINES              - local-symbol-pruner's isFileDefinesEdge test
 *   INJECTS              - di phase fan-out
 *
 * Deliberately NOT retained: STEP_IN_PROCESS / ENTRY_POINT_OF / MEMBER_OF
 * (written only by the `processes` / `communities` phases, which the streaming
 * flag disables), TAINT_PATH / CALL_SUMMARY (their phases are likewise gated
 * off under the flag), and HANDLES_ROUTE / HANDLES_TOOL (written by
 * `routes`/`tools`, never read back mid-pipeline).
 *
 * Adding a relationship type that a phase reads back WITHOUT adding it here is
 * a silent-wrong-graph bug, not a crash. The differential round-trip test cannot:
 * `addRelationship` partitions edges
 * between the graph and the CSVs, and the union of a partition is invariant
 * under where the partition line falls, so that test stays green no matter how
 * this set is drawn. Only the read-site audit protects this invariant; re-run it
 * (grep iterRelationshipsByType / iterRelationships / forEachRelationship /
 * removeRelationship across src/) when adding a phase or a relationship type.
 */
export const RETAINED_REL_TYPES: ReadonlySet<RelationshipType> = new Set<RelationshipType>([
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
  'DEFINES',
  'INJECTS',
  // springAopInheritance reads direct behavior evidence after MRO.
  'ADVISED_BY',
]);

/**
 * COPY manifest produced by {@link GraphEmitSink.finalize}.
 *
 * Only `relsByPair` — this PR does not stream node rows, so a `nodeFiles`
 * dimension would be permanently empty. Note that unlike `PdgEmitManifest`,
 * these pair keys DO collide with the whole-graph emit's (streamed `CALLS` is
 * `Function|Function`, same as retained edges), so `loadGraphToLbug` must
 * APPEND these files to the pair rather than reject them as a collision.
 */
export interface GraphEmitManifest {
  /** pairKey (`From|To`) -> per-pair edge CSV. */
  readonly relsByPair: Map<string, { csvPath: string; rows: number }>;
  /** Total streamed rows, for the buffer-pool size hint (#2631 path). */
  readonly totalRows: number;
}

/**
 * The slice of the sink that pipeline phases drive. Declared here, next to the
 * implementation, and imported as a type by `pipeline-phases/types.ts` so the
 * phase layer depends on this narrow capability rather than on two loose
 * callbacks bolted onto the context.
 */
export interface GraphEmitControl {
  /** Start routing non-retained relationships to disk (see {@link GraphEmitSink.beginStreaming}). */
  beginStreaming(): void;
}

/**
 * A streamed edge, rebuilt for a read.
 *
 * A class, not an object literal, for two reasons that both showed up in
 * measurement. Its shape is fixed, so V8 keeps one hidden class across millions
 * of instances; and `id` is a PROTOTYPE getter, so the ~150-character
 * concatenation happens only if a caller actually reads it — which none of the
 * in-pipeline consumers do. Building it eagerly cost 436 ms of a 555 ms
 * iteration regression across the six full scans an analyze performs (measured
 * at 400k nodes / 1.08M edges); deferring it gives that back.
 */
class StreamedRelationship implements GraphRelationship {
  /** Constant for streamed edges — see the note on the columns about why
   *  `reason` is not retained. The persisted CSV row keeps the real value. */
  readonly reason = 'streamed';

  constructor(
    readonly sourceId: string,
    readonly targetId: string,
    readonly type: RelationshipType,
    readonly confidence: number,
    private readonly ix: number,
  ) {}

  /** Deterministic and unique — the column index disambiguates two streamed
   *  edges that share (type, source, target). Lazily built; nothing in the
   *  pipeline reads it. */
  get id(): string {
    return `${this.type}:${this.sourceId}->${this.targetId}#${this.ix}`;
  }
}

/** Thrown when a consumer removes a relationship that already streamed to
 *  disk. Silently no-oping would let a mutating consumer (e.g. the COBOL
 *  cross-program CALL resolver) corrupt the persisted graph undetected. */
export class StreamedRelationshipRemovalError extends Error {
  constructor(relationshipId: string) {
    super(
      `Cannot remove relationship "${relationshipId}": it has already been streamed to ` +
        `CSV and cannot be recalled. A phase that removes relationships must run before ` +
        `the GraphEmitSink is installed (see the parse-boundary construction in pipeline.ts).`,
    );
    this.name = 'StreamedRelationshipRemovalError';
  }
}

/**
 * Write-routing graph façade. Construct one per analyze run at the PARSE
 * boundary — not at `createKnowledgeGraph()` — so the pre-parse phases
 * (`structure`, `springConfig`, `markdown`, `cobol`) complete their
 * read-modify-delete passes against a fully in-memory graph. Call
 * {@link finalize} once after the pipeline, before `loadGraphToLbug`.
 */
export class GraphEmitSink implements KnowledgeGraph, GraphEmitControl {
  private readonly relWriters = new Map<string, SyncCsvWriter>();
  /**
   * Ids of relationships already streamed. `KnowledgeGraph.addRelationship`
   * drops duplicate ids first-writer-wins, and COPY into a PK-bearing table
   * would violate on a repeat, so the sink must dedup itself — unlike
   * `PdgEmitSink`, whose emit loop guarantees per-file uniqueness upstream.
   *
   * ponytail: O(streamed-edges) id strings retained. That is ~a tenth of full
   * edge retention (the objects, both endpoint index Sets, and the type bucket
   * all go away), but it is not O(chunk). Upgrade path if it ever dominates:
   * a per-pair sorted-run dedup on disk, or hashing ids into a Bloom filter
   * with an exact fallback.
   */
  private readonly streamedIds = new Set<string>();
  /**
   * Streamed edges, kept as parallel columns so the sink can still answer a
   * COMPLETE relationship read (see {@link iterRelationships}). Only the four
   * fields any consumer of these edges actually reads are retained —
   * `sourceId`, `targetId`, `type`, `confidence` — audited across
   * community-processor, process-processor, taint-summaries and the pruner.
   *
   * `id`, `reason` and `step` are deliberately NOT kept. Every relationship id
   * is a unique long string, and retaining ids is exactly what made an earlier
   * fully-columnar attempt LOSE to the object-based graph (measured 838 MB vs
   * 822 MB at 400k nodes / 1.08M edges). Keeping ids out of the heap is where
   * the saving comes from, so a read synthesizes a deterministic id instead —
   * safe because `buildRelRow` never persists `rel.id` and no consumer keys on
   * it (audited).
   *
   * The dropped `reason`/`step` are safe too, but for a different reason worth
   * stating: the PERSISTED row keeps their true values, because `buildRelRow` is
   * handed the original relationship on the way through. Only in-memory reads
   * see the `'streamed'` placeholder, and the in-pipeline consumers of streamed
   * edges read neither field. So e.g. the `ACCESSES reason: 'read'|'write'`
   * distinction that MCP queries rely on survives in the database. A future
   * in-pipeline consumer needing `reason` or `step` on a streamed edge must add
   * the column, not trust the placeholder.
   *
   * Node ids are interned; the strings are shared by reference with the node
   * map's, so interning adds bookkeeping, not new text.
   */
  private readonly nodeIds = new Map<string, number>();
  private readonly nodeIdByIx: string[] = [];
  private readonly srcIx: number[] = [];
  private readonly tgtIx: number[] = [];
  private readonly relTypes: RelationshipType[] = [];
  private readonly confidences: number[] = [];
  private finalized = false;
  /**
   * Streaming is OFF until {@link beginStreaming} is called by `parse`.
   *
   * The pre-parse phases are not all write-only: `mapCobolToGraph` scans
   * `CALLS` edges and REMOVES the unresolved ones after adding resolved
   * replacements (cobol-processor.ts). If the sink streamed from
   * construction, that scan would see an empty set, no COBOL cross-program
   * call would ever resolve, and the removal would be a silent no-op. Nothing
   * before parse produces bulk edge volume, so deferring costs nothing.
   */
  private armed = false;
  /**
   * First writer-construction failure (`fs.openSync` throwing on e.g. EMFILE).
   * It happens inside the `SyncCsvWriter` constructor before a writer object
   * exists to carry poison, so it is held at sink level and folded into the
   * {@link finalize} error check — otherwise an open failure mid-emit would be
   * swallowed by a caller's try/catch and silently drop the rest of the rows.
   */
  private openFailure: unknown | undefined = undefined;

  constructor(
    private readonly real: KnowledgeGraph,
    private readonly csvDir: string,
    private readonly chunkRows: number = DEFAULT_EMIT_CHUNK_ROWS,
  ) {
    // Own directory, distinct from the PDG sink's: PdgEmitSink wipes and
    // recreates its dir on construction and opens with O_EXCL, so a shared dir
    // would destroy the other sink's manifest on a combined --pdg run.
    fs.rmSync(csvDir, { recursive: true, force: true });
    fs.mkdirSync(csvDir, { recursive: true });
  }

  // ── routed writes ──────────────────────────────────────────────────────────

  /** Nodes are never streamed (see the file header) — always the real graph. */
  addNode(node: GraphNode): void {
    this.real.addNode(node);
  }

  /**
   * Start streaming. Called once, by the `parse` phase, for the reason on
   * {@link armed}.
   */
  beginStreaming(): void {
    this.armed = true;
  }

  /**
   * Exact dedup key, built to hold no reference to the relationship id.
   *
   * An id embeds both node ids in full — ~200 characters on this repo — and the
   * only information it adds beyond `(type, source, target)` is a short trailing
   * disambiguator, e.g. `emit-references.ts` appends `:line:col` so two calls
   * between the same pair at different sites stay distinct. The endpoints are
   * already interned for the columns, so the key reuses those indices and parses
   * the tail into NUMBERS.
   *
   * Numbers matter for more than size: a key built by slicing or replacing
   * inside a long string is a V8 sliced/cons string that keeps its parent alive,
   * so the 200-character id would never be freed and the memory saving would
   * silently fail to materialize. Parsing to numbers severs that link.
   *
   * Falls back to the full id when the tail is not a numeric `:a:b` form (other
   * id shapes exist, e.g. `rel:contains:` has no tail). Correctness first: an
   * unrecognized shape is stored exactly, just without the saving.
   */
  private dedupKey(rel: GraphRelationship, srcIx: number, tgtIx: number): string {
    const afterTarget = rel.id.lastIndexOf(rel.targetId);
    if (afterTarget >= 0) {
      const tail = rel.id.slice(afterTarget + rel.targetId.length);
      if (tail.length === 0) return `${srcIx}|${tgtIx}|${rel.type}`;
      // `:1483:6` -> two integers. Any non-numeric segment falls through.
      if (tail.charCodeAt(0) === 58 /* ':' */) {
        let a = 0;
        let b = 0;
        let seen = 0;
        let ok = true;
        for (const part of tail.slice(1).split(':')) {
          const n = Number(part);
          if (part.length === 0 || !Number.isInteger(n)) {
            ok = false;
            break;
          }
          if (seen === 0) a = n;
          else if (seen === 1) b = n;
          else {
            ok = false;
            break;
          }
          seen++;
        }
        // `seen` is part of the key: without it a one-segment tail `:7` (b
        // defaults to 0) and a two-segment `:7:0` produce the same key, and the
        // second edge is silently discarded as a duplicate. Distinct ids must
        // never collapse — that is a lost relationship with no error.
        if (ok) return `${srcIx}|${tgtIx}|${rel.type}|${seen}|${a}|${b}`;
      }
    }
    return rel.id;
  }

  private internNode(id: string): number {
    const existing = this.nodeIds.get(id);
    if (existing !== undefined) return existing;
    const ix = this.nodeIdByIx.length;
    this.nodeIdByIx.push(id);
    this.nodeIds.set(id, ix);
    return ix;
  }

  /** Rebuild a streamed edge; its id is synthesized lazily, not stored. */
  private streamedAt(ix: number): GraphRelationship {
    return new StreamedRelationship(
      this.nodeIdByIx[this.srcIx[ix]],
      this.nodeIdByIx[this.tgtIx[ix]],
      this.relTypes[ix],
      this.confidences[ix],
      ix,
    );
  }

  addRelationship(relationship: GraphRelationship): void {
    if (!this.armed || RETAINED_REL_TYPES.has(relationship.type)) {
      this.real.addRelationship(relationship);
      return;
    }
    // Mirror KnowledgeGraph.addRelationship's first-writer-wins dedup.

    // Classify + skip via the SHARED `relPairKeyFor`, not a local copy of its
    // three lines, so the streamed set cannot drift from the whole-graph set
    // `RelPairRouter` produces. `undefined` = an endpoint label is not a node
    // table, so the edge is dropped exactly as the router drops it.
    const pairKey = relPairKeyFor(relationship.sourceId, relationship.targetId, VALID_NODE_TABLES);
    if (pairKey === undefined) return;

    assertDeclaredPair(
      pairKey,
      DECLARED_RELATION_PAIRS,
      relationship.type,
      relationship.sourceId,
      relationship.targetId,
    );
    let writer = this.relWriters.get(pairKey);
    if (writer === undefined) {
      // Cold: once per pair, so decoding the key back into its labels is free.
      const [fromLabel, toLabel] = splitRelPairKey(pairKey);
      try {
        writer = new SyncCsvWriter(
          path.join(this.csvDir, `rel_${fromLabel}_${toLabel}.csv`),
          REL_CSV_HEADER,
          this.chunkRows,
        );
      } catch (e) {
        this.openFailure ??= e;
        throw e;
      }
      this.relWriters.set(pairKey, writer);
    }
    // Intern first so the dedup key can reuse the indices.
    const srcIx = this.internNode(relationship.sourceId);
    const tgtIx = this.internNode(relationship.targetId);
    const key = this.dedupKey(relationship, srcIx, tgtIx);
    if (this.streamedIds.has(key)) return;
    this.streamedIds.add(key);

    writer.addRow(buildRelRow(relationship));
    this.srcIx.push(srcIx);
    this.tgtIx.push(tgtIx);
    this.relTypes.push(relationship.type);
    this.confidences.push(relationship.confidence);
  }

  /** Flush + close every writer and return the COPY manifest. Every fd is
   *  closed even when a writer is poisoned; any IO fault — an in-flight write,
   *  a final-flush failure, or a writer-open failure (EMFILE) — is surfaced
   *  loudly here so a disk-full / out-of-fds run never hands a truncated CSV to
   *  the bulk COPY. */
  finalize(): GraphEmitManifest {
    if (this.finalized) throw new Error('GraphEmitSink.finalize() called twice');
    this.finalized = true;

    const errors: unknown[] = [];
    if (this.openFailure !== undefined) errors.push(this.openFailure);

    const relsByPair = new Map<string, { csvPath: string; rows: number }>();
    let totalRows = 0;
    for (const [pairKey, writer] of this.relWriters) {
      writer.close();
      if (writer.poison !== undefined) errors.push(writer.poison);
      relsByPair.set(pairKey, { csvPath: writer.csvPath, rows: writer.rows });
      totalRows += writer.rows;
    }

    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `GraphEmitSink: ${errors.length} streamed CSV writer(s) hit an IO error ` +
          `(disk-full / out-of-fds) during the emit — the persisted graph would be ` +
          `truncated, so the run is failed rather than COPYing a partial CSV: ${
            first instanceof Error ? first.message : String(first)
          }`,
      );
    }

    return { relsByPair, totalRows };
  }

  /** Best-effort fd release for the error path — when the pipeline throws
   *  before {@link finalize} runs, the caller's `finally` calls this so the
   *  per-pair fds never leak. Idempotent with finalize via `finalized`. */
  close(): void {
    if (this.finalized) return;
    this.finalized = true;
    for (const writer of this.relWriters.values()) {
      try {
        writer.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // ── delegated reads / retained mutations ───────────────────────────────────

  get nodes(): GraphNode[] {
    return this.real.nodes;
  }
  get relationships(): GraphRelationship[] {
    return [...this.iterRelationships()];
  }
  iterNodes(): IterableIterator<GraphNode> {
    return this.real.iterNodes();
  }
  /**
   * Retained edges followed by the streamed ones, so every consumer sees a
   * complete graph and no phase needs to know streaming happened. This is what
   * lets streaming be the default.
   *
   * Hand-rolled rather than a generator: a generator pays per-`yield` machinery
   * on every one of millions of edges, and the pruner and process extraction
   * walk this three times per analyze.
   */
  iterRelationships(): IterableIterator<GraphRelationship> {
    const retained = this.real.iterRelationships();
    const self = this;
    let ix = 0;
    // One reused result record. The iterator protocol lets the producer hand
    // back the same object each step — `for…of` reads `value`/`done` and drops
    // it immediately — and allocating a fresh one per edge cost more than the
    // generator it replaced.
    const result: { value: GraphRelationship | undefined; done: boolean } = {
      value: undefined,
      done: true,
    };
    const it: IterableIterator<GraphRelationship> = {
      next(): IteratorResult<GraphRelationship> {
        const fromReal = retained.next();
        if (fromReal.done !== true) {
          result.value = fromReal.value;
          result.done = false;
          return result as IteratorResult<GraphRelationship>;
        }
        if (ix < self.srcIx.length) {
          result.value = self.streamedAt(ix++);
          result.done = false;
          return result as IteratorResult<GraphRelationship>;
        }
        result.value = undefined;
        result.done = true;
        return result as IteratorResult<GraphRelationship>;
      },
      [Symbol.iterator]() {
        return it;
      },
    };
    return it;
  }

  *iterRelationshipsByType(type: RelationshipType): IterableIterator<GraphRelationship> {
    yield* this.real.iterRelationshipsByType(type);
    if (RETAINED_REL_TYPES.has(type)) return; // never streamed — skip the scan
    for (let ix = 0; ix < this.srcIx.length; ix++) {
      if (this.relTypes[ix] === type) yield this.streamedAt(ix);
    }
  }
  forEachNode(fn: (node: GraphNode) => void): void {
    this.real.forEachNode(fn);
  }
  /**
   * The fast path: streamed edges are read straight out of the columns, so a
   * whole-graph scan allocates NOTHING. This is what keeps iteration at parity
   * with the object-based graph despite holding relationships columnar.
   */
  forEachRelationshipFields(
    fn: (sourceId: string, targetId: string, type: RelationshipType, confidence: number) => void,
  ): void {
    this.real.forEachRelationshipFields(fn);
    for (let ix = 0; ix < this.srcIx.length; ix++) {
      fn(
        this.nodeIdByIx[this.srcIx[ix]],
        this.nodeIdByIx[this.tgtIx[ix]],
        this.relTypes[ix],
        this.confidences[ix],
      );
    }
  }

  /** Direct loop rather than delegating to {@link iterRelationships}: this is
   *  the form community detection uses (twice), and skipping the generator and
   *  iterator protocol is measurably cheaper on a million-edge scan. */
  forEachRelationship(fn: (rel: GraphRelationship) => void): void {
    this.real.forEachRelationship(fn);
    for (let ix = 0; ix < this.srcIx.length; ix++) fn(this.streamedAt(ix));
  }
  getNode(id: string): GraphNode | undefined {
    return this.real.getNode(id);
  }
  get nodeCount(): number {
    return this.real.nodeCount;
  }
  /** Retained edges only — streamed edges are gone from the heap by design.
   *  `run-analyze.ts` sizes the LadybugDB buffer pool from this, so it adds
   *  the manifest's `totalRows` back in (the hint only ever shrinks the pool,
   *  so under-reporting would starve the COPY at exactly the scale this
   *  feature targets). */
  get relationshipCount(): number {
    return this.real.relationshipCount + this.srcIx.length;
  }
  removeNode(nodeId: string): boolean {
    return this.real.removeNode(nodeId);
  }
  removeNodesByFile(filePath: string): number {
    return this.real.removeNodesByFile(filePath);
  }
  /**
   * Deliberately conservative. The dedup Set holds compact keys derived from a
   * relationship's endpoints ({@link dedupKey}), and a bare id alone cannot be
   * turned back into one — so a streamed edge is not directly identifiable here.
   *
   * Rather than risk the silent case (returning `false` for an edge that IS on
   * disk and cannot be recalled), anything the real graph does not hold is
   * treated as possibly-streamed once streaming has begun, and fails loudly. A
   * genuinely-absent id therefore throws too, where the object-based graph would
   * return `false`; that is acceptable because the only production caller is the
   * COBOL resolver, which runs BEFORE the sink is armed and so takes the branch
   * below.
   *
   * NOTE this diverges from {@link KnowledgeGraph.removeRelationship}, which
   * returns `false` for an id it does not hold. Pinned by a test so the
   * divergence stays deliberate.
   */
  removeRelationship(relationshipId: string): boolean {
    if (this.real.removeRelationship(relationshipId)) return true;
    if (this.srcIx.length > 0) throw new StreamedRelationshipRemovalError(relationshipId);
    return false;
  }
}
