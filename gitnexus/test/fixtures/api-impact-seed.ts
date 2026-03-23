import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

/**
 * Seed data for api_impact E2E tests.
 *
 * Simulates what the pipeline would produce for a Next.js project with:
 * - /api/grants route (success + error shapes)
 * - /api/secure route (middleware-wrapped, two method exports)
 * - Multiple consumers with different fetch patterns
 * - Multi-fetch consumer (useMulti fetches both routes)
 * - Mismatch consumer (accesses 'meta' which doesn't exist)
 */
export const API_IMPACT_SEED_DATA = [
  // ─── Files ─────────────────────────────────────────────────────────
  `CREATE (f:File {id: 'file:app/api/grants/route.ts', name: 'route.ts', filePath: 'app/api/grants/route.ts', content: 'export async function GET() { ... }'})`,
  `CREATE (f:File {id: 'file:app/api/secure/route.ts', name: 'route.ts', filePath: 'app/api/secure/route.ts', content: 'export const GET = withAuth(withRateLimit(handler))'})`,
  `CREATE (f:File {id: 'file:components/GrantsList.tsx', name: 'GrantsList.tsx', filePath: 'components/GrantsList.tsx', content: 'const { data, pagination } = await res.json()'})`,
  `CREATE (f:File {id: 'file:hooks/useGrants.ts', name: 'useGrants.ts', filePath: 'hooks/useGrants.ts', content: 'const data = await result.json(); data.items'})`,
  `CREATE (f:File {id: 'file:hooks/useMulti.ts', name: 'useMulti.ts', filePath: 'hooks/useMulti.ts', content: 'fetches /api/grants and /api/secure'})`,

  // ─── Route nodes ───────────────────────────────────────────────────
  // /api/grants: success keys = [data, pagination], error keys = [error, message]
  `CREATE (r:Route {id: 'Route:/api/grants', name: '/api/grants', filePath: 'app/api/grants/route.ts', responseKeys: ['data', 'pagination'], errorKeys: ['error', 'message'], middleware: []})`,
  // /api/secure: middleware wrapped, separate success keys per method
  `CREATE (r:Route {id: 'Route:/api/secure', name: '/api/secure', filePath: 'app/api/secure/route.ts', responseKeys: ['items', 'count'], errorKeys: [], middleware: ['withAuth', 'withRateLimit']})`,

  // ─── Functions (consumers) ─────────────────────────────────────────
  `CREATE (fn:Function {id: 'func:GrantsList', name: 'GrantsList', filePath: 'components/GrantsList.tsx', startLine: 1, endLine: 10, isExported: true, content: 'export async function GrantsList()', description: 'Grants list component'})`,
  `CREATE (fn:Function {id: 'func:useGrants', name: 'useGrants', filePath: 'hooks/useGrants.ts', startLine: 1, endLine: 5, isExported: true, content: 'export async function useGrants()', description: 'Grants data hook'})`,
  `CREATE (fn:Function {id: 'func:useMulti', name: 'useMulti', filePath: 'hooks/useMulti.ts', startLine: 1, endLine: 8, isExported: true, content: 'export async function useMulti()', description: 'Multi-route fetcher'})`,

  // ─── Functions (handlers) ──────────────────────────────────────────
  `CREATE (fn:Function {id: 'func:grants-GET', name: 'GET', filePath: 'app/api/grants/route.ts', startLine: 3, endLine: 10, isExported: true, content: 'export async function GET()', description: 'Grants GET handler'})`,
  `CREATE (fn:Function {id: 'func:secure-GET', name: 'GET', filePath: 'app/api/secure/route.ts', startLine: 5, endLine: 7, isExported: true, content: 'export const GET = withAuth(withRateLimit(handler))', description: 'Secure GET handler'})`,
  `CREATE (fn:Function {id: 'func:secure-POST', name: 'POST', filePath: 'app/api/secure/route.ts', startLine: 9, endLine: 12, isExported: true, content: 'export const POST = async (req)', description: 'Secure POST handler'})`,

  // ─── FETCHES edges (consumer → route) ──────────────────────────────
  // GrantsList fetches /api/grants — accesses 'data' and 'pagination'
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:GrantsList' AND r.id = 'Route:/api/grants'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 1.0, reason: 'fetch-url-match|keys:data,pagination', step: 0}]->(r)`,
  // useGrants fetches /api/grants — accesses 'items' (valid key from useGrants perspective — data.items)
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:useGrants' AND r.id = 'Route:/api/grants'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 1.0, reason: 'fetch-url-match|keys:items', step: 0}]->(r)`,
  // useMulti fetches /api/grants — accesses 'data' and 'meta' (meta is a mismatch)
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:useMulti' AND r.id = 'Route:/api/grants'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 0.8, reason: 'fetch-url-match|keys:data,meta|fetches:2', step: 0}]->(r)`,
  // useMulti also fetches /api/secure — accesses 'items'
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:useMulti' AND r.id = 'Route:/api/secure'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 0.8, reason: 'fetch-url-match|keys:items|fetches:2', step: 0}]->(r)`,

  // ─── HANDLES_ROUTE edges (handler → route) ────────────────────────
  `MATCH (fn:Function), (r:Route) WHERE fn.id = 'func:grants-GET' AND r.id = 'Route:/api/grants'
   CREATE (fn)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'nextjs-app-router', step: 0}]->(r)`,
  `MATCH (fn:Function), (r:Route) WHERE fn.id = 'func:secure-GET' AND r.id = 'Route:/api/secure'
   CREATE (fn)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'nextjs-app-router', step: 0}]->(r)`,
  `MATCH (fn:Function), (r:Route) WHERE fn.id = 'func:secure-POST' AND r.id = 'Route:/api/secure'
   CREATE (fn)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'nextjs-app-router', step: 0}]->(r)`,
];

export const API_IMPACT_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
];
