/**
 * MRO (Method Resolution Order) Processor
 *
 * Walks the inheritance graph (EXTENDS/IMPLEMENTS edges), collects methods from
 * each ancestor via HAS_METHOD edges, detects method-name collisions across
 * parents, and applies language-specific resolution rules to emit METHOD_OVERRIDES edges.
 *
 * Language-specific rules:
 * - C++:       leftmost base class in declaration order wins
 * - C#/Java:   class method wins over interface default; multiple interface
 *              methods with same name are ambiguous (null resolution)
 * - Python:    C3 linearization determines MRO; first in linearized order wins
 * - Rust:      no auto-resolution — requires qualified syntax, resolvedTo = null
 * - Default:   single inheritance — first definition wins
 *
 * METHOD_OVERRIDES edge direction: Class → Method (not Method → Method).
 * The source is the child class that inherits conflicting methods,
 * the target is the winning ancestor method node.
 * Cypher: MATCH (c:Class)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(m:Method)
 */

import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from './languages/index.js';
import { c3Linearize, gatherAncestors } from './model/resolve.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MROEntry {
  classId: string;
  className: string;
  language: SupportedLanguages;
  mro: string[]; // linearized parent names
  ambiguities: MethodAmbiguity[];
}

export interface MethodAmbiguity {
  methodName: string;
  definedIn: Array<{ classId: string; className: string; methodId: string }>;
  resolvedTo: string | null; // winning methodId or null if truly ambiguous
  reason: string;
}

export interface MROResult {
  entries: MROEntry[];
  overrideEdges: number;
  ambiguityCount: number;
  methodImplementsEdges: number;
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

  // Three typed iterations replace one full-relationship-map scan
  // with per-edge type checks. Each consumes only the edges of the
  // type it cares about — see plan
  // docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 2).
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
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
    edgeTypes.set(rel.targetId, 'EXTENDS');
  }
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
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
    edgeTypes.set(rel.targetId, 'IMPLEMENTS');
  }
  for (const rel of graph.iterRelationshipsByType('HAS_METHOD')) {
    let methods = methodMap.get(rel.sourceId);
    if (!methods) {
      methods = [];
      methodMap.set(rel.sourceId, methods);
    }
    methods.push(rel.targetId);
  }

  return { parentMap, methodMap, parentEdgeType };
}

// `gatherAncestors` and `c3Linearize` live in `./model/resolve.ts` and
// are imported at the top of this file for internal use by `computeMRO`
// and the method-override edge emitter.

// ---------------------------------------------------------------------------
// Language-specific resolution
// ---------------------------------------------------------------------------

type MethodDef = { classId: string; className: string; methodId: string };
type Resolution = { resolvedTo: string | null; reason: string; confidence: number };

/** Resolve by MRO order — first ancestor in linearized order wins. */
function resolveByMroOrder(
  methodName: string,
  defs: MethodDef[],
  mroOrder: string[],
  reasonPrefix: string,
): Resolution {
  for (const ancestorId of mroOrder) {
    const match = defs.find((d) => d.classId === ancestorId);
    if (match) {
      return {
        resolvedTo: match.methodId,
        reason: `${reasonPrefix}: ${match.className}::${methodName}`,
        confidence: 0.9, // MRO-ordered resolution
      };
    }
  }
  return {
    resolvedTo: defs[0].methodId,
    reason: `${reasonPrefix} fallback: first definition`,
    confidence: 0.7,
  };
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
      confidence: 0.95, // Class method is authoritative
    };
  }

  if (interfaceDefs.length > 1) {
    return {
      resolvedTo: null,
      reason: `ambiguous: ${methodName} defined in multiple interfaces: ${interfaceDefs.map((d) => d.className).join(', ')}`,
      confidence: 0.5,
    };
  }

  if (interfaceDefs.length === 1) {
    return {
      resolvedTo: interfaceDefs[0].methodId,
      reason: `single interface default: ${interfaceDefs[0].className}::${methodName}`,
      confidence: 0.85, // Single interface, unambiguous
    };
  }

  return { resolvedTo: null, reason: 'no resolution found', confidence: 0.5 };
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

  // Pre-computed maps to avoid redundant BFS in emitMethodImplementsEdges
  const ancestorsMap = new Map<string, string[]>();
  const edgeTypesMap = new Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>();

  // Process every class that has at least one parent
  for (const [classId, directParents] of parentMap) {
    if (directParents.length === 0) continue;

    const classNode = graph.getNode(classId);
    if (!classNode) continue;

    const language = classNode.properties.language as SupportedLanguages | undefined;
    if (!language) continue;
    const className = classNode.properties.name;

    // Compute linearized MRO depending on language strategy
    const provider = getProvider(language);
    const ancestors = gatherAncestors(classId, parentMap);
    ancestorsMap.set(classId, ancestors);
    edgeTypesMap.set(classId, buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType));

    let mroOrder: string[];
    if (provider.mroStrategy === 'c3') {
      const c3Result = c3Linearize(classId, parentMap, c3Cache);
      mroOrder = c3Result ?? ancestors;
    } else {
      mroOrder = ancestors;
    }

    // Get the parent names for the MRO entry
    const mroNames: string[] = mroOrder
      .map((id) => graph.getNode(id)?.properties.name)
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
        if (!defs.some((d) => d.methodId === methodId)) {
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

    // Use pre-computed transitive edge types (only needed for implements-split languages)
    const needsEdgeTypes = provider.mroStrategy === 'implements-split';
    const classEdgeTypes = needsEdgeTypes ? edgeTypesMap.get(classId) : undefined;

    for (const [methodName, defs] of methodsByName) {
      if (defs.length < 2) continue;

      // Own method shadows inherited — no ambiguity
      const ownMethods = methodMap.get(classId) ?? [];
      const ownDefinesIt = ownMethods.some((mid) => {
        const mn = graph.getNode(mid);
        return mn?.properties.name === methodName;
      });
      if (ownDefinesIt) continue;

      let resolution: Resolution;

      switch (provider.mroStrategy) {
        case 'leftmost-base':
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'leftmost base');
          break;
        case 'implements-split':
          resolution = resolveCsharpJava(methodName, defs, classEdgeTypes);
          break;
        case 'c3':
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'C3 MRO');
          break;
        case 'qualified-syntax':
          resolution = {
            resolvedTo: null,
            reason: `requires qualified syntax: <Type as Trait>::${methodName}()`,
            confidence: 0.5,
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

      // Emit METHOD_OVERRIDES edge if resolution found
      if (resolution.resolvedTo !== null) {
        graph.addRelationship({
          id: generateId('METHOD_OVERRIDES', `${classId}->${resolution.resolvedTo}`),
          sourceId: classId,
          targetId: resolution.resolvedTo,
          type: 'METHOD_OVERRIDES',
          confidence: resolution.confidence,
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

  const methodImplementsEdges = emitMethodImplementsEdges(
    graph,
    parentMap,
    methodMap,
    parentEdgeType,
    ancestorsMap,
    edgeTypesMap,
  );

  return { entries, overrideEdges, ambiguityCount, methodImplementsEdges };
}

// ---------------------------------------------------------------------------
// METHOD_IMPLEMENTS edge emission
// ---------------------------------------------------------------------------

/**
 * Check if two parameter type arrays match.
 * When either side has no type info, fall back to parameterCount comparison
 * (arity-compatible matching). If both have parameterCount and they differ,
 * return no match. If counts match, return confident match. If either count
 * is undefined, return lenient (non-confident) match.
 *
 * Returns `{ match, confident }`:
 * - Exact type match → `{ match: true, confident: true }`
 * - Arity match (both have parameterCount, counts equal) → `{ match: true, confident: true }`
 * - Lenient (either side lacks types AND lacks parameterCount) → `{ match: true, confident: false }`
 * - No match → `{ match: false, confident: false }`
 */
function parameterTypesMatch(
  a: string[],
  b: string[],
  aParamCount?: number,
  bParamCount?: number,
): { match: boolean; confident: boolean } {
  // If one side is variadic and the other isn't, types may match superficially
  // but the methods aren't guaranteed to be interchangeable
  if ((aParamCount === undefined) !== (bParamCount === undefined)) {
    return { match: true, confident: false };
  }

  if (a.length === 0 || b.length === 0) {
    // Fall back to arity check when type info is missing
    if (aParamCount !== undefined && bParamCount !== undefined) {
      return { match: aParamCount === bParamCount, confident: aParamCount === bParamCount };
    }
    return { match: true, confident: false }; // lenient when either count is unknown
  }
  if (a.length !== b.length) return { match: false, confident: false };
  const exact = a.every((t, i) => t === b[i]);
  return { match: exact, confident: exact };
}

/**
 * For each concrete class that implements/extends an interface or trait,
 * find methods in the class that implement methods defined in the interface
 * and emit METHOD_IMPLEMENTS edges: ConcreteMethod → InterfaceMethod.
 *
 * Method node IDs include a `#<paramCount>` arity suffix, so overloaded
 * methods with different parameter counts are distinct nodes in the graph.
 * For same-arity overloads with different parameter types, a `~type1,type2`
 * suffix is appended when type info is available (issue #651), producing
 * distinct nodes that `parameterTypesMatch` can resolve to correct edges.
 */
function emitMethodImplementsEdges(
  graph: KnowledgeGraph,
  parentMap: Map<string, string[]>,
  methodMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
  ancestorsMap: Map<string, string[]>,
  edgeTypesMap: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
): number {
  let edgeCount = 0;

  for (const [classId, parentIds] of parentMap) {
    const classNode = graph.getNode(classId);
    if (!classNode) continue;

    // Interfaces and traits declare contracts — they don't implement them
    if (classNode.label === 'Interface' || classNode.label === 'Trait') continue;

    // Get this class's own methods
    const ownMethodIds = methodMap.get(classId) ?? [];

    // Build a lookup: methodName → Array<{methodId, parameterTypes, parameterCount}> for own methods
    const ownMethodsByName = new Map<
      string,
      Array<{ methodId: string; parameterTypes: string[]; parameterCount?: number }>
    >();
    for (const methodId of ownMethodIds) {
      const methodNode = graph.getNode(methodId);
      if (!methodNode || methodNode.label === 'Property') continue;
      // Abstract methods don't satisfy interface contracts
      if (methodNode.properties.isAbstract === true) continue;
      const name = methodNode.properties.name as string;
      const parameterTypes = (methodNode.properties.parameterTypes as string[] | undefined) ?? [];
      const parameterCount = methodNode.properties.parameterCount as number | undefined;
      let bucket = ownMethodsByName.get(name);
      if (!bucket) {
        bucket = [];
        ownMethodsByName.set(name, bucket);
      }
      bucket.push({ methodId, parameterTypes, parameterCount });
    }

    // Use pre-computed ancestors and edge types; fall back to computing if missing (safety)
    const allAncestors = ancestorsMap.get(classId) ?? gatherAncestors(classId, parentMap);
    const ancestorEdgeTypes =
      edgeTypesMap.get(classId) ?? buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType);

    // Dedup set: avoid duplicate edges from diamond paths
    const emitted = new Set<string>();

    // For each ancestor, check if it's an interface/trait or classified as IMPLEMENTS
    for (const ancestorId of allAncestors) {
      const ancestorNode = graph.getNode(ancestorId);
      if (!ancestorNode) continue;

      const isInterfaceLike = ancestorNode.label === 'Interface' || ancestorNode.label === 'Trait';
      const classifiedEdgeType = ancestorEdgeTypes.get(ancestorId);
      if (!isInterfaceLike && classifiedEdgeType !== 'IMPLEMENTS') continue;

      // Get ancestor's methods
      const ancestorMethodIds = methodMap.get(ancestorId) ?? [];

      for (const ancestorMethodId of ancestorMethodIds) {
        const ancestorMethodNode = graph.getNode(ancestorMethodId);
        if (!ancestorMethodNode || ancestorMethodNode.label === 'Property') continue;

        const ancestorName = ancestorMethodNode.properties.name as string;
        const ancestorParamTypes =
          (ancestorMethodNode.properties.parameterTypes as string[] | undefined) ?? [];
        const ancestorParamCount = ancestorMethodNode.properties.parameterCount as
          | number
          | undefined;

        // Find matching method in own class by name + parameterTypes/arity
        const candidates = ownMethodsByName.get(ancestorName);

        // Unit 3: If no own method matches, walk the EXTENDS chain to find inherited concrete method
        if (!candidates || candidates.length === 0) {
          const inherited = findInheritedMethod(
            classId,
            ancestorName,
            ancestorParamTypes,
            ancestorParamCount,
            graph,
            parentMap,
            methodMap,
            parentEdgeType,
            ancestorMethodId,
          );
          if (inherited) {
            const edgeKey = `${inherited.methodId}->${ancestorMethodId}`;
            if (!emitted.has(edgeKey)) {
              emitted.add(edgeKey);
              graph.addRelationship({
                id: generateId('METHOD_IMPLEMENTS', edgeKey),
                sourceId: inherited.methodId,
                targetId: ancestorMethodId,
                type: 'METHOD_IMPLEMENTS',
                confidence: inherited.confident ? 1.0 : 0.7,
                reason: '',
              });
              edgeCount++;
            }
          }
          continue;
        }

        // Unit 4: Filter candidates by type/arity match, then check for ambiguity
        const matching: Array<{
          methodId: string;
          parameterTypes: string[];
          parameterCount?: number;
          confident: boolean;
        }> = [];
        for (const c of candidates) {
          const result = parameterTypesMatch(
            c.parameterTypes,
            ancestorParamTypes,
            c.parameterCount,
            ancestorParamCount,
          );
          if (result.match) {
            matching.push({ ...c, confident: result.confident });
          }
        }

        if (matching.length === 0) continue;

        // If multiple candidates match at name+arity level, emit no edge (ambiguous)
        if (matching.length > 1) continue;

        const winner = matching[0];
        const edgeKey = `${winner.methodId}->${ancestorMethodId}`;
        if (emitted.has(edgeKey)) continue;
        emitted.add(edgeKey);

        graph.addRelationship({
          id: generateId('METHOD_IMPLEMENTS', edgeKey),
          sourceId: winner.methodId,
          targetId: ancestorMethodId,
          type: 'METHOD_IMPLEMENTS',
          confidence: winner.confident ? 1.0 : 0.7,
          reason: '',
        });
        edgeCount++;
      }
    }
  }

  return edgeCount;
}

/**
 * Walk the class's EXTENDS chain to find the nearest concrete method matching
 * the given name and parameter signature. If the EXTENDS chain yields no match,
 * fall back to IMPLEMENTS parents and check for non-abstract default methods
 * (e.g. Java default interface methods, Kotlin interface defaults).
 * Returns the first matching method found in BFS order, or null.
 */
function findInheritedMethod(
  classId: string,
  methodName: string,
  targetParamTypes: string[],
  targetParamCount: number | undefined,
  graph: KnowledgeGraph,
  parentMap: Map<string, string[]>,
  methodMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
  /** Method ID to exclude from results (prevents self-edges when the ancestor
   *  method being matched lives on an IMPLEMENTS parent). */
  excludeMethodId?: string,
): { methodId: string; parameterTypes: string[]; confident: boolean } | null {
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed with direct EXTENDS parents only
  const directParents = parentMap.get(classId) ?? [];
  const directEdges = parentEdgeType.get(classId);
  for (const pid of directParents) {
    const et = directEdges?.get(pid);
    if (et === 'EXTENDS') {
      // Also check that the parent is not an Interface/Trait
      const parentNode = graph.getNode(pid);
      if (parentNode && parentNode.label !== 'Interface' && parentNode.label !== 'Trait') {
        queue.push(pid);
      }
    }
  }

  // Level-order BFS: process all ancestors at the current depth before
  // advancing. Once any match is found at depth D, finish that depth and stop.
  // Diamond dedup: same methodId via two paths at the same depth = 1 match.
  let currentLevel = [...queue];

  while (currentLevel.length > 0) {
    const matches = new Map<
      string,
      { methodId: string; parameterTypes: string[]; confident: boolean }
    >();
    const nextLevel: string[] = [];

    for (const ancestorId of currentLevel) {
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);

      // Check this ancestor's methods
      const methods = methodMap.get(ancestorId) ?? [];
      for (const mid of methods) {
        const mNode = graph.getNode(mid);
        if (!mNode || mNode.label === 'Property') continue;
        // Abstract inherited methods don't count as concrete implementations
        if (mNode.properties.isAbstract === true) continue;
        if (mNode.properties.name !== methodName) continue;

        const mParamTypes = (mNode.properties.parameterTypes as string[] | undefined) ?? [];
        const mParamCount = mNode.properties.parameterCount as number | undefined;
        const ptResult = parameterTypesMatch(
          mParamTypes,
          targetParamTypes,
          mParamCount,
          targetParamCount,
        );
        if (ptResult.match) {
          matches.set(mid, {
            methodId: mid,
            parameterTypes: mParamTypes,
            confident: ptResult.confident,
          });
        }
      }

      // Collect EXTENDS parents for the next depth level
      const grandparents = parentMap.get(ancestorId) ?? [];
      const ancestorEdges = parentEdgeType.get(ancestorId);
      for (const gp of grandparents) {
        if (visited.has(gp)) continue;
        const gpEdge = ancestorEdges?.get(gp);
        if (gpEdge === 'EXTENDS') {
          const gpNode = graph.getNode(gp);
          if (gpNode && gpNode.label !== 'Interface' && gpNode.label !== 'Trait') {
            nextLevel.push(gp);
          }
        }
      }
    }

    // If any matches found at this depth, decide and stop
    if (matches.size === 1) return matches.values().next().value!;
    if (matches.size > 1) return null; // ambiguous at same depth

    currentLevel = nextLevel;
  }

  // ── Second pass: walk IMPLEMENTS parents AND their interface ancestry ──
  // Only reached when the EXTENDS chain yielded no match.
  // BFS through interface/trait hierarchy to find default (non-abstract) methods.
  const implBfsQueue: string[] = [];
  for (const pid of directParents) {
    const et = directEdges?.get(pid);
    if (et === 'IMPLEMENTS') {
      implBfsQueue.push(pid);
    }
  }

  // Collect all matches from the IMPLEMENTS BFS — return null if ambiguous (>1 match)
  const implMatches: Array<{
    methodId: string;
    parameterTypes: string[];
    confident: boolean;
  }> = [];
  const implVisited = new Set<string>();
  while (implBfsQueue.length > 0) {
    const ifaceId = implBfsQueue.shift()!;
    if (implVisited.has(ifaceId)) continue;
    implVisited.add(ifaceId);

    // Only process Interface/Trait nodes — Dart `implements Class` does not
    // inherit method bodies, so Class/Struct/Enum parents must be skipped.
    const ifaceNode = graph.getNode(ifaceId);
    if (!ifaceNode || (ifaceNode.label !== 'Interface' && ifaceNode.label !== 'Trait')) continue;

    // Check this interface/trait's methods for a non-abstract default
    const methods = methodMap.get(ifaceId) ?? [];
    for (const mid of methods) {
      if (mid === excludeMethodId) continue; // prevent self-edges
      const mNode = graph.getNode(mid);
      if (!mNode || mNode.label === 'Property') continue;
      if (mNode.properties.isAbstract === true) continue;
      if (mNode.properties.name !== methodName) continue;

      const mParamTypes = (mNode.properties.parameterTypes as string[] | undefined) ?? [];
      const mParamCount = mNode.properties.parameterCount as number | undefined;
      const ptResult = parameterTypesMatch(
        mParamTypes,
        targetParamTypes,
        mParamCount,
        targetParamCount,
      );
      if (ptResult.match) {
        implMatches.push({
          methodId: mid,
          parameterTypes: mParamTypes,
          confident: ptResult.confident,
        });
      }
    }

    // Walk this interface's parents (interface-extends-interface chains)
    const ifaceParents = parentMap.get(ifaceId) ?? [];
    for (const gp of ifaceParents) {
      if (!implVisited.has(gp)) implBfsQueue.push(gp);
    }
  }

  // Ambiguous: multiple interfaces provide the same default method
  if (implMatches.length === 1) return implMatches[0];
  return null; // 0 matches or ambiguous (>1)
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
