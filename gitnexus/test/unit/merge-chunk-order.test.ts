/**
 * `mergeChunkResults` merges one parse chunk in a single canonical order,
 * whatever shape the chunk arrived in: a few batched worker results (files out
 * of path order inside each, batching set by the worker count) or one result
 * per file (the per-file reuse store). Graph nodes, graph relationships, the
 * symbol table and the route registry are first-wins, so arrival order must not
 * pick the owner of an id two files declare.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { serialize, deserialize } from 'node:v8';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExportedTypeMap } from '../../src/core/ingestion/call-processor.js';
import type { SymbolTableWriter } from '../../src/core/ingestion/model/index.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import {
  mergeChunkResults,
  type WorkerExtractedData,
} from '../../src/core/ingestion/parsing-processor.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

// Ordinal path order: FIRST < PY < GO < TS < LAST. An uppercase letter sorts
// before every lowercase one, so FIRST leads only under the ordinal compare.
// FIRST, GO and LAST have route facts and no decorator routes: their insertion
// slots sit before the first routed file, between two, and after the last.
const FIRST = 'app/Zeta/main.go';
const PY = 'app/api/main.py';
const GO = 'app/gateway/main.go';
const TS = 'app/web/server.ts';
const LAST = 'app/worker/jobs.go';
const PATH_ORDER = [FIRST, PY, GO, TS, LAST];

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
  'routeRequireBindings',
  'toolDefs',
  'ormQueries',
  'fileScopeBindings',
  'parsedFiles',
] as const;
type ListKey = (typeof LIST_KEYS)[number];
/** Lists the merge returns that the tests below check on their own. */
type CheckedSeparately = 'decoratorRoutes' | 'routeFacts' | 'scopeExtractionFailures';
// Fails typecheck when the merge returns a list this file does not check.
const EVERY_RETURNED_LIST_IS_CHECKED: [
  Exclude<keyof WorkerExtractedData, ListKey | CheckedSeparately>,
] extends [never]
  ? true
  : false = true;

type ParsedNode = ParseWorkerResult['nodes'][number];
type ParsedRelationship = ParseWorkerResult['relationships'][number];
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
  relationships: ParsedRelationship[];
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
  // One relationship per function, in the parse's own order, each to a node
  // of this file (how the worker emits them).
  const relationships: ParsedRelationship[] = nodes.map((target) => ({
    id: `DEFINES:File:${path}->${target.id}`,
    sourceId: `File:${path}`,
    targetId: target.id,
    type: 'DEFINES',
    confidence: 1,
    reason: '',
  }));
  if (options.declaresHealthRoute) {
    // Every file that declares the route emits the same id.
    nodes.push(node('Route:GET /health', 'Route', '/health', 9));
  }
  const symbols: ParsedSymbol[] = [
    // Not in name order: the file's own order must survive. The same callable
    // name in every file: lookups return insertion order.
    {
      filePath: path,
      name: 'make',
      nodeId: `Function:${path}:make#5`,
      type: 'Function',
      returnType: 'FromLine5',
    },
    { filePath: path, name: 'handle', nodeId: `Function:${path}:handle`, type: 'Function' },
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
    relationships,
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
    relationships: files.flatMap((file) => file.relationships),
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
    routeRequireBindings: list('routeRequireBindings'),
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
      relationships: [...graph.iterRelationships()].map((relationship) => relationship.id),
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
    first: fileParse(FIRST, SupportedLanguages.Go, {
      declaresHealthRoute: false,
      routeFacts: { owner: FIRST },
    }),
    py: fileParse(PY, SupportedLanguages.Python, { declaresHealthRoute: true }),
    go: fileParse(GO, SupportedLanguages.Go, {
      declaresHealthRoute: false,
      routeFacts: { owner: GO },
    }),
    ts: fileParse(TS, SupportedLanguages.TypeScript, {
      declaresHealthRoute: true,
      routeFacts: { owner: TS },
    }),
    last: fileParse(LAST, SupportedLanguages.Go, {
      declaresHealthRoute: false,
      routeFacts: { owner: LAST },
    }),
  };
}

const ARRIVAL_SHAPES = ['batched', 'twoBatches', 'perFile', 'perFileReversed'] as const;

/** The same chunk in every shape it can arrive in. */
function arrivals(): Record<(typeof ARRIVAL_SHAPES)[number], ParseWorkerResult[]> {
  const { first, py, go, ts, last } = files();
  return {
    batched: [workerResult(ts, last, py, first, go)],
    twoBatches: [workerResult(ts, go, last), workerResult(py, first)],
    perFile: [first, py, go, ts, last].map((file) => workerResult(file)),
    perFileReversed: [last, ts, go, py, first].map((file) => workerResult(file)),
  };
}

describe('mergeChunkResults canonical order', () => {
  it.each([false, true])(
    'uses relationship origins when both files emit the same node ids (cache replay=%s)',
    (replay) => {
      const make = (path: string): FileParse => {
        const parsed = fileParse(path, SupportedLanguages.Go, { declaresHealthRoute: false });
        parsed.nodes.push({
          id: 'shared',
          label: 'Class',
          properties: {
            name: 'Shared',
            filePath: path,
            startLine: 0,
            endLine: 0,
            language: SupportedLanguages.Go,
            isExported: true,
          },
        });
        parsed.relationships.push({
          id: 'shared-edge',
          sourceId: 'shared',
          targetId: 'shared',
          originFilePath: path,
          type: 'HAS_METHOD',
          confidence: 1,
          reason: path,
        });
        return parsed;
      };
      const first = make('a.go'),
        last = make('z.go');
      const shapes = [
        [workerResult(last, first)],
        [workerResult(last), workerResult(first)],
        [workerResult(first), workerResult(last)],
      ];
      const winners = shapes.map((results) => {
        const graph = createKnowledgeGraph();
        mergeChunkResults(
          graph,
          recordingSymbolTable().table,
          replay ? deserialize(serialize(results)) : results,
        );
        return [...graph.iterRelationships()].find((rel) => rel.id === 'shared-edge');
      });
      expect(winners).toEqual(
        Array(3).fill({
          id: 'shared-edge',
          sourceId: 'shared',
          targetId: 'shared',
          type: 'HAS_METHOD',
          confidence: 1,
          reason: 'a.go',
        }),
      );
    },
  );
  it.each(['batched', 'twoBatches', 'perFileReversed'] as const)(
    'merges the %s arrival like the per-file arrival in path order',
    (shape) => {
      const shapes = arrivals();
      expect(merge(shapes[shape]).view).toEqual(merge(shapes.perFile).view);
    },
  );

  it.each(ARRIVAL_SHAPES)(
    'gives an id two files declare to the file first in path order (%s arrival)',
    (shape) => {
      const owners = merge(arrivals()[shape]).view.nodes.filter((node) =>
        node.startsWith('Route:'),
      );
      expect(owners).toEqual([`Route:GET /health @ ${PY}`]);
    },
  );

  it('orders files by path and keeps each file`s own order', () => {
    const { view } = merge(arrivals().batched);

    expect(EVERY_RETURNED_LIST_IS_CHECKED).toBe(true);
    expect(view.nodes).toEqual([
      `Function:${FIRST}:make#2 @ ${FIRST}`,
      `Function:${FIRST}:handle @ ${FIRST}`,
      `Function:${FIRST}:make#5 @ ${FIRST}`,
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
      `Function:${LAST}:make#2 @ ${LAST}`,
      `Function:${LAST}:handle @ ${LAST}`,
      `Function:${LAST}:make#5 @ ${LAST}`,
    ]);
    // The id both files declare belongs to the file first in path order.
    expect(view.nodes).not.toContain(`Route:GET /health @ ${TS}`);

    // Files in path order; within a file the order the parse emitted them.
    expect(view.relationships).toEqual(
      PATH_ORDER.flatMap((path) => [
        `DEFINES:File:${path}->Function:${path}:make#5`,
        `DEFINES:File:${path}->Function:${path}:handle`,
        `DEFINES:File:${path}->Function:${path}:make#2`,
      ]),
    );

    expect(view.symbolsAdded).toEqual(
      PATH_ORDER.flatMap((path) => [
        `${path} make Function:${path}:make#5`,
        `${path} handle Function:${path}:handle`,
        `${path} make Function:${path}:make#2`,
      ]),
    );
    expect(view.handleCallables).toEqual(PATH_ORDER);
    expect(view.symbolFiles).toEqual(PATH_ORDER);

    // Files in path order; within a file the parse's own node order, so the
    // later `make` (line 2) is the one recorded.
    expect(view.exportedTypes).toEqual(PATH_ORDER.map((path) => [path, [['make', 'FromLine2']]]));

    expect(view.lists).toEqual(
      Object.fromEntries(
        LIST_KEYS.map((key) => [
          key,
          PATH_ORDER.flatMap((path) => [`${key}:${path}:b`, `${key}:${path}:a`]),
        ]),
      ),
    );
    expect(view.decoratorRoutes).toEqual([
      `${PY} /ready`,
      `${PY} /health`,
      `${TS} /ready`,
      `${TS} /health`,
    ]);
    expect(view.scopeExtractionFailures).toEqual(PATH_ORDER);
  });

  it.each(ARRIVAL_SHAPES)(
    'keeps every route position at its file`s slot after the routes are reordered (%s arrival)',
    (shape) => {
      const results = arrivals()[shape];
      // The route the arriving position points at: the file's first route in
      // the result it arrived in (positions are per result).
      const arrivedTsFirst = results.flatMap((result) =>
        (result.routeFacts ?? [])
          .filter((fact) => fact.filePath === TS)
          .map((fact) => result.decoratorRoutes[fact.routePosition]),
      );
      expect(arrivedTsFirst).toEqual([files().ts.decoratorRoutes[0]]);

      const { data, view } = merge(results);
      const tsPositions = (data.routeFacts ?? [])
        .filter((fact) => fact.filePath === TS)
        .map((fact) => data.decoratorRoutes[fact.routePosition]);
      // The same decorator route object after reordering, not just an equal one.
      expect(tsPositions).toHaveLength(1);
      expect(tsPositions[0]).toBe(arrivedTsFirst[0]);

      // A file with facts but no decorator routes takes the slot its routes
      // would occupy: before the first routed file, between two, or at the end.
      expect(view.routeFacts).toEqual([
        {
          filePath: FIRST,
          facts: { owner: FIRST },
          routePosition: 0,
          insertedBefore: `${PY} /ready`,
        },
        { filePath: GO, facts: { owner: GO }, routePosition: 2, insertedBefore: `${TS} /ready` },
        { filePath: TS, facts: { owner: TS }, routePosition: 2, insertedBefore: `${TS} /ready` },
        { filePath: LAST, facts: { owner: LAST }, routePosition: 4, insertedBefore: 'end' },
      ]);
    },
  );

  it('gives every file slot 0 when the chunk has no decorator routes', () => {
    const { first, go, last } = files();

    const { view } = merge([workerResult(last, first, go)]);

    expect(view.decoratorRoutes).toEqual([]);
    expect(view.routeFacts).toEqual([
      { filePath: FIRST, facts: { owner: FIRST }, routePosition: 0, insertedBefore: 'end' },
      { filePath: GO, facts: { owner: GO }, routePosition: 0, insertedBefore: 'end' },
      { filePath: LAST, facts: { owner: LAST }, routePosition: 0, insertedBefore: 'end' },
    ]);
  });

  it('never reorders or rewrites the caller`s arrays (the parse cache may persist them)', () => {
    const [batched] = arrivals().batched;
    const snapshot = (result: ParseWorkerResult) => ({
      nodes: [...result.nodes],
      relationships: [...result.relationships],
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
