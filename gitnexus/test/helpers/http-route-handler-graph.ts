export interface SymbolRow {
  uid: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  labels: string[];
}
const isFileQuery = (q: string): boolean =>
  q.includes('UNION ALL') && q.includes('sym.filePath = $filePath');
const isFilesQuery = (q: string): boolean =>
  q.includes('UNION ALL') && q.includes('UNWIND $filePaths');

/**
 * A graph that answers the extractor's queries from `symbols` (kept in
 * storage order) and records every query. Each row carries `ord`, its
 * position in `symbols`, as the engine's rows carry their scan offset.
 * By default a symbol query returns the Function rows, then Method, then
 * CodeElement, each in storage order (what one execution thread gives);
 * `reversed` returns them back to front, standing in for the order several
 * threads can deliver. `failBatch` makes every CONTAINING_FILES_QUERY throw.
 */
export const recordingGraph = (opts: {
  routes?: Record<string, unknown>[];
  symbols: SymbolRow[];
  failBatch?: boolean;
  reversed?: boolean;
}) => {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  const stored = opts.symbols.map((sym, ord) => ({ ...sym, ord }));
  const rowsOf = (files: ReadonlySet<string>): Record<string, unknown>[] => {
    const rows = ['Function', 'Method', 'CodeElement'].flatMap((label) =>
      stored
        .filter((sym) => sym.labels[0] === label && files.has(sym.filePath))
        .map((sym) => ({ ...sym })),
    );
    return opts.reversed ? rows.reverse() : rows;
  };
  const db = async (
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    calls.push({ query, params });
    if (query.includes("type: 'HANDLES_ROUTE'")) return opts.routes ?? [];
    if (isFilesQuery(query)) {
      if (opts.failBatch) throw new Error('batch query failed');
      return rowsOf(new Set(params.filePaths as string[]));
    }
    if (isFileQuery(query)) return rowsOf(new Set([String(params.filePath)]));
    return [];
  };
  return {
    db,
    batches: (): string[][] =>
      calls.filter((c) => isFilesQuery(c.query)).map((c) => c.params.filePaths as string[]),
    singles: (): string[] =>
      calls.filter((c) => isFileQuery(c.query)).map((c) => String(c.params.filePath)),
  };
};

export const ORDERS = 'src/main/java/shop/OrderController.java';
export const USERS = 'src/main/java/shop/UserController.java';
export const ITEMS = 'src/main/java/shop/ItemController.java';
const handler = (filePath: string, name: string, startLine: number): SymbolRow => ({
  uid: `Method:${filePath}:${name}`,
  name,
  filePath,
  startLine,
  endLine: startLine + 3,
  labels: ['Method'],
});
// Storage order mixes the files.
export const handlerSymbols = [
  handler(ORDERS, 'listOrders', 10),
  handler(USERS, 'listUsers', 8),
  handler(ORDERS, 'createOrder', 20),
  handler(ITEMS, 'listItems', 5),
];
export const route = (filePath: string, routeMethod: string, routePath: string, name: string) => ({
  fileId: `File:${filePath}`,
  filePath,
  routePath,
  routeId: `Route:${routeMethod}:${routePath}`,
  routeMethod,
  handlerSymbolId: `Method:${filePath}:${name}`,
  routeSource: 'framework-route',
});
export const handlerRoutes = [
  route(ORDERS, 'GET', '/api/orders', 'listOrders'),
  route(ORDERS, 'POST', '/api/orders', 'createOrder'),
  route(USERS, 'GET', '/api/users', 'listUsers'),
  route(ITEMS, 'GET', '/api/items', 'listItems'),
];
export const summary = (
  contracts: { contractId: string; symbolUid: string; symbolName: string }[],
) => contracts.map((c) => [c.contractId, c.symbolUid, c.symbolName]);
