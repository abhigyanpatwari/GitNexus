/**
 * Streaming structural graph-emit sink (issue #2680).
 *
 * The in-memory `KnowledgeGraph` retains every node and relationship on the
 * main thread for the whole pipeline, so `analyze`'s peak heap is O(repo)
 * (#2649 measured ~2.1 KB of heap per node at Linux-kernel scale). Measurement
 * on a kernel-shaped synthetic graph (400k nodes, 2.7 edges/node) locates that
 * cost precisely:
 *
 *   nodes only ......... 367 B/node
 *   nodes + edges ..... 2075 B/node   <- reproduces the #2649 figure
 *   => the relationship layer is 83% of graph heap, ~646 B/edge
 *
 * ~646 B for an object holding four short strings is the cost of storing each
 * edge four times over (`relationshipMap`, a `relationshipsByType` bucket, and
 * both endpoints' `edgeIdsByNode` Sets) plus an `id` that concatenates both
 * endpoint ids. Dropping only the two redundant indexes saves 174 of those
 * 648 B/edge (~1.3x overall) — not enough; the objects and id strings
 * themselves have to leave the heap.
 *
 * `GraphEmitSink` is the structural sibling of {@link PdgEmitSink}: a
 * write-routing façade over the real graph that sends relationships no
 * mid-pipeline phase reads back straight to bounded CSV-on-disk writers and
 * **never stores them**. Nodes are NOT streamed — they are only 17% of the
 * heap and two scope-resolution index builders (`buildGraphNodeLookup`,
 * `buildGraphCallableAnchorIndex`) scan them.
 *
 * Retained share = 0.17 (nodes) + 0.83 * 0.21 (retained edges) = 0.344,
 * i.e. a ~2.9x reduction of graph heap. This is NOT O(chunk): node identity
 * and the resolution registries stay O(repo). True O(chunk) needs DB-side
 * resolution and DB-side Leiden (#2337).
 *
 * Byte-identity: the sink reuses the SAME row builder (`buildRelRow`), header
 * (`REL_CSV_HEADER`), and label derivation (`getNodeLabel`) as
 * `streamAllCSVsToDisk`, and mirrors `RelPairRouter`'s validity check, so the
 * streamed row SET is identical to the whole-graph emit's and the bulk COPY
 * loads the same rows. Guarantee is set-level, not byte-level: rows stream in
 * emit order and are not re-sorted under `GITNEXUS_SORT_GRAPH_OUTPUT`.
 */

import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { REL_CSV_HEADER, buildRelRow } from './csv-generator.js';
import { getNodeLabel } from './rel-pair-routing.js';
import { NODE_TABLES } from './schema.js';
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
 * a silent-wrong-graph bug, not a crash. The differential round-trip test is
 * what catches drift.
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
export class GraphEmitSink implements KnowledgeGraph {
  private readonly validTables: Set<string>;
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
   * Endpoint ids of streamed relationships, consumed by the local-symbol
   * pruner via {@link hasStreamedSemanticEdge}.
   *
   * Both endpoints count as "semantic". The pruner treats any outgoing edge as
   * semantic, and any incoming edge as semantic unless it is the structural
   * `File -> DEFINES` edge — and `DEFINES` is retained in memory, so no
   * streamed edge is ever a DEFINES. Every streamed edge therefore makes both
   * of its endpoints semantically referenced.
   */
  private readonly streamedEndpoints = new Set<string>();
  private finalized = false;
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
    this.validTables = new Set<string>(NODE_TABLES as readonly string[]);
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

  addRelationship(relationship: GraphRelationship): void {
    if (RETAINED_REL_TYPES.has(relationship.type)) {
      this.real.addRelationship(relationship);
      return;
    }
    // Mirror KnowledgeGraph.addRelationship's first-writer-wins dedup.
    if (this.streamedIds.has(relationship.id)) return;

    const fromLabel = getNodeLabel(relationship.sourceId);
    const toLabel = getNodeLabel(relationship.targetId);
    // Skip edges whose endpoint labels are not valid node tables — mirrors
    // `RelPairRouter` exactly so the streamed set matches the whole-graph set.
    if (!this.validTables.has(fromLabel) || !this.validTables.has(toLabel)) return;

    const pairKey = `${fromLabel}|${toLabel}`;
    let writer = this.relWriters.get(pairKey);
    if (writer === undefined) {
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
    writer.addRow(buildRelRow(relationship));
    this.streamedIds.add(relationship.id);
    this.streamedEndpoints.add(relationship.sourceId);
    this.streamedEndpoints.add(relationship.targetId);
  }

  /**
   * True when `nodeId` is an endpoint of a relationship that has streamed to
   * disk. The local-symbol pruner consults this alongside its in-memory scan:
   * without it, a block-local symbol whose only reference is a streamed CALLS
   * edge looks unreferenced and gets pruned, leaving the streamed CSV row
   * pointing at a node with no row (a dangling edge at COPY).
   */
  hasStreamedSemanticEdge = (nodeId: string): boolean => this.streamedEndpoints.has(nodeId);

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
    return this.real.relationships;
  }
  iterNodes(): IterableIterator<GraphNode> {
    return this.real.iterNodes();
  }
  iterRelationships(): IterableIterator<GraphRelationship> {
    return this.real.iterRelationships();
  }
  iterRelationshipsByType(type: RelationshipType): IterableIterator<GraphRelationship> {
    return this.real.iterRelationshipsByType(type);
  }
  forEachNode(fn: (node: GraphNode) => void): void {
    this.real.forEachNode(fn);
  }
  forEachRelationship(fn: (rel: GraphRelationship) => void): void {
    this.real.forEachRelationship(fn);
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
    return this.real.relationshipCount;
  }
  removeNode(nodeId: string): boolean {
    return this.real.removeNode(nodeId);
  }
  removeNodesByFile(filePath: string): number {
    return this.real.removeNodesByFile(filePath);
  }
  removeRelationship(relationshipId: string): boolean {
    if (this.streamedIds.has(relationshipId)) {
      throw new StreamedRelationshipRemovalError(relationshipId);
    }
    return this.real.removeRelationship(relationshipId);
  }
}
