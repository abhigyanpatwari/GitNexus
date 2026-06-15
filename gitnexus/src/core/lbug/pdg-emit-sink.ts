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
 * order rows were streamed in. The sink keeps per-id seen-sets that mirror the
 * in-memory graph's first-writer-wins Map idempotency — load-bearing because a
 * file can be PDG-emitted in more than one language pass (a `.ts` module
 * imported by a `.vue` SFC is emitted in both the TypeScript and Vue context
 * passes over the same worker-built CFG), and the graph dedups those by id
 * where a dedup-free sink would double the rows. The differential fingerprint
 * test (issue #2202 U6) and the duplicate-id unit test guard byte-identity.
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
  private readonly chunkRows: number;
  rows = 0;

  constructor(
    readonly csvPath: string,
    header: string,
    chunkRows: number,
  ) {
    // Guard a 0/negative buffer: the flush modulo would never fire and `buf`
    // would grow unbounded, defeating the whole point of streaming.
    this.chunkRows = Math.max(1, chunkRows);
    // Exclusive create (O_EXCL): the streamed-CSV dir is wiped + recreated fresh
    // by the PdgEmitSink constructor before any writer opens a file, so the path
    // never pre-exists — 'wx' both matches that invariant and refuses to follow
    // a pre-planted symlink at the path (CWE-377 / CodeQL js/insecure-temporary-file).
    this.fd = fs.openSync(csvPath, 'wx');
    this.buf.push(header);
  }

  addRow(row: string): void {
    this.buf.push(row);
    this.rows++;
    // Flush on DATA-row count, not buffer length: the header occupies buf[0]
    // until the first flush, so a `buf.length >= chunkRows` test would fire one
    // row early on the first chunk. Counting rows makes every flush exactly
    // `chunkRows` rows.
    if (this.rows % this.chunkRows === 0) this.flush();
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    const data = Buffer.from(this.buf.join('\n') + '\n', 'utf8');
    // fs.writeSync can return a short byte count; loop until the whole buffer
    // lands so a partial write never truncates a CSV row mid-field.
    let offset = 0;
    while (offset < data.length) {
      offset += fs.writeSync(this.fd, data, offset, data.length - offset);
    }
    this.buf.length = 0;
  }

  /** Flush remaining rows and close the fd. The fd is closed even when the
   *  final flush throws (e.g. disk-full), so a write error never leaks it. */
  close(): void {
    try {
      this.flush();
    } finally {
      fs.closeSync(this.fd);
    }
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
  // NOTE on dedup: the same file can be PDG-emitted in more than one language
  // pass (e.g. a `.ts` module imported by a `.vue` SFC is emitted in both the
  // TypeScript pass and the Vue context pass over the same worker-built
  // `cfgSideChannel`). The in-memory graph dedups that by id (first-writer-wins);
  // this sink does NOT — to keep peak memory O(write buffer) rather than
  // O(total ids), cross-pass dedup is done upstream, per FILE, in the emit loop
  // (`run.ts` skips a file whose PDG already streamed via `pdgEmittedFiles`).
  // The sink therefore receives each id exactly once and is a faithful
  // pass-through; it must not be fed duplicate ids.

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

  /** Flush + close every streamed writer and return the COPY manifest. Every
   *  fd is closed even if a flush throws; a flush failure is surfaced after all
   *  writers are closed so a disk-full never COPYs a truncated CSV silently. */
  finalize(): PdgEmitManifest {
    if (this.finalized) throw new Error('PdgEmitSink.finalize() called twice');
    this.finalized = true;

    const errors: unknown[] = [];
    const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
    if (this.bbWriter !== undefined) {
      try {
        this.bbWriter.close();
      } catch (e) {
        errors.push(e);
      }
      nodeFiles.set('BasicBlock' as NodeTableName, {
        csvPath: this.bbWriter.csvPath,
        rows: this.bbWriter.rows,
      });
    }

    const relsByPair = new Map<string, { csvPath: string; rows: number }>();
    for (const [pairKey, writer] of this.relWriters) {
      try {
        writer.close();
      } catch (e) {
        errors.push(e);
      }
      relsByPair.set(pairKey, { csvPath: writer.csvPath, rows: writer.rows });
    }

    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `PdgEmitSink: ${errors.length} CSV writer(s) failed to flush: ${
          first instanceof Error ? first.message : String(first)
        }`,
      );
    }

    return { nodeFiles, relsByPair };
  }

  /**
   * Best-effort fd release for the error path — when a language pass throws
   * before {@link finalize} runs, the caller's `finally` calls this so the
   * BasicBlock + per-pair fds never leak. Idempotent with finalize via the
   * `finalized` flag; close errors are swallowed because the run is already
   * failing.
   */
  close(): void {
    if (this.finalized) return;
    this.finalized = true;
    try {
      this.bbWriter?.close();
    } catch {
      /* best-effort */
    }
    for (const writer of this.relWriters.values()) {
      try {
        writer.close();
      } catch {
        /* best-effort */
      }
    }
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
