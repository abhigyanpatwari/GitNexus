CREATE OR REPLACE PACKAGE BODY pkg_job AS

  PROCEDURE run_daily IS
  BEGIN
    DELETE FROM t_job_log WHERE log_date < TRUNC(SYSDATE) - 30;
  END run_daily;

END pkg_job;
/
