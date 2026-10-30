import { describe, it, expect } from 'vitest';
import { extractPlSqlFacts } from '../../src/core/ingestion/plsql/extract.js';
import { isPlSqlSource, looksLikeOraclePlSql } from '../../src/core/ingestion/plsql/file-types.js';
import { resolvePlSqlScriptInclude } from '../../src/core/ingestion/plsql/script-include.js';

const BODY = `CREATE OR REPLACE PACKAGE BODY app.pkg_a AS
  FUNCTION f(p IN NUMBER, q IN NUMBER DEFAULT 0) RETURN NUMBER IS
  BEGIN
    RETURN p + q;
  END f;

  PROCEDURE run IS
    l NUMBER;
    PROCEDURE inner_step IS BEGIN NULL; END inner_step;
  BEGIN
    l := f(1);
    inner_step;
    pkg_b.go(x => 1);
    other_schema.pkg_c.stop@remote_db;
    WITH w AS (SELECT id FROM t_src) SELECT COUNT(*) INTO l FROM w, dual;
    INSERT INTO t_dst SELECT * FROM t_src;
    UPDATE "MixedCase" SET a = 1;
    DELETE FROM app.t_old;
    EXECUTE IMMEDIATE 'DROP TABLE t_tmp';
  END run;
END pkg_a;
/
`;

describe('extractPlSqlFacts', () => {
  const facts = extractPlSqlFacts(BODY);

  it('parses the package without errors in one segment', () => {
    expect(facts.segments).toBe(1);
    expect(facts.segmentsWithErrors).toBe(0);
  });

  it('extracts definitions with owner paths, parameters, positions and END labels', () => {
    expect(facts.definitions.map((d) => `${d.kind} ${[...d.ownerPath, d.name].join('.')}`)).toEqual(
      [
        'package PKG_A',
        'function PKG_A.F',
        'procedure PKG_A.RUN',
        'procedure PKG_A.RUN.INNER_STEP',
      ],
    );
    const pkg = facts.definitions[0]!;
    expect(pkg.schema).toBe('APP');
    expect(pkg.endLabels.map((l) => `${l.name}@${l.line}:${l.column}`)).toEqual(['PKG_A@21:4']);
    const f = facts.definitions[1]!;
    expect(f.parameters).toEqual([
      { name: 'P', hasDefault: false, type: 'NUMBER' },
      { name: 'Q', hasDefault: true, type: 'NUMBER' },
    ]);
    expect({ line: f.nameLine, column: f.nameColumn, length: f.nameLength }).toEqual({
      line: 2,
      column: 11,
      length: 1,
    });
    expect(f.endLabels.map((l) => l.line)).toEqual([5]);
  });

  it('extracts call sites with name tokens, arity, named arguments and db links', () => {
    const describe = (c: (typeof facts.calls)[number]) =>
      [
        `${c.nameParts.join('.')}/${c.arity}`,
        c.namedArguments.length > 0 ? `named=${c.namedArguments.join(',')}` : '',
        c.dbLink ? `@${c.dbLink}` : '',
        c.form,
      ]
        .filter(Boolean)
        .join(' ');
    // COUNT(*) is an aggregate rule, not a call; built-ins are filtered later by resolution.
    expect(facts.calls.map(describe)).toEqual([
      'F/1 expression',
      'INNER_STEP/0 statement',
      'PKG_B.GO/1 named=X statement',
      'OTHER_SCHEMA.PKG_C.STOP/0 @REMOTE_DB statement',
    ]);
    const go = facts.calls.find((c) => c.nameParts.join('.') === 'PKG_B.GO')!;
    expect(go.nameTokens.map((t) => `${t.name}@${t.line}:${t.column}`)).toEqual([
      'PKG_B@13:4',
      'GO@13:10',
    ]);
  });

  it('classifies table accesses and filters CTE names and DUAL', () => {
    expect(
      facts.accesses.map((a) => `${a.kind} ${a.schema ? `${a.schema}.` : ''}${a.table}`),
    ).toEqual([
      'select T_SRC',
      'insert T_DST',
      'select T_SRC',
      'update MixedCase',
      'delete APP.T_OLD',
    ]);
  });

  it('records dynamic SQL with its literal text', () => {
    expect(facts.dynamicSql.map((d) => d.literal)).toEqual(['DROP TABLE t_tmp']);
  });

  it('recovers definitions the error-recovered tree lost, marked as fallback', () => {
    const broken = `CREATE OR REPLACE PACKAGE BODY pkg_x AS
  PROCEDURE a IS BEGIN this is not plsql at all; END a;
  PROCEDURE b IS BEGIN NULL; END b;
END pkg_x;
/
`;
    const f = extractPlSqlFacts(broken);
    expect(f.segmentsWithErrors).toBe(1);
    const names = f.definitions.map(
      (d) => `${[...d.ownerPath, d.name].join('.')}${d.fromFallback ? ' (fallback)' : ''}`,
    );
    expect(names).toContain('PKG_X.B');
    expect(names.some((n) => n.startsWith('PKG_X.A'))).toBe(true);
  });

  it('keeps one segment per `/`-terminated unit so an error stays local', () => {
    const f = extractPlSqlFacts(
      'CREATE PROCEDURE ok1 IS BEGIN NULL; END;\n/\nCREATE PROCEDURE bad IS BEGIN ((( END;\n/\nCREATE PROCEDURE ok2 IS BEGIN NULL; END;\n/\n',
    );
    expect(f.segments).toBe(3);
    expect(f.segmentsWithErrors).toBe(1);
    expect(f.definitions.filter((d) => !d.fromFallback).map((d) => d.name)).toEqual(
      expect.arrayContaining(['OK1', 'OK2']),
    );
  });
});

describe('file classification', () => {
  it('always claims dedicated PL/SQL extensions', () => {
    expect(isPlSqlSource('db/pkg.pkb', '')).toBe(true);
  });

  it('claims .sql only for Oracle PL/SQL units or SQL*Plus include scripts', () => {
    expect(looksLikeOraclePlSql('CREATE OR REPLACE PROCEDURE p IS\nBEGIN NULL; END;\n/\n')).toBe(
      true,
    );
    expect(looksLikeOraclePlSql('@@packages/pkg.pks\n@@packages/pkg.pkb\n')).toBe(true);
    expect(
      looksLikeOraclePlSql(
        'CREATE FUNCTION f() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
      ),
    ).toBe(false);
    expect(looksLikeOraclePlSql('CREATE PROCEDURE p AS\nBEGIN\n  SET NOCOUNT ON;\nEND\nGO\n')).toBe(
      false,
    );
    expect(looksLikeOraclePlSql('SELECT * FROM t;')).toBe(false);
    // MySQL: no IS/AS before BEGIN, even with an Oracle-looking marker in a comment.
    expect(
      looksLikeOraclePlSql(
        'CREATE PROCEDURE p()\nBEGIN\n  -- nvl( is not MySQL\n  SELECT 1;\nEND\n/\n',
      ),
    ).toBe(false);
    // Oracle header split across lines still counts.
    expect(
      looksLikeOraclePlSql('CREATE OR REPLACE\nPACKAGE BODY p\nAS\n  x VARCHAR2(1);\nEND p;\n/\n'),
    ).toBe(true);
  });
});

describe('resolvePlSqlScriptInclude', () => {
  const files = new Set(['db/install.sql', 'db/pkg/a.pks', 'db/b.sql', 'vendor/ext.pks']);
  it('resolves relative to the calling script, then the repository root, adding .sql', () => {
    expect(resolvePlSqlScriptInclude('pkg/a.pks', 'db/install.sql', files)).toBe('db/pkg/a.pks');
    expect(resolvePlSqlScriptInclude('b', 'db/install.sql', files)).toBe('db/b.sql');
    expect(resolvePlSqlScriptInclude('vendor/ext.pks', 'db/install.sql', files)).toBe(
      'vendor/ext.pks',
    );
    expect(resolvePlSqlScriptInclude('../vendor/ext.pks', 'db/install.sql', files)).toBe(
      'vendor/ext.pks',
    );
  });
  it('never suffix-matches a script outside the repository', () => {
    expect(resolvePlSqlScriptInclude('ext.pks', 'db/install.sql', files)).toBeNull();
    expect(
      resolvePlSqlScriptInclude('?/rdbms/admin/utlrp.sql', 'db/install.sql', files),
    ).toBeNull();
    expect(resolvePlSqlScriptInclude('/opt/x.sql', 'db/install.sql', files)).toBeNull();
  });
});
