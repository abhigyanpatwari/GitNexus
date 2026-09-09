/**
 * Routes phase: the definition-level `HANDLES_ROUTE` edge and the
 * `Route.handlerSymbolId` stamp, both gated on the handler symbol EXISTING in
 * the graph.
 *
 * `routeHandlerSymbols` carries `SemanticModel` node ids, which are a
 * resolution claim rather than proof that the definition node reached
 * `ctx.graph`. Two directions are pinned here:
 *
 *   • resolved — a live `Function` / `Method` node gets BOTH the file-level edge
 *     (what `http-route-extractor.ts` queries) and the definition-level edge, so
 *     a HANDLES_ROUTE traversal reaches the handler and not just its file;
 *   • dangling — an id with no node in the graph falls back to exactly the
 *     file-level behavior a route with no handler resolution has: file-level
 *     edge only, no `handlerSymbolId` stamp, and no edge sourced on a node that
 *     does not exist.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NodeLabel } from 'gitnexus-shared';
import { routesPhase } from '../../src/core/ingestion/pipeline-phases/routes.js';
import { routeNodeKey } from '../../src/core/ingestion/route-extractors/route-path.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../src/core/ingestion/route-extractors/data-route-table.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

const CONTROLLER = 'src/orders/controller.ts';
const TABLE_FILE = 'src/routes/table.ts';
const HANDLER_FILE = 'src/handlers/orders.ts';
const HANDLER_SOURCE = `export function createOrder() {\n  return { id: 1 };\n}\n`;

interface RunOptions {
  /** Files to materialize in the temp repo, path → contents. */
  readonly files?: Readonly<Record<string, string>>;
  /** Handler definition node to seed into the graph before the phase runs. */
  readonly handlerNode?: { id: string; label: NodeLabel; filePath: string };
  readonly routeHandlerSymbols: ReadonlyMap<string, string>;
  readonly extractedRoutes?: readonly unknown[];
  readonly decoratorRoutes?: readonly unknown[];
}

async function runRoutesPhase(
  options: RunOptions,
): Promise<{ graph: KnowledgeGraph; repoPath: string }> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-route-handler-edge-'));
  const files = options.files ?? { [CONTROLLER]: HANDLER_SOURCE };
  for (const [filePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.join(repoPath, path.dirname(filePath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, filePath), contents);
  }

  const graph = createKnowledgeGraph();
  if (options.handlerNode) {
    graph.addNode({
      id: options.handlerNode.id,
      label: options.handlerNode.label,
      properties: {
        name: 'createOrder',
        filePath: options.handlerNode.filePath,
        startLine: 0,
        endLine: 2,
      },
    });
  }

  const parseOutput = {
    allPaths: Object.keys(files),
    allFetchCalls: [],
    allFetchWrapperDefs: [],
    allExtractedRoutes: options.extractedRoutes ?? [],
    allDecoratorRoutes: options.decoratorRoutes ?? [],
    routeHandlerSymbols: options.routeHandlerSymbols,
  } as unknown as ParseOutput;

  try {
    await routesPhase.execute(
      { repoPath, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );
    return { graph, repoPath };
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
}

/** A single framework route: `POST /orders`, declared in `CONTROLLER`. */
const frameworkRoute = (filePath = CONTROLLER) => ({
  filePath,
  httpMethod: 'post',
  routePath: '/orders',
  routeName: null,
  controllerName: null,
  methodName: null,
  middleware: [],
  prefix: null,
  lineNumber: 1,
});

const POST_ORDERS = routeNodeKey('POST', '/orders');
const ROUTE_ID = generateId('Route', POST_ORDERS);

/** `HANDLES_ROUTE` source ids pointing at the route node, de-duplicated. */
const handlesRouteSources = (graph: KnowledgeGraph, routeNodeId = ROUTE_ID): string[] => [
  ...new Set(
    graph.relationships
      .filter((rel) => rel.type === 'HANDLES_ROUTE' && rel.targetId === routeNodeId)
      .map((rel) => rel.sourceId),
  ),
];

describe('routes phase — definition-level HANDLES_ROUTE', () => {
  it.each<NodeLabel>(['Function', 'Method'])(
    'emits both the file-level and the definition-level edge for a live %s handler',
    async (label) => {
      const handlerId = `${label}:${CONTROLLER}:createOrder`;
      const { graph } = await runRoutesPhase({
        handlerNode: { id: handlerId, label, filePath: CONTROLLER },
        routeHandlerSymbols: new Map([[POST_ORDERS, handlerId]]),
        extractedRoutes: [frameworkRoute()],
      });

      expect(graph.getNode(ROUTE_ID)?.properties.handlerSymbolId).toBe(handlerId);
      expect(handlesRouteSources(graph).sort()).toEqual(
        [generateId('File', CONTROLLER), handlerId].sort(),
      );
    },
  );

  it('falls back to file-level attribution when the handler id has no node in the graph', async () => {
    // Resolution claimed a symbol the graph does not hold. The stamp is the
    // extractor's fast path and the edge would source on an absent node, so
    // neither may be emitted.
    const { graph } = await runRoutesPhase({
      routeHandlerSymbols: new Map([[POST_ORDERS, `Method:${CONTROLLER}:ghost`]]),
      extractedRoutes: [frameworkRoute()],
    });

    const route = graph.getNode(ROUTE_ID);
    expect(route, 'the route itself must survive a dangling handler id').toBeTruthy();
    expect(route?.properties).not.toHaveProperty('handlerSymbolId');
    expect(handlesRouteSources(graph)).toEqual([generateId('File', CONTROLLER)]);
  });

  it('resolves the data-route-table handler path from the graph, and falls back when it dangles', async () => {
    const routeKey = routeNodeKey('GET', '/orders');
    const routeNodeId = generateId('Route', routeKey);
    const handlerId = `Function:${HANDLER_FILE}:createOrder`;
    const dataRoute = {
      filePath: TABLE_FILE,
      routePath: '/orders',
      httpMethod: 'GET',
      decoratorName: 'data-route-table',
      source: DATA_ROUTE_TABLE_SOURCE,
      lineNumber: 1,
      handlerName: 'createOrder',
    };
    const files = {
      [TABLE_FILE]: `export const routes = [{ path: '/orders', method: 'GET', handler: createOrder }];\n`,
      [HANDLER_FILE]: HANDLER_SOURCE,
    };

    const resolved = await runRoutesPhase({
      files,
      handlerNode: { id: handlerId, label: 'Function', filePath: HANDLER_FILE },
      routeHandlerSymbols: new Map([[routeKey, handlerId]]),
      decoratorRoutes: [dataRoute],
    });
    const resolvedRoute = resolved.graph.getNode(routeNodeId);
    expect(resolvedRoute?.properties.filePath).toBe(HANDLER_FILE);
    expect(resolvedRoute?.properties.handlerSymbolId).toBe(handlerId);
    expect(handlesRouteSources(resolved.graph, routeNodeId).sort()).toEqual(
      [generateId('File', HANDLER_FILE), handlerId].sort(),
    );

    const dangling = await runRoutesPhase({
      files,
      routeHandlerSymbols: new Map([[routeKey, handlerId]]),
      decoratorRoutes: [dataRoute],
    });
    const danglingRoute = dangling.graph.getNode(routeNodeId);
    // No handler node to read a path from, so the declaring file stands in.
    expect(danglingRoute?.properties.filePath).toBe(TABLE_FILE);
    expect(danglingRoute?.properties).not.toHaveProperty('handlerSymbolId');
    expect(handlesRouteSources(dangling.graph, routeNodeId)).toEqual([
      generateId('File', TABLE_FILE),
    ]);
  });
});
