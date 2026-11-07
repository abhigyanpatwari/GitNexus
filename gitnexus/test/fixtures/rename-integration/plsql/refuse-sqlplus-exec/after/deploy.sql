CREATE OR REPLACE PROCEDURE prc_deploy_marker IS
BEGIN
  NULL;
END prc_deploy_marker;
/
-- Run the daily job once right after deployment.
EXEC pkg_job.run_daily;
