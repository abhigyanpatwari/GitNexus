/**
 * Spring Cloud OpenFeign RPC heuristic: resolve method calls on
 * @FeignClient-injected fields.
 *
 * `@FeignClient` interfaces have no implementation class in the source
 * codebase — Spring Cloud creates a dynamic proxy at runtime. The call
 * graph sees `feignClient.doSomething()` but the scope resolver cannot
 * resolve the receiver to any concrete implementation, so the CALLS edge
 * is missing entirely. This means impact analysis from the caller through
 * the RPC interface is completely broken.
 *
 * This module:
 * 1. Scans source text for `@FeignClient` annotations → identifies Feign
 *    interface names.
 * 2. Builds Feign interface name → method-node index from the graph.
 * 3. Scans each Class with an injected Feign-type field for
 *    `fieldName.methodName(...)` call patterns.
 * 4. Emits CALLS edges from the calling method to the Feign interface method.
 *
 * Runs in `emitPostResolutionEdges` (after the full graph is built).
 */

import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ParsedFile } from 'gitnexus-shared';

// ── Constants ─────────────────────────────────────────────────────────────

/** Regex to detect @FeignClient annotation on an interface declaration. */
const FEIGN_CLIENT_RE = /@FeignClient\s*\(/;

/**
 * Regex to extract the interface name from a source file containing
 * `@FeignClient`. Matches `public interface XxxRpcService {`.
 */
const INTERFACE_NAME_RE = /interface\s+(\w+)/;

/** Regex to detect field declarations of a known Feign type. */
function makeFieldPattern(typeName: string): RegExp {
  // Matches: private TypeName fieldName;  |  @Autowired TypeName fieldName;
  // 'g' flag required for exec() loop to advance.
  return new RegExp(
    `(?:@(?:Autowired|Resource)\\s+)?(?:private|protected|public)?\\s*${typeName}\\s+(\\w+)\\s*[;=]`,
    'g',
  );
}

/**
 * Regex to detect method calls on a field: `fieldName.methodName(`.
 * Captures methodName for resolution.
 */
function makeCallPattern(fieldName: string): RegExp {
  return new RegExp(`\\b${fieldName}\\.(\\w+)\\s*\\(`, 'g');
}

// ── Types ────────────────────────────────────────────────────────────────

interface FeignMethodInfo {
  /** Graph node IDs of methods declared on the Feign interface. */
  methodNodeIds: Map<string, string>; // methodName → nodeId
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Attach CALLS edges for @FeignClient interface method invocations.
 * Called from `emitPostResolutionEdges` in the Java scope resolver.
 */
export function attachJavaFeignRpcCalls(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  fileContents: ReadonlyMap<string, string>,
): void {
  // ── Step 1: Identify @FeignClient interface names from source ──
  const feignTypeNames = new Set<string>();
  for (const [, content] of fileContents) {
    if (!FEIGN_CLIENT_RE.test(content)) continue;
    const m = INTERFACE_NAME_RE.exec(content);
    if (m) feignTypeNames.add(m[1]);
  }
  if (feignTypeNames.size === 0) return;

  // ── Step 2: Build Feign interface → method-node index ──
  // Map: interfaceName → (methodName → nodeId[])
  const feignMethods = new Map<string, Map<string, string[]>>();
  graph.forEachNode((node) => {
    if (node.label !== 'Method' && node.label !== 'Function') return;
    const filePath = node.properties.filePath as string | undefined;
    if (!filePath) return;
    // Check if this method belongs to a Feign interface by matching
    // the interface name in the file path or node ancestry
    const fileName =
      filePath
        .split('/')
        .pop()
        ?.replace(/\.java$/, '') ?? '';
    if (!feignTypeNames.has(fileName)) return;
    const methodName = node.properties.name as string | undefined;
    if (!methodName) return;
    let methodMap = feignMethods.get(fileName);
    if (!methodMap) {
      methodMap = new Map<string, string[]>();
      feignMethods.set(fileName, methodMap);
    }
    const ids = methodMap.get(methodName);
    if (ids) ids.push(node.id);
    else methodMap.set(methodName, [node.id]);
  });

  if (feignMethods.size === 0) return;

  // ── Step 3: Build caller-side index ──
  // For each file, find Feign-type field declarations and their field names.
  // Map: filePath → (typeName → fieldName[])
  const fileToFeignFields = new Map<string, Array<{ typeName: string; fieldName: string }>>();
  for (const [path, content] of fileContents) {
    for (const typeName of feignTypeNames) {
      const fieldPattern = makeFieldPattern(typeName);
      let m: RegExpExecArray | null;
      fieldPattern.lastIndex = 0;
      while ((m = fieldPattern.exec(content)) !== null) {
        const fieldName = m[1];
        let list = fileToFeignFields.get(path);
        if (!list) {
          list = [];
          fileToFeignFields.set(path, list);
        }
        list.push({ typeName, fieldName });
      }
    }
  }

  if (fileToFeignFields.size === 0) return;

  // Track emitted edges to avoid duplicates
  const emittedEdges = new Set<string>();

  // ── Step 4: Scan Function/Method nodes for Feign calls ──
  graph.forEachNode((node) => {
    if (node.label !== 'Function' && node.label !== 'Method') return;

    const filePath = node.properties.filePath as string | undefined;
    const startLine = node.properties.startLine as number | undefined;
    const endLine = node.properties.endLine as number | undefined;
    if (!filePath || startLine === undefined || endLine === undefined) return;

    // This file must have Feign-type fields
    const feignFields = fileToFeignFields.get(filePath);
    if (!feignFields || feignFields.length === 0) return;

    const source = fileContents.get(filePath);
    if (!source) return;

    // Extract function source by line range
    const lines = source.split('\n');
    const funcSource = lines
      .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
      .join('\n');

    // For each Feign field, find calls
    for (const { typeName, fieldName } of feignFields) {
      const methodMap = feignMethods.get(typeName);
      if (!methodMap) continue;

      const callPattern = makeCallPattern(fieldName);
      let m: RegExpExecArray | null;
      while ((m = callPattern.exec(funcSource)) !== null) {
        const calledMethod = m[1];
        const targetIds = methodMap.get(calledMethod);
        if (!targetIds) continue;

        for (const targetId of targetIds) {
          if (targetId === node.id) continue;
          // Avoid duplicate edges
          const edgeId = `FEIGN_CALLS:${node.id}->${targetId}`;
          if (emittedEdges.has(edgeId)) continue;
          emittedEdges.add(edgeId);
          graph.addRelationship({
            id: edgeId,
            sourceId: node.id,
            targetId,
            type: 'CALLS',
            confidence: 0.85,
            reason: `Feign RPC call: ${typeName}.${calledMethod}()`,
          });
        }
      }
    }
  });
}
