CREATE OR REPLACE PROCEDURE caller IS
BEGIN
  app.info;
  -- `n` is no member of package APP: here `app` can only be a schema.
  app.n;
END caller;
/
