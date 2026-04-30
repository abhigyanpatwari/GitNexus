import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

export const LOCAL_BACKEND_SEED_DATA = [
  // Files
  `CREATE (f:File {id: 'file:auth.ts', name: 'auth.ts', filePath: 'src/auth.ts', content: 'auth module'})`,
  `CREATE (f:File {id: 'file:utils.ts', name: 'utils.ts', filePath: 'src/utils.ts', content: 'utils module'})`,
  // Functions
  `CREATE (fn:Function {id: 'func:login', name: 'login', filePath: 'src/auth.ts', startLine: 1, endLine: 15, isExported: true, content: 'function login() {}', description: 'User login'})`,
  `CREATE (fn:Function {id: 'func:validate', name: 'validate', filePath: 'src/auth.ts', startLine: 17, endLine: 25, isExported: true, content: 'function validate() {}', description: 'Validate input'})`,
  `CREATE (fn:Function {id: 'func:hash', name: 'hash', filePath: 'src/utils.ts', startLine: 1, endLine: 8, isExported: true, content: 'function hash() {}', description: 'Hash utility'})`,
  `CREATE (fn:Function {id: 'func:alpha', name: 'alpha', filePath: 'src/tools.py', startLine: 1, endLine: 8, isExported: true, content: 'def alpha(): pass', description: 'Alpha tool handler'})`,
  `CREATE (fn:Function {id: 'func:beta', name: 'beta', filePath: 'src/tools.py', startLine: 10, endLine: 18, isExported: true, content: 'def beta(): pass', description: 'Beta tool handler'})`,
  `CREATE (t:Tool {id: 'Tool:alpha', name: 'alpha', filePath: 'src/tools.py', description: 'Calls chain A.'})`,
  `CREATE (t:Tool {id: 'Tool:beta', name: 'beta', filePath: 'src/tools.py', description: 'Calls chain B.'})`,
  // Class
  `CREATE (c:Class {id: 'class:AuthService', name: 'AuthService', filePath: 'src/auth.ts', startLine: 30, endLine: 60, isExported: true, content: 'class AuthService {}', description: 'Authentication service'})`,
  `CREATE (c:Class {id: 'class:BaseService', name: 'BaseService', filePath: 'src/base.ts', startLine: 1, endLine: 20, isExported: true, content: 'class BaseService {}', description: 'Base service class'})`,
  // Methods
  `CREATE (m:Method {id: 'method:AuthService.authenticate', name: 'authenticate', filePath: 'src/auth.ts', startLine: 35, endLine: 45, isExported: false, content: 'authenticate() {}', description: 'Authenticate user'})`,
  `CREATE (m:Method {id: 'method:BaseService.authenticate', name: 'authenticate', filePath: 'src/base.ts', startLine: 5, endLine: 10, isExported: false, content: 'authenticate() {}', description: 'Base authenticate'})`,
  // Community
  `CREATE (c:Community {id: 'comm:auth', label: 'Auth', heuristicLabel: 'Authentication', keywords: ['auth', 'login'], description: 'Auth module', enrichedBy: 'heuristic', cohesion: 0.8, symbolCount: 3})`,
  // Process
  `CREATE (p:Process {id: 'proc:login-flow', label: 'LoginFlow', heuristicLabel: 'User Login', processType: 'intra_community', stepCount: 2, communities: ['auth'], entryPointId: 'func:login', terminalId: 'func:validate'})`,
  `CREATE (p:Process {id: 'proc:alpha-flow', label: 'AlphaFlow', heuristicLabel: 'Alpha Flow', processType: 'intra_community', stepCount: 3, communities: ['tools'], entryPointId: 'func:alpha', terminalId: 'func:hash'})`,
  `CREATE (p:Process {id: 'proc:beta-flow', label: 'BetaFlow', heuristicLabel: 'Beta Flow', processType: 'intra_community', stepCount: 3, communities: ['tools'], entryPointId: 'func:beta', terminalId: 'func:validate'})`,
  // Relationships
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:validate'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:login' AND b.id = 'func:hash'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'import-resolved', step: 0}]->(b)`,
  `MATCH (a:Function), (c:Community) WHERE a.id = 'func:login' AND c.id = 'comm:auth'
   CREATE (a)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:login' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 1}]->(p)`,
  `MATCH (a:Function), (p:Process) WHERE a.id = 'func:validate' AND p.id = 'proc:login-flow'
   CREATE (a)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: '', step: 2}]->(p)`,
  `MATCH (h:Function), (t:Tool) WHERE h.id = 'func:alpha' AND t.id = 'Tool:alpha'
   CREATE (h)-[:CodeRelation {type: 'HANDLES_TOOL', confidence: 1.0, reason: 'tool-definition', step: 0}]->(t)`,
  `MATCH (h:Function), (t:Tool) WHERE h.id = 'func:beta' AND t.id = 'Tool:beta'
   CREATE (h)-[:CodeRelation {type: 'HANDLES_TOOL', confidence: 1.0, reason: 'tool-definition', step: 0}]->(t)`,
  `MATCH (t:Tool), (p:Process) WHERE t.id = 'Tool:alpha' AND p.id = 'proc:alpha-flow'
   CREATE (t)-[:CodeRelation {type: 'ENTRY_POINT_OF', confidence: 0.85, reason: 'tool-handler-entry-point', step: 0}]->(p)`,
  `MATCH (t:Tool), (p:Process) WHERE t.id = 'Tool:beta' AND p.id = 'proc:beta-flow'
   CREATE (t)-[:CodeRelation {type: 'ENTRY_POINT_OF', confidence: 0.85, reason: 'tool-handler-entry-point', step: 0}]->(p)`,
  // HAS_METHOD: AuthService -> authenticate
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class:AuthService' AND m.id = 'method:AuthService.authenticate'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
  // OVERRIDES: AuthService.authenticate -> BaseService.authenticate
  `MATCH (a:Method), (b:Method) WHERE a.id = 'method:AuthService.authenticate' AND b.id = 'method:BaseService.authenticate'
   CREATE (a)-[:CodeRelation {type: 'METHOD_OVERRIDES', confidence: 1.0, reason: 'mro-resolution', step: 0}]->(b)`,
  // HAS_METHOD: BaseService -> authenticate
  `MATCH (c:Class), (m:Method) WHERE c.id = 'class:BaseService' AND m.id = 'method:BaseService.authenticate'
   CREATE (c)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'class-method', step: 0}]->(m)`,
];

export const LOCAL_BACKEND_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
];
