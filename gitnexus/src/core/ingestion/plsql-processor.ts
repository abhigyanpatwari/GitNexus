/**
 * Oracle PL/SQL → knowledge graph.
 *
 * Standalone processor (COBOL precedent): parses PL/SQL files with the
 * ANTLR4 grammar (`plsql/`), resolves names across the whole repository and
 * writes structural nodes and edges directly into the graph before the parse
 * phase. The PL/SQL scope resolver runs in `callable-flow-only` mode, so every
 * structural edge below is owned here.
 *
 * Mapping (no schema extension):
 *   package (spec + body)            → Module   (one node, anchored at the spec)
 *   procedure / function / trigger   → Function (CONTAINS from its owner)
 *   table / view                     → Record   (one node per table name)
 *   call                             → CALLS    (reason plsql-call*)
 *   DML / SELECT / trigger target    → ACCESSES (reason plsql-<op>)
 *   SQL*Plus @@script / START        → IMPORTS  (File → File)
 *
 * Resolution is deliberately conservative: a call only becomes an edge when it
 * resolves to a definition indexed from this repository. Built-ins
 * (`TRUNC`, `DBMS_OUTPUT.PUT_LINE`) and objects outside the repository yield
 * no edge rather than a guessed one; overloads that arity and named arguments
 * cannot tell apart yield one lower-confidence edge per candidate.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { toZeroBasedLine } from './utils/line-base.js';
import { extractPlSqlFacts, type PlSqlDefinition, type PlSqlFileFacts } from './plsql/extract.js';
import { isPlSqlSource } from './plsql/file-types.js';
import { resolvePlSqlScriptInclude } from './plsql/script-include.js';
import { PlSqlNameIndex, plsqlSignatureKey, type PlSqlIndexEntry } from './plsql/resolve.js';

export interface PlSqlFile {
  readonly path: string;
  readonly content: string;
}

export interface PlSqlProcessResult {
  readonly files: number;
  readonly packages: number;
  readonly subprograms: number;
  readonly triggers: number;
  readonly tables: number;
  readonly calls: number;
  readonly ambiguousCalls: number;
  readonly unresolvedCalls: number;
  readonly accesses: number;
  readonly scriptIncludes: number;
  readonly dynamicSqlSites: number;
  readonly segmentsWithErrors: number;
  readonly fallbackDefinitions: number;
}

export { isPlSqlSource };

// ─── node identity ────────────────────────────────────────────────────────

/** A package is one node for spec and body, keyed by the file that declares it. */
export function plsqlPackageNodeId(homeFile: string, packageName: string): string {
  return generateId('Module', `${homeFile}:${packageName}`);
}

/**
 * Subprograms are keyed by owner path plus the normalised parameter signature,
 * so overloads get distinct ids that survive edits elsewhere in the file.
 */
export function plsqlSubprogramNodeId(filePath: string, def: PlSqlDefinition): string {
  return generateId(
    'Function',
    `${filePath}:${plsqlSignatureKey(def)}${def.kind === 'trigger' ? ':trigger' : ''}`,
  );
}

export function plsqlTableNodeId(tableName: string): string {
  return generateId('Record', `plsql-table:${tableName}`);
}

interface Entry extends PlSqlIndexEntry {
  /** Graph node of this definition (a spec declaration with a body maps to the body). */
  nodeId?: string;
}

// ─── graph mapping ────────────────────────────────────────────────────────

export function processPlSql(
  graph: KnowledgeGraph,
  files: readonly PlSqlFile[],
  allPaths: ReadonlySet<string> = new Set(files.map((f) => f.path)),
): PlSqlProcessResult {
  const facts = new Map<string, PlSqlFileFacts>();
  for (const file of files) facts.set(file.path, extractPlSqlFacts(file.content));

  const index = new PlSqlNameIndex<Entry>();
  const entryOf = new Map<PlSqlDefinition, Entry>();
  for (const [filePath, f] of facts) {
    for (const def of f.definitions) {
      const entry: Entry = { def, filePath };
      entryOf.set(def, entry);
      index.add(entry);
    }
  }

  // ── packages: one Module per name, anchored at the spec when indexed ──
  const packageHome = new Map<string, { file: string; def: PlSqlDefinition; files: Set<string> }>();
  for (const [filePath, f] of facts) {
    for (const def of f.definitions) {
      if (def.kind !== 'package') continue;
      const home = packageHome.get(def.name);
      if (!home) packageHome.set(def.name, { file: filePath, def, files: new Set([filePath]) });
      else {
        home.files.add(filePath);
        if (def.isSpec && !home.def.isSpec) Object.assign(home, { file: filePath, def });
      }
    }
  }
  const packageNode = new Map<string, string>();
  for (const [name, home] of packageHome) {
    const nodeId = plsqlPackageNodeId(home.file, name);
    packageNode.set(name, nodeId);
    const bodyFiles = [...home.files].filter((f) => f !== home.file);
    graph.addNode({
      id: nodeId,
      label: 'Module',
      properties: {
        name,
        filePath: home.file,
        startLine: toZeroBasedLine(home.def.startLine),
        endLine: toZeroBasedLine(home.def.endLine),
        language: SupportedLanguages.PlSql,
        isExported: true,
        description:
          bodyFiles.length > 0
            ? `PL/SQL package; also defined in ${bodyFiles.join(', ')}`
            : 'PL/SQL package',
      },
    });
    for (const file of home.files) {
      addEdge(graph, 'CONTAINS', generateId('File', file), nodeId, 1.0, 'plsql-package');
    }
  }
  for (const entry of entryOf.values()) {
    if (entry.def.kind === 'package') entry.nodeId = packageNode.get(entry.def.name);
  }

  // ── subprograms and triggers ──
  const bodySignatures = new Set<string>();
  const specSignatures = new Set<string>();
  for (const entry of entryOf.values()) {
    if (entry.def.kind === 'package') continue;
    (entry.def.isSpec ? specSignatures : bodySignatures).add(plsqlSignatureKey(entry.def));
  }
  const bodyNodeBySignature = new Map<string, string>();
  let subprograms = 0;
  let triggers = 0;
  let fallbackDefinitions = 0;
  for (const entry of entryOf.values()) {
    const { def, filePath } = entry;
    if (def.kind === 'package') continue;
    if (def.fromFallback) fallbackDefinitions++;
    // A spec declaration with an indexed body is the same subprogram.
    if (def.isSpec && bodySignatures.has(plsqlSignatureKey(def))) continue;
    entry.nodeId = plsqlSubprogramNodeId(filePath, def);
    if (!def.isSpec) bodyNodeBySignature.set(plsqlSignatureKey(def), entry.nodeId);
    if (def.kind === 'trigger') triggers++;
    else subprograms++;
    const packageMember = def.ownerPath.length === 1 && packageNode.has(def.ownerPath[0]!);
    graph.addNode({
      id: entry.nodeId,
      label: 'Function',
      properties: {
        name: def.name,
        filePath,
        startLine: toZeroBasedLine(def.startLine),
        endLine: toZeroBasedLine(def.endLine),
        language: SupportedLanguages.PlSql,
        // Package members are public exactly when the spec declares them.
        isExported: packageMember
          ? specSignatures.has(plsqlSignatureKey(def))
          : def.ownerPath.length === 0,
        parameterCount: def.parameters.length,
        description: describeDefinition(def),
      },
    });
  }
  for (const entry of entryOf.values()) {
    if (entry.def.isSpec && entry.def.kind !== 'package' && !entry.nodeId) {
      entry.nodeId = bodyNodeBySignature.get(plsqlSignatureKey(entry.def));
    }
  }

  /** Graph node of the innermost definition enclosing `ownerPath` in `filePath`. */
  const ownerNode = (filePath: string, ownerPath: readonly string[]): string | undefined => {
    if (ownerPath.length === 0) return undefined;
    const name = ownerPath[ownerPath.length - 1]!;
    const parent = ownerPath.slice(0, -1);
    const local = index
      .lookup(parent, name)
      .find((e) => e.filePath === filePath && !e.def.isSpec && e.nodeId !== undefined);
    if (local) return local.nodeId;
    return ownerPath.length === 1 ? packageNode.get(name) : undefined;
  };

  for (const entry of entryOf.values()) {
    const { def, filePath, nodeId } = entry;
    if (
      def.kind === 'package' ||
      !nodeId ||
      (def.isSpec && bodySignatures.has(plsqlSignatureKey(def)))
    )
      continue;
    const owner = ownerNode(filePath, def.ownerPath) ?? generateId('File', filePath);
    addEdge(
      graph,
      'CONTAINS',
      owner,
      nodeId,
      1.0,
      def.kind === 'trigger' ? 'plsql-trigger' : 'plsql-subprogram',
    );
  }

  // ── calls ──
  let calls = 0;
  let ambiguousCalls = 0;
  let unresolvedCalls = 0;
  for (const [filePath, f] of facts) {
    const degraded = f.segmentsWithErrors > 0;
    for (const call of f.calls) {
      const sourceId = ownerNode(filePath, call.ownerPath);
      if (!sourceId) continue; // top-level script statements have no callable owner
      const targets = call.dbLink ? [] : index.resolve(call).filter((t) => t.nodeId !== undefined);
      if (targets.length === 0) {
        if (call.form === 'statement') unresolvedCalls++;
        continue;
      }
      const ambiguous = targets.length > 1;
      if (ambiguous) ambiguousCalls++;
      for (const target of targets) {
        graph.addRelationship({
          id: generateId('CALLS', `${sourceId}->${target.nodeId}:L${call.line}:${call.column}`),
          type: 'CALLS',
          sourceId,
          targetId: target.nodeId!,
          confidence: ambiguous ? 0.5 : degraded || target.def.fromFallback ? 0.7 : 1.0,
          reason: ambiguous ? 'plsql-call-ambiguous' : 'plsql-call',
        });
        calls++;
      }
    }
  }

  // ── table accesses ──
  const tables = new Set<string>();
  let accesses = 0;
  for (const [filePath, f] of facts) {
    for (const access of f.accesses) {
      const sourceId = ownerNode(filePath, access.ownerPath);
      if (!sourceId) continue;
      const tableId = plsqlTableNodeId(access.table);
      if (!tables.has(access.table)) {
        tables.add(access.table);
        graph.addNode({
          id: tableId,
          label: 'Record',
          properties: {
            name: access.table,
            // A table is a database object, not source; anchor it at its first
            // reference so it stays navigable.
            filePath,
            startLine: toZeroBasedLine(access.line),
            endLine: toZeroBasedLine(access.line),
            language: SupportedLanguages.PlSql,
            description: 'database table or view referenced from PL/SQL',
          },
        });
      }
      graph.addRelationship({
        id: generateId(
          'ACCESSES',
          `${sourceId}->${tableId}:${access.kind}:L${access.line}:${access.column}`,
        ),
        type: 'ACCESSES',
        sourceId,
        targetId: tableId,
        confidence: f.segmentsWithErrors > 0 ? 0.7 : 1.0,
        reason: `plsql-${access.kind}`,
      });
      accesses++;
    }
  }

  // ── SQL*Plus script includes ──
  let scriptIncludes = 0;
  for (const [filePath, f] of facts) {
    for (const include of f.scriptIncludes) {
      const target = resolvePlSqlScriptInclude(include.target, filePath, allPaths);
      if (!target) continue;
      addEdge(
        graph,
        'IMPORTS',
        generateId('File', filePath),
        generateId('File', target),
        1.0,
        'plsql-script-include',
        `:L${include.line}`,
      );
      scriptIncludes++;
    }
  }

  let segmentsWithErrors = 0;
  let dynamicSqlSites = 0;
  for (const f of facts.values()) {
    segmentsWithErrors += f.segmentsWithErrors;
    dynamicSqlSites += f.dynamicSql.length;
  }

  return {
    files: files.length,
    packages: packageNode.size,
    subprograms,
    triggers,
    tables: tables.size,
    calls,
    ambiguousCalls,
    unresolvedCalls,
    accesses,
    scriptIncludes,
    dynamicSqlSites,
    segmentsWithErrors,
    fallbackDefinitions,
  };
}

function addEdge(
  graph: KnowledgeGraph,
  type: 'CONTAINS' | 'IMPORTS',
  sourceId: string,
  targetId: string,
  confidence: number,
  reason: string,
  idSuffix = '',
): void {
  graph.addRelationship({
    id: generateId(type, `${sourceId}->${targetId}${idSuffix}`),
    type,
    sourceId,
    targetId,
    confidence,
    reason,
  });
}

function describeDefinition(def: PlSqlDefinition): string | undefined {
  const parts: string[] = [];
  if (def.kind === 'trigger' && def.triggerTable) parts.push(`trigger on ${def.triggerTable}`);
  if (def.isSpec) parts.push('declared in package spec (no body indexed)');
  if (def.fromFallback) parts.push('recovered by fallback; parameters unknown');
  return parts.length > 0 ? parts.join('; ') : undefined;
}
