CREATE OR REPLACE PROCEDURE prc_settle(p_loan_id IN NUMBER) AS
BEGIN
  UPDATE t_repay_plan SET status = 'SETTLED' WHERE loan_id = p_loan_id;
  IF SQL%ROWCOUNT = 0 THEN
    pkg_log.notify('nothing to settle for ' || p_loan_id);
  END IF;
END prc_settle;
/
