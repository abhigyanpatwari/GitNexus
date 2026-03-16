/**
 * MRO (Method Resolution Order) Processor
 *
 * Walks the inheritance DAG (EXTENDS/IMPLEMENTS edges), collects methods from
 * each ancestor via HAS_METHOD edges, detects method-name collisions across
 * parents, and applies language-specific resolution rules to emit OVERRIDES edges.
 *
 * Language-specific rules:
 * - C++:       leftmost base class in declaration order wins
 * - C#/Java:   class method wins over interface default; multiple interface
 *              methods with same name are ambiguous (null resolution)
 * - Python:    C3 linearization determines MRO; first in linearized order wins
 * - Rust:      no auto-resolution — requires qualified syntax, resolvedTo = null
 * - Default:   single inheritance — first definition wins
 *
 * OVERRIDES edge direction: Class → Method (not Method → Method).
 * The source is the child class that inherits conflicting methods,
 * the target is the winning ancestor method node.
 * Cypher: MATCH (c:Class)-[r:CodeRelation {type: 'OVERRIDES'}]->(m:Method)
 */

import { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MROEntry {
  classId: string;
  className: string;
  language: SupportedLanguages;
  mro: string[];               // linearized parent names
  ambiguities: MethodAmbiguity[];
}

export interface MethodAmbiguity {
  methodName: string;
  definedIn: Array<{ classId: string; className: string; methodId: string }>;
  resolvedTo: string | null;   // winning methodId or null if truly ambiguous
  reason: string;
}

export interface MROResult {
  entries: MROEntry[];
  overrideEdges: number;
  ambiguityCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect EXTENDS, IMPLEMENTS, and HAS_METHOD adjacency from the graph. */
function buildAdjacency(graph: KnowledgeGraph) {
  // parentMap: childId → parentIds[] (in insertion / declaration order)
  const parentMap = new Map<string, string[]>();
  // methodMap: classId → methodIds[]
  const methodMap = new Map<string, string[]>();
  // Track which edge type each parent link came from
  const parentEdgeType = new Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>();

  graph.forEachRelationship((rel) => {
    if (rel.type === 'EXTENDS' || rel.type === 'IMPLEMENTS') {
      let parents = parentMap.get(rel.sourceId);
      if (!parents) {
        parents = [];
        parentMap.set(rel.sourceId, parents);
      }
      parents.push(rel.targetId);

      let edgeTypes = parentEdgeType.get(rel.sourceId);
      if (!edgeTypes) {
        edgeTypes = new Map();
        parentEdgeType.set(rel.sourceId, edgeTypes);
      }
      edgeTypes.set(rel.targetId, rel.type);
    }

    if (rel.type === 'HAS_METHOD') {
      let methods = methodMap.get(rel.sourceId);
      if (!methods) {
        methods = [];
        methodMap.set(rel.sourceId, methods);
      }
      methods.push(rel.targetId);
    }
  });

  return { parentMap, methodMap, parentEdgeType };
}

/**
 * Gather all ancestor IDs in BFS / topological order.
 * Returns the linearized list of ancestor IDs (excluding the class itself).
 */
function gatherAncestors(
  classId: string,
  parentMap: Map<string, string[]>,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...(parentMap.get(classId) ?? [])];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const grandparents = parentMap.get(id);
    if (grandparents) {
      for (const gp of grandparents) {
        if (!visited.has(gp)) queue.push(gp);
      }
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// C3 linearization (Python MRO)
// ---------------------------------------------------------------------------

/**
 * Compute C3 linearization for a class given a parentMap.
 * Returns an array of ancestor IDs in C3 order (excluding the class itself),
 * or null if linearization fails (inconsistent or cyclic hierarchy).
 */
function c3Linearize(
  classId: string,
  parentMap: Map<string, string[]>,
  cache: Map<string, string[] | null>,
  inProgress?: Set<string>,
): string[] | null {
  if (cache.has(classId)) return cache.get(classId)!;

  // Cycle detection: if we're already computing this class, the hierarchy is cyclic
  const visiting = inProgress ?? new Set<string>();
  if (visiting.has(classId)) {
    cache.set(classId, null);
    return null;
  }
  visiting.add(classId);

  const directParents = parentMap.get(classId);
  if (!directParents || directParents.length === 0) {
    visiting.delete(classId);
    cache.set(classId, []);
    return [];
  }

  // Compute linearization for each parent first
  const parentLinearizations: string[][] = [];
  for (const pid of directParents) {
    const pLin = c3Linearize(pid, parentMap, cache, visiting);
    if (pLin === null) {
      visiting.delete(classId);
      cache.set(classId, null);
      return null;
    }
    parentLinearizations.push([pid, ...pLin]);
  }

  // Add the direct parents list as the final sequence
  const sequences = [...parentLinearizations, [...directParents]];
  const result: string[] = [];

  while (sequences.some(s => s.length > 0)) {
    // Find a good head: one that doesn't appear in the tail of any other sequence
    let head: string | null = null;
    for (const seq of sequences) {
      if (seq.length === 0) continue;
      const candidate = seq[0];
      const inTail = sequences.some(
        other => other.length > 1 && other.indexOf(candidate, 1) !== -1
      );
      if (!inTail) {
        head = candidate;
        break;
      }
    }

    if (head === null) {
      // Inconsistent hierarchy
      visiting.delete(classId);
      cache.set(classId, null);
      return null;
    }

    result.push(head);

    // Remove the chosen head from all sequences
    for (const seq of sequences) {
      if (seq.length > 0 && seq[0] === head) {
        seq.shift();
      }
    }
  }

  visiting.delete(classId);
  cache.set(classId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Language-specific resolution
// ---------------------------------------------------------------------------

type MethodDef = { classId: string; className: string; methodId: string };
type Resolution = { resolvedTo: string | null; reason: string };

/** Resolve by MRO order — first ancestor in linearized order wins. */
function resolveByMroOrder(
  methodName: string,
  defs: MethodDef[],
  mroOrder: string[],
  reasonPrefix: string,
): Resolution {
  for (const ancestorId of mroOrder) {
    const match = defs.find(d => d.classId === ancestorId);
    if (match) {
      return {
        resolvedTo: match.methodId,
        reason: `${reasonPrefix}: ${match.className}::${methodName}`,
      };
    }
  }
  return { resolvedTo: defs[0].methodId, reason: `${reasonPrefix} fallback: first definition` };
}

function resolveCsharpJava(
  methodName: string,
  defs: MethodDef[],
  parentEdgeTypes: Map<string, 'EXTENDS' | 'IMPLEMENTS'> | undefined,
): Resolution {
  const classDefs: MethodDef[] = [];
  const interfaceDefs: MethodDef[] = [];

  for (const def of defs) {
    const edgeType = parentEdgeTypes?.get(def.classId);
    if (edgeType === 'IMPLEMENTS') {
      interfaceDefs.push(def);
    } else {
      classDefs.push(def);
    }
  }

  if (classDefs.length > 0) {
    return {
      resolvedTo: classDefs[0].methodId,
      reason: `class method wins: ${classDefs[0].className}::${methodName}`,
    };
  }

  if (interfaceDefs.length > 1) {
    return {
      resolvedTo: null,
      reason: `ambiguous: ${methodName} defined in multiple interfaces: ${interfaceDefs.map(d => d.className).join(', ')}`,
    };
  }

  if (interfaceDefs.length === 1) {
    return {
      resolvedTo: interfaceDefs[0].methodId,
      reason: `single interface default: ${interfaceDefs[0].className}::${methodName}`,
    };
  }

  return { resolvedTo: null, reason: 'no resolution found' };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function computeMRO(graph: KnowledgeGraph): MROResult {
  const { parentMap, methodMap, parentEdgeType } = buildAdjacency(graph);
  const c3Cache = new Map<string, string[] | null>();

  const entries: MROEntry[] = [];
  let overrideEdges = 0;
  let ambiguityCount = 0;

  // Process every class that has at least one parent
  for (const [classId, directParents] of parentMap) {
    if (directParents.length === 0) continue;

    const classNode = graph.getNode(classId);
    if (!classNode) continue;

    const language = classNode.properties.language;
    if (!language) continue;
    const className = classNode.properties.name;

    // Compute linearized MRO depending on language
    let mroOrder: string[];
    if (language === SupportedLanguages.Python) {
      const c3Result = c3Linearize(classId, parentMap, c3Cache);
      mroOrder = c3Result ?? gatherAncestors(classId, parentMap);
    } else {
      mroOrder = gatherAncestors(classId, parentMap);
    }

    // Get the parent names for the MRO entry
    const mroNames: string[] = mroOrder
      .map(id => graph.getNode(id)?.properties.name)
      .filter((n): n is string => n !== undefined);

    // Collect methods from all ancestors, grouped by method name
    const methodsByName = new Map<string, MethodDef[]>();
    for (const ancestorId of mroOrder) {
      const ancestorNode = graph.getNode(ancestorId);
      if (!ancestorNode) continue;

      const methods = methodMap.get(ancestorId) ?? [];
      for (const methodId of methods) {
        const methodNode = graph.getNode(methodId);
        if (!methodNode) continue;
        // Properties don't participate in method resolution order
        if (methodNode.label === 'Property') continue;

        const methodName = methodNode.properties.name;
        let defs = methodsByName.get(methodName);
        if (!defs) {
          defs = [];
          methodsByName.set(methodName, defs);
        }
        // Avoid duplicates (same method seen via multiple paths)
        if (!defs.some(d => d.methodId === methodId)) {
          defs.push({
            classId: ancestorId,
            className: ancestorNode.properties.name,
            methodId,
          });
        }
      }
    }

    // Detect collisions: methods defined in 2+ different ancestors
    const ambiguities: MethodAmbiguity[] = [];

    // Compute transitive edge types once per class (only needed for C#/Java)
    const needsEdgeTypes = language === SupportedLanguages.CSharp || language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin;
    const classEdgeTypes = needsEdgeTypes
      ? buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType)
      : undefined;

    for (const [methodName, defs] of methodsByName) {
      if (defs.length < 2) continue;

      // Own method shadows inherited — no ambiguity
      const ownMethods = methodMap.get(classId) ?? [];
      const ownDefinesIt = ownMethods.some(mid => {
        const mn = graph.getNode(mid);
        return mn?.properties.name === methodName;
      });
      if (ownDefinesIt) continue;

      let resolution: Resolution;

      switch (language) {
        case SupportedLanguages.CPlusPlus:
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'C++ leftmost base');
          break;
        case SupportedLanguages.CSharp:
        case SupportedLanguages.Java:
        case SupportedLanguages.Kotlin:
          resolution = resolveCsharpJava(methodName, defs, classEdgeTypes);
          break;
        case SupportedLanguages.Python:
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'Python C3 MRO');
          break;
        case SupportedLanguages.Rust:
          resolution = {
            resolvedTo: null,
            reason: `Rust requires qualified syntax: <Type as Trait>::${methodName}()`,
          };
          break;
        default:
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'first definition');
          break;
      }

      const ambiguity: MethodAmbiguity = {
        methodName,
        definedIn: defs,
        resolvedTo: resolution.resolvedTo,
        reason: resolution.reason,
      };
      ambiguities.push(ambiguity);

      if (resolution.resolvedTo === null) {
        ambiguityCount++;
      }

      // Emit OVERRIDES edge if resolution found
      if (resolution.resolvedTo !== null) {
        graph.addRelationship({
          id: generateId('OVERRIDES', `${classId}->${resolution.resolvedTo}`),
          sourceId: classId,
          targetId: resolution.resolvedTo,
          type: 'OVERRIDES',
          confidence: 1.0,
          reason: resolution.reason,
        });
        overrideEdges++;
      }
    }

    entries.push({
      classId,
      className,
      language,
      mro: mroNames,
      ambiguities,
    });
  }

  return { entries, overrideEdges, ambiguityCount };
}

/**
 * Build transitive edge types for a class using BFS from the class to all ancestors.
 *
 * Known limitation: BFS first-reach heuristic can misclassify an interface as
 * EXTENDS if it's reachable via a class chain before being seen via IMPLEMENTS.
 * E.g. if BaseClass also implements IFoo, IFoo may be classified as EXTENDS.
 * This affects C#/Java/Kotlin conflict resolution in rare diamond hierarchies.
 */
function buildTransitiveEdgeTypes(
  classId: string,
  parentMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
): Map<string, 'EXTENDS' | 'IMPLEMENTS'> {
  const result = new Map<string, 'EXTENDS' | 'IMPLEMENTS'>();
  const directEdges = parentEdgeType.get(classId);
  if (!directEdges) return result;

  // BFS: propagate edge type from direct parents
  const queue: Array<{ id: string; edgeType: 'EXTENDS' | 'IMPLEMENTS' }> = [];
  const directParents = parentMap.get(classId) ?? [];

  for (const pid of directParents) {
    const et = directEdges.get(pid) ?? 'EXTENDS';
    if (!result.has(pid)) {
      result.set(pid, et);
      queue.push({ id: pid, edgeType: et });
    }
  }

  while (queue.length > 0) {
    const { id, edgeType } = queue.shift()!;
    const grandparents = parentMap.get(id) ?? [];
    for (const gp of grandparents) {
      if (!result.has(gp)) {
        result.set(gp, edgeType);
        queue.push({ id: gp, edgeType });
      }
    }
  }

  return result;
}
