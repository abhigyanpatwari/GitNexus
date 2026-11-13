CREATE OR REPLACE PACKAGE BODY pkg_log AS

  PROCEDURE log_msg(p_msg IN VARCHAR2) IS
  BEGIN
    log_msg(p_msg, 1);
  END log_msg;

  PROCEDURE log_msg(p_msg IN VARCHAR2, p_level IN NUMBER) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO t_app_log (log_time, log_level, message) VALUES (SYSTIMESTAMP, p_level, p_msg);
    COMMIT;
  END log_msg;

  PROCEDURE warn(p_msg IN VARCHAR2) IS
  BEGIN
    log_msg(p_msg => p_msg, p_level => 2);
  END warn;

END pkg_log;
/
