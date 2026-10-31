CREATE OR REPLACE PACKAGE loan.pkg_loan_settle AS
  PROCEDURE settle_one(p_loan_id IN NUMBER);
  PROCEDURE run_batch(p_biz_date IN DATE DEFAULT TRUNC(SYSDATE));
END pkg_loan_settle;
/
