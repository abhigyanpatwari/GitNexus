CREATE OR REPLACE PACKAGE pkg_log AS
  PROCEDURE log_msg(p_msg IN VARCHAR2);
  PROCEDURE log_msg(p_msg IN VARCHAR2, p_level IN NUMBER);
  PROCEDURE warn(p_msg IN VARCHAR2);
END pkg_log;
/
