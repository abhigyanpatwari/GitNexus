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
import { KnowledgeGraph, GraphNode, NodeLabel } from '../graph/types.js';
import { NodeTableName } from './schema.js';

/** Flush buffered rows to disk every N rows */
const FLUSH_EVERY = 500;

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

export const escapeCSVNumber = (value: number | undefined | null, defaultValue: number = -1): string => {
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
    if ((code < 9) || (code > 13 && code < 32) || code === 127) nonPrintable++;
  }
  return (nonPrintable / sample.length) > 0.1;
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

const extractContent = async (
  node: GraphNode,
  contentCache: FileContentCache
): Promise<string> => {
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

  addRow(row: string) {
    this.buffer.push(row);
    this.rows++;
    if (this.buffer.length >= FLUSH_EVERY) {
      return this.flush();
    }
    return Promise.resolve();
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

export interface StreamedCSVResult {
  nodeFiles: Map<NodeTableName, { csvPath: string; rows: number }>;
  relCsvPath: string;
  relRows: number;
}

/**
 * Stream all CSV data directly to disk files.
 * Iterates graph nodes exactly ONCE — routes each node to the right writer.
 * File contents are lazy-read from disk with a generous LRU cache.
 */
export const streamAllCSVsToDisk = async (
  graph: KnowledgeGraph,
  repoPath: string,
  csvDir: string,
): Promise<StreamedCSVResult> => {
  // Remove stale CSVs from previous crashed runs, then recreate
  try { await fs.rm(csvDir, { recursive: true, force: true }); } catch {}
  await fs.mkdir(csvDir, { recursive: true });

  // We open ~30 concurrent write-streams; raise process limit to suppress
  // MaxListenersExceededWarning (restored after all streams finish).
  const prevMax = process.getMaxListeners();
  process.setMaxListeners(prevMax + 40);

  const contentCache = new FileContentCache(repoPath);

  // Create writers for every node type up-front
  const fileWriter = new BufferedCSVWriter(path.join(csvDir, 'file.csv'), 'id,name,filePath,content');
  const folderWriter = new BufferedCSVWriter(path.join(csvDir, 'folder.csv'), 'id,name,filePath');
  const codeElementHeader = 'id,name,filePath,startLine,endLine,isExported,content,description';
  const functionWriter = new BufferedCSVWriter(path.join(csvDir, 'function.csv'), codeElementHeader);
  const classWriter = new BufferedCSVWriter(path.join(csvDir, 'class.csv'), codeElementHeader);
  const interfaceWriter = new BufferedCSVWriter(path.join(csvDir, 'interface.csv'), codeElementHeader);
  const methodHeader = 'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType';
  const methodWriter = new BufferedCSVWriter(path.join(csvDir, 'method.csv'), methodHeader);
  const codeElemWriter = new BufferedCSVWriter(path.join(csvDir, 'codeelement.csv'), codeElementHeader);
  const communityWriter = new BufferedCSVWriter(path.join(csvDir, 'community.csv'), 'id,label,heuristicLabel,keywords,description,enrichedBy,cohesion,symbolCount');
  const processWriter = new BufferedCSVWriter(path.join(csvDir, 'process.csv'), 'id,label,heuristicLabel,processType,stepCount,communities,entryPointId,terminalId');

  // Multi-language node types share the same CSV shape (no isExported column)
  const multiLangHeader = 'id,name,filePath,startLine,endLine,content,description';
  const MULTI_LANG_TYPES = ['Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
    'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module'] as const;
  const multiLangWriters = new Map<string, BufferedCSVWriter>();
  for (const t of MULTI_LANG_TYPES) {
    multiLangWriters.set(t, new BufferedCSVWriter(path.join(csvDir, `${t.toLowerCase()}.csv`), multiLangHeader));
  }

  const codeWriterMap: Record<string, BufferedCSVWriter> = {
    'Function': functionWriter,
    'Class': classWriter,
    'Interface': interfaceWriter,
    'CodeElement': codeElemWriter,
  };

  const seenFileIds = new Set<string>();

  // --- SINGLE PASS over all nodes ---
  for (const node of graph.iterNodes()) {
    switch (node.label) {
      case 'File': {
        if (seenFileIds.has(node.id)) break;
        seenFileIds.add(node.id);
        const content = await extractContent(node, contentCache);
        await fileWriter.addRow([
          escapeCSVField(node.id),
          escapeCSVField(node.properties.name || ''),
          escapeCSVField(node.properties.filePath || ''),
          escapeCSVField(content),
        ].join(','));
        break;
      }
      case 'Folder':
        await folderWriter.addRow([
          escapeCSVField(node.id),
          escapeCSVField(node.properties.name || ''),
          escapeCSVField(node.properties.filePath || ''),
        ].join(','));
        break;
      case 'Community': {
        const keywords = (node.properties as any).keywords || [];
        const keywordsStr = `[${keywords.map((k: string) => `'${k.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/,/g, '\\,')}'`).join(',')}]`;
        await communityWriter.addRow([
          escapeCSVField(node.id),
          escapeCSVField(node.properties.name || ''),
          escapeCSVField(node.properties.heuristicLabel || ''),
          keywordsStr,
          escapeCSVField((node.properties as any).description || ''),
          escapeCSVField((node.properties as any).enrichedBy || 'heuristic'),
          escapeCSVNumber(node.properties.cohesion, 0),
          escapeCSVNumber(node.properties.symbolCount, 0),
        ].join(','));
        break;
      }
      case 'Process': {
        const communities = (node.properties as any).communities || [];
        const communitiesStr = `[${communities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',')}]`;
        await processWriter.addRow([
          escapeCSVField(node.id),
          escapeCSVField(node.properties.name || ''),
          escapeCSVField((node.properties as any).heuristicLabel || ''),
          escapeCSVField((node.properties as any).processType || ''),
          escapeCSVNumber((node.properties as any).stepCount, 0),
          escapeCSVField(communitiesStr),
          escapeCSVField((node.properties as any).entryPointId || ''),
          escapeCSVField((node.properties as any).terminalId || ''),
        ].join(','));
        break;
      }
      case 'Method': {
        const content = await extractContent(node, contentCache);
        await methodWriter.addRow([
          escapeCSVField(node.id),
          escapeCSVField(node.properties.name || ''),
          escapeCSVField(node.properties.filePath || ''),
          escapeCSVNumber(node.properties.startLine, -1),
          escapeCSVNumber(node.properties.endLine, -1),
          node.properties.isExported ? 'true' : 'false',
          escapeCSVField(content),
          escapeCSVField((node.properties as any).description || ''),
          escapeCSVNumber(node.properties.parameterCount, 0),
          escapeCSVField(node.properties.returnType || ''),
        ].join(','));
        break;
      }
      default: {
        // Code element nodes (Function, Class, Interface, CodeElement)
        const writer = codeWriterMap[node.label];
        if (writer) {
          const content = await extractContent(node, contentCache);
          await writer.addRow([
            escapeCSVField(node.id),
            escapeCSVField(node.properties.name || ''),
            escapeCSVField(node.properties.filePath || ''),
            escapeCSVNumber(node.properties.startLine, -1),
            escapeCSVNumber(node.properties.endLine, -1),
            node.properties.isExported ? 'true' : 'false',
            escapeCSVField(content),
            escapeCSVField((node.properties as any).description || ''),
          ].join(','));
        } else {
          // Multi-language node types (Struct, Impl, Trait, Macro, etc.)
          const mlWriter = multiLangWriters.get(node.label);
          if (mlWriter) {
            const content = await extractContent(node, contentCache);
            await mlWriter.addRow([
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              escapeCSVField(content),
              escapeCSVField((node.properties as any).description || ''),
            ].join(','));
          }
        }
        break;
      }
    }
  }

  // Finish all node writers
  const allWriters = [fileWriter, folderWriter, functionWriter, classWriter, interfaceWriter, methodWriter, codeElemWriter, communityWriter, processWriter, ...multiLangWriters.values()];
  await Promise.all(allWriters.map(w => w.finish()));

  // --- Stream relationship CSV ---
  const relCsvPath = path.join(csvDir, 'relations.csv');
  const relWriter = new BufferedCSVWriter(relCsvPath, 'from,to,type,confidence,reason,step');
  for (const rel of graph.iterRelationships()) {
    await relWriter.addRow([
      escapeCSVField(rel.sourceId),
      escapeCSVField(rel.targetId),
      escapeCSVField(rel.type),
      escapeCSVNumber(rel.confidence, 1.0),
      escapeCSVField(rel.reason),
      escapeCSVNumber((rel as any).step, 0),
    ].join(','));
  }
  await relWriter.finish();

  // Build result map — only include tables that have rows
  const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
  const tableMap: [NodeTableName, BufferedCSVWriter][] = [
    ['File', fileWriter], ['Folder', folderWriter],
    ['Function', functionWriter], ['Class', classWriter],
    ['Interface', interfaceWriter], ['Method', methodWriter],
    ['CodeElement', codeElemWriter],
    ['Community', communityWriter], ['Process', processWriter],
    ...Array.from(multiLangWriters.entries()).map(([name, w]) => [name as NodeTableName, w] as [NodeTableName, BufferedCSVWriter]),
  ];
  for (const [name, writer] of tableMap) {
    if (writer.rows > 0) {
      nodeFiles.set(name, { csvPath: path.join(csvDir, `${name.toLowerCase()}.csv`), rows: writer.rows });
    }
  }

  // Restore original process listener limit
  process.setMaxListeners(prevMax);

  return { nodeFiles, relCsvPath, relRows: relWriter.rows };
};
