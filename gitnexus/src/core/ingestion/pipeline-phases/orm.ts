/**
 * Phase: orm
 *
 * Processes ORM queries and creates QUERIES edges.
 *
 * Supported ORMs:
 *   - Prisma (TypeScript/JavaScript)
 *   - Supabase (TypeScript/JavaScript)
 *   - MyBatis (Java) — scans XML mapper files, extracts table names from SQL,
 *     links Mapper interface methods to table CodeElement nodes via QUERIES edges
 *
 * @deps    parse, scan
 * @reads   allORMQueries (from parse), allPaths (from scan, for XML mapper discovery)
 * @writes  graph (CodeElement nodes, QUERIES edges)
 */

import { readFile } from 'node:fs/promises';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import type { ScanOutput } from './scan.js';
import { generateId } from '../../../lib/utils.js';
import type { ExtractedORMQuery } from '../workers/parse-worker.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface ORMOutput {
  edgesCreated: number;
  modelCount: number;
}

export const ormPhase: PipelinePhase<ORMOutput> = {
  name: 'orm',
  deps: ['parse', 'scan'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ORMOutput> {
    const { allORMQueries } = getPhaseOutput<ParseOutput>(deps, 'parse');
    const { allPaths } = getPhaseOutput<ScanOutput>(deps, 'scan');

    // Collect MyBatis XML mapper queries alongside existing ORM queries
    const mybatisQueries = await extractMybatisQueries(allPaths, ctx.repoPath);
    const allQueries = [...allORMQueries, ...mybatisQueries];

    if (allQueries.length === 0) {
      return { edgesCreated: 0, modelCount: 0 };
    }

    return processORMQueries(ctx.graph, allQueries);
  },
};

// ---------------------------------------------------------------------------
// MyBatis XML mapper extraction
// ---------------------------------------------------------------------------

/** SQL keywords that introduce a table reference */
const TABLE_REF_RE =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?(?:\s+(?:AS\s+)?\w+)?/gi;

/** MyBatis XML mapper statement tags */
const STMT_TAG_RE =
  /<(select|insert|update|delete)\s[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;

/** MyBatis mapper namespace attribute */
const NAMESPACE_RE = /<mapper\s[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i;

interface MybatisStatement {
  op: 'select' | 'insert' | 'update' | 'delete';
  id: string;
  tables: string[];
}

/**
 * Extract table names from a SQL fragment, stripping CDATA and XML comments.
 * Returns lowercase table names, deduped.
 */
function extractTablesFromSql(sql: string): string[] {
  // Strip CDATA wrapper
  const clean = sql.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1');
  // Strip XML comments
  const noComments = clean.replace(/<!--[\s\S]*?-->/g, '');

  const tables = new Set<string>();
  let m: RegExpExecArray | null;
  TABLE_REF_RE.lastIndex = 0;
  while ((m = TABLE_REF_RE.exec(noComments)) !== null) {
    const name = m[1].toLowerCase();
    // Filter out SQL keywords and very short names that aren't table names
    if (name.length >= 2 && !/^(select|dual|values|set)$/.test(name)) {
      tables.add(name);
    }
  }
  return [...tables];
}

/** Parse a single MyBatis XML mapper file. */
function parseMybatisXml(content: string): { namespace: string; statements: MybatisStatement[] } | null {
  const nsMatch = NAMESPACE_RE.exec(content);
  if (!nsMatch) return null;
  const namespace = nsMatch[1];

  const statements: MybatisStatement[] = [];
  let m: RegExpExecArray | null;
  STMT_TAG_RE.lastIndex = 0;
  while ((m = STMT_TAG_RE.exec(content)) !== null) {
    const op = m[1].toLowerCase() as MybatisStatement['op'];
    const id = m[2];
    const body = m[3];
    const tables = extractTablesFromSql(body);
    if (tables.length > 0) {
      statements.push({ op, id, tables });
    }
  }

  return { namespace, statements };
}

/**
 * Resolve a MyBatis namespace (fully-qualified class name) to a Java source
 * file path relative to the repo. Tries to find a matching Mapper interface.
 */
function namespaceToFilePath(namespace: string, allPaths: string[]): string | null {
  // com.example.foo.XxxMapper → com/example/foo/XxxMapper.java
  // Strip inner-class suffix (e.g. "Outer$Inner" → use "Outer.java").
  const outerNamespace = namespace.includes('$')
    ? namespace.slice(0, namespace.indexOf('$'))
    : namespace;
  const rel = outerNamespace.replace(/\./g, '/') + '.java';
  const found = allPaths.find((p) => p.replace(/\\/g, '/').endsWith(rel));
  return found ?? null;
}

async function extractMybatisQueries(
  allPaths: string[],
  repoPath: string,
): Promise<ExtractedORMQuery[]> {
  const xmlPaths = allPaths.filter((p) => p.endsWith('.xml'));
  if (xmlPaths.length === 0) return [];

  const queries: ExtractedORMQuery[] = [];

  for (const xmlPath of xmlPaths) {
    let content: string;
    try {
      const abs = xmlPath.startsWith('/') ? xmlPath : `${repoPath}/${xmlPath}`;
      content = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }

    // Quick check before full parse
    if (!content.includes('<mapper') || !content.includes('namespace')) continue;

    const parsed = parseMybatisXml(content);
    if (!parsed || parsed.statements.length === 0) continue;

    const mapperFilePath = namespaceToFilePath(parsed.namespace, allPaths) ?? xmlPath;
    // Extract simple class name from namespace: "com.example.mapper.UPayMapper" → "UPayMapper"
    const mapperClassName = parsed.namespace.split('.').pop() ?? '';

    for (const stmt of parsed.statements) {
      for (const table of stmt.tables) {
        queries.push({
          filePath: mapperFilePath,
          orm: 'mybatis',
          model: table,
          method: stmt.op,
          lineNumber: 0,
          mapperId: stmt.id,
          sqlOp: stmt.op,
          mapperClassName,
        });
      }
    }
  }

  if (isDev && queries.length > 0) {
    const mapperCount = new Set(queries.map((q) => q.filePath)).size;
    logger.info(`MyBatis: ${queries.length} table refs across ${mapperCount} mapper files`);
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Graph construction (shared for all ORM types)
// ---------------------------------------------------------------------------

/**
 * Build a lookup index: "filePath:ClassName.methodName" → Method node ID.
 * The Java parser appends #<paramCount> to disambiguate overloaded methods
 * (e.g. "UPayMapper.selectByExampleWithPage#2"). MyBatis XML only knows the
 * method name, not the param count, so we strip the suffix and keep the first
 * match. When a mapper interface extends a base class (e.g. MybatisBaseMapper)
 * the inherited CRUD methods have no Method nodes in that file — those remain
 * as file-level fallback edges, which is expected.
 */
function buildMapperMethodIndex(graph: KnowledgeGraph): {
  methodIndex: Map<string, string>;
  filesWithMethods: Set<string>;
} {
  const methodIndex = new Map<string, string>();
  /** Mapper Java files that have at least one Method node in the graph. */
  const filesWithMethods = new Set<string>();
  graph.forEachNode((node) => {
    if (!node.id.startsWith('Method:')) return;
    const filePath = node.properties.filePath as string | undefined;
    // Match common Java DAO/Mapper interface naming conventions.
    if (!filePath || !/(?:Mapper|Dao|DAO|Repository)\.java$/.test(filePath)) return;
    filesWithMethods.add(filePath);
    // ID format: "Method:<filePath>:<ClassName>.<methodName>#<paramCount>"
    // Strip the #N suffix to get a param-count-agnostic key.
    const idBody = node.id.replace(/^Method:/, '');
    const hashIdx = idBody.lastIndexOf('#');
    const withoutSuffix = hashIdx >= 0 ? idBody.slice(0, hashIdx) : idBody;
    if (!methodIndex.has(withoutSuffix)) {
      methodIndex.set(withoutSuffix, node.id);
    }
  });
  return { methodIndex, filesWithMethods };
}

function processORMQueries(
  graph: KnowledgeGraph,
  queries: readonly ExtractedORMQuery[],
): ORMOutput {
  const modelNodes = new Map<string, string>();
  const seenEdges = new Set<string>();
  let edgesCreated = 0;

  // Pre-build index for fast filePath+methodName → Method node lookup (any #N)
  const { methodIndex: mapperMethodIndex, filesWithMethods } = buildMapperMethodIndex(graph);
  let xmlOrphansSkipped = 0;

  for (const q of queries) {
    const modelKey = `${q.orm}:${q.model}`;
    let modelNodeId = modelNodes.get(modelKey);
    if (!modelNodeId) {
      const candidateIds = [
        generateId('Class', `${q.model}`),
        generateId('Interface', `${q.model}`),
        generateId('CodeElement', `${q.model}`),
      ];
      const existing = candidateIds.find((id) => graph.getNode(id));
      if (existing) {
        modelNodeId = existing;
      } else {
        modelNodeId = generateId('CodeElement', `${q.orm}:${q.model}`);
        graph.addNode({
          id: modelNodeId,
          label: 'CodeElement',
          properties: {
            name: q.model,
            filePath: '',
            description: `${q.orm} model/table: ${q.model}`,
          },
        });
      }
      modelNodes.set(modelKey, modelNodeId);
    }

    // For MyBatis: prefer linking to the specific mapper method node.
    // Use the pre-built index (filePath:ClassName.methodName → node ID) to
    // resolve any #<paramCount> suffix without enumerating candidates.
    //
    // When method lookup fails there are two distinct cases:
    //   1. Inherited CRUD methods (e.g. MybatisBaseMapper subclasses) — the
    //      Java file has NO own Method nodes at all.  Fall back to file-level.
    //   2. XML-only statements (e.g. selectBySelectiveWithPage) present in the
    //      XML but absent from the Java interface that otherwise has methods.
    //      These are orphan/dead SQL — skip them entirely (no edge created).
    let sourceId: string;
    if (q.orm === 'mybatis' && q.mapperId && q.mapperClassName) {
      const qualifiedMethod = `${q.mapperClassName}.${q.mapperId}`;
      const indexKey = `${q.filePath}:${qualifiedMethod}`;
      const methodNodeId = mapperMethodIndex.get(indexKey);
      if (methodNodeId) {
        sourceId = methodNodeId;
      } else if (filesWithMethods.has(q.filePath)) {
        // Java interface was parsed and has other methods, but this specific
        // statement ID has no matching method → XML-only orphan, skip it.
        xmlOrphansSkipped++;
        continue;
      } else {
        // Java interface has no Method nodes (e.g. all inherited from base
        // class) — fall back to file-level edge.
        sourceId = generateId('File', q.filePath);
      }
    } else {
      sourceId = generateId('File', q.filePath);
    }

    const edgeKey = `${sourceId}->${modelNodeId}:${q.method}:${q.mapperId ?? ''}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    const reason = q.orm === 'mybatis' && q.sqlOp
      ? `mybatis-${q.sqlOp}`
      : `${q.orm}-${q.method}`;

    graph.addRelationship({
      id: generateId('QUERIES', edgeKey),
      sourceId,
      targetId: modelNodeId,
      type: 'QUERIES',
      confidence: q.orm === 'mybatis' ? 1.0 : 0.9,
      reason,
    });
    edgesCreated++;
  }

  if (isDev) {
    const orphanNote = xmlOrphansSkipped > 0 ? `, ${xmlOrphansSkipped} XML orphans skipped` : '';
    logger.info(
      `ORM dataflow: ${edgesCreated} QUERIES edges, ${modelNodes.size} models (${queries.length} total refs${orphanNote})`,
    );
  }

  return { edgesCreated, modelCount: modelNodes.size };
}
