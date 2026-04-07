/**
 * Seed data for Namespace Isolation remediation tests (Phase 2).
 *
 * Seeds:
 * - Section nodes with CONTAINS hierarchy (parent → child)
 * - CodeElement (pseudocode) node orphaned (no parent Section)
 * - Section with IMPORTS cross-ref edge to another file
 * - Function/Method nodes with git_namespace
 * - Community with members that have git_namespace
 * - Process with steps that have git_namespace
 * - Tool node with git_namespace
 * - Route node with git_namespace
 * - Section with regex-special-char name for rename edge case
 */
import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

export const NS_ISOLATION_SEED_DATA = [
  // ─── Files ─────────────────────────────────────────────
  `CREATE (f:File {id: 'file:docs/architecture.md', name: 'architecture.md', filePath: 'docs/architecture.md', content: 'Architecture doc', git_namespace: 'docs'})`,
  `CREATE (f:File {id: 'file:docs/api-guide.md', name: 'api-guide.md', filePath: 'docs/api-guide.md', content: 'API guide', git_namespace: 'docs'})`,
  `CREATE (f:File {id: 'file:src/auth.ts', name: 'auth.ts', filePath: 'src/auth.ts', content: 'auth module', git_namespace: 'app/backend'})`,
  `CREATE (f:File {id: 'file:src/utils.ts', name: 'utils.ts', filePath: 'src/utils.ts', content: 'utils module', git_namespace: 'app/backend'})`,

  // ─── Section nodes (Markdown headings) ────────────────
  `CREATE (s:Section {id: 'Section:docs/architecture.md:L1:Architecture Overview', name: 'architecture-overview', filePath: 'docs/architecture.md', startLine: 1, endLine: 50, content: '# Architecture Overview', git_namespace: 'docs'})`,
  `CREATE (s:Section {id: 'Section:docs/architecture.md:L10:System Design', name: 'system-design', filePath: 'docs/architecture.md', startLine: 10, endLine: 30, content: '## System Design', git_namespace: 'docs'})`,
  `CREATE (s:Section {id: 'Section:docs/architecture.md:L35:Type Resolution System', name: 'type-resolution-system', filePath: 'docs/architecture.md', startLine: 35, endLine: 50, content: '## Type Resolution System', git_namespace: 'docs'})`,
  // Section with regex special chars in name (EC3 test)
  `CREATE (s:Section {id: 'Section:docs/api-guide.md:L5:API Methods (v2) [Draft]', name: 'api-methods-v2-draft', filePath: 'docs/api-guide.md', startLine: 5, endLine: 20, content: '## API Methods (v2) [Draft]', git_namespace: 'docs'})`,
  // Duplicate Section name in same namespace but different file (EC1 test)
  `CREATE (s:Section {id: 'Section:docs/api-guide.md:L25:Architecture Overview', name: 'architecture-overview', filePath: 'docs/api-guide.md', startLine: 25, endLine: 40, content: '## Architecture Overview', git_namespace: 'docs'})`,

  // ─── CodeElement (pseudocode block) ────────────────────
  `CREATE (ce:CodeElement {id: 'CodeElement:docs/architecture.md:L15:parseConfig', name: 'parseConfig', filePath: 'docs/architecture.md', startLine: 15, endLine: 20, content: 'parseConfig()', git_namespace: 'docs'})`,
  // Orphaned CodeElement (EC2: no parent Section)
  `CREATE (ce:CodeElement {id: 'CodeElement:docs/api-guide.md:L45:orphanedBlock', name: 'orphanedBlock', filePath: 'docs/api-guide.md', startLine: 45, endLine: 50, content: 'orphaned pseudocode', git_namespace: 'docs'})`,

  // ─── Functions with git_namespace ──────────────────────
  `CREATE (fn:Function {id: 'func:login', name: 'login', filePath: 'src/auth.ts', startLine: 1, endLine: 15, isExported: true, content: 'function login() {}', description: 'User login', git_namespace: 'app/backend'})`,
  `CREATE (fn:Function {id: 'func:validate', name: 'validate', filePath: 'src/auth.ts', startLine: 17, endLine: 25, isExported: true, content: 'function validate() {}', description: 'Validate input', git_namespace: 'app/backend'})`,
  `CREATE (fn:Function {id: 'func:hash', name: 'hash', filePath: 'src/utils.ts', startLine: 1, endLine: 8, isExported: true, content: 'function hash() {}', description: 'Hash utility', git_namespace: 'app/backend'})`,

  // ─── Community ─────────────────────────────────────────
  `CREATE (c:Community {id: 'comm:auth', label: 'Auth', heuristicLabel: 'Authentication', keywords: ['auth', 'login'], description: 'Auth module', enrichedBy: 'heuristic', cohesion: 0.8, symbolCount: 3})`,

  // ─── Process ───────────────────────────────────────────
  `CREATE (p:Process {id: 'proc:login-flow', label: 'LoginFlow', heuristicLabel: 'User Login', processType: 'intra_community', stepCount: 2, communities: ['auth'], entryPointId: 'func:login', terminalId: 'func:validate'})`,

  // ─── Tool node ─────────────────────────────────────────
  `CREATE (t:Tool {id: 'Tool:query', name: 'query', filePath: 'src/mcp/tools.ts', description: 'Query the knowledge graph', git_namespace: 'app/mcp-server'})`,

  // ─── Route node ────────────────────────────────────────
  `CREATE (r:Route {id: 'Route:/api/auth', name: '/api/auth', filePath: 'src/routes/auth.ts', responseKeys: ['token', 'user'], errorKeys: ['error'], git_namespace: 'app/backend'})`,

  // ─── Relationships ─────────────────────────────────────

  // CONTAINS: parent Section → child Section
  `MATCH (a:Section), (b:Section) WHERE a.id = 'Section:docs/architecture.md:L1:Architecture Overview' AND b.id = 'Section:docs/architecture.md:L10:System Design'
   CREATE (a)-[:CodeRelation {type: 'CONTAINS', confidence: 1.0, reason: 'heading-hierarchy', step: 0}]->(b)`,
  `MATCH (a:Section), (b:Section) WHERE a.id = 'Section:docs/architecture.md:L1:Architecture Overview' AND b.id = 'Section:docs/architecture.md:L35:Type Resolution System'
   CREATE (a)-[:CodeRelation {type: 'CONTAINS', confidence: 1.0, reason: 'heading-hierarchy', step: 0}]->(b)`,

  // CONTAINS: File → CodeElement (parseConfig lives in architecture.md)
  // Note: Schema has FROM File TO CodeElement but NOT FROM Section TO CodeElement
  `MATCH (f:File), (ce:CodeElement) WHERE f.id = 'file:docs/architecture.md' AND ce.id = 'CodeElement:docs/architecture.md:L15:parseConfig'
   CREATE (f)-[:CodeRelation {type: 'CONTAINS', confidence: 1.0, reason: 'file-contains-pseudocode', step: 0}]->(ce)`,

  // DEFINES: File → Section
  `MATCH (f:File), (s:Section) WHERE f.id = 'file:docs/architecture.md' AND s.id = 'Section:docs/architecture.md:L1:Architecture Overview'
   CREATE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0, reason: 'file-defines-section', step: 0}]->(s)`,

  // IMPORTS: Section cross-ref → another file (with targetAnchor)
  `MATCH (s:Section), (f:File) WHERE s.id = 'Section:docs/architecture.md:L35:Type Resolution System' AND f.id = 'file:docs/api-guide.md'
   CREATE (s)-[:CodeRelation {type: 'IMPORTS', confidence: 0.9, reason: 'markdown-link', step: 0, targetAnchor: 'api-methods-v2-draft'}]->(f)`,

  // CALLS: login → validate, login → hash
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:validate'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:hash'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'import-resolved', step: 0}]->(b)`,

  // MEMBER_OF: functions → community
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:login' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:validate' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:hash' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,

  // STEP_IN_PROCESS: functions → process
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:login' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:validate' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 2}]->(p)`,

  // HANDLES_ROUTE (for routeMap)
  `MATCH (f:File), (r:Route) WHERE f.id = 'file:src/auth.ts' AND r.id = 'Route:/api/auth'
   CREATE (f)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'file-handler', step: 0}]->(r)`,
];

export const NS_ISOLATION_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Section', indexName: 'section_fts', columns: ['name', 'content'] },
  { table: 'CodeElement', indexName: 'codeelement_fts', columns: ['name', 'content'] },
];
