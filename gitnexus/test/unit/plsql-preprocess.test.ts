import { describe, it, expect } from 'vitest';
import {
  neutraliseSubstitutionVariables,
  preprocessPlSql,
  resolveConditionalCompilation,
  scriptIncludesOf,
  stripSqlPlusCommands,
  type SqlPlusCommand,
} from '../../src/core/ingestion/plsql/preprocess.js';

const lines = (s: string) => s.split('\n');

describe('stripSqlPlusCommands', () => {
  it('blanks client commands between statements and keeps the line count', () => {
    const src = [
      'SET DEFINE OFF',
      'PROMPT installing',
      '@@pkg.pks',
      'CREATE TABLE t (id NUMBER);',
      'EXIT',
    ].join('\n');
    const out = stripSqlPlusCommands(src);
    expect(lines(out)).toEqual(['', '', '', 'CREATE TABLE t (id NUMBER);', '']);
  });

  it('never touches code inside a PL/SQL unit (EXECUTE IMMEDIATE, a column named desc)', () => {
    const src = [
      'CREATE OR REPLACE PROCEDURE p IS',
      'BEGIN',
      "  execute immediate 'truncate table t';",
      '  set_status(1);',
      '  select desc into l_d from t;',
      'END;',
      '/',
      'SET ECHO ON',
    ].join('\n');
    expect(lines(stripSqlPlusCommands(src))).toEqual([...lines(src).slice(0, 7), '']);
  });

  it('recognises a CREATE header split across lines (EXIT, calls named like commands survive)', () => {
    const src = [
      'CREATE OR REPLACE',
      '/* generated */',
      'PACKAGE BODY p AS',
      '  PROCEDURE run IS BEGIN',
      '    FETCH c INTO r;',
      '    exit when c%NOTFOUND;',
      '    run_step;',
      '    list := 1;',
      '  END run;',
      'END p;',
      '/',
      'SHOW ERRORS',
    ].join('\n');
    expect(lines(stripSqlPlusCommands(src))).toEqual([...lines(src).slice(0, 11), '']);
  });

  it('tracks a unit that follows a closed block comment on the same line', () => {
    const src = [
      '/* v2 */ CREATE OR REPLACE PROCEDURE q IS',
      'BEGIN',
      '  x := 1;',
      '  exit;',
      'END;',
      '/',
    ].join('\n');
    expect(stripSqlPlusCommands(src)).toBe(src);
  });

  it('blanks `-` continuation lines of a command', () => {
    const src = [
      'EXECUTE dbms_stats.gather_schema_stats( -',
      "  'HR', -",
      '  cascade => TRUE)',
      'SELECT 1 FROM dual;',
    ].join('\n');
    expect(lines(stripSqlPlusCommands(src))).toEqual(['', '', '', 'SELECT 1 FROM dual;']);
  });

  it('reports blanked commands to the sink', () => {
    const commands: SqlPlusCommand[] = [];
    stripSqlPlusCommands('REM header\n@@a.sql\n', commands);
    expect(commands).toEqual([
      { line: 1, text: 'REM header' },
      { line: 2, text: '@@a.sql' },
    ]);
  });
});

describe('neutraliseSubstitutionVariables', () => {
  it('replaces &var / &&var. with an identifier of the same length', () => {
    const src = 'CREATE USER &&owner. IDENTIFIED BY &pwd;';
    const out = neutraliseSubstitutionVariables(src);
    expect(out).toBe('CREATE USER ZZowner  IDENTIFIED BY Zpwd;');
    expect(out.length).toBe(src.length);
  });
});

describe('positional substitution', () => {
  it('neutralises &1 / &&2 at equal length', () => {
    const src = 'SELECT * FROM t WHERE id = &1 AND d = &&2.;';
    const out = neutraliseSubstitutionVariables(src);
    expect(out).toBe('SELECT * FROM t WHERE id = Z1 AND d = ZZ2 ;');
    expect(out.length).toBe(src.length);
  });
});

describe('resolveConditionalCompilation', () => {
  it('keeps the first branch, blanks directives and other branches, preserves layout', () => {
    const src = [
      'x := 1;',
      '$IF dbms_db_version.ver_le_11 $THEN',
      '  a;',
      '$ELSE',
      '  b;',
      '$END',
      'y := 2;',
    ].join('\n');
    const out = resolveConditionalCompilation(src);
    expect(out.length).toBe(src.length);
    expect(lines(out).map((l) => l.trim())).toEqual(['x := 1;', '', 'a;', '', '', '', 'y := 2;']);
  });

  it('handles nesting and ignores directives inside strings and comments', () => {
    const src = "$if a $then $if b $then k1; $else s1; $end $else s2; $end -- $end\nv := '$end';";
    const out = resolveConditionalCompilation(src);
    expect(out.replace(/\s+/g, ' ').trim()).toBe("k1; -- $end v := '$end';");
  });

  it('blanks $ERROR … $END', () => {
    expect(resolveConditionalCompilation("$ERROR 'unsupported' $END ok;").trim()).toBe('ok;');
  });
});

describe('scriptIncludesOf', () => {
  it('extracts @@, @ and START targets with their column; skips substitution paths', () => {
    const commands: SqlPlusCommand[] = [];
    preprocessPlSql('@@pkg/a.pks\n  @b.sql\nSTART "c d.sql"\n@&dir/x.sql\n', commands);
    expect(scriptIncludesOf(commands)).toEqual([
      { line: 1, column: 2, target: 'pkg/a.pks', relativeToScript: true },
      { line: 2, column: 3, target: 'b.sql', relativeToScript: false },
      { line: 3, column: 7, target: 'c d.sql', relativeToScript: false },
    ]);
  });
});
