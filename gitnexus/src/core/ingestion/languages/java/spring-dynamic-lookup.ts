/**
 * Spring dynamic bean lookup heuristic: `SpringContextUtil.getBeans(X.class)`.
 *
 * Java frameworks commonly provide a static accessor that retrieves all Spring
 * beans of a given type at runtime — e.g. Winning Health's
 * `SpringContextUtil.getBeans(X.class)` or Spring's own
 * `ApplicationContext.getBeansOfType(X.class)`. These calls are the programmatic
 * equivalent of `@Autowired List<X>`: both express "inject all implementations
 * of interface X".
 *
 * The call graph sees `SpringContextUtil.getBeans(...)` but cannot resolve the
 * receiver (it's a static utility in a binary JAR), so the call resolves to
 * nothing. The INJECTS edges from the caller to each implementer of X are
 * missing entirely.
 *
 * This module scans Function/Method graph nodes for source text matching the
 * pattern `*.getBeans(Type.class)` / `*.getBean(Type.class)`, resolves `Type`
 * to an Interface node via IMPLEMENTS edges, and emits INJECTS edges from the
 * calling function to each implementer.
 *
 * Runs in `emitPostResolutionEdges` (after the full graph is built).
 */

import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ParsedFile } from 'gitnexus-shared';

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Method names that perform dynamic bean lookup by type.
 * `getBeans` / `getBeansOfType` → collection (all implementers)
 * `getBean` → single (first match, but we still fan out to all)
 */
const COLLECTION_METHODS = new Set(['getBeans', 'getBeansOfType']);
const SINGLE_METHODS = new Set(['getBean']);

/**
 * Receiver names commonly used for Spring's ApplicationContext or vendor
 * equivalents. Intentionally broad — false positives are low-cost.
 */
const KNOWN_RECEIVERS = new Set([
  'SpringContextUtil',
  'SpringContextHolder',
  'SpringBeanUtil',
  'ApplicationContextProvider',
  'BeanFactoryProvider',
  'applicationContext',
  'context',
  'ctx',
  'appContext',
  'beanFactory',
]);

// ── Helpers ───────────────────────────────────────────────────────────────

interface LookupSite {
  callerNodeId: string;
  typeName: string;
  isCollection: boolean;
}

/** Detect `Receiver.method(Type.class)` patterns in source text. */
function extractDynamicLookups(sourceText: string, callerNodeId: string): LookupSite[] {
  const sites: LookupSite[] = [];
  // Match: receiver.getBean[s](Type.class)
  const pattern = /(\w+)\.(getBeans(?:OfType)?|getBean)\s*\(\s*(\w+)\.class\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sourceText)) !== null) {
    const receiver = match[1];
    const methodName = match[2];
    const typeName = match[3];
    if (!KNOWN_RECEIVERS.has(receiver)) continue;
    const isCollection = COLLECTION_METHODS.has(methodName);
    if (!isCollection && !SINGLE_METHODS.has(methodName)) continue;
    sites.push({ callerNodeId, typeName, isCollection });
  }
  return sites;
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Attach INJECTS edges for dynamic bean lookups.
 * Called from `emitPostResolutionEdges` in the Java scope resolver.
 */
export function attachJavaSpringDynamicLookup(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  fileContents: ReadonlyMap<string, string>,
): void {
  // Build Interface/Class name → node-ID index
  const typeIndex = new Map<string, string[]>();
  graph.forEachNode((node) => {
    if (node.label === 'Interface' || node.label === 'Class') {
      const name = node.properties.name as string | undefined;
      if (name) {
        const existing = typeIndex.get(name);
        if (existing) existing.push(node.id);
        else typeIndex.set(name, [node.id]);
      }
    }
  });

  // Build Interface → implementers map from IMPLEMENTS edges
  const implementersIndex = new Map<string, Set<string>>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const set = implementersIndex.get(rel.targetId) ?? new Set<string>();
    set.add(rel.sourceId);
    implementersIndex.set(rel.targetId, set);
  }

  // Build file-path → source-text lookup
  const sourceByFile = new Map<string, string>();
  for (const [path, content] of fileContents) {
    sourceByFile.set(path, content);
  }

  // Scan Function/Method nodes for dynamic lookup patterns
  graph.forEachNode((node) => {
    if (node.label !== 'Function' && node.label !== 'Method') return;

    const filePath = node.properties.filePath as string | undefined;
    const startLine = node.properties.startLine as number | undefined;
    const endLine = node.properties.endLine as number | undefined;
    if (!filePath || startLine === undefined || endLine === undefined) return;

    const source = sourceByFile.get(filePath);
    if (!source) return;

    // Extract function source by line range
    const lines = source.split('\n');
    const funcSource = lines
      .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
      .join('\n');

    const sites = extractDynamicLookups(funcSource, node.id);
    for (const site of sites) {
      // Resolve typeName → Interface node (skip ambiguous names)
      const typeIds = typeIndex.get(site.typeName);
      if (!typeIds || typeIds.length !== 1) continue;

      const implementers = implementersIndex.get(typeIds[0]);
      if (!implementers || implementers.size === 0) continue;

      // Emit INJECTS edges
      const confidence = site.isCollection ? 0.8 : 0.6;
      const reason = site.isCollection
        ? `Spring getBeans(${site.typeName}.class) dynamic collection lookup`
        : `Spring getBean(${site.typeName}.class) dynamic lookup`;

      for (const implId of implementers) {
        if (implId === node.id) continue;
        graph.addRelationship({
          id: `INJECTS:${node.id}->${implId}`,
          sourceId: node.id,
          targetId: implId,
          type: 'INJECTS',
          confidence,
          reason,
        });
      }
    }
  });
}
