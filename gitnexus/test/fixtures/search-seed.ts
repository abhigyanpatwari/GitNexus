import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

export const SEARCH_SEED_DATA = [
  // File nodes — content is the searchable field
  `CREATE (n:File {id: 'file:auth.ts', name: 'auth.ts', filePath: 'src/auth.ts', content: 'authentication module for user login and session management'})`,
  `CREATE (n:File {id: 'file:router.ts', name: 'router.ts', filePath: 'src/router.ts', content: 'HTTP request routing and middleware pipeline'})`,
  `CREATE (n:File {id: 'file:utils.ts', name: 'utils.ts', filePath: 'src/utils.ts', content: 'general utility functions for string manipulation'})`,

  // Function nodes
  `CREATE (n:Function {id: 'func:validateUser', name: 'validateUser', filePath: 'src/auth.ts', startLine: 10, endLine: 30, isExported: true, content: 'validates user credentials and authentication tokens', description: 'user auth validator'})`,
  `CREATE (n:Function {id: 'func:hashPassword', name: 'hashPassword', filePath: 'src/auth.ts', startLine: 35, endLine: 50, isExported: true, content: 'hashes user password with bcrypt for secure authentication', description: 'password hashing'})`,
  `CREATE (n:Function {id: 'func:handleRoute', name: 'handleRoute', filePath: 'src/router.ts', startLine: 1, endLine: 20, isExported: true, content: 'handles HTTP request routing to controllers', description: 'route handler'})`,
  `CREATE (n:Function {id: 'func:formatString', name: 'formatString', filePath: 'src/utils.ts', startLine: 1, endLine: 10, isExported: true, content: 'formats a string with template placeholders', description: 'string formatter'})`,

  // Class nodes
  `CREATE (n:Class {id: 'class:AuthService', name: 'AuthService', filePath: 'src/auth.ts', startLine: 55, endLine: 120, isExported: true, content: 'authentication service handling user login logout and token refresh', description: 'auth service class'})`,

  // Method nodes
  `CREATE (n:Method {id: 'method:AuthService.login', name: 'login', filePath: 'src/auth.ts', startLine: 60, endLine: 80, isExported: false, content: 'authenticates user with username and password returning JWT token', description: 'login method'})`,

  // Interface nodes
  `CREATE (n:Interface {id: 'iface:UserCredentials', name: 'UserCredentials', filePath: 'src/auth.ts', startLine: 1, endLine: 8, isExported: true, content: 'interface for user authentication credentials username password', description: 'credentials interface'})`,
];

export const SEARCH_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content', 'description'] },
  { table: 'Method', indexName: 'method_fts', columns: ['name', 'content', 'description'] },
  { table: 'Interface', indexName: 'interface_fts', columns: ['name', 'content', 'description'] },
];
