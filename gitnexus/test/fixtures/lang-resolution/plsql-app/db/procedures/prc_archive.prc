CREATE OR REPLACE PROCEDURE prc_archive(p_before IN DATE) AS
BEGIN
  loan.pkg_loan_settle.run_batch(p_before);
  INSERT INTO t_repay_plan_hist SELECT * FROM t_repay_plan WHERE settle_time < p_before;
  DELETE FROM t_repay_plan WHERE settle_time < p_before;
  pkg_log.log_msg('archived', 1);
END prc_archive;
/
