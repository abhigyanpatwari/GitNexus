/**
 * Oracle PL/SQL Language Provider
 *
 * Standalone ANTLR4 provider — no tree-sitter grammar. PL/SQL files are
 * parsed with the grammars-v4 PlSql grammar (`../plsql/`) and mapped to the
 * graph by `plsql-processor.ts` in the `plsql` pipeline phase, before parse.
 *
 * Dedicated extensions (.pks, .pkb, .pck, …) are always PL/SQL. `.sql` is
 * claimed through `classifyFileContent` only when the file holds an Oracle
 * PL/SQL unit, leaving other SQL dialects alone.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { PLSQL_EXTENSIONS, isSqlFile, looksLikeOraclePlSql } from '../plsql/file-types.js';
import {
  collectPlSqlSourceCfgs,
  emitPlSqlScopeCaptures,
  interpretPlSqlImport,
  plsqlImportOwningScope,
  plsqlReceiverBinding,
  plsqlRenameProvider,
} from './plsql/index.js';

export const plsqlProvider = defineLanguage({
  id: SupportedLanguages.PlSql,
  parseStrategy: 'standalone',
  extensions: [...PLSQL_EXTENSIONS],
  // Check the extension first: classifiers run before extension lookup for every file.
  shouldClassifyFileContent: isSqlFile,
  classifyFileContent: (filePath, sourceText) =>
    isSqlFile(filePath) && looksLikeOraclePlSql(sourceText),
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  rename: plsqlRenameProvider,
  collectSourceCfgs: collectPlSqlSourceCfgs,

  // ── Scope-resolution hooks ───────────────────────────────────────
  emitScopeCaptures: emitPlSqlScopeCaptures,
  interpretImport: interpretPlSqlImport,
  importOwningScope: plsqlImportOwningScope,
  receiverBinding: plsqlReceiverBinding,
});
