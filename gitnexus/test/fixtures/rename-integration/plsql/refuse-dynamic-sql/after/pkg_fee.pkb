CREATE OR REPLACE PACKAGE BODY pkg_fee AS

  FUNCTION calc_fee(p_amt IN NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN ROUND(p_amt * 0.003, 2);
  END calc_fee;

  PROCEDURE reprice(p_batch IN VARCHAR2) IS
  BEGIN
    -- The fee function is also invoked from a generated statement.
    EXECUTE IMMEDIATE 'UPDATE t_txn SET fee = pkg_fee.calc_fee(amount) WHERE batch_no = :1' USING p_batch;
  END reprice;

END pkg_fee;
/
