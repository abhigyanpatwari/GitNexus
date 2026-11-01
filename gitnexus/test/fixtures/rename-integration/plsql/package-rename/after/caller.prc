CREATE OR REPLACE PROCEDURE caller IS
BEGIN
  core.info;
  -- a comment naming app and a literal stay as they are
  DBMS_OUTPUT.PUT_LINE('app');
END caller;
/
