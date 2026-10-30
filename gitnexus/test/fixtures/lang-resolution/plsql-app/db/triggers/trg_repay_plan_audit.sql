CREATE OR REPLACE TRIGGER trg_repay_plan_audit
AFTER UPDATE OF status ON t_repay_plan
FOR EACH ROW
BEGIN
  INSERT INTO t_audit_log (tbl, pk, old_val, new_val)
  VALUES ('T_REPAY_PLAN', :NEW.loan_id, :OLD.status, :NEW.status);
  pkg_log.warn('status changed');
END;
/
