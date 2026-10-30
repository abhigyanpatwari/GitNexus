/**
 * Oracle PL/SQL: strict integration test over the plsql-app fixture.
 *
 * Every PL/SQL node and edge is asserted with exact sorted lists, including
 * the negatives: built-ins, database-link calls, CTE names, DUAL, scripts
 * outside the repository and a PostgreSQL `.sql` decoy produce nothing.
 *
 *   db/install.sql                       SQL*Plus install script (@@ includes)
 *   db/packages/pkg_log.{pks,pkb}        overloaded LOG_MSG, named arguments
 *   db/packages/pkg_loan_settle.{pks,pkb} schema-qualified package, private
 *                                        and nested subprograms, MERGE, CTE
 *   db/procedures/prc_archive.prc        standalone procedure, INSERT…SELECT
 *   db/triggers/trg_repay_plan_audit.sql trigger in a .sql file
 *   db/postgres/fn_pg.sql                PL/pgSQL decoy — must not be claimed
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const plsqlNodes = (result: PipelineResult, label: string) => {
  const out: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label && n.properties.language === 'plsql') out.push(n.properties.name);
  });
  return out.sort();
};

const plsqlEdges = (result: PipelineResult, type: string) =>
  getRelationships(result, type)
    .filter((e) => e.rel.reason.startsWith('plsql'))
    .map((e) => `${e.source} → ${e.target} [${e.rel.reason}]`)
    .sort();

describe('Oracle PL/SQL extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'plsql-app'), () => {}, {
      skipGraphPhases: true,
    });
  }, 120000);

  describe('nodes', () => {
    it('merges each package spec and body into one Module anchored at the spec', () => {
      expect(plsqlNodes(result, 'Module')).toEqual(['PKG_LOAN_SETTLE', 'PKG_LOG']);
      let anchor: string | undefined;
      result.graph.forEachNode((n) => {
        if (n.label === 'Module' && n.properties.name === 'PKG_LOAN_SETTLE')
          anchor = n.properties.filePath;
      });
      expect(anchor).toBe('db/packages/pkg_loan_settle.pks');
    });

    it('creates one Function per subprogram body, overloads and nested subprograms included', () => {
      expect(plsqlNodes(result, 'Function')).toEqual([
        'CALC_PENALTY',
        'LOG_MSG',
        'LOG_MSG',
        'MARK_SETTLED',
        'PRC_ARCHIVE',
        'RUN_BATCH',
        'SETTLE_ONE',
        'TRG_REPAY_PLAN_AUDIT',
        'WARN',
        'WRITE_JOURNAL',
      ]);
    });

    it('exports package members exactly when the spec declares them', () => {
      const exported: Record<string, boolean | undefined> = {};
      result.graph.forEachNode((n) => {
        if (n.label === 'Function' && n.properties.language === 'plsql')
          exported[n.properties.name] = n.properties.isExported;
      });
      expect(exported).toMatchObject({
        SETTLE_ONE: true,
        RUN_BATCH: true,
        CALC_PENALTY: false,
        WRITE_JOURNAL: false,
        MARK_SETTLED: false,
        PRC_ARCHIVE: true,
      });
    });

    it('creates one Record per referenced table, never for CTEs or DUAL', () => {
      expect(plsqlNodes(result, 'Record')).toEqual([
        'T_ACCT_JOURNAL',
        'T_APP_LOG',
        'T_AUDIT_LOG',
        'T_LOAN_BALANCE',
        'T_LOAN_CONTRACT',
        'T_LOAN_PRODUCT',
        'T_REPAY_PLAN',
        'T_REPAY_PLAN_HIST',
      ]);
    });

    it('does not claim the PL/pgSQL .sql file', () => {
      let claimed = false;
      result.graph.forEachNode((n) => {
        if (n.properties.language === 'plsql' && n.properties.filePath === 'db/postgres/fn_pg.sql')
          claimed = true;
      });
      expect(claimed).toBe(false);
    });
  });

  describe('edges', () => {
    it('CONTAINS: files → packages, packages → members, procedures → nested subprograms', () => {
      expect(plsqlEdges(result, 'CONTAINS')).toEqual([
        'PKG_LOAN_SETTLE → CALC_PENALTY [plsql-subprogram]',
        'PKG_LOAN_SETTLE → RUN_BATCH [plsql-subprogram]',
        'PKG_LOAN_SETTLE → SETTLE_ONE [plsql-subprogram]',
        'PKG_LOAN_SETTLE → WRITE_JOURNAL [plsql-subprogram]',
        'PKG_LOG → LOG_MSG [plsql-subprogram]',
        'PKG_LOG → LOG_MSG [plsql-subprogram]',
        'PKG_LOG → WARN [plsql-subprogram]',
        'SETTLE_ONE → MARK_SETTLED [plsql-subprogram]',
        'pkg_loan_settle.pkb → PKG_LOAN_SETTLE [plsql-package]',
        'pkg_loan_settle.pks → PKG_LOAN_SETTLE [plsql-package]',
        'pkg_log.pkb → PKG_LOG [plsql-package]',
        'pkg_log.pks → PKG_LOG [plsql-package]',
        'prc_archive.prc → PRC_ARCHIVE [plsql-subprogram]',
        'trg_repay_plan_audit.sql → TRG_REPAY_PLAN_AUDIT [plsql-trigger]',
      ]);
    });

    it('CALLS: local, nested, package-qualified and schema-qualified calls; no built-ins or db links', () => {
      expect(plsqlEdges(result, 'CALLS')).toEqual([
        'LOG_MSG → LOG_MSG [plsql-call]',
        'PRC_ARCHIVE → LOG_MSG [plsql-call]',
        'PRC_ARCHIVE → RUN_BATCH [plsql-call]',
        'RUN_BATCH → LOG_MSG [plsql-call]',
        'RUN_BATCH → SETTLE_ONE [plsql-call]',
        'SETTLE_ONE → CALC_PENALTY [plsql-call]',
        'SETTLE_ONE → MARK_SETTLED [plsql-call]',
        'SETTLE_ONE → WARN [plsql-call]',
        'SETTLE_ONE → WRITE_JOURNAL [plsql-call]',
        'TRG_REPAY_PLAN_AUDIT → WARN [plsql-call]',
        'WARN → LOG_MSG [plsql-call]',
      ]);
    });

    it('CALLS: overloads are selected by arity and named arguments', () => {
      const overloadLine = new Map<string, number>();
      result.graph.forEachNode((n) => {
        if (n.label === 'Function' && n.properties.name === 'LOG_MSG') {
          overloadLine.set(n.id, n.properties.startLine! + 1);
        }
      });
      const calls = getRelationships(result, 'CALLS')
        .filter((e) => e.target === 'LOG_MSG')
        .map((e) => `${e.source}@${e.sourceLabel} → LOG_MSG@L${overloadLine.get(e.rel.targetId)}`)
        .sort();
      // L3: log_msg(p_msg)   L8: log_msg(p_msg, p_level)
      expect(calls).toEqual([
        'LOG_MSG@Function → LOG_MSG@L8', // log_msg(p_msg, 1)
        'PRC_ARCHIVE@Function → LOG_MSG@L8', // log_msg('archived', 1)
        'RUN_BATCH@Function → LOG_MSG@L3', // pkg_log.log_msg('…')
        'WARN@Function → LOG_MSG@L8', // log_msg(p_msg => …, p_level => 2)
      ]);
    });

    it('ACCESSES: read/write per statement, MERGE target vs source, trigger target', () => {
      expect(plsqlEdges(result, 'ACCESSES')).toEqual([
        'CALC_PENALTY → T_LOAN_CONTRACT [plsql-select]',
        'CALC_PENALTY → T_LOAN_PRODUCT [plsql-select]',
        'LOG_MSG → T_APP_LOG [plsql-insert]',
        'MARK_SETTLED → T_REPAY_PLAN [plsql-update]',
        'PRC_ARCHIVE → T_REPAY_PLAN [plsql-delete]',
        'PRC_ARCHIVE → T_REPAY_PLAN [plsql-select]',
        'PRC_ARCHIVE → T_REPAY_PLAN_HIST [plsql-insert]',
        'RUN_BATCH → T_REPAY_PLAN [plsql-select]',
        'SETTLE_ONE → T_ACCT_JOURNAL [plsql-select]',
        'SETTLE_ONE → T_LOAN_BALANCE [plsql-merge]',
        'SETTLE_ONE → T_REPAY_PLAN [plsql-select]',
        'TRG_REPAY_PLAN_AUDIT → T_AUDIT_LOG [plsql-insert]',
        'TRG_REPAY_PLAN_AUDIT → T_REPAY_PLAN [plsql-trigger]',
        'WRITE_JOURNAL → T_ACCT_JOURNAL [plsql-insert]',
      ]);
    });

    it('IMPORTS: SQL*Plus @@ includes that exist in the repository', () => {
      expect(plsqlEdges(result, 'IMPORTS')).toEqual([
        'install.sql → pkg_loan_settle.pkb [plsql-script-include]',
        'install.sql → pkg_loan_settle.pks [plsql-script-include]',
        'install.sql → pkg_log.pkb [plsql-script-include]',
        'install.sql → pkg_log.pks [plsql-script-include]',
        'install.sql → prc_archive.prc [plsql-script-include]',
        'install.sql → trg_repay_plan_audit.sql [plsql-script-include]',
      ]);
    });
  });
});
