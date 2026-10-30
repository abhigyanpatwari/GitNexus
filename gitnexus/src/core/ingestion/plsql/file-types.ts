/**
 * Oracle PL/SQL file detection.
 *
 * Dedicated extensions are always PL/SQL. `.sql` is shared by every SQL
 * dialect, so it is claimed only when the content contains an Oracle PL/SQL
 * compilation unit (see `looksLikeOraclePlSql`).
 */

/** Extensions that are unambiguously Oracle PL/SQL source. */
export const PLSQL_EXTENSIONS = [
  '.pks', // package spec
  '.pkb', // package body
  '.pck', // spec + body
  '.pls', // generic PL/SQL source
  '.plb', // body (often wrapped)
  '.prc', // standalone procedure
  '.fnc', // standalone function
  '.trg', // trigger
  '.tps', // object type spec
  '.tpb', // object type body
] as const;

const PLSQL_EXTENSION_SET: ReadonlySet<string> = new Set(PLSQL_EXTENSIONS);

function extensionOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const dot = filePath.lastIndexOf('.');
  return dot > slash ? filePath.slice(dot).toLowerCase() : '';
}

export function hasPlSqlExtension(filePath: string): boolean {
  return PLSQL_EXTENSION_SET.has(extensionOf(filePath));
}

export function isSqlFile(filePath: string): boolean {
  return extensionOf(filePath) === '.sql';
}

/**
 * An Oracle unit header at the start of a line:
 *   `CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] PACKAGE|PROCEDURE|FUNCTION|TYPE <name> … IS|AS`
 *   `CREATE [OR REPLACE] … TRIGGER <name> BEFORE|AFTER|INSTEAD OF|FOR`
 * `IS`/`AS` must follow the name (after an optional parameter list / RETURN
 * clause) before any `BEGIN`, which rules out MySQL's `CREATE PROCEDURE p() BEGIN`.
 * PostgreSQL's `AS $$` and T-SQL are excluded separately below.
 */
const ORACLE_UNIT_HEADER =
  /^[ \t]*create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:(?:package(?:\s+body)?|procedure|function|type(?:\s+body)?)\s+[\w$#."]+(?:(?!\bbegin\b)[\s\S]){0,4000}?\b(?:is|as)\b|trigger\s+[\w$#."]+\s+(?:before|after|instead\s+of|for)\b)/im;
const POSTGRES_DOLLAR_BODY = /\bas\s+\$[\w]*\$|\blanguage\s+plpgsql\b/i;
const TSQL_MARKERS = /^\s*go\s*$|\bnvarchar\s*\(\s*max\s*\)|@@identity|\bset\s+nocount\s+on\b/im;
/** Constructs that only appear in Oracle PL/SQL. */
const ORACLE_MARKERS =
  /%(?:row)?type\b|^\s*\/\s*$|\bpragma\s+(?:autonomous_transaction|exception_init|serially_reusable|restrict_references)\b|\bexecute\s+immediate\b|\bdbms_\w+\.|\braise_application_error\b|\bsys_refcursor\b|\bvarchar2\b|\bnvl\s*\(/im;

/**
 * A SQL*Plus script inclusion of a PL/SQL or SQL file on its own line. `@@`,
 * `@path.ext` and `START path.ext` are SQL*Plus client syntax (psql uses `\i`,
 * sqlcmd `:r`), so install scripts made of them are Oracle sources too.
 */
const SQLPLUS_INCLUDE =
  /^[ \t]*(?:@@|@|sta(?:rt)?[ \t]+)[\w./\\-]+\.(?:sql|pks|pkb|pck|pls|plb|prc|fnc|trg|tps|tpb)[ \t]*\r?$/im;

/**
 * True when `.sql` content holds at least one Oracle PL/SQL compilation unit,
 * or is a SQL*Plus script that includes other scripts.
 */
export function looksLikeOraclePlSql(content: string): boolean {
  if (SQLPLUS_INCLUDE.test(content) && !TSQL_MARKERS.test(content)) return true;
  if (!ORACLE_UNIT_HEADER.test(content)) return false;
  if (POSTGRES_DOLLAR_BODY.test(content) || TSQL_MARKERS.test(content)) return false;
  return ORACLE_MARKERS.test(content);
}

/** File-level predicate used by the PL/SQL phase. */
export function isPlSqlSource(filePath: string, content: string): boolean {
  if (hasPlSqlExtension(filePath)) return true;
  return isSqlFile(filePath) && looksLikeOraclePlSql(content);
}
