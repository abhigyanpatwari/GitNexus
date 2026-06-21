/**
 * CSV Generator for LadybugDB Hybrid Schema
 *
 * Streams CSV rows directly to disk files in a single pass over graph nodes.
 * File contents are lazy-read from disk per-node to avoid holding the entire
 * repo in RAM. Rows are buffered (FLUSH_EVERY) before writing to minimize
 * per-row Promise overhead.
 *
 * RFC 4180 Compliant:
 * - Fields containing commas, double quotes, or newlines are enclosed in double quotes
 * - Double quotes within fields are escaped by doubling them ("")
 * - All fields are consistently quoted for safety with code content
 */

import fs from 'fs/promises';
import { createWriteStream, WriteStream } from 'fs';
import path from 'path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import { NodeTableName, NODE_TABLES } from './schema.js';
import { RelPairRouter } from './rel-pair-routing.js';
import { parseTruthyEnv } from '../ingestion/utils/env.js';

/**
 * Deterministic output ordering — optional (out-of-core / windowed-resolve
 * enabler). When `GITNEXUS_SORT_GRAPH_OUTPUT` is set, nodes and relationships
 * are emitted sorted by their (unique, dedup-key) graph `id` rather than in
 * graph-insertion order, making the CSV a pure function of the graph's node/edge
 * SET instead of of emit order. Default off returns the iterator untouched, so
 * the bytes are identical to today. With it on, a windowed/out-of-core emit
 * (the later windowed-resolve work) need only reproduce the same edge SET, not the global insertion order —
 * which removes "CSV row order == Map insertion order" as a byte-identical
 * hazard for every later windowing step.
 */
const byGraphId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const orderedNodes = (graph: KnowledgeGraph, sorted: boolean): Iterable<GraphNode> =>
  sorted ? [...graph.iterNodes()].sort(byGraphId) : graph.iterNodes();

const orderedRelationships = (
  graph: KnowledgeGraph,
  sorted: boolean,
): Iterable<GraphRelationship> =>
  sorted ? [...graph.iterRelationships()].sort(byGraphId) : graph.iterRelationships();

/** Flush buffered rows to disk every N rows */
const FLUSH_EVERY = 500;

/**
 * Yield the event loop every N relationship rows during the emit pass (#2226 F4)
 * so a concurrent node COPY (the overlap in loadGraphToLbug) and write-stream
 * drain callbacks get scheduling time during long synchronous emit stretches.
 * Scheduling-only — never changes row content or order (byte-identical). Tuning
 * constant, not load-bearing.
 */
const REL_YIELD_EVERY = 5000;

// ============================================================================
// CSV ESCAPE UTILITIES
// ============================================================================

export const sanitizeUTF8 = (str: string): string => {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[\uFFFE\uFFFF]/g, '');
};

export const escapeCSVField = (value: string | number | undefined | null): string => {
  if (value === undefined || value === null) return '""';
  let str = String(value);
  str = sanitizeUTF8(str);
  return `"${str.replace(/"/g, '""')}"`;
};

export const escapeCSVNumber = (
  value: number | undefined | null,
  defaultValue: number = -1,
): string => {
  if (value === undefined || value === null) return String(defaultValue);
  return String(value);
};

// ============================================================================
// CONTENT EXTRACTION (lazy — reads from disk on demand)
// ============================================================================

export const isBinaryContent = (content: string): boolean => {
  if (!content || content.length === 0) return false;
  const sample = content.slice(0, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 127) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.1;
};

/**
 * LRU content cache — avoids re-reading the same source file for every
 * symbol defined in it. Sized generously so most files stay cached during
 * the single-pass node iteration.
 */
class FileContentCache {
  private cache = new Map<string, string>();
  private accessOrder: string[] = [];
  private maxSize: number;
  private repoPath: string;

  constructor(repoPath: string, maxSize: number = 3000) {
    this.repoPath = repoPath;
    this.maxSize = maxSize;
  }

  async get(relativePath: string): Promise<string> {
    if (!relativePath) return '';
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) {
      // Move to end of accessOrder (LRU promotion)
      const idx = this.accessOrder.indexOf(relativePath);
      if (idx !== -1) {
        this.accessOrder.splice(idx, 1);
        this.accessOrder.push(relativePath);
      }
      return cached;
    }
    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      this.set(relativePath, content);
      return content;
    } catch {
      this.set(relativePath, '');
      return '';
    }
  }

  private set(key: string, value: string) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }
}

const extractContent = async (node: GraphNode, contentCache: FileContentCache): Promise<string> => {
  const filePath = node.properties.filePath;
  const content = await contentCache.get(filePath);
  if (!content) return '';
  if (node.label === 'Folder') return '';
  if (isBinaryContent(content)) return '[Binary file - content not stored]';

  if (node.label === 'File') {
    const MAX_FILE_CONTENT = 10000;
    return content.length > MAX_FILE_CONTENT
      ? content.slice(0, MAX_FILE_CONTENT) + '\n... [truncated]'
      : content;
  }

  const startLine = node.properties.startLine;
  const endLine = node.properties.endLine;
  if (startLine === undefined || endLine === undefined) return '';

  const lines = content.split('\n');
  const start = Math.max(0, startLine - 2);
  const end = Math.min(lines.length - 1, endLine + 2);
  const snippet = lines.slice(start, end + 1).join('\n');
  const MAX_SNIPPET = 5000;
  return snippet.length > MAX_SNIPPET
    ? snippet.slice(0, MAX_SNIPPET) + '\n... [truncated]'
    : snippet;
};

// ============================================================================
// BUFFERED CSV WRITER
// ============================================================================

class BufferedCSVWriter {
  private ws: WriteStream;
  private buffer: string[] = [];
  rows = 0;

  constructor(filePath: string, header: string) {
    this.ws = createWriteStream(filePath, 'utf-8');
    // Large repos flush many times — raise listener cap to avoid MaxListenersExceededWarning
    this.ws.setMaxListeners(50);
    this.buffer.push(header);
  }

  /**
   * Buffer a row. Returns a promise ONLY when the buffer crossed FLUSH_EVERY
   * and a disk write was issued; otherwise returns `undefined` so the caller
   * can skip awaiting (#2203 U3) — avoiding a microtask tick on every buffered
   * row (millions at scale). The flush promise still resolves on drain, so
   * backpressure is preserved on the rows that actually write.
   */
  addRow(row: string): Promise<void> | undefined {
    this.buffer.push(row);
    this.rows++;
    if (this.buffer.length >= FLUSH_EVERY) {
      return this.flush();
    }
    return undefined;
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer.length = 0;
    return new Promise((resolve, reject) => {
      this.ws.once('error', reject);
      const ok = this.ws.write(chunk);
      if (ok) {
        this.ws.removeListener('error', reject);
        resolve();
      } else {
        this.ws.once('drain', () => {
          this.ws.removeListener('error', reject);
          resolve();
        });
      }
    });
  }

  async finish(): Promise<void> {
    await this.flush();
    return new Promise((resolve, reject) => {
      this.ws.end(() => resolve());
      this.ws.on('error', reject);
    });
  }
}

// ============================================================================
// STREAMING CSV GENERATION — SINGLE PASS
// ============================================================================

/** Canonical relationship CSV header — shared by the emit pass and the
 * `splitRelCsvByLabelPair` differential oracle. */
export const REL_CSV_HEADER = 'from,to,type,confidence,reason,step';

/** Build the escaped CSV row (no trailing newline) for one relationship.
 * Single source of the relationship row bytes — used by the emit pass and by
 * the byte-identity differential test that feeds the legacy split oracle. */
export const buildRelRow = (rel: GraphRelationship): string =>
  [
    escapeCSVField(rel.sourceId),
    escapeCSVField(rel.targetId),
    escapeCSVField(rel.type),
    escapeCSVNumber(rel.confidence, 1.0),
    escapeCSVField(rel.reason),
    escapeCSVNumber(rel.step, 0),
  ].join(',');

/** Canonical BasicBlock node CSV header — taint/PDG substrate (issue #2080).
 * No `name` column; blocks are identified by id + source span. Shared by the
 * whole-graph emit pass and the streaming PDG emit sink (issue #2202) so the
 * two paths produce byte-identical BasicBlock rows by construction. */
export const BASICBLOCK_CSV_HEADER = 'id,filePath,startLine,endLine,text,callees,calleeIds';

/** Build the escaped CSV row (no trailing newline) for one BasicBlock node.
 * Single source of the BasicBlock row bytes — used by `streamAllCSVsToDisk`
 * and by the streaming `PdgEmitSink` (issue #2202). `callees` is a comma-free
 * (space-joined) list of the leaf callee names invoked in the block — the
 * statement-precise inter-procedural reach substrate (the field is itself a CSV
 * cell, so the inner separator must NOT be a comma). `calleeIds` is the SOUND
 * parallel to `callees`: the space-joined RESOLVED callee symbol ids for the
 * block (#2227 follow-up), likewise a comma-free cell. */
export const buildBasicBlockRow = (node: GraphNode): string =>
  [
    escapeCSVField(node.id),
    escapeCSVField(node.properties.filePath || ''),
    escapeCSVNumber(node.properties.startLine, -1),
    escapeCSVNumber(node.properties.endLine, -1),
    escapeCSVField(node.properties.text || ''),
    escapeCSVField(String(node.properties.callees ?? '')),
    escapeCSVField(String(node.properties.calleeIds ?? '')),
  ].join(',');

export interface StreamedCSVResult {
  nodeFiles: Map<NodeTableName, { csvPath: string; rows: number }>;
  /** pairKey (`From|To`) → per-FROM→TO-label-pair CSV file. */
  relsByPair: Map<string, { csvPath: string; rows: number }>;
  /** Header line shared by every per-pair file. */
  relHeader: string;
  /** Edges skipped because an endpoint label is not a valid node table. */
  skippedRels: number;
  /** Edges routed to a per-pair file. */
  totalValidRels: number;
}

/**
 * Stream all CSV data directly to disk files.
 * Iterates graph nodes exactly ONCE — routes each node to the right writer.
 * File contents are lazy-read from disk with a generous LRU cache.
 *
 * `onNodePhaseComplete` (optional, #2203 parallelism leg): fired exactly once,
 * right after every node CSV is fully flushed to disk and BEFORE the
 * relationship pass starts writing any `rel_*.csv`. It receives the finished
 * node-file manifest so the caller can begin `COPY`-ing nodes while this
 * function keeps generating relationship CSVs (the only single-writer-safe
 * overlap — node `COPY` ‖ relationship emit). It is intentionally NOT awaited:
 * the relationship pass proceeds concurrently with whatever the caller
 * schedules. A synchronous throw from the callback is allowed and propagates out
 * of this function (rejecting the returned promise) — it is raised before the
 * relationship pass begins, so no `rel_*.csv` is written; `loadGraphToLbug` uses
 * this to surface its PDG-manifest collision guard. The callback must NOT, however,
 * schedule un-awaited async work that can reject unobserved. Absent ⇒ today's
 * behavior, byte-for-byte.
 */
export const streamAllCSVsToDisk = async (
  graph: KnowledgeGraph,
  repoPath: string,
  csvDir: string,
  onNodePhaseComplete?: (nodeFiles: Map<NodeTableName, { csvPath: string; rows: number }>) => void,
): Promise<StreamedCSVResult> => {
  // Deterministic (id-sorted) node/relationship row order when enabled;
  // default off = today's graph-insertion order (byte-identical).
  const sortOutput = parseTruthyEnv(process.env.GITNEXUS_SORT_GRAPH_OUTPUT);
  // Remove stale CSVs from previous crashed runs, then recreate
  try {
    await fs.rm(csvDir, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(csvDir, { recursive: true });

  // We open ~30 concurrent write-streams; raise process limit to suppress
  // MaxListenersExceededWarning (restored after all streams finish).
  const prevMax = process.getMaxListeners();
  process.setMaxListeners(prevMax + 40);

  // try/finally so the listener bump is ALWAYS restored — including the
  // rel-routing throw path (#2203 U2) and any node-writer finish() rejection,
  // not just the success path (avoids leaking +40 listeners across failed runs
  // in long-lived hosts / the test suite).
  try {
    const contentCache = new FileContentCache(repoPath);

    // Create writers for every node type up-front
    const fileWriter = new BufferedCSVWriter(
      path.join(csvDir, 'file.csv'),
      'id,name,filePath,content',
    );
    const folderWriter = new BufferedCSVWriter(path.join(csvDir, 'folder.csv'), 'id,name,filePath');
    const codeElementHeader = 'id,name,filePath,startLine,endLine,isExported,content,description';
    const functionWriter = new BufferedCSVWriter(
      path.join(csvDir, 'function.csv'),
      codeElementHeader,
    );
    const classWriter = new BufferedCSVWriter(path.join(csvDir, 'class.csv'), codeElementHeader);
    const interfaceWriter = new BufferedCSVWriter(
      path.join(csvDir, 'interface.csv'),
      codeElementHeader,
    );
    const methodHeader =
      'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType';
    const methodWriter = new BufferedCSVWriter(path.join(csvDir, 'method.csv'), methodHeader);
    const codeElemWriter = new BufferedCSVWriter(
      path.join(csvDir, 'codeelement.csv'),
      codeElementHeader,
    );
    const communityWriter = new BufferedCSVWriter(
      path.join(csvDir, 'community.csv'),
      'id,label,heuristicLabel,keywords,description,enrichedBy,cohesion,symbolCount',
    );
    const processWriter = new BufferedCSVWriter(
      path.join(csvDir, 'process.csv'),
      'id,label,heuristicLabel,processType,stepCount,communities,entryPointId,terminalId',
    );

    // Section nodes have an extra 'level' column
    const sectionWriter = new BufferedCSVWriter(
      path.join(csvDir, 'section.csv'),
      'id,name,filePath,startLine,endLine,level,content,description',
    );

    // Route nodes for API endpoint mapping
    const routeWriter = new BufferedCSVWriter(
      path.join(csvDir, 'route.csv'),
      'id,name,filePath,responseKeys,errorKeys,middleware,method,handlerSymbolId',
    );

    // Tool nodes for MCP tool definitions
    const toolWriter = new BufferedCSVWriter(
      path.join(csvDir, 'tool.csv'),
      'id,name,filePath,description',
    );

    // BasicBlock nodes — taint/PDG substrate (issue #2080). No `name` column;
    // blocks are identified by id + source span. Emitted by no phase yet.
    const basicBlockWriter = new BufferedCSVWriter(
      path.join(csvDir, 'basicblock.csv'),
      BASICBLOCK_CSV_HEADER,
    );

    // Multi-language node types share the same CSV shape (no isExported column)
    const multiLangHeader = 'id,name,filePath,startLine,endLine,content,description';
    const MULTI_LANG_TYPES = [
      'Struct',
      'Enum',
      'Macro',
      'Typedef',
      'Union',
      'Namespace',
      'Trait',
      'Impl',
      'TypeAlias',
      'Const',
      'Static',
      'Variable',
      'Property',
      'Record',
      'Delegate',
      'Annotation',
      'Constructor',
      'Template',
      'Module',
    ] as const;
    const propertyHeader = 'id,name,filePath,startLine,endLine,content,description,declaredType';
    const multiLangWriters = new Map<string, BufferedCSVWriter>();
    for (const t of MULTI_LANG_TYPES) {
      multiLangWriters.set(
        t,
        new BufferedCSVWriter(
          path.join(csvDir, `${t.toLowerCase()}.csv`),
          t === 'Property' ? propertyHeader : multiLangHeader,
        ),
      );
    }

    const codeWriterMap: Record<string, BufferedCSVWriter> = {
      Function: functionWriter,
      Class: classWriter,
      Interface: interfaceWriter,
      CodeElement: codeElemWriter,
    };

    // Deduplicate all node types — the pipeline can produce duplicate IDs across
    // all symbol types (Class, Method, Function, etc.), not just File nodes.
    // A single Set covering every label prevents PK violations on COPY.
    const seenNodeIds = new Set<string>();

    // --- SINGLE PASS over all nodes ---
    for (const node of orderedNodes(graph, sortOutput)) {
      if (seenNodeIds.has(node.id)) continue;
      seenNodeIds.add(node.id);

      // addRow returns a promise only when it flushes; awaiting it once after the
      // switch (instead of `await`-ing every addRow) skips a per-row microtask
      // tick on the ~FLUSH_EVERY-1 buffered rows between flushes (#2203 U3).
      let pending: Promise<void> | undefined;
      switch (node.label) {
        case 'File': {
          const content = await extractContent(node, contentCache);
          pending = fileWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(content),
            ].join(','),
          );
          break;
        }
        case 'Folder':
          pending = folderWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
            ].join(','),
          );
          break;
        case 'Community': {
          const keywords = node.properties.keywords || [];
          const keywordsStr = `[${keywords.map((k: string) => `'${k.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/,/g, '\\,')}'`).join(',')}]`;
          pending = communityWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.heuristicLabel || ''),
              keywordsStr,
              escapeCSVField(node.properties.description || ''),
              escapeCSVField(node.properties.enrichedBy || 'heuristic'),
              escapeCSVNumber(node.properties.cohesion, 0),
              escapeCSVNumber(node.properties.symbolCount, 0),
            ].join(','),
          );
          break;
        }
        case 'Process': {
          const communities = node.properties.communities || [];
          const communitiesStr = `[${communities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',')}]`;
          pending = processWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.heuristicLabel || ''),
              escapeCSVField(node.properties.processType || ''),
              escapeCSVNumber(node.properties.stepCount, 0),
              escapeCSVField(communitiesStr),
              escapeCSVField(node.properties.entryPointId || ''),
              escapeCSVField(node.properties.terminalId || ''),
            ].join(','),
          );
          break;
        }
        case 'Method': {
          const content = await extractContent(node, contentCache);
          pending = methodWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              node.properties.isExported ? 'true' : 'false',
              escapeCSVField(content),
              escapeCSVField(node.properties.description || ''),
              escapeCSVNumber(node.properties.parameterCount, 0),
              escapeCSVField(node.properties.returnType || ''),
            ].join(','),
          );
          break;
        }
        case 'Section': {
          const content = await extractContent(node, contentCache);
          pending = sectionWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              escapeCSVNumber(node.properties.level, 1),
              escapeCSVField(content),
              escapeCSVField(node.properties.description || ''),
            ].join(','),
          );
          break;
        }
        case 'Route': {
          const responseKeys = node.properties.responseKeys || [];
          // LadybugDB array literal inside a quoted CSV field: escapeCSVField wraps in "..."
          // and the array uses single-quoted elements
          const keysStr = `[${responseKeys.map((k: string) => `'${k.replace(/'/g, "''")}'`).join(',')}]`;
          const errorKeys = node.properties.errorKeys || [];
          const errorKeysStr = `[${errorKeys.map((k: string) => `'${k.replace(/'/g, "''")}'`).join(',')}]`;
          const middleware = node.properties.middleware || [];
          const middlewareStr = `[${middleware.map((m: string) => `'${m.replace(/'/g, "''")}'`).join(',')}]`;
          pending = routeWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(keysStr),
              escapeCSVField(errorKeysStr),
              escapeCSVField(middlewareStr),
              escapeCSVField(String(node.properties.method ?? '')),
              escapeCSVField(String(node.properties.handlerSymbolId ?? '')),
            ].join(','),
          );
          break;
        }
        case 'Tool':
          pending = toolWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(node.properties.description || ''),
            ].join(','),
          );
          break;
        case 'BasicBlock':
          pending = basicBlockWriter.addRow(buildBasicBlockRow(node));
          break;
        default: {
          // Code element nodes (Function, Class, Interface, CodeElement)
          const writer = codeWriterMap[node.label];
          if (writer) {
            const content = await extractContent(node, contentCache);
            pending = writer.addRow(
              [
                escapeCSVField(node.id),
                escapeCSVField(node.properties.name || ''),
                escapeCSVField(node.properties.filePath || ''),
                escapeCSVNumber(node.properties.startLine, -1),
                escapeCSVNumber(node.properties.endLine, -1),
                node.properties.isExported ? 'true' : 'false',
                escapeCSVField(content),
                escapeCSVField(node.properties.description || ''),
              ].join(','),
            );
          } else {
            // Multi-language node types (Struct, Impl, Trait, Macro, etc.)
            const mlWriter = multiLangWriters.get(node.label);
            if (mlWriter) {
              const content = await extractContent(node, contentCache);
              pending = mlWriter.addRow(
                [
                  escapeCSVField(node.id),
                  escapeCSVField(node.properties.name || ''),
                  escapeCSVField(node.properties.filePath || ''),
                  escapeCSVNumber(node.properties.startLine, -1),
                  escapeCSVNumber(node.properties.endLine, -1),
                  escapeCSVField(content),
                  escapeCSVField(node.properties.description || ''),
                  ...(node.label === 'Property'
                    ? [escapeCSVField(node.properties.declaredType || '')]
                    : []),
                ].join(','),
              );
            } else {
              // Unknown label: not in codeWriterMap or multiLangWriters, so there
              // is no CSV table for it and it is intentionally NOT persisted —
              // `pending` stays undefined, so the loop awaits nothing. Made
              // explicit so a future node type isn't silently dropped here: wire
              // it into one of the writer maps above (or this branch).
            }
          }
          break;
        }
      }
      if (pending) await pending;
    }

    // Finish all node writers
    const allWriters = [
      fileWriter,
      folderWriter,
      functionWriter,
      classWriter,
      interfaceWriter,
      methodWriter,
      codeElemWriter,
      communityWriter,
      processWriter,
      sectionWriter,
      routeWriter,
      toolWriter,
      basicBlockWriter,
      ...multiLangWriters.values(),
    ];
    await Promise.all(allWriters.map((w) => w.finish()));

    // Build the node-file manifest now (all writers are flushed; `.rows` is
    // final). Hoisted above the relationship pass so `onNodePhaseComplete` can
    // hand the caller a complete node manifest to start COPY-ing while we keep
    // generating relationship CSVs below (#2203 overlap). The same map is
    // returned, so the result is unchanged when no callback is supplied.
    const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
    const tableMap: [NodeTableName, BufferedCSVWriter][] = [
      ['File', fileWriter],
      ['Folder', folderWriter],
      ['Function', functionWriter],
      ['Class', classWriter],
      ['Interface', interfaceWriter],
      ['Method', methodWriter],
      ['CodeElement', codeElemWriter],
      ['Community', communityWriter],
      ['Process', processWriter],
      ['Section' as NodeTableName, sectionWriter],
      ['Route' as NodeTableName, routeWriter],
      ['Tool' as NodeTableName, toolWriter],
      ['BasicBlock' as NodeTableName, basicBlockWriter],
      ...Array.from(multiLangWriters.entries()).map(
        ([name, w]) => [name as NodeTableName, w] as [NodeTableName, BufferedCSVWriter],
      ),
    ];
    for (const [name, writer] of tableMap) {
      if (writer.rows > 0) {
        nodeFiles.set(name, {
          csvPath: path.join(csvDir, `${name.toLowerCase()}.csv`),
          rows: writer.rows,
        });
      }
    }

    // Node CSVs are on disk; relationship CSVs have not been touched yet. Hand
    // the manifest to the caller (not awaited — the rel pass runs concurrently).
    onNodePhaseComplete?.(nodeFiles);

    // --- Stream relationships directly to per-FROM→TO-label-pair files ---
    // (#2203 U2) Route every edge to its pair file in this single pass. The old
    // monolithic relations.csv — and its line-by-line re-read + per-edge regex
    // re-split in loadGraphToLbug — are gone, so the ~1M-edge set is written and
    // read once instead of twice. The router applies the SAME label-derivation +
    // validTables filter as the legacy splitRelCsvByLabelPair, so the per-pair
    // files are byte-identical (asserted by the differential test).
    const relRouter = new RelPairRouter(csvDir, REL_CSV_HEADER, new Set<string>(NODE_TABLES));
    try {
      let emitted = 0;
      for (const rel of orderedRelationships(graph, sortOutput)) {
        const pending = relRouter.route(rel.sourceId, rel.targetId, buildRelRow(rel));
        if (pending) await pending;
        // Periodically hand the event loop back so the overlapped node COPY and
        // write-stream drains run instead of starving behind this synchronous
        // loop (#2226 F4). No effect on emitted bytes — pure scheduling.
        if (++emitted % REL_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      }
      await relRouter.close();
    } catch (err) {
      relRouter.destroy();
      // Rethrow the real stream error (EMFILE / disk-full) rather than the generic
      // AbortError a pending drain-await rejects with — mirrors the retained
      // splitRelCsvByLabelPair's `throw streamError ?? err`.
      throw relRouter.lastError ?? err;
    }

    return {
      nodeFiles,
      relsByPair: relRouter.byPair,
      relHeader: REL_CSV_HEADER,
      skippedRels: relRouter.skipped,
      totalValidRels: relRouter.total,
    };
  } finally {
    // Restore original process listener limit on every path (success or throw).
    process.setMaxListeners(prevMax);
  }
};
