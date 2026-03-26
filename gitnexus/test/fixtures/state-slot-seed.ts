import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

/**
 * Seed data for data_flow E2E tests.
 *
 * Simulates what the pipeline would produce for a Next.js project with:
 * - Two React Query hooks sharing cache key ['vendor-patterns', slug] with DIFFERENT produced shapes (conflict)
 * - One SWR hook with a different cache key (no conflict)
 * - Consumer components with different access patterns
 * - StateSlot nodes representing shared cache keys
 * - PRODUCES edges (from hooks to StateSlot)
 * - CONSUMES edges (from components to StateSlot)
 */
export const STATE_SLOT_SEED_DATA: string[] = [
  // ─── Files ─────────────────────────────────────────────────────────
  `CREATE (f:File {id: 'file:hooks/useVendorPatterns.ts', name: 'useVendorPatterns.ts', filePath: 'hooks/useVendorPatterns.ts', content: 'export function useVendorPatterns(slug) { return useQuery({ queryKey: ["vendor-patterns", slug], ... }) }'})`,
  `CREATE (f:File {id: 'file:hooks/useVendorPatternsSummary.ts', name: 'useVendorPatternsSummary.ts', filePath: 'hooks/useVendorPatternsSummary.ts', content: 'export function useVendorPatternsSummary(slug) { return useQuery({ queryKey: ["vendor-patterns", slug], ... }) }'})`,
  `CREATE (f:File {id: 'file:hooks/useVendorStats.ts', name: 'useVendorStats.ts', filePath: 'hooks/useVendorStats.ts', content: 'export function useVendorStats(slug) { return useSWR(["vendor-stats", slug], fetcher) }'})`,
  `CREATE (f:File {id: 'file:components/VendorDashboard.tsx', name: 'VendorDashboard.tsx', filePath: 'components/VendorDashboard.tsx', content: 'const { data } = useVendorPatterns(slug); data.patterns; data.total; data.page'})`,
  `CREATE (f:File {id: 'file:components/VendorSidebar.tsx', name: 'VendorSidebar.tsx', filePath: 'components/VendorSidebar.tsx', content: 'const { data } = useVendorPatternsSummary(slug); data.patterns; data.page'})`,
  `CREATE (f:File {id: 'file:components/VendorStatsWidget.tsx', name: 'VendorStatsWidget.tsx', filePath: 'components/VendorStatsWidget.tsx', content: 'const { data } = useVendorStats(slug); data.count; data.trend'})`,

  // ─── StateSlot nodes ────────────────────────────────────────────────
  // Conflict slot: two React Query hooks share this key with different shapes
  `CREATE (ss:StateSlot {id: 'StateSlot:react-query:vendor-patterns-slug', name: '["vendor-patterns", slug]', slotKind: 'react-query', cacheKey: '["vendor-patterns", slug]'})`,
  // Clean slot: single SWR hook, no conflict
  `CREATE (ss:StateSlot {id: 'StateSlot:swr:vendor-stats-slug', name: '["vendor-stats", slug]', slotKind: 'swr', cacheKey: '["vendor-stats", slug]'})`,

  // ─── Functions (hooks — producers) ─────────────────────────────────
  `CREATE (fn:Function {id: 'func:useVendorPatterns', name: 'useVendorPatterns', filePath: 'hooks/useVendorPatterns.ts', startLine: 1, endLine: 8, isExported: true, content: 'export function useVendorPatterns(slug)', description: 'React Query hook — full vendor patterns with pagination'})`,
  `CREATE (fn:Function {id: 'func:useVendorPatternsSummary', name: 'useVendorPatternsSummary', filePath: 'hooks/useVendorPatternsSummary.ts', startLine: 1, endLine: 6, isExported: true, content: 'export function useVendorPatternsSummary(slug)', description: 'React Query hook — summary shape, omits total field'})`,
  `CREATE (fn:Function {id: 'func:useVendorStats', name: 'useVendorStats', filePath: 'hooks/useVendorStats.ts', startLine: 1, endLine: 5, isExported: true, content: 'export function useVendorStats(slug)', description: 'SWR hook — vendor stats with count and trend'})`,

  // ─── Functions (components — consumers) ────────────────────────────
  `CREATE (fn:Function {id: 'func:VendorDashboard', name: 'VendorDashboard', filePath: 'components/VendorDashboard.tsx', startLine: 1, endLine: 20, isExported: true, content: 'export function VendorDashboard()', description: 'Dashboard component — reads patterns, total, page'})`,
  `CREATE (fn:Function {id: 'func:VendorSidebar', name: 'VendorSidebar', filePath: 'components/VendorSidebar.tsx', startLine: 1, endLine: 15, isExported: true, content: 'export function VendorSidebar()', description: 'Sidebar component — reads patterns, page (omits total)'})`,
  `CREATE (fn:Function {id: 'func:VendorStatsWidget', name: 'VendorStatsWidget', filePath: 'components/VendorStatsWidget.tsx', startLine: 1, endLine: 12, isExported: true, content: 'export function VendorStatsWidget()', description: 'Stats widget — reads count, trend from SWR slot'})`,

  // ─── PRODUCES edges (hook → StateSlot) ─────────────────────────────
  // useVendorPatterns produces shape with keys: patterns, total, page
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:useVendorPatterns' AND ss.id = 'StateSlot:react-query:vendor-patterns-slug'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 1.0, reason: 'shape-ast-literal|keys:patterns,total,page', step: 0}]->(ss)`,
  // useVendorPatternsSummary produces shape with keys: patterns, page (missing total — CONFLICT)
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:useVendorPatternsSummary' AND ss.id = 'StateSlot:react-query:vendor-patterns-slug'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 0.9, reason: 'shape-ast-literal|keys:patterns,page', step: 0}]->(ss)`,
  // useVendorStats produces shape for its own SWR slot
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:useVendorStats' AND ss.id = 'StateSlot:swr:vendor-stats-slug'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 1.0, reason: 'shape-ast-literal|keys:count,trend', step: 0}]->(ss)`,

  // ─── CONSUMES edges (component → StateSlot) ────────────────────────
  // VendorDashboard consumes patterns, total, page from the conflict slot
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:VendorDashboard' AND ss.id = 'StateSlot:react-query:vendor-patterns-slug'
   CREATE (fn)-[:CodeRelation {type: 'CONSUMES', confidence: 1.0, reason: 'shape-heuristic|keys:patterns,total,page', step: 0}]->(ss)`,
  // VendorSidebar consumes patterns, page from the conflict slot
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:VendorSidebar' AND ss.id = 'StateSlot:react-query:vendor-patterns-slug'
   CREATE (fn)-[:CodeRelation {type: 'CONSUMES', confidence: 1.0, reason: 'shape-heuristic|keys:patterns,page', step: 0}]->(ss)`,
  // VendorStatsWidget consumes count, trend from the clean SWR slot
  `MATCH (fn:Function), (ss:StateSlot) WHERE fn.id = 'func:VendorStatsWidget' AND ss.id = 'StateSlot:swr:vendor-stats-slug'
   CREATE (fn)-[:CodeRelation {type: 'CONSUMES', confidence: 1.0, reason: 'shape-heuristic|keys:count,trend', step: 0}]->(ss)`,
];

export const STATE_SLOT_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
];
