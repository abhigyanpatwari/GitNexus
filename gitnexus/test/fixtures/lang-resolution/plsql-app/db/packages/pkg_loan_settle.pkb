CREATE OR REPLACE PACKAGE BODY loan.pkg_loan_settle AS

  g_batch_no VARCHAR2(32);

  -- Private: not declared in the spec.
  FUNCTION calc_penalty(p_loan_id IN NUMBER, p_days IN NUMBER) RETURN NUMBER IS
    l_rate NUMBER;
  BEGIN
    SELECT p.penalty_rate INTO l_rate
      FROM t_loan_product p
     WHERE p.product_id = (SELECT c.product_id FROM t_loan_contract c WHERE c.loan_id = p_loan_id);
    RETURN ROUND(l_rate * p_days, 2);
  END calc_penalty;

  PROCEDURE write_journal(p_loan_id NUMBER, p_amt NUMBER, p_type VARCHAR2) IS
  BEGIN
    INSERT INTO t_acct_journal (journal_id, loan_id, amount, journal_type, batch_no)
    VALUES (seq_journal.NEXTVAL, p_loan_id, p_amt, p_type, g_batch_no);
  END write_journal;

  PROCEDURE settle_one(p_loan_id IN NUMBER) IS
    l_overdue_days NUMBER;
    l_penalty      NUMBER;

    PROCEDURE mark_settled IS
    BEGIN
      UPDATE t_repay_plan SET status = 'SETTLED', settle_time = SYSTIMESTAMP
       WHERE loan_id = p_loan_id AND status = 'DUE';
    END mark_settled;
  BEGIN
    SELECT TRUNC(SYSDATE) - due_date INTO l_overdue_days
      FROM t_repay_plan WHERE loan_id = p_loan_id AND status = 'DUE' AND ROWNUM = 1;

    IF l_overdue_days > 0 THEN
      l_penalty := calc_penalty(p_loan_id, l_overdue_days);
      write_journal(p_loan_id, l_penalty, 'PENALTY');
      pkg_acct.freeze@core_link(p_loan_id);
    END IF;
    mark_settled;

    MERGE INTO t_loan_balance b
    USING (SELECT loan_id, SUM(amount) amt FROM t_acct_journal WHERE loan_id = p_loan_id GROUP BY loan_id) j
       ON (b.loan_id = j.loan_id)
     WHEN MATCHED THEN UPDATE SET b.balance = b.balance - j.amt
     WHEN NOT MATCHED THEN INSERT (loan_id, balance) VALUES (j.loan_id, -j.amt);
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      pkg_log.warn('no due plan for ' || p_loan_id);
  END settle_one;

  PROCEDURE run_batch(p_biz_date IN DATE DEFAULT TRUNC(SYSDATE)) IS
    CURSOR c_due IS
      WITH due AS (SELECT loan_id FROM t_repay_plan WHERE due_date <= p_biz_date AND status = 'DUE')
      SELECT loan_id FROM due;
    l_today DATE;
  BEGIN
    SELECT SYSDATE INTO l_today FROM dual;
    g_batch_no := TO_CHAR(p_biz_date, 'YYYYMMDD') || '_' || seq_batch.NEXTVAL;
    FOR r IN c_due LOOP
      settle_one(r.loan_id);
    END LOOP;
    EXECUTE IMMEDIATE 'TRUNCATE TABLE t_settle_stage';
    pkg_log.log_msg('batch ' || g_batch_no || ' done');
    DBMS_OUTPUT.PUT_LINE('done');
  END run_batch;

END pkg_loan_settle;
/
