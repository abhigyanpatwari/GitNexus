-- Installs the loan settlement schema objects in dependency order.
SET DEFINE OFF
WHENEVER SQLERROR EXIT FAILURE
PROMPT Installing packages...
@@packages/pkg_log.pks
@@packages/pkg_log.pkb
@@packages/pkg_loan_settle.pks
@@packages/pkg_loan_settle.pkb
@@procedures/prc_archive.prc
@@triggers/trg_repay_plan_audit.sql
-- Shipped by the vendor, not part of this repository.
@@vendor_patch.sql
EXIT
