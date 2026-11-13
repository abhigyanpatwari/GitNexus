/**
 * `mergeChunkResults` merges one parse chunk in a single canonical order,
 * whatever shape the chunk arrived in: a few batched worker results (files
 * grouped by language inside each, batching set by the worker count) or one
 * result per file (the per-file reuse store). Graph nodes, the symbol table and
 * the route registry are first-wins, so arrival order must not pick the owner
 * of an id two files declare.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExportedTypeMap } from '../../src/core/ingestion/call-processor.js';
import type { SymbolTableWriter } from '../../src/core/ingestion/model/index.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { mergeChunkResults } from '../../src/core/ingestion/parsing-processor.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

// Path order: PY < GO < TS. GO has no decorator routes, only route facts, so
// its insertion slot sits between two files that do have routes.
const PY = 'app/api/main.py';
const GO = 'app/gateway/main.go';
const TS = 'app/web/server.ts';

/** Every per-file list the merge returns, besides decorator routes and route facts. */
const LIST_KEYS = [
  'routes',
  'fetchCalls',
  'fetchWrapperDefs',
  'fetchWrapperCalls',
  'fetchWrapperReexports',
  'routerIncludes',
  'routerImports',
  'routerConstructorPrefixes',
  'routerModuleAliases',
  'moduleConstants',
  'springTypes',
  'toolDefs',
  'ormQueries',
  'fileScopeBindings',
  'parsedFiles',
] as const;
type ListKey = (typeof LIST_KEYS)[number];

type ParsedNode = ParseWorkerResult['nodes'][number];
type ParsedSymbol = ParseWorkerResult['symbols'][number];
type DecoratorRoute = ParseWorkerResult['decoratorRoutes'][number];
interface TaggedItem {
  filePath: string;
  tag: string;
}

/** What one file's parse contributes to a worker result. */
interface FileParse {
  path: string;
  nodes: ParsedNode[];
  symbols: ParsedSymbol[];
  decoratorRoutes: DecoratorRoute[];
  routeFacts?: unknown;
  lists: Record<ListKey, TaggedItem[]>;
  scopeExtractionFailures: string[];
}

function fileParse(
  path: string,
  language: SupportedLanguages,
  options: { declaresHealthRoute: boolean; routeFacts?: unknown },
): FileParse {
  const node = (id: string, label: string, name: string, startLine: number): ParsedNode => ({
    id,
    label,
    properties: {
      name,
      filePath: path,
      startLine,
      endLine: startLine + 1,
      language,
      isExported: true,
    },
  });
  const nodes = [
    // Out of line order on purpose: the graph gets source order, while the
    // exported-type map reads the parse's own order (the later `make` wins).
    node(`Function:${path}:make#5`, 'Function', 'make', 5),
    node(`Function:${path}:handle`, 'Function', 'handle', 3),
    node(`Function:${path}:make#2`, 'Function', 'make', 2),
  ];
  if (options.declaresHealthRoute) {
    // Every file that declares the route emits the same id.
    nodes.push(node('Route:GET /health', 'Route', '/health', 9));
  }
  const symbols: ParsedSymbol[] = [
    // The same callable name in every file: lookups return insertion order.
    { filePath: path, name: 'handle', nodeId: `Function:${path}:handle`, type: 'Function' },
    {
      filePath: path,
      name: 'make',
      nodeId: `Function:${path}:make#5`,
      type: 'Function',
      returnType: 'FromLine5',
    },
    {
      filePath: path,
      name: 'make',
      nodeId: `Function:${path}:make#2`,
      type: 'Function',
      returnType: 'FromLine2',
    },
  ];
  const decoratorRoutes: DecoratorRoute[] = options.declaresHealthRoute
    ? [
        // Not in routePath order: the file's own order must survive.
        {
          filePath: path,
          routePath: '/ready',
          httpMethod: 'GET',
          decoratorName: 'get',
          lineNumber: 4,
        },
        {
          filePath: path,
          routePath: '/health',
          httpMethod: 'GET',
          decoratorName: 'get',
          lineNumber: 9,
        },
      ]
    : [];
  const lists = Object.fromEntries(
    LIST_KEYS.map((key) => [
      key,
      // Two items per list, deliberately out of tag order.
      [
        { filePath: path, tag: `${key}:${path}:b` },
        { filePath: path, tag: `${key}:${path}:a` },
      ],
    ]),
  ) as Record<ListKey, TaggedItem[]>;
  return {
    path,
    nodes,
    symbols,
    decoratorRoutes,
    routeFacts: options.routeFacts,
    lists,
    scopeExtractionFailures: [path],
  };
}

/**
 * One worker result holding `files` in the given order, with route positions
 * recorded the way the worker records them: where the file's own decorator
 * routes begin in this result.
 */
function workerResult(...files: FileParse[]): ParseWorkerResult {
  const decoratorRoutes: DecoratorRoute[] = [];
  const routeFacts: NonNullable<ParseWorkerResult['routeFacts']> = [];
  for (const file of files) {
    if (file.routeFacts !== undefined) {
      routeFacts.push({
        filePath: file.path,
        facts: file.routeFacts,
        routePosition: decoratorRoutes.length,
      });
    }
    for (const route of file.decoratorRoutes) decoratorRoutes.push(route);
  }
  const list = (key: ListKey) => files.flatMap((file) => file.lists[key]) as never;
  return {
    nodes: files.flatMap((file) => file.nodes),
    relationships: [],
    symbols: files.flatMap((file) => file.symbols),
    calls: [],
    assignments: [],
    routes: list('routes'),
    fetchCalls: list('fetchCalls'),
    fetchWrapperDefs: list('fetchWrapperDefs'),
    fetchWrapperCalls: list('fetchWrapperCalls'),
    fetchWrapperReexports: list('fetchWrapperReexports'),
    decoratorRoutes,
    routeFacts,
    routerIncludes: list('routerIncludes'),
    routerImports: list('routerImports'),
    routerConstructorPrefixes: list('routerConstructorPrefixes'),
    routerModuleAliases: list('routerModuleAliases'),
    moduleConstants: list('moduleConstants'),
    springTypes: list('springTypes'),
    toolDefs: list('toolDefs'),
    ormQueries: list('ormQueries'),
    constructorBindings: [],
    fileScopeBindings: list('fileScopeBindings'),
    parsedFiles: list('parsedFiles'),
    scopeExtractionFailures: files.flatMap((file) => file.scopeExtractionFailures),
    skippedLanguages: {},
    fileCount: files.length,
  };
}

/** A real symbol table whose `add` calls are also recorded in order. */
function recordingSymbolTable() {
  const symbols = createSemanticModel().symbols;
  const added: string[] = [];
  const table = new Proxy(symbols, {
    get(target, property, receiver) {
      if (property !== 'add') return Reflect.get(target, property, receiver);
      const add: SymbolTableWriter['add'] = (filePath, name, nodeId, type, metadata) => {
        added.push(`${filePath} ${name} ${nodeId}`);
        return target.add(filePath, name, nodeId, type, metadata);
      };
      return add;
    },
  });
  return { table, added, symbols };
}

const routeKey = (route: DecoratorRoute | undefined): string =>
  route ? `${route.filePath} ${route.routePath}` : 'end';

function merge(results: ParseWorkerResult[]) {
  const graph = createKnowledgeGraph();
  const { table, added, symbols } = recordingSymbolTable();
  const exportedTypeMap: ExportedTypeMap = new Map();
  const data = mergeChunkResults(graph, table, results, exportedTypeMap);
  const tags = (items: readonly unknown[]) => items.map((item) => (item as TaggedItem).tag);
  return {
    data,
    view: {
      nodes: [...graph.iterNodes()].map((node) => `${node.id} @ ${node.properties.filePath}`),
      symbolsAdded: added,
      handleCallables: symbols.lookupCallableByName('handle').map((def) => def.filePath),
      symbolFiles: [...symbols.getFiles()],
      exportedTypes: [...exportedTypeMap].map(([filePath, exports]) => [filePath, [...exports]]),
      lists: Object.fromEntries(LIST_KEYS.map((key) => [key, tags(data[key])])),
      decoratorRoutes: data.decoratorRoutes.map(routeKey),
      routeFacts: (data.routeFacts ?? []).map((fact) => ({
        filePath: fact.filePath,
        facts: fact.facts,
        routePosition: fact.routePosition,
        insertedBefore: routeKey(data.decoratorRoutes[fact.routePosition]),
      })),
      scopeExtractionFailures: data.scopeExtractionFailures,
    },
  };
}

function files() {
  return {
    py: fileParse(PY, SupportedLanguages.Python, { declaresHealthRoute: true }),
    go: fileParse(GO, SupportedLanguages.Go, {
      declaresHealthRoute: false,
      routeFacts: { owner: GO },
    }),
    ts: fileParse(TS, SupportedLanguages.TypeScript, {
      declaresHealthRoute: true,
      routeFacts: { owner: TS },
    }),
  };
}

/** The same chunk in every shape it can arrive in. */
function arrivals() {
  const { py, go, ts } = files();
  return {
    batched: [workerResult(ts, py, go)],
    twoBatches: [workerResult(ts, go), workerResult(py)],
    perFile: [workerResult(py), workerResult(go), workerResult(ts)],
    perFileReversed: [workerResult(ts), workerResult(go), workerResult(py)],
  };
}

describe('mergeChunkResults canonical order', () => {
  it('merges batched, per-file, reversed and two-batch arrivals identically', () => {
    const shapes = arrivals();
    const expected = merge(shapes.perFile).view;
    expect(merge(shapes.batched).view).toEqual(expected);
    expect(merge(shapes.twoBatches).view).toEqual(expected);
    expect(merge(shapes.perFileReversed).view).toEqual(expected);
  });

  it('gives an id two files declare to the file first in path order, however the chunk arrived', () => {
    for (const [shape, results] of Object.entries(arrivals())) {
      const owners = merge(results).view.nodes.filter((node) => node.startsWith('Route:'));
      expect(owners, shape).toEqual([`Route:GET /health @ ${PY}`]);
    }
  });

  it('orders files by path and keeps each file`s own order', () => {
    const { view } = merge(arrivals().batched);

    expect(view.nodes).toEqual([
      `Function:${PY}:make#2 @ ${PY}`,
      `Function:${PY}:handle @ ${PY}`,
      `Function:${PY}:make#5 @ ${PY}`,
      `Route:GET /health @ ${PY}`,
      `Function:${GO}:make#2 @ ${GO}`,
      `Function:${GO}:handle @ ${GO}`,
      `Function:${GO}:make#5 @ ${GO}`,
      `Function:${TS}:make#2 @ ${TS}`,
      `Function:${TS}:handle @ ${TS}`,
      `Function:${TS}:make#5 @ ${TS}`,
    ]);
    // The id both files declare belongs to the file first in path order.
    expect(view.nodes).not.toContain(`Route:GET /health @ ${TS}`);

    expect(view.symbolsAdded).toEqual(
      [PY, GO, TS].flatMap((path) => [
        `${path} handle Function:${path}:handle`,
        `${path} make Function:${path}:make#5`,
        `${path} make Function:${path}:make#2`,
      ]),
    );
    expect(view.handleCallables).toEqual([PY, GO, TS]);
    expect(view.symbolFiles).toEqual([PY, GO, TS]);

    // Files in path order; within a file the parse's own node order, so the
    // later `make` (line 2) is the one recorded.
    expect(view.exportedTypes).toEqual([PY, GO, TS].map((path) => [path, [['make', 'FromLine2']]]));

    for (const key of LIST_KEYS) {
      expect(view.lists[key], key).toEqual(
        [PY, GO, TS].flatMap((path) => [`${key}:${path}:b`, `${key}:${path}:a`]),
      );
    }
    expect(view.decoratorRoutes).toEqual([
      `${PY} /ready`,
      `${PY} /health`,
      `${TS} /ready`,
      `${TS} /health`,
    ]);
    expect(view.scopeExtractionFailures).toEqual([PY, GO, TS]);
  });

  it('keeps every route position at its file`s slot after the routes are reordered', () => {
    const tsFirstRoute = files().ts.decoratorRoutes[0];

    for (const [shape, results] of Object.entries(arrivals())) {
      // The route the arriving position points at: the file's first route in
      // the results as they arrived (positions are per result).
      let arrivedTsFirst: DecoratorRoute | undefined;
      for (const result of results) {
        const fact = result.routeFacts?.find((item) => item.filePath === TS);
        if (fact) arrivedTsFirst = result.decoratorRoutes[fact.routePosition];
      }
      expect(arrivedTsFirst, shape).toEqual(tsFirstRoute);

      const { data, view } = merge(results);
      const tsPosition = data.routeFacts?.find((fact) => fact.filePath === TS)?.routePosition;
      // The same decorator route object after reordering, not just an equal one.
      expect(data.decoratorRoutes[tsPosition ?? -1], shape).toBe(arrivedTsFirst);

      // A file with facts but no decorator routes takes the slot its routes
      // would occupy: after every route of an earlier path, before any later.
      expect(view.routeFacts, shape).toEqual([
        { filePath: GO, facts: { owner: GO }, routePosition: 2, insertedBefore: `${TS} /ready` },
        { filePath: TS, facts: { owner: TS }, routePosition: 2, insertedBefore: `${TS} /ready` },
      ]);
    }
  });

  it('never reorders or rewrites the caller`s arrays (the parse cache may persist them)', () => {
    const [batched] = arrivals().batched;
    const snapshot = (result: ParseWorkerResult) => ({
      nodes: [...result.nodes],
      symbols: [...result.symbols],
      decoratorRoutes: [...result.decoratorRoutes],
      routeFacts: (result.routeFacts ?? []).map((fact) => ({ ...fact })),
      lists: Object.fromEntries(LIST_KEYS.map((key) => [key, [...(result[key] ?? [])]])),
      scopeExtractionFailures: [...(result.scopeExtractionFailures ?? [])],
    });
    const before = snapshot(batched);
    merge([batched]);
    expect(snapshot(batched)).toEqual(before);
  });
});
