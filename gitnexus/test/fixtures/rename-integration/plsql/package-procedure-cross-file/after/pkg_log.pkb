CREATE OR REPLACE PACKAGE BODY pkg_log AS

  PROCEDURE info(p_msg IN VARCHAR2) IS
  BEGIN
    INSERT INTO t_app_log (log_level, message) VALUES ('info', p_msg);
  END info;

  -- warn writes a warning row and echoes it
  PROCEDURE notify(p_msg IN VARCHAR2) IS
  BEGIN
    INSERT INTO t_app_log (log_level, message) VALUES ('warn', p_msg);
    info('warn: ' || p_msg);
  END notify;

END pkg_log;
/
