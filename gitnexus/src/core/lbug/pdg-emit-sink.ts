/**
 * Streaming PDG graph-emit sink (issue #2202).
 *
 * The PDG emit loop (`scope-resolution/pipeline/run.ts`, the `--pdg` block)
 * materializes BasicBlock nodes + intra-file PDG edges (CFG / REACHING_DEF /
 * CDG / POST_DOMINATE / TAINTED / SANITIZES) into the in-memory
 * `KnowledgeGraph`. At full-kernel scale that layer dominates peak RSS
 * (~7 GB at 511K BasicBlocks; ~100 GB extrapolated to the full kernel → OOM).
 *
 * `PdgEmitSink` is a write-routing façade over the real graph: the emit
 * functions are write-only and compute every edge endpoint by deterministic id
 * (audited — no read-back), so the sink can route BasicBlock node rows and PDG
 * edge rows straight to bounded CSV-on-disk writers and **never store them**.
 * The graph's resident size stops growing with the PDG layer → peak RSS becomes
 * O(chunk buffer), not O(graph). Everything else (structural nodes/edges, the
 * whole-program M4 TAINT_PATH edges) is delegated to the real graph unchanged.
 *
 * Why synchronous writers? The whole PDG emit (`runScopeResolution` and its
 * per-file loop) is synchronous — there is no `await` point to drain an async
 * stream, so a `BufferedCSVWriter` (Node `WriteStream`) would accumulate
 * unwritten chunks in process memory across millions of rows, defeating the RSS
 * bound. `fs.writeSync` goes straight to the OS; resident memory is bounded to
 * one `chunkRows` buffer. This mirrors the sync-shard pattern in
 * `storage/parsedfile-store.ts`.
 *
 * Byte-identity (issue acceptance): the sink reuses the SAME shared row
 * builders (`buildBasicBlockRow`, `buildRelRow`) and label derivation
 * (`getNodeLabel`) as `streamAllCSVsToDisk`, so the streamed CSV line SET is
 * identical to the whole-graph emit's. Under `GITNEXUS_SORT_GRAPH_OUTPUT`
 * (order-independent) the persisted graph is byte-identical regardless of the
 * order rows were streamed in. No global dedup set is kept: BasicBlock ids are
 * unique by construction and REACHING_DEF facts are deduped before emit, so the
 * graph's Map-idempotency never actually drops a PDG row — the differential
 * fingerprint test (issue #2202 U6) is the byte-identity guard.
 */

import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import {
  BASICBLOCK_CSV_HEADER,
  REL_CSV_HEADER,
  buildBasicBlockRow,
  buildRelRow,
} from './csv-generator.js';
import { getNodeLabel } from './rel-pair-routing.js';
import { NODE_TABLES, type NodeTableName } from './schema.js';

/**
 * PDG edge types streamed per-file (all intra-block BasicBlock→BasicBlock).
 * `TAINT_PATH` is intentionally excluded — it is the whole-program M4 edge
 * (Function→Function), computed in a separate post-resolution phase over the
 * complete CALLS graph, and stays in the in-memory graph (it is small and is
 * persisted by the normal whole-graph emit).
 */
const PDG_EDGE_TYPES: ReadonlySet<RelationshipType> = new Set<RelationshipType>([
  'CFG',
  'REACHING_DEF',
  'CDG',
  'POST_DOMINATE',
  'TAINTED',
  'SANITIZES',
]);

/** Default streamed-write buffer (rows). Matches the whole-graph emit's
 *  `FLUSH_EVERY` order of magnitude; overridable via `GITNEXUS_PDG_EMIT_CHUNK_SIZE`. */
export const DEFAULT_PDG_EMIT_CHUNK_ROWS = 500;

/**
 * Synchronous buffered CSV writer. Buffers up to `chunkRows` rows, then issues
 * one `fs.writeSync` straight to the OS (no in-process stream buffer). Header
 * is written into the buffer at construction and is NOT counted in `rows`
 * (matching `BufferedCSVWriter` semantics, so manifest row counts line up).
 */
class SyncCsvWriter {
  private fd: number;
  private buf: string[] = [];
  rows = 0;

  constructor(
    readonly csvPath: string,
    header: string,
    private readonly chunkRows: number,
  ) {
    this.fd = fs.openSync(csvPath, 'w');
    this.buf.push(header);
  }

  addRow(row: string): void {
    this.buf.push(row);
    this.rows++;
    if (this.buf.length >= this.chunkRows) this.flush();
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    fs.writeSync(this.fd, this.buf.join('\n') + '\n');
    this.buf.length = 0;
  }

  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

/**
 * COPY manifest produced by {@link PdgEmitSink.finalize}. Shaped to merge
 * directly into `StreamedCSVResult` so `loadGraphToLbug` COPYs the streamed
 * PDG CSVs through the same per-table / per-pair loops as the structural CSVs.
 * Paths are absolute, so persistence needs no dir recomputation.
 */
export interface PdgEmitManifest {
  /** Node-table CSVs (only `BasicBlock` today). */
  readonly nodeFiles: Map<NodeTableName, { csvPath: string; rows: number }>;
  /** pairKey (`From|To`) → per-pair edge CSV. */
  readonly relsByPair: Map<string, { csvPath: string; rows: number }>;
  /** Header shared by every per-pair file (matches the whole-graph emit). */
  readonly relHeader: string;
}

/**
 * Write-routing graph façade. Construct one per analyze run, thread it into the
 * per-language `runScopeResolution` calls in place of the real graph during the
 * `--pdg` emit, then {@link finalize} once after the last language.
 */
export class PdgEmitSink implements KnowledgeGraph {
  private readonly validTables: Set<string>;
  private bbWriter: SyncCsvWriter | undefined;
  /** pairKey (`From|To`) → writer. PDG edges are all `BasicBlock|BasicBlock`,
   *  but the map keeps the sink general and the manifest pair-keyed. */
  private readonly relWriters = new Map<string, SyncCsvWriter>();
  private finalized = false;

  constructor(
    private readonly real: KnowledgeGraph,
    private readonly pdgCsvDir: string,
    private readonly chunkRows: number = DEFAULT_PDG_EMIT_CHUNK_ROWS,
  ) {
    this.validTables = new Set<string>(NODE_TABLES as readonly string[]);
    // Clear any streamed CSVs left by a previous (possibly crashed) run so a
    // later COPY never picks up stale rows.
    fs.rmSync(pdgCsvDir, { recursive: true, force: true });
    fs.mkdirSync(pdgCsvDir, { recursive: true });
  }

  // ── routed writes ──────────────────────────────────────────────────────────

  addNode(node: GraphNode): void {
    if (node.label === 'BasicBlock') {
      if (this.bbWriter === undefined) {
        this.bbWriter = new SyncCsvWriter(
          path.join(this.pdgCsvDir, 'basicblock.csv'),
          BASICBLOCK_CSV_HEADER,
          this.chunkRows,
        );
      }
      this.bbWriter.addRow(buildBasicBlockRow(node));
      return;
    }
    this.real.addNode(node);
  }

  addRelationship(relationship: GraphRelationship): void {
    if (PDG_EDGE_TYPES.has(relationship.type)) {
      const fromLabel = getNodeLabel(relationship.sourceId);
      const toLabel = getNodeLabel(relationship.targetId);
      // Skip edges whose endpoint labels are not valid node tables — mirrors
      // `RelPairRouter` exactly so the streamed set matches the whole-graph set.
      if (!this.validTables.has(fromLabel) || !this.validTables.has(toLabel)) return;
      const pairKey = `${fromLabel}|${toLabel}`;
      let writer = this.relWriters.get(pairKey);
      if (writer === undefined) {
        writer = new SyncCsvWriter(
          path.join(this.pdgCsvDir, `rel_${fromLabel}_${toLabel}.csv`),
          REL_CSV_HEADER,
          this.chunkRows,
        );
        this.relWriters.set(pairKey, writer);
      }
      writer.addRow(buildRelRow(relationship));
      return;
    }
    this.real.addRelationship(relationship);
  }

  /** Flush + close every streamed writer and return the COPY manifest. */
  finalize(): PdgEmitManifest {
    if (this.finalized) throw new Error('PdgEmitSink.finalize() called twice');
    this.finalized = true;

    const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
    if (this.bbWriter !== undefined) {
      this.bbWriter.close();
      nodeFiles.set('BasicBlock' as NodeTableName, {
        csvPath: this.bbWriter.csvPath,
        rows: this.bbWriter.rows,
      });
    }

    const relsByPair = new Map<string, { csvPath: string; rows: number }>();
    for (const [pairKey, writer] of this.relWriters) {
      writer.close();
      relsByPair.set(pairKey, { csvPath: writer.csvPath, rows: writer.rows });
    }

    return { nodeFiles, relsByPair, relHeader: REL_CSV_HEADER };
  }

  // ── delegated reads / non-PDG mutations ─────────────────────────────────────
  // The PDG emit functions never call these on the routed graph, but the
  // façade implements the full KnowledgeGraph surface so it is a drop-in for
  // the emit target and any non-PDG write transparently reaches the real graph.

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
    return this.real.removeRelationship(relationshipId);
  }
}
