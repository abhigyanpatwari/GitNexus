/**
 * CSV Generator for LadybugDB Hybrid Schema
 *
 * Streams CSV rows directly to disk files in a single pass over graph nodes.
 * File contents are lazy-read from disk per-node to avoid holding the entire
 * repo in RAM. Rows are buffered (FLUSH_BYTES) before writing to minimize
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
import { NodeTableName, RELATION_SCHEMA } from './schema.js';
import { VALID_NODE_TABLES, parseRelationSchemaPairs, RelPairRouter } from './rel-pair-routing.js';
import { parseTruthyEnv } from '../ingestion/utils/env.js';
import { SYMBOL_NODE_LABELS } from '../ingestion/utils/symbol-labels.js';
import { applyCjkSegmentationIfEnabled } from '../search/cjk-segmentation.js';

/** Computed once — `RELATION_SCHEMA` is a static template literal. Exported so
 *  the streamed sinks (`GraphEmitSink`, `PdgEmitSink`) share this parse
 *  instead of each re-deriving it from the same DDL string. */
export const DECLARED_RELATION_PAIRS = parseRelationSchemaPairs(RELATION_SCHEMA);

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

/**
 * Flush buffered rows to disk once the buffered chunk reaches this many bytes.
 * Byte-bounded rather than row-count-bounded: row size ranges from a few dozen
 * bytes (typical symbol/relationship rows) up to a full File's content
 * (#2317/#2323), so a row-count-only cap lets a handful of huge rows build an
 * unbounded `buffer.join('\n')` string before ever tripping it.
 *
 * Not an env knob — fixed by a safety margin, not a preference. The one worst
 * case that matters: one more oversized row lands right after the buffer was
 * just under this threshold, before the flush fires. That row is capped at
 * TREE_SITTER_MAX_BUFFER (32MB, hard-clamped — GITNEXUS_MAX_FILE_SIZE cannot
 * raise it). Two transforms can each grow it before it reaches the buffer:
 * `applyCjkSegmentationIfEnabled` (#2331, `CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR`
 * on an all-CJK row when `GITNEXUS_FTS_CJK_SEGMENTATION=bigram` — the single
 * source of truth for that ratio, imported by the paired test) and
 * `escapeCSVField`'s worst-case quote-doubling (2x). So the peak joined-string
 * size is bounded by
 *   FLUSH_BYTES + 2 * CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR * TREE_SITTER_MAX_BUFFER
 *     ≈ 8MB + 149MB ≈ 157MB,
 * versus Node's `buffer.constants.MAX_STRING_LENGTH` (~512MB) — the test
 * actually enforces half of that (~256MB), for a ~1.63x margin (see the
 * `shouldFlushCSVBuffer stays within the V8 string-length ceiling` test,
 * which fails loudly if any of these constants ever moves this margin the
 * wrong way). With segmentation disabled (default), the old ~3.56x margin
 * still applies. Raising FLUSH_BYTES trades fewer/larger flushes for less
 * margin; lowering it trades the reverse for lower peak transient memory.
 * Change the constant directly if a real workload needs a different point on
 * that curve — a per-host env var would let the margin get silently
 * reintroduced by an operator with no way to know why 512MB is dangerous.
 */
export const FLUSH_BYTES = 8 * 1024 * 1024;

export const shouldFlushCSVBuffer = (byteCount: number): boolean => byteCount >= FLUSH_BYTES;

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

/**
 * A numeric column that may legitimately have NO value.
 *
 * `escapeCSVNumber` substitutes a sentinel (-1) for absence, which is right
 * where every row has a span and wrong where absence is the fact being
 * recorded. An empty field is loaded as NULL by COPY, so the column can say
 * "there is no line here" instead of pointing at line -1.
 */
export const escapeCSVNullableNumber = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

const formatCSVStringArray = (value: unknown): string => {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const unsafe = items.find((item) => /[,\[\]'"\n\r]/.test(item));
  if (unsafe !== undefined) {
    throw new Error(`Cannot safely encode CSV string-list item: ${JSON.stringify(unsafe)}`);
  }
  return `[${items.join(',')}]`;
};

// ============================================================================
// CONTENT EXTRACTION (lazy — reads from disk on demand)
// ============================================================================

const BINARY_SAMPLE_CHARS = 1000;
const UNICODE_REPLACEMENT_CHAR = 0xfffd;

/**
 * Did this text come from a binary payload? Density of non-printables over the
 * first {@link BINARY_SAMPLE_CHARS} characters, above 10%.
 *
 * U+FFFD counts, and it is the character that matters most here (#2889). Every
 * source file enters the pipeline through a `utf-8` decode — the content cache
 * below reads with `fs.readFile(path, 'utf-8')`, and the parse worker decodes
 * the same way. That decode is lossy and total: an invalid byte sequence never
 * survives as invalid bytes, it is REPLACED with U+FFFD. So the embedded-binary
 * payloads #2889 describes (webpack bundles, class-file constant pools,
 * serialized objects inside .js/.vue sources) arrive here as long runs of
 * U+FFFD, not as the control bytes this scan was originally written to count —
 * charCode 0xFFFD is neither `< 9`, nor between 13 and 32, nor 127, so the
 * detector scored a wholly corrupt payload as clean text and every caller waved
 * it through.
 *
 * The threshold stays at 10%: a legitimate source file carries no replacement
 * characters at all unless it was mis-decoded, and a handful (a stray latin-1
 * comment, one bad byte in a license header) still scores far under the bar.
 * Density rather than "contains any binary run" is deliberate — a description
 * that is mostly real prose with one stray replacement character is worth more
 * indexed than dropped.
 */
export const isBinaryContent = (content: string): boolean => {
  // `content &&` keeps the original tolerance for a null/undefined caller —
  // `strict` is off in this package, so the type alone does not rule it out.
  const end = content ? Math.min(content.length, BINARY_SAMPLE_CHARS) : 0;
  if (end === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < end; i++) {
    const code = content.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 127 || code === UNICODE_REPLACEMENT_CHAR)
      nonPrintable++;
  }
  return nonPrintable / end > 0.1;
};

interface PreparedFileContent {
  readonly content: string;
  readonly lines: string[];
  readonly isBinary: boolean;
}

const EMPTY_PREPARED: PreparedFileContent = { content: '', lines: [''], isBinary: false };

/**
 * LRU content cache — avoids re-reading the same source file for every
 * symbol defined in it. Sized generously so most files stay cached during
 * the single-pass node iteration. Insertion order on the Map is LRU
 * (delete+set on touch).
 */
class FileContentCache {
  private cache = new Map<string, PreparedFileContent>();
  private maxSize: number;
  private repoPath: string;

  constructor(repoPath: string, maxSize: number = 3000) {
    this.repoPath = repoPath;
    this.maxSize = maxSize;
  }

  async get(relativePath: string): Promise<PreparedFileContent> {
    if (!relativePath) return EMPTY_PREPARED;
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) {
      this.cache.delete(relativePath);
      this.cache.set(relativePath, cached);
      return cached;
    }
    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const prepared: PreparedFileContent = {
        content,
        lines: content.split('\n'),
        isBinary: isBinaryContent(content),
      };
      this.set(relativePath, prepared);
      return prepared;
    } catch {
      this.set(relativePath, EMPTY_PREPARED);
      return EMPTY_PREPARED;
    }
  }

  private set(key: string, value: PreparedFileContent) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}

/**
 * Flatten newlines and tabs to single spaces for FTS-indexed text columns
 * (`content`, `description`) — the real fix for #2317.
 *
 * Ladybug's full-text-search tokenizer splits ONLY on the space character —
 * `\n`, `\r`, and `\t` are NOT token delimiters. So multiline text indexes as
 * a handful of giant tokens (each whole line, joined across lines), and a
 * word query matches none of them: `searchFTSFromLbug('foo')` misses a file
 * whose content is `... \nfoo\n ...`. Removing the 10KB cap (#2333/#2317)
 * stores the full body but leaves it unsearchable; collapsing intra-text
 * whitespace to spaces is what actually makes every word searchable.
 *
 * This rewrites the STORED column too (the same value is COPYed in), so File
 * content returned via the graph API is space-flattened — an accepted trade
 * for making file/symbol text searchable. Leading/trailing/empty are no-ops.
 *
 * Callers apply `applyCjkSegmentationIfEnabled` (#2331) to the text *before*
 * this flatten, so a CJK phrase split across a line-wrap loses its boundary
 * bigram (run detection resets at whitespace) — an accepted limitation, see
 * the plan's Scope Boundaries.
 *
 * Exported (#2339) so `bm25-index.ts`'s query path can compose it in the
 * same order on incoming search queries, keeping index-time and query-time
 * text transforms symmetric — a literal tab/newline in a query would
 * otherwise fail to match whitespace-normalized indexed content.
 */
export const normalizeFtsText = (text: string): string => text.replace(/[\r\n\t]+/g, ' ');

/**
 * Composes both FTS-text transforms for the `description` column — one place for
 * the six emission sites below to call, instead of repeating the composition.
 *
 * Binary-looking descriptions are dropped rather than transformed (#2889). The
 * `content` column has always been gated on {@link isBinaryContent} inside
 * {@link extractContent}; `description` never was, so a symbol whose "doc
 * comment" is really a slice of an embedded binary payload had that payload
 * copied verbatim into an FTS-indexed column. Dropping it here rather than at
 * each of the six call sites keeps the gate in the same place as the transforms
 * it guards. Empty string, not a sentinel: unlike `content`, a description has
 * no reader that needs to be told why it is missing.
 */
const formatFtsDescription = (description: string): string =>
  isBinaryContent(description) ? '' : normalizeFtsText(applyCjkSegmentationIfEnabled(description));

// Labels that get exact source-span content (no ±2 window). Single source of
// truth in `symbol-labels.ts` — see there for why the exactness depends on the
// 0-based line invariant. Kept as a named alias to read intent at the use site.
const EXACT_SYMBOL_CONTENT_LABELS = SYMBOL_NODE_LABELS;

const extractContent = async (node: GraphNode, contentCache: FileContentCache): Promise<string> => {
  const filePath = node.properties.filePath;
  const prepared = await contentCache.get(filePath);
  const content = prepared.content;
  if (!content) return '';
  if (node.label === 'Folder') return '';
  if (prepared.isBinary) return '[Binary file - content not stored]';

  // File content is stored in full — intentionally NOT length-capped here, so
  // text past the old 10KB cutoff stays FTS-searchable (#2317). It is already
  // bounded upstream by the walker's max-file-size cap (512KB default / 32MB),
  // and only whitespace-normalized for the tokenizer. The symbol snippet path
  // below, by contrast, deliberately stays capped at MAX_SNIPPET.
  if (node.label === 'File') {
    return normalizeFtsText(applyCjkSegmentationIfEnabled(content));
  }

  const startLine = node.properties.startLine;
  const endLine = node.properties.endLine;
  if (startLine === undefined || endLine === undefined) return '';

  const lines = prepared.lines;
  const exactSymbolContent = EXACT_SYMBOL_CONTENT_LABELS.has(node.label);
  const start = Math.max(0, exactSymbolContent ? startLine : startLine - 2);
  const end = Math.min(lines.length - 1, exactSymbolContent ? endLine : endLine + 2);
  const snippet = lines.slice(start, end + 1).join('\n');
  const MAX_SNIPPET = 5000;
  const capped =
    snippet.length > MAX_SNIPPET ? snippet.slice(0, MAX_SNIPPET) + '\n... [truncated]' : snippet;
  return normalizeFtsText(applyCjkSegmentationIfEnabled(capped));
};

// ============================================================================
// BUFFERED CSV WRITER
// ============================================================================

class BufferedCSVWriter {
  private ws: WriteStream;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  rows = 0;

  constructor(filePath: string, header: string) {
    this.ws = createWriteStream(filePath, 'utf-8');
    // Large repos flush many times — raise listener cap to avoid MaxListenersExceededWarning
    this.ws.setMaxListeners(50);
    this.buffer.push(header);
    this.bufferedBytes = Buffer.byteLength(header) + 1;
  }

  /**
   * Buffer a row. Returns a promise ONLY when the buffer crossed FLUSH_BYTES
   * and a disk write was issued; otherwise returns `undefined` so the caller
   * can skip awaiting (#2203 U3) — avoiding a microtask tick on every buffered
   * row (millions at scale). The flush promise still resolves on drain, so
   * backpressure is preserved on the rows that actually write.
   */
  addRow(row: string): Promise<void> | undefined {
    this.buffer.push(row);
    this.bufferedBytes += Buffer.byteLength(row) + 1;
    this.rows++;
    if (shouldFlushCSVBuffer(this.bufferedBytes)) {
      return this.flush();
    }
    return undefined;
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer.length = 0;
    this.bufferedBytes = 0;
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
export const REL_CSV_HEADER = 'from,to,type,confidence,reason,step,staticGated';

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
    // `staticGated` persists as 0/1 (LadybugDB BOOLEAN COPY accepts both).
    // Every edge that does not carry the flag writes 0, so readers treat
    // absence and `false` identically.
    rel.staticGated === true ? '1' : '0',
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
      `${codeElementHeader},convexEndpointFactory`,
    );
    const classWriter = new BufferedCSVWriter(
      path.join(csvDir, 'class.csv'),
      `${codeElementHeader},frameworkAnnotations`,
    );
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
      'id,name,filePath,responseKeys,errorKeys,middleware,method,handlerSymbolId,runtimeConfirmed,runtimeSource,runtimeStatus',
    );

    // Tool nodes for MCP tool definitions
    const toolWriter = new BufferedCSVWriter(
      path.join(csvDir, 'tool.csv'),
      'id,name,filePath,description',
    );

    // Destination nodes for async messaging (Kafka topics, Rabbit exchanges, …)
    const destinationWriter = new BufferedCSVWriter(
      path.join(csvDir, 'destination.csv'),
      'id,name,filePath,startLine,endLine,address,broker,resolution,configKey,configDefault,description',
    );

    // BasicBlock nodes — taint/PDG substrate (issue #2080). No `name` column;
    // blocks are identified by id + source span. Emitted by no phase yet.
    const basicBlockWriter = new BufferedCSVWriter(
      path.join(csvDir, 'basicblock.csv'),
      BASICBLOCK_CSV_HEADER,
    );

    // Multi-language node types share the same CSV shape (no isExported column)
    const multiLangHeader = 'id,name,filePath,startLine,endLine,content,description';
    const constHeader = `${multiLangHeader},convexEndpointFactory`;
    const MULTI_LANG_TYPES = [
      'Protocol',
      'Category',
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
    const propertyHeader =
      'id,name,filePath,startLine,endLine,content,description,declaredType,isDetail';
    const multiLangWriters = new Map<string, BufferedCSVWriter>();
    for (const t of MULTI_LANG_TYPES) {
      multiLangWriters.set(
        t,
        new BufferedCSVWriter(
          path.join(csvDir, `${t.toLowerCase()}.csv`),
          t === 'Property' ? propertyHeader : t === 'Const' ? constHeader : multiLangHeader,
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
      // tick on the rows buffered between byte-bounded flushes (#2203 U3).
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
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
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
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
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
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
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
              node.properties.runtimeConfirmed === true ? 'true' : 'false',
              escapeCSVField(String(node.properties.runtimeSource ?? '')),
              escapeCSVField(String(node.properties.runtimeStatus ?? '')),
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
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
            ].join(','),
          );
          break;
        case 'Destination':
          // `address` is the cross-service join key and is written as an EMPTY
          // field for an unresolved destination, which COPY loads as NULL —
          // mirroring the in-memory rule that the property is absent there, and
          // measured on a real index (`spring-destinations-lbug.test.ts` asserts
          // both the NULL and the zero-false-join it buys). Writing the
          // placeholder text into this column instead would make two services
          // that merely both wrote `${app.topic}` join on it, reintroducing
          // below the database line the exact false connection the
          // location-based node id prevents above it. The placeholder is
          // carried by `name`, which nothing joins on.
          //
          // The line columns are written EMPTY (→ NULL) rather than defaulted
          // to -1 when the node carries none. A resolved destination has no
          // location at all — that is the point of the `filePath` rule two
          // fields to the left — and a row saying `filePath` NULL but
          // `startLine` -1 makes the two columns disagree about one fact and
          // renders as "line -1" in the UI.
          //
          // `broker` is written for every destination, resolved or not. It is
          // part of the resolved node's IDENTITY — the id is minted from
          // `(broker, address)` — so a reader who joins on `address` alone and
          // sees two rows needs this column to tell them apart, not merely to
          // decorate them. Every column named in this row list must also be
          // named in DESTINATION_SCHEMA and in the COPY statement in
          // `lbug-adapter.ts`; a property the phase writes but those two omit is
          // dropped at the database boundary without a warning, and the query
          // that reads it back raises a binder error instead.
          pending = destinationWriter.addRow(
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNullableNumber(node.properties.startLine),
              escapeCSVNullableNumber(node.properties.endLine),
              escapeCSVField(String(node.properties.address ?? '')),
              escapeCSVField(String(node.properties.broker ?? '')),
              escapeCSVField(String(node.properties.resolution ?? '')),
              escapeCSVField(String(node.properties.configKey ?? '')),
              escapeCSVField(String(node.properties.configDefault ?? '')),
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
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
            const row = [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              node.properties.isExported ? 'true' : 'false',
              escapeCSVField(content),
              escapeCSVField(formatFtsDescription(node.properties.description || '')),
            ];
            if (node.label === 'Class') {
              row.push(escapeCSVField(formatCSVStringArray(node.properties.frameworkAnnotations)));
            } else if (node.label === 'Function') {
              row.push(escapeCSVField(String(node.properties.convexEndpointFactory ?? '')));
            }
            pending = writer.addRow(row.join(','));
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
                  escapeCSVField(formatFtsDescription(node.properties.description || '')),
                  ...(node.label === 'Property'
                    ? [
                        escapeCSVField(node.properties.declaredType || ''),
                        // R3-4 detail symbols — see PROPERTY_SCHEMA. Written as
                        // an explicit boolean so the column is never empty; an
                        // empty BOOLEAN cell fails the COPY.
                        node.properties.isDetail === true ? 'true' : 'false',
                      ]
                    : node.label === 'Const'
                      ? [escapeCSVField(String(node.properties.convexEndpointFactory ?? ''))]
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
      // A writer missing from THIS list is not a loud failure. `finish()` is
      // what flushes the buffered rows, while the header is written eagerly and
      // `.rows` counts rows as they are added — so an unflushed writer still
      // produces a valid, header-only CSV and a manifest entry claiming rows.
      // The COPY then succeeds and loads nothing. Adding a node table means
      // adding it here as well as to the switch and the manifest.
      destinationWriter,
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
      ['Destination' as NodeTableName, destinationWriter],
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
    const relRouter = new RelPairRouter(
      csvDir,
      REL_CSV_HEADER,
      VALID_NODE_TABLES,
      DECLARED_RELATION_PAIRS,
    );
    try {
      let emitted = 0;
      for (const rel of orderedRelationships(graph, sortOutput)) {
        const pending = relRouter.route(rel.sourceId, rel.targetId, buildRelRow(rel), rel.type);
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
