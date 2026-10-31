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
import type { PlSqlDefinition, PlSqlFileFacts } from './plsql/extract.js';
import { plsqlFactsForFile, resetPlSqlFactsStore } from './plsql/facts-store.js';
import { isPlSqlSource } from './plsql/file-types.js';
import { resolvePlSqlScriptInclude } from './plsql/script-include.js';
import {
  PlSqlNameIndex,
  PlSqlPackageInstances,
  plsqlSignatureKey,
  rootPackageOf,
  type PlSqlIndexEntry,
} from './plsql/resolve.js';

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
  /** Segments abandoned at the parse deadline (a subset of `segmentsWithErrors`). */
  readonly segmentsTimedOut: number;
  readonly fallbackDefinitions: number;
}

export { isPlSqlSource };

// ─── node identity ────────────────────────────────────────────────────────

/**
 * A package is one node for spec and body, keyed by the file that declares it.
 * The schema joins the key only when one file declares same-named packages of
 * several schemas, so ordinary ids stay `Module:<file>:<name>`.
 */
export function plsqlPackageNodeId(homeFile: string, packageName: string, schema?: string): string {
  return generateId('Module', `${homeFile}:${schema ? `${schema}.` : ''}${packageName}`);
}

/**
 * Subprograms are keyed by owner path plus the normalised parameter signature,
 * so overloads get distinct ids that survive edits elsewhere in the file.
 */
export function plsqlSubprogramNodeId(
  filePath: string,
  def: PlSqlDefinition,
  packageSchema?: string,
): string {
  const schema = packageSchema ? `${packageSchema}.` : '';
  return generateId(
    'Function',
    `${filePath}:${schema}${plsqlSignatureKey(def)}${def.kind === 'trigger' ? ':trigger' : ''}`,
  );
}

export function plsqlTableNodeId(tableName: string): string {
  return generateId('Record', `plsql-table:${tableName}`);
}

interface Entry extends PlSqlIndexEntry {
  /** Graph node of this definition (a declaration with a body maps to the body). */
  nodeId?: string;
}

// ─── graph mapping ────────────────────────────────────────────────────────

export function processPlSql(
  graph: KnowledgeGraph,
  files: readonly PlSqlFile[],
  allPaths: ReadonlySet<string> = new Set(files.map((f) => f.path)),
): PlSqlProcessResult {
  resetPlSqlFactsStore(files.length);
  const facts = new Map<string, PlSqlFileFacts>();
  for (const file of files) facts.set(file.path, plsqlFactsForFile(file.path, file.content));

  const index = new PlSqlNameIndex<Entry>();
  const entryOf = new Map<PlSqlDefinition, Entry>();
  for (const [filePath, f] of facts) {
    for (const def of f.definitions) {
      const entry: Entry = {
        def,
        filePath,
        packageSchema:
          def.kind === 'package' ? undefined : rootPackageOf(def, f.definitions)?.schema,
      };
      entryOf.set(def, entry);
      index.add(entry);
    }
  }

  // ── package instances: each spec paired with its nearest compatible body ──
  const packageDefs = [...entryOf.values()].filter((e) => e.def.kind === 'package');
  const instances = new PlSqlPackageInstances(
    packageDefs.map((e) => ({
      name: e.def.name,
      schema: e.def.schema,
      filePath: e.filePath,
      isSpec: e.def.isSpec,
    })),
  );
  const instanceOfPackage = (pkg: PlSqlDefinition, filePath: string) =>
    instances.instanceOf(pkg.name, pkg.schema, filePath);
  /** The package instance a definition in `filePath` belongs to, if it is a package member. */
  const memberInstance = (def: PlSqlDefinition, filePath: string): string | undefined => {
    if (def.kind === 'package') return undefined;
    const pkg = rootPackageOf(def, facts.get(filePath)!.definitions);
    return pkg ? instanceOfPackage(pkg, filePath) : undefined;
  };
  /** Pairs a spec/forward declaration with its body inside one package instance (or one file). */
  const pairingKey = (def: PlSqlDefinition, filePath: string) =>
    `${memberInstance(def, filePath) ?? `\0${filePath}`}|${plsqlSignatureKey(def)}`;

  const packageNodeByInstance = new Map<string, string>();
  const instanceFiles = new Map<string, { home: string; anchor: Entry; files: Set<string> }>();
  for (const entry of packageDefs) {
    const key = instanceOfPackage(entry.def, entry.filePath);
    const instance = instanceFiles.get(key);
    if (!instance) {
      instanceFiles.set(key, {
        home: instances.homeOf(key) ?? entry.filePath,
        anchor: entry,
        files: new Set([entry.filePath]),
      });
    } else {
      instance.files.add(entry.filePath);
      if (entry.def.isSpec && !instance.anchor.def.isSpec) instance.anchor = entry;
    }
  }
  const homeClashes = new Map<string, number>();
  for (const instance of instanceFiles.values()) {
    const k = `${instance.home}\0${instance.anchor.def.name}`;
    homeClashes.set(k, (homeClashes.get(k) ?? 0) + 1);
  }
  for (const [key, instance] of instanceFiles) {
    const { name, schema } = instance.anchor.def;
    const clash = (homeClashes.get(`${instance.home}\0${name}`) ?? 0) > 1;
    const nodeId = plsqlPackageNodeId(instance.home, name, clash ? schema : undefined);
    packageNodeByInstance.set(key, nodeId);
    const others = [...instance.files].filter((f) => f !== instance.home).sort();
    graph.addNode({
      id: nodeId,
      label: 'Module',
      properties: {
        name,
        filePath: instance.home,
        startLine: toZeroBasedLine(instance.anchor.def.startLine),
        endLine: toZeroBasedLine(instance.anchor.def.endLine),
        language: SupportedLanguages.PlSql,
        isExported: true,
        description:
          others.length > 0
            ? `PL/SQL package; also defined in ${others.join(', ')}`
            : 'PL/SQL package',
      },
    });
    for (const file of instance.files) {
      addEdge(graph, 'CONTAINS', generateId('File', file), nodeId, 1.0, 'plsql-package');
    }
  }
  for (const entry of packageDefs) {
    entry.nodeId = packageNodeByInstance.get(instanceOfPackage(entry.def, entry.filePath));
    entry.instance = instanceOfPackage(entry.def, entry.filePath);
  }
  for (const entry of entryOf.values()) {
    if (entry.def.kind !== 'package') entry.instance = memberInstance(entry.def, entry.filePath);
  }

  // ── subprograms and triggers ──
  const bodyKeys = new Set<string>();
  const publicKeys = new Set<string>();
  for (const { def, filePath } of entryOf.values()) {
    if (def.kind === 'package') continue;
    if (!def.declarationOnly) bodyKeys.add(pairingKey(def, filePath));
    if (def.isSpec) publicKeys.add(pairingKey(def, filePath));
  }
  const bodyNodeByKey = new Map<string, string>();
  let subprograms = 0;
  let triggers = 0;
  let fallbackDefinitions = 0;
  for (const entry of entryOf.values()) {
    const { def, filePath } = entry;
    if (def.kind === 'package') continue;
    if (def.fromFallback) fallbackDefinitions++;
    const key = pairingKey(def, filePath);
    // A spec/forward declaration with an indexed body is the same subprogram.
    if (def.declarationOnly && bodyKeys.has(key)) continue;
    // Package members carry their package's schema; standalone subprograms
    // their own (`CREATE PROCEDURE a.p` and `b.p` in one file are two objects).
    const schema = entry.packageSchema ?? (def.ownerPath.length === 0 ? def.schema : undefined);
    entry.nodeId = plsqlSubprogramNodeId(filePath, def, schema);
    if (!def.declarationOnly) bodyNodeByKey.set(key, entry.nodeId);
    if (def.kind === 'trigger') triggers++;
    else subprograms++;
    const packageMember = def.ownerPath.length === 1 && memberInstance(def, filePath) !== undefined;
    graph.addNode({
      id: entry.nodeId,
      label: 'Function',
      properties: {
        name: def.name,
        filePath,
        startLine: toZeroBasedLine(def.startLine),
        endLine: toZeroBasedLine(def.endLine),
        language: SupportedLanguages.PlSql,
        // Package members are public exactly when the package spec declares them.
        isExported: packageMember ? publicKeys.has(key) : def.ownerPath.length === 0,
        parameterCount: def.parameters.length,
        description: describeDefinition(def),
      },
    });
  }
  for (const entry of entryOf.values()) {
    if (entry.def.declarationOnly && !entry.nodeId) {
      entry.nodeId = bodyNodeByKey.get(pairingKey(entry.def, entry.filePath));
    }
  }

  /**
   * Graph node that owns a site or definition: the definition at `ownerIndex`
   * (by position, so overloads keep their own sites), or — for fallback
   * definitions, which carry no index — the file's package instance.
   */
  const ownerNode = (
    filePath: string,
    fileFacts: PlSqlFileFacts,
    site: { readonly ownerIndex?: number; readonly ownerPath: readonly string[] },
  ): string | undefined => {
    if (site.ownerIndex !== undefined) {
      const owner = fileFacts.definitions[site.ownerIndex]!;
      return entryOf.get(owner)?.nodeId;
    }
    const pkgName = site.ownerPath[0];
    const pkg =
      site.ownerPath.length === 1
        ? fileFacts.definitions.find((d) => d.kind === 'package' && d.name === pkgName)
        : undefined;
    if (pkg) return packageNodeByInstance.get(instanceOfPackage(pkg, filePath));
    return undefined;
  };

  for (const [filePath, f] of facts) {
    for (const def of f.definitions) {
      const nodeId = entryOf.get(def)?.nodeId;
      if (def.kind === 'package' || !nodeId || def.declarationOnly) continue;
      const owner = ownerNode(filePath, f, def) ?? generateId('File', filePath);
      addEdge(
        graph,
        'CONTAINS',
        owner,
        nodeId,
        1.0,
        def.kind === 'trigger' ? 'plsql-trigger' : 'plsql-subprogram',
      );
    }
  }
  // Spec-only subprograms (no body indexed) hang off their package.
  for (const entry of entryOf.values()) {
    const { def, filePath, nodeId } = entry;
    if (!def.declarationOnly || !nodeId || bodyKeys.has(pairingKey(def, filePath))) continue;
    const facts0 = facts.get(filePath)!;
    const owner = ownerNode(filePath, facts0, def) ?? generateId('File', filePath);
    addEdge(graph, 'CONTAINS', owner, nodeId, 1.0, 'plsql-subprogram');
  }

  // ── calls ──
  let calls = 0;
  let ambiguousCalls = 0;
  let unresolvedCalls = 0;
  for (const [filePath, f] of facts) {
    const degraded = f.segmentsWithErrors > 0;
    for (const call of f.calls) {
      const sourceId = ownerNode(filePath, f, call);
      if (!sourceId) continue; // top-level script statements have no callable owner
      const targets = call.dbLink
        ? []
        : index.resolve(call, filePath).filter((t) => t.nodeId !== undefined);
      const targetIds = [...new Set(targets.map((t) => t.nodeId!))];
      if (targetIds.length === 0) {
        if (call.form === 'statement') unresolvedCalls++;
        continue;
      }
      const ambiguous = targetIds.length > 1;
      if (ambiguous) ambiguousCalls++;
      const fallbackTarget = targets.some((t) => t.def.fromFallback);
      for (const targetId of targetIds) {
        graph.addRelationship({
          id: generateId('CALLS', `${sourceId}->${targetId}:L${call.line}:${call.column}`),
          type: 'CALLS',
          sourceId,
          targetId,
          confidence: ambiguous ? 0.5 : degraded || fallbackTarget ? 0.7 : 1.0,
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
      const sourceId = ownerNode(filePath, f, access);
      if (!sourceId) continue;
      // A table over a database link is a remote object, not the local table
      // of the same name: its identity keeps the link.
      const tableName = access.dbLink ? `${access.table}@${access.dbLink}` : access.table;
      const tableId = plsqlTableNodeId(tableName);
      if (!tables.has(tableName)) {
        tables.add(tableName);
        graph.addNode({
          id: tableId,
          label: 'Record',
          properties: {
            name: tableName,
            // A table is a database object, not source; anchor it at its first
            // reference so it stays navigable.
            filePath,
            startLine: toZeroBasedLine(access.line),
            endLine: toZeroBasedLine(access.line),
            language: SupportedLanguages.PlSql,
            description: access.dbLink
              ? `remote table or view over database link ${access.dbLink}, referenced from PL/SQL`
              : 'database table or view referenced from PL/SQL',
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
      const target = resolvePlSqlScriptInclude(
        include.target,
        filePath,
        allPaths,
        include.relativeToScript,
      );
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
  let segmentsTimedOut = 0;
  let dynamicSqlSites = 0;
  for (const f of facts.values()) {
    segmentsWithErrors += f.segmentsWithErrors;
    segmentsTimedOut += f.segmentsTimedOut;
    dynamicSqlSites += f.dynamicSql.length;
  }

  return {
    files: files.length,
    packages: packageNodeByInstance.size,
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
    segmentsTimedOut,
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
  if (def.declarationOnly)
    parts.push(
      def.isSpec
        ? 'declared in package spec (no body indexed)'
        : 'forward declaration (no body indexed)',
    );
  if (def.fromFallback) parts.push('recovered by fallback; parameters unknown');
  return parts.length > 0 ? parts.join('; ') : undefined;
}
