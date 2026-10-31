/**
 * Oracle(c) PL/SQL 11g Parser
 *
 * Copyright (c) 2009-2011 Alexandre Porcelli <alexandre.porcelli@gmail.com>
 * Copyright (c) 2015-2019 Ivan Kochurkin (KvanTTT, kvanttt@gmail.com, Positive Technologies).
 * Copyright (c) 2017-2018 Mark Adams <madams51703@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// $antlr-format alignTrailingComments true, columnLimit 150, minEmptyLines 1, maxEmptyLinesToKeep 1, reflowComments false, useTab false
// $antlr-format allowShortRulesOnASingleLine false, allowShortBlocksOnASingleLine true, alignSemicolons hanging, alignColons hanging

parser grammar PlSqlParser;

options {
    tokenVocab = PlSqlLexer;
    superClass = PlSqlParserBase;
}

// Insert here @header for C++ parser.

sql_script
    : (sql_plus_command SEMICOLON?)* (
        script_unit (terminator script_unit)* terminator?
    )? EOF
    ;

// Actions set a flag for the `terminator` predicate: bare '/' is accepted only
// after a SQL unit; a PL/SQL unit requires a preceding SEMICOLON.
script_unit
    : plsql_unit {this.setLastUnitPlsql();}
    | sql_unit {this.setLastUnitSql();}
    | sql_plus_command {this.setLastUnitSql();}
    ;

// Separator between units (and optional terminator after the last one).
// SEMICOLON is always valid; bare '/' only after a SQL unit — the predicate
// rejects '/' after a PL/SQL block, yielding useful diagnostic.
// isSolidusSeparator() checks that '/' is on its own line (SQL*Plus separator
// vs division operator).
terminator
    : SEMICOLON
    | SEMICOLON {this.isSolidusSeparator()}? SOLIDUS
    | {this.isLastUnitSql() && this.isSolidusSeparator()}? SOLIDUS
    ;

plsql_unit
    : anonymous_block
    | create_function_body
    | create_procedure_body
    | create_package
    | create_package_body
    | create_trigger
    | create_type_body
    ;

// SQL/DDL statements. A trailing terminator is optional (the last unit in a
// script may omit it); when present it is matched by the `terminator` rule,
// which accepts SEMICOLON, SOLIDUS, or both.
sql_unit
    : alter_analytic_view
    | alter_attribute_dimension
    | alter_audit_policy
    | alter_cluster
    | alter_database
    | alter_database_link
    | alter_dimension
    | alter_diskgroup
    | alter_flashback_archive
    | alter_function
    | alter_hierarchy
    | alter_index
    | alter_inmemory_join_group
    | alter_java
    | alter_library
    | alter_lockdown_profile
    | alter_materialized_view
    | alter_materialized_view_log
    | alter_materialized_zonemap
    | alter_operator
    | alter_outline
    | alter_package
    | alter_pmem_filestore
    | alter_procedure
    | alter_resource_cost
    | alter_role
    | alter_rollback_segment
    | alter_sequence
    | alter_session
    | alter_synonym
    | alter_table
    | alter_tablespace
    | alter_tablespace_set
    | alter_trigger
    | alter_type
    | alter_user
    | alter_view
    | call_statement
    | create_analytic_view
    | create_attribute_dimension
    | create_audit_policy
    | create_cluster
    | create_context
    | create_controlfile
    | create_schema
    | create_database
    | create_database_link
    | create_dimension
    | create_directory
    | create_diskgroup
    | create_edition
    | create_flashback_archive
    | create_hierarchy
    | create_index
    | create_inmemory_join_group
    | create_java
    | create_library
    | create_lockdown_profile
    | create_materialized_view
    | create_materialized_view_log
    | create_materialized_zonemap
    | create_operator
    | create_outline
    | create_pmem_filestore
    | create_profile
    | create_restore_point
    | create_role
    | create_rollback_segment
    | create_sequence
    | create_spfile
    | create_synonym
    | create_table
    | create_tablespace
    | create_tablespace_set
    | create_type_spec
    | create_user
    | create_view
    | drop_analytic_view
    | drop_attribute_dimension
    | drop_audit_policy
    | drop_cluster
    | drop_context
    | drop_database
    | drop_database_link
    | drop_directory
    | drop_diskgroup
    | drop_edition
    | drop_flashback_archive
    | drop_function
    | drop_hierarchy
    | drop_index
    | drop_indextype
    | drop_inmemory_join_group
    | drop_java
    | drop_library
    | drop_lockdown_profile
    | drop_materialized_view
    | drop_materialized_view_log
    | drop_materialized_zonemap
    | drop_operator
    | drop_outline
    | drop_package
    | drop_pmem_filestore
    | drop_procedure
    | drop_restore_point
    | drop_role
    | drop_rollback_segment
    | drop_sequence
    | drop_synonym
    | drop_table
    | drop_tablespace
    | drop_tablespace_set
    | drop_trigger
    | drop_type
    | drop_user
    | drop_view
    | administer_key_management
    | analyze
    | associate_statistics
    | audit_traditional
    | comment_on_column
    | comment_on_materialized
    | comment_on_table
    | data_manipulation_language_statements
    | disassociate_statistics
    | flashback_table
    | grant_statement
    | noaudit_statement
    | purge_statement
    | rename_object
    | revoke_statement
    | transaction_control_statements
    | truncate_cluster
    | truncate_table
    | unified_auditing
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-DISKGROUP.html
alter_diskgroup
    : ALTER DISKGROUP (
        id_expression (
            ((add_disk_clause | drop_disk_clause)+ | resize_disk_clause) rebalance_diskgroup_clause?
            | (
                replace_disk_clause
                | rename_disk_clause
                | disk_online_clause
                | disk_offline_clause
                | rebalance_diskgroup_clause
                | check_diskgroup_clause
                | diskgroup_template_clauses
                | diskgroup_directory_clauses
                | diskgroup_alias_clauses
                | diskgroup_volume_clauses
                | diskgroup_attributes
                | drop_diskgroup_file_clause
                | convert_redundancy_clause
                | usergroup_clauses
                | user_clauses
                | file_permissions_clause
                | file_owner_clause
                | scrub_clause
                | quotagroup_clauses
                | filegroup_clauses
            )
        )
        | (id_expression (',' id_expression)* | ALL) (
            undrop_disk_clause
            | diskgroup_availability
            | enable_disable_volume
        )
    )
    ;

add_disk_clause
    : ADD (
        (SITE sn = id_expression)? quorum_regular? (FAILGROUP fgn = id_expression)? DISK qualified_disk_clause (
            ',' qualified_disk_clause
        )*
    )+
    ;

drop_disk_clause
    : DROP (
        quorum_regular? DISK id_expression force_noforce? (',' id_expression force_noforce?)*
        | DISKS IN quorum_regular? FAILGROUP id_expression force_noforce? (
            ',' id_expression force_noforce?
        )*
    )
    ;

resize_disk_clause
    : RESIZE ALL (SIZE size_clause)?
    ;

replace_disk_clause
    : REPLACE DISK id_expression WITH CHAR_STRING force_noforce? (
        ',' id_expression WITH CHAR_STRING force_noforce?
    )* (POWER numeric)? wait_nowait?
    ;

wait_nowait
    : WAIT
    | NOWAIT
    ;

rename_disk_clause
    : RENAME (
        DISK id_expression TO id_expression (',' id_expression TO id_expression)*
        | DISKS ALL
    )
    ;

disk_online_clause
    : ONLINE (
        (
            quorum_regular? DISK id_expression (',' id_expression)*
            | DISKS IN quorum_regular? FAILGROUP id_expression (',' id_expression)*
        )+
        | ALL
    ) (POWER numeric)? wait_nowait?
    ;

disk_offline_clause
    : OFFLINE (
        quorum_regular? DISK id_expression (',' id_expression)*
        | DISKS IN quorum_regular? FAILGROUP id_expression (',' id_expression)*
    ) timeout_clause?
    ;

timeout_clause
    : DROP AFTER numeric (M_LETTER | H_LETTER)
    ;

rebalance_diskgroup_clause
    : REBALANCE (
        ((WITH | WITHOUT) phase+)? (POWER numeric) (WAIT | NOWAIT)?
        | MODIFY POWER numeric?
    )
    ;

phase
    : id_expression //TODO
    ;

check_diskgroup_clause
    : CHECK ALL? (REPAIR | NOREPAIR)? //inconsistent documentation
    ;

diskgroup_template_clauses
    : (ADD | MODIFY) TEMPLATE id_expression qualified_template_clause (
        ',' id_expression qualified_template_clause
    )*
    | DROP TEMPLATE id_expression (',' id_expression)*
    ;

qualified_template_clause
    : ATTRIBUTES '(' redundancy_clause? striping_clause? ')' //inconsistent documentation
    ;

redundancy_clause
    : MIRROR
    | HIGH
    | UNPROTECTED
    | PARITY
    | DOUBLE
    ;

striping_clause
    : FINE
    | COARSE
    ;

force_noforce
    : FORCE
    | NOFORCE
    ;

diskgroup_directory_clauses
    : ADD DIRECTORY filename (',' filename)*
    | DROP DIRECTORY filename force_noforce? (',' filename force_noforce?)*
    | RENAME DIRECTORY dir_name TO dir_name (',' dir_name TO dir_name)*
    ;

dir_name
    : CHAR_STRING
    ;

diskgroup_alias_clauses
    : ADD ALIAS CHAR_STRING FOR CHAR_STRING (',' CHAR_STRING FOR CHAR_STRING)*
    | DROP ALIAS CHAR_STRING (',' CHAR_STRING)*
    | RENAME ALIAS CHAR_STRING TO CHAR_STRING (',' CHAR_STRING TO CHAR_STRING)*
    ;

diskgroup_volume_clauses
    : add_volume_clause
    | modify_volume_clause
    | RESIZE VOLUME id_expression SIZE size_clause
    | DROP VOLUME id_expression
    ;

add_volume_clause
    : ADD VOLUME id_expression SIZE size_clause redundancy_clause? (
        STRIPE_WIDTH numeric (K_LETTER | M_LETTER)
    )? (STRIPE_COLUMNS numeric)?
    ;

modify_volume_clause
    : MODIFY VOLUME id_expression (MOUNTPATH CHAR_STRING)? (USAGE CHAR_STRING)?
    ;

diskgroup_attributes
    : SET ATTRIBUTE CHAR_STRING '=' CHAR_STRING
    ;

drop_diskgroup_file_clause
    : DROP FILE filename (',' filename)*
    ;

convert_redundancy_clause
    : CONVERT REDUNDANCY TO FLEX
    ;

usergroup_clauses
    : ADD USERGROUP CHAR_STRING WITH MEMBER CHAR_STRING (',' CHAR_STRING)*
    | MODIFY USERGROUP CHAR_STRING (ADD | DROP) MEMBER CHAR_STRING (',' CHAR_STRING)*
    | DROP USERGROUP CHAR_STRING
    ;

user_clauses
    : ADD USER CHAR_STRING (',' CHAR_STRING)*
    | DROP USER CHAR_STRING (',' CHAR_STRING)* CASCADE?
    | REPLACE USER CHAR_STRING WITH CHAR_STRING (',' CHAR_STRING WITH CHAR_STRING)*
    ;

file_permissions_clause
    : SET PERMISSION (OWNER | GROUP | OTHER) '=' (NONE | READ (ONLY | WRITE)) (
        ',' (OWNER | GROUP | OTHER) '=' (NONE | READ (ONLY | WRITE))
    )* FOR FILE CHAR_STRING (',' CHAR_STRING)*
    ;

file_owner_clause
    : SET OWNERSHIP (OWNER | GROUP) '=' CHAR_STRING (',' (OWNER | GROUP) '=' CHAR_STRING)* FOR FILE CHAR_STRING (
        ',' CHAR_STRING
    )*
    ;

scrub_clause
    : SCRUB (FILE CHAR_STRING | DISK id_expression)? (REPAIR | NOREPAIR)? (
        POWER (AUTO | LOW | HIGH | MAX)
    )? wait_nowait? force_noforce? STOP?
    ;

quotagroup_clauses
    : ADD QUOTAGROUP id_expression (SET property_name '=' property_value)?
    | MODIFY QUOTAGROUP id_expression SET property_name '=' property_value
    | MOVE QUOTAGROUP id_expression TO id_expression
    | DROP QUOTAGROUP id_expression
    ;

property_name
    : id_expression
    ;

property_value
    : id_expression
    ;

filegroup_clauses
    : add_filegroup_clause
    | modify_filegroup_clause
    | move_to_filegroup_clause
    | drop_filegroup_clause
    ;

add_filegroup_clause
    : ADD FILEGROUP id_expression ((DATABASE | CLUSTER | VOLUME) id_expression | TEMPLATE) (
        FROM TEMPLATE id_expression
    )? (SET CHAR_STRING '=' CHAR_STRING)?
    ;

modify_filegroup_clause
    : MODIFY FILEGROUP id_expression SET CHAR_STRING '=' CHAR_STRING
    ;

move_to_filegroup_clause
    : MOVE FILE CHAR_STRING TO FILEGROUP id_expression
    ;

drop_filegroup_clause
    : DROP FILEGROUP id_expression CASCADE?
    ;

quorum_regular
    : QUORUM
    | REGULAR
    ;

undrop_disk_clause
    : UNDROP DISKS
    ;

diskgroup_availability
    : MOUNT (RESTRICTED | NORMAL)? (FORCE | NOFORCE)?
    | DISMOUNT (FORCE | NOFORCE)?
    ;

enable_disable_volume
    : (ENABLE | DISABLE) VOLUME (id_expression (',' id_expression)* | ALL)
    ;

// DDL -> SQL Statements for Stored PL/SQL Units

// Function DDLs

drop_function
    : DROP FUNCTION function_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-FLASHBACK-ARCHIVE.html
alter_flashback_archive
    : ALTER FLASHBACK ARCHIVE fa = id_expression (
        SET DEFAULT
        | (ADD | MODIFY) TABLESPACE ts = id_expression flashback_archive_quota?
        | REMOVE TABLESPACE rts = id_expression
        | MODIFY /*RETENTION*/ flashback_archive_retention // inconsistent documentation
        | PURGE (ALL | BEFORE (SCN expression | TIMESTAMP expression))
        | NO? OPTIMIZE DATA
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-HIERARCHY.html
alter_hierarchy
    : ALTER HIERARCHY (schema_name '.')? hn = id_expression (
        RENAME TO nhn = id_expression
        | COMPILE
    )
    ;

alter_function
    : ALTER FUNCTION function_name (
        EDITIONABLE
        | NONEDITIONABLE
        | COMPILE DEBUG? compiler_parameters_clause* (REUSE SETTINGS)?
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-JAVA.html
alter_java
    : ALTER JAVA (SOURCE | CLASS) (schema_name '.')? o = id_expression (
        RESOLVER '(' ('(' match_string ','? (schema_name | '-') ')')+ ')'
    )? (COMPILE | RESOLVE | invoker_rights_clause)
    ;

match_string
    : DELIMITED_ID
    | '*'
    ;

create_function_body
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? FUNCTION function_name (
        '(' parameter (',' parameter)* ')'
    )? RETURN type_spec (SHARING '=' (METADATA | NONE))? (
        invoker_rights_clause
        | accessible_by_clause
        | default_collation_clause
        | parallel_enable_clause
        | result_cache_clause
        | PIPELINED
        | DETERMINISTIC
    )* (
        ((IS | AS) (DECLARE? seq_of_declare_specs? body | call_spec))
        | aggregate_clause
        | pipelined_using_clause
        | sql_macro_body
    )
    ;

sql_macro_body
    : SQL_MACRO IS BEGIN RETURN quoted_string SEMICOLON END
    ;

// Creation Function - Specific Clauses

parallel_enable_clause
    : PARALLEL_ENABLE partition_by_clause?
    ;

partition_by_clause
    : '(' PARTITION expression BY (ANY | (HASH | RANGE | LIST) paren_column_list) streaming_clause? ')'
    ;

result_cache_clause
    : RESULT_CACHE relies_on_part? ('(' MODE (DEFAULT | FORCE ) ')')?
    ;

accessible_by_clause
    : ACCESSIBLE BY '(' accessor (',' accessor)* ')'
    ;

default_collation_clause
    : DEFAULT COLLATION USING_NLS_COMP
    ;

aggregate_clause
    : AGGREGATE USING implementation_type_name
    ;

pipelined_using_clause
    : PIPELINED ((ROW | TABLE) POLYMORPHIC)? USING implementation_type_name
    ;

accessor
    : unitKind = (FUNCTION | PROCEDURE | PACKAGE | TRIGGER | TYPE) function_name
    ;

relies_on_part
    : RELIES_ON '(' tableview_name (',' tableview_name)* ')'
    ;

streaming_clause
    : (ORDER | CLUSTER) expression BY paren_column_list
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-OUTLINE.html
alter_outline
    : ALTER OUTLINE (PUBLIC | PRIVATE)? o = id_expression outline_options+
    ;

outline_options
    : REBUILD
    | RENAME TO non = id_expression
    | CHANGE CATEGORY TO ncn = id_expression
    | ENABLE
    | DISABLE
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-LOCKDOWN-PROFILE.html
alter_lockdown_profile
    : ALTER LOCKDOWN PROFILE id_expression (
        lockdown_feature
        | lockdown_options
        | lockdown_statements
    ) (USERS '=' (ALL | COMMON | LOCAL))?
    ;

lockdown_feature
    : disable_enable FEATURE ('=' '(' string_list ')' | ALL (EXCEPT '=' '(' string_list ')')?)
    ;

lockdown_options
    : disable_enable OPTION ('=' '(' string_list ')' | ALL (EXCEPT '=' '(' string_list ')')?)
    ;

lockdown_statements
    : disable_enable STATEMENT (
        '=' '(' string_list ')'
        | '=' '(' CHAR_STRING ')' statement_clauses
        | ALL (EXCEPT '=' '(' string_list ')')?
    )
    ;

statement_clauses
    : CLAUSE (
        '=' '(' string_list ')'
        | '=' '(' CHAR_STRING ')' clause_options
        | ALL (EXCEPT '=' '(' string_list ')')?
    )
    ;

clause_options
    : OPTION (
        '=' '(' string_list ')'
        | '=' '(' CHAR_STRING ')' option_values+
        | ALL (EXCEPT '=' '(' string_list ')')?
    )
    ;

option_values
    : VALUE '=' '(' string_list ')'
    | (MINVALUE | MAXVALUE) '=' CHAR_STRING
    ;

string_list
    : CHAR_STRING (',' CHAR_STRING)*
    ;

disable_enable
    : DISABLE
    | ENABLE
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-LOCKDOWN-PROFILE.html
drop_lockdown_profile
    : DROP LOCKDOWN PROFILE p = id_expression
    ;

// Package DDLs

drop_package
    : DROP PACKAGE BODY? (schema_object_name '.')? package_name
    ;

alter_package
    : ALTER PACKAGE package_name COMPILE DEBUG? (PACKAGE | BODY | SPECIFICATION)? compiler_parameters_clause* (
        REUSE SETTINGS
    )?
    ;

create_package
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? PACKAGE (schema_object_name '.')? package_name invoker_rights_clause? (
        IS
        | AS
    ) package_obj_spec* END package_name?
    ;

create_package_body
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? PACKAGE BODY (schema_object_name '.')? package_name (
        IS
        | AS
    ) package_obj_body*? (BEGIN seq_of_statements (EXCEPTION exception_handler+)?)? END package_name?
    ;

// Create Package Specific Clauses

package_obj_spec
    : pragma_declaration
    | exception_declaration
    | procedure_spec
    | function_spec
    | variable_declaration
    | subtype_declaration
    | cursor_declaration
    | type_declaration
    ;

procedure_spec
    : PROCEDURE identifier ('(' parameter ( ',' parameter)* ')')? (
        accessible_by_clause
        | PARALLEL_ENABLE
        | DETERMINISTIC
    )* (AS call_spec)? ';'
    ;

function_spec
    : FUNCTION identifier ('(' parameter ( ',' parameter)* ')')? RETURN type_spec (
        DETERMINISTIC
        | PIPELINED
        | parallel_enable_clause
        | RESULT_CACHE
        | streaming_clause
    )* (AS call_spec)? ';'
    ;

package_obj_body
    : pragma_declaration
    | exception_declaration
    | procedure_spec
    | function_spec
    | subtype_declaration
    | cursor_declaration
    | variable_declaration
    | type_declaration
    | procedure_body
    | function_body
    | selection_directive
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/alter-pmem-filestore.html
alter_pmem_filestore
    : ALTER PMEM FILESTORE fsn = id_expression (
        RESIZE size_clause
        | autoextend_clause
        | MOUNT (MOUNTPOINT file_path)? (BACKINGFILE filename)? FORCE? //inconsistent documentation
        | DISMOUNT
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/drop-pmem-filestore.html
drop_pmem_filestore
    : DROP PMEM FILESTORE fsn = id_expression ((FORCE? INCLUDING | EXCLUDING) CONTENTS)?
    ;

// Procedure DDLs

drop_procedure
    : DROP PROCEDURE procedure_name
    ;

alter_procedure
    : ALTER PROCEDURE procedure_name COMPILE DEBUG? compiler_parameters_clause* (REUSE SETTINGS)?
    ;

function_body
    : FUNCTION identifier ('(' parameter (',' parameter)* ')')? RETURN type_spec (
        PIPELINED
        | DETERMINISTIC
        | invoker_rights_clause
        | parallel_enable_clause
        | result_cache_clause
        | streaming_clause
            // see example in section "How Table Functions Stream their Input Data" on streaming_clause in Oracle 9i: https://docs.oracle.com/cd/B10501_01/appdev.920/a96624/08_subs.htm#20554
    )* (
        ( (IS | AS) (DECLARE? seq_of_declare_specs? body | call_spec))
        | (PIPELINED | AGGREGATE) USING implementation_type_name
    ) ';'
    ;

procedure_body
    : PROCEDURE identifier ('(' parameter (',' parameter)* ')')? (
        accessible_by_clause
        | PARALLEL_ENABLE
        | DETERMINISTIC
    )* (IS | AS) (DECLARE? seq_of_declare_specs? body | call_spec | EXTERNAL) ';'
    ;

create_procedure_body
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? PROCEDURE procedure_name (
        '(' parameter (',' parameter)* ')'
    )? invoker_rights_clause? (PARALLEL_ENABLE | DETERMINISTIC)* (IS | AS) (
        DECLARE? seq_of_declare_specs? body
        | call_spec
        | EXTERNAL
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-RESOURCE-COST.html
alter_resource_cost
    : ALTER RESOURCE COST (
        (CPU_PER_SESSION | CONNECT_TIME | LOGICAL_READS_PER_SESSION | PRIVATE_SGA) UNSIGNED_INTEGER
    )+
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-OUTLINE.html
drop_outline
    : DROP OUTLINE o = id_expression
    ;

// Rollback Segment DDLs

//https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_2011.htm#SQLRF00816
alter_rollback_segment
    : ALTER ROLLBACK SEGMENT rollback_segment_name (
        ONLINE
        | OFFLINE
        | storage_clause
        | SHRINK (TO size_clause)?
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-RESTORE-POINT.html
drop_restore_point
    : DROP RESTORE POINT rp = id_expression (FOR PLUGGABLE DATABASE pdb = id_expression)?
    ;

drop_rollback_segment
    : DROP ROLLBACK SEGMENT rollback_segment_name
    ;

drop_role
    : DROP ROLE role_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/create-pmem-filestore.html
create_pmem_filestore
    : CREATE PMEM FILESTORE fsn = id_expression pmem_filestore_options+
    ;

pmem_filestore_options
    : MOUNTPOINT file_path
    | BACKINGFILE filename REUSE?
    | (SIZE | BLOCKSIZE) size_clause
    | autoextend_clause
    ;

file_path
    : CHAR_STRING
    ;

create_rollback_segment
    : CREATE PUBLIC? ROLLBACK SEGMENT rollback_segment_name (
        TABLESPACE tablespace
        | storage_clause
    )*
    ;

// Trigger DDLs

drop_trigger
    : DROP TRIGGER trigger_name
    ;

alter_trigger
    : ALTER TRIGGER alter_trigger_name = trigger_name (
        (ENABLE | DISABLE)
        | RENAME TO rename_trigger_name = trigger_name
        | COMPILE DEBUG? compiler_parameters_clause* (REUSE SETTINGS)?
    )
    ;

create_trigger
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? TRIGGER trigger_name (
        simple_dml_trigger
        | compound_dml_trigger
        | non_dml_trigger
    ) trigger_follows_clause? (ENABLE | DISABLE)? trigger_when_clause? trigger_body
    ;

trigger_follows_clause
    : FOLLOWS trigger_name (',' trigger_name)*
    ;

trigger_when_clause
    : WHEN '(' condition ')'
    ;

// Create Trigger Specific Clauses

simple_dml_trigger
    : (BEFORE | AFTER | INSTEAD OF) dml_event_clause referencing_clause? for_each_row?
    ;

for_each_row
    : FOR EACH ROW
    ;

compound_dml_trigger
    : FOR dml_event_clause referencing_clause?
    ;

non_dml_trigger
    : (BEFORE | AFTER) non_dml_event (OR non_dml_event)* ON (DATABASE | (schema_name '.')? SCHEMA)
    ;

trigger_body
    : compound_trigger_block
    | CALL identifier
    | trigger_block
    ;

compound_trigger_block
    : COMPOUND TRIGGER seq_of_declare_specs? timing_point_section+ END trigger_name?
    ;

timing_point_section
    : bk = BEFORE STATEMENT IS tps_block BEFORE STATEMENT ';'
    | bk = BEFORE EACH ROW IS tps_block BEFORE EACH ROW ';'
    | ak = AFTER STATEMENT IS tps_block AFTER STATEMENT ';'
    | ak = AFTER EACH ROW IS tps_block AFTER EACH ROW ';'
    ;

non_dml_event
    : ALTER
    | ANALYZE
    | ASSOCIATE STATISTICS
    | AUDIT
    | COMMENT
    | CREATE
    | DISASSOCIATE STATISTICS
    | DROP
    | GRANT
    | NOAUDIT
    | RENAME
    | REVOKE
    | TRUNCATE
    | DDL
    | STARTUP
    | SHUTDOWN
    | DB_ROLE_CHANGE
    | LOGON
    | LOGOFF
    | SERVERERROR
    | SUSPEND
    | DATABASE
    | SCHEMA
    | FOLLOWS
    ;

dml_event_clause
    : dml_event_element (OR dml_event_element)* ON dml_event_nested_clause? tableview_name
    ;

dml_event_element
    : (DELETE | INSERT | UPDATE) (OF column_list)?
    ;

dml_event_nested_clause
    : NESTED TABLE tableview_name OF
    ;

referencing_clause
    : (REFERENCING referencing_element | REFERENCES) referencing_element*
    ;

referencing_element
    : (NEW | OLD | PARENT) column_alias
    ;

// DDLs

drop_type
    : DROP TYPE BODY? type_name (FORCE | VALIDATE)?
    ;

alter_type
    : ALTER TYPE type_name (
        compile_type_clause
        | replace_type_clause
        | alter_method_spec
        | alter_attribute_definition
        | alter_collection_clauses
        | modifier_clause
        | overriding_subprogram_spec
    ) dependent_handling_clause?
    ;

// Alter Type Specific Clauses

compile_type_clause
    : COMPILE DEBUG? (SPECIFICATION | BODY)? compiler_parameters_clause* (REUSE SETTINGS)?
    ;

replace_type_clause
    : REPLACE invoker_rights_clause? AS OBJECT '(' object_member_spec (',' object_member_spec)* ')'
    ;

alter_method_spec
    : alter_method_element (',' alter_method_element)*
    ;

alter_method_element
    : (ADD | DROP) (map_order_function_spec | subprogram_spec)
    ;

alter_attribute_definition
    : (ADD | MODIFY) ATTRIBUTE (identifier type_spec? | '(' identifier type_spec (',' identifier type_spec)* ')')
    | DROP ATTRIBUTE (identifier | '(' identifier (',' identifier)* ')')
    ;

alter_collection_clauses
    : MODIFY (LIMIT expression | ELEMENT TYPE type_spec)
    ;

dependent_handling_clause
    : INVALIDATE
    | CASCADE (CONVERT TO SUBSTITUTABLE | NOT? INCLUDING TABLE DATA)? dependent_exceptions_part?
    ;

dependent_exceptions_part
    : FORCE? EXCEPTIONS INTO tableview_name
    ;

create_type
    : create_type_spec | create_type_body
    ;

// Type spec (SQL, no END) — semicolon optional, solidus valid as terminator
create_type_spec
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? TYPE type_definition
    ;

// Type body (PL/SQL, has END) — requires semicolon, solidus optional after
create_type_body
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? TYPE type_body
    ;

// Create Type Specific Clauses

type_definition
    : type_name (OID CHAR_STRING)? FORCE? object_type_def?
    ;

object_type_def
    : invoker_rights_clause? (object_as_part | object_under_part) sqlj_object_type? (
        '(' object_member_spec (',' object_member_spec)* ')'
    )? modifier_clause*
    ;

object_as_part
    : (IS | AS) (OBJECT | varray_type_def | nested_table_type_def)
    ;

object_under_part
    : UNDER type_spec
    ;

nested_table_type_def
    : TABLE OF type_spec (NOT NULL_)?
    ;

sqlj_object_type
    : EXTERNAL NAME expression LANGUAGE JAVA USING (SQLDATA | CUSTOMDATUM | ORADATA)
    ;

type_body
    : BODY type_name (IS | AS) (type_body_elements)+ END
    ;

type_body_elements
    : map_order_func_declaration
    | subprog_decl_in_type
    | overriding_subprogram_spec
    ;

map_order_func_declaration
    : (MAP | ORDER) MEMBER func_decl_in_type
    ;

subprog_decl_in_type
    : (MEMBER | STATIC)? (proc_decl_in_type | func_decl_in_type | constructor_declaration)
    ;

proc_decl_in_type
    : PROCEDURE procedure_name
        (
            '(' type_elements_parameter (',' type_elements_parameter)* ')'
        )?
        (IS | AS) (call_spec | DECLARE? seq_of_declare_specs? body ';')
    ;

func_decl_in_type
    : FUNCTION function_name ('(' type_elements_parameter (',' type_elements_parameter)* ')')? RETURN type_spec (
        IS
        | AS
    ) (call_spec | DECLARE? seq_of_declare_specs? body ';')
    ;

constructor_declaration
    : FINAL? INSTANTIABLE? CONSTRUCTOR FUNCTION function_name
        (
            '(' (SELF IN OUT type_spec ',')? (type_elements_parameter (',' type_elements_parameter)*)? ')'
        )?
      RETURN SELF AS RESULT (IS | AS) (call_spec | DECLARE? seq_of_declare_specs? body ';')
    ;

// Common Type Clauses

modifier_clause
    : NOT? (INSTANTIABLE | FINAL | OVERRIDING)
    ;

object_member_spec
    : identifier type_spec sqlj_object_type_attr?
    | element_spec
    ;

sqlj_object_type_attr
    : EXTERNAL NAME expression
    ;

element_spec
    : modifier_clause? element_spec_options+ (',' pragma_clause)?
    ;

element_spec_options
    : subprogram_spec
    | constructor_spec
    | map_order_function_spec
    ;

subprogram_spec
    : (MEMBER | STATIC) (type_procedure_spec | type_function_spec)
    ;

// TODO: should be refactored such as Procedure body and Function body, maybe Type_Function_Body and overriding_function_body
overriding_subprogram_spec
    : OVERRIDING MEMBER overriding_function_spec
    | OVERRIDING MEMBER overriding_procedure_spec
    ;

overriding_function_spec
    : FUNCTION function_name ('(' type_elements_parameter (',' type_elements_parameter)* ')')? RETURN (
        type_spec
        | SELF AS RESULT
    ) (PIPELINED? (IS | AS) (DECLARE? seq_of_declare_specs? body))? ';'?
    ;

overriding_procedure_spec
    : PROCEDURE procedure_name
        (
            '(' type_elements_parameter (',' type_elements_parameter)* ')'
        )?
        (IS | AS) (call_spec | DECLARE? seq_of_declare_specs? body ';')
    ;

type_procedure_spec
    : PROCEDURE procedure_name ('(' type_elements_parameter (',' type_elements_parameter)* ')')? (
        (IS | AS) call_spec
    )?
    ;

type_function_spec
    : FUNCTION function_name ('(' type_elements_parameter (',' type_elements_parameter)* ')')? RETURN (
        type_spec
        | SELF AS RESULT
    ) ((IS | AS) call_spec | EXTERNAL VARIABLE? NAME expression)?
    ;

constructor_spec
    : FINAL? INSTANTIABLE? CONSTRUCTOR FUNCTION type_spec (
        '(' (SELF IN OUT type_spec ',')? (type_elements_parameter (',' type_elements_parameter)*)? ')'
    )? RETURN SELF AS RESULT ((IS | AS) call_spec)?
    ;

map_order_function_spec
    : (MAP | ORDER) MEMBER type_function_spec
    ;

pragma_clause
    : PRAGMA RESTRICT_REFERENCES '(' pragma_elements (',' pragma_elements)* ')'
    ;

pragma_elements
    : identifier
    | DEFAULT
    ;

type_elements_parameter
    : parameter_name (IN OUT NOCOPY | IN OUT | OUT NOCOPY | OUT | IN)? type_spec (ASSIGN_OP constant)?
    ;

// Sequence DDLs

drop_sequence
    : DROP SEQUENCE sequence_name
    ;

alter_sequence
    : ALTER SEQUENCE sequence_name sequence_spec+
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-SESSION.html
alter_session
    : ALTER SESSION (
        ADVISE ( COMMIT | ROLLBACK | NOTHING)
        | CLOSE DATABASE LINK parameter_name
        | enable_or_disable COMMIT IN PROCEDURE
        | enable_or_disable GUARD
        | (enable_or_disable | FORCE) PARALLEL (DML | DDL | QUERY) (
            PARALLEL (literal | parameter_name)
        )?
        | SET alter_session_set_clause
    )
    ;

alter_session_set_clause
    : (parameter_name '=' parameter_value)+
    | EDITION '=' en = id_expression
    | CONTAINER '=' cn = id_expression (SERVICE '=' sn = id_expression)?
    | ROW ARCHIVAL VISIBILITY '=' (ACTIVE | ALL)
    | DEFAULT_COLLATION '=' (c = id_expression | NONE)
    ;

create_sequence
    : CREATE SEQUENCE (IF NOT EXISTS)? sequence_name sequence_spec* (SHARING '=' (METADATA | DATA | NONE))?
    ;

// Common Sequence

sequence_spec
    : INCREMENT BY UNSIGNED_INTEGER
    | sequence_start_clause
    | MAXVALUE UNSIGNED_INTEGER
    | NOMAXVALUE
    | MINVALUE UNSIGNED_INTEGER
    | NOMINVALUE
    | CYCLE
    | NOCYCLE
    | CACHE UNSIGNED_INTEGER
    | NOCACHE
    | ORDER
    | NOORDER
    | KEEP
    | NOKEEP
    | SCALE (EXTEND | NOEXTEND)?
    | NOSCALE
    | SHARD (EXTEND | NOEXTEND)?
    | NOSHARD
    | SESSION
    | GLOBAL
    ;

sequence_start_clause
    : START WITH (UNSIGNED_INTEGER | APPROXIMATE_NUM_LIT)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-ANALYTIC-VIEW.html
create_analytic_view
    : CREATE (OR REPLACE)? (NOFORCE | FORCE)? ANALYTIC VIEW av = id_expression (
        SHARING '=' (METADATA | NONE)
    )? classification_clause* cav_using_clause? dim_by_clause? measures_clause? default_measure_clause? default_aggregate_clause? cache_clause?
        fact_columns_clause? qry_transform_clause?
    ;

classification_clause
    // : (CAPTION c=quoted_string)? (DESCRIPTION d=quoted_string)? classification_item*
    // to handle - 'rule contains a closure with at least one alternative that can match an empty string'
    : (caption_clause description_clause? | caption_clause? description_clause) classification_item*
    | caption_clause? description_clause? classification_item+
    ;

caption_clause
    : CAPTION c = quoted_string
    ;

description_clause
    : DESCRIPTION d = quoted_string
    ;

classification_item
    : CLASSIFICATION cn = id_expression (VALUE cv = quoted_string)? (LANGUAGE language)?
    ;

language
    : NULL_
    | nls = id_expression
    ;

cav_using_clause
    : USING (schema_name '.')? t = id_expression REMOTE? (AS? ta = id_expression)?
    ;

dim_by_clause
    : DIMENSION BY '(' dim_key (',' dim_key)* ')'
    ;

dim_key
    : dim_ref classification_clause* KEY (
        '(' (a += id_expression '.')? f += column_name (',' (a += id_expression '.')? f += column_name)* ')'
        | (a += id_expression '.')? f += column_name
    ) REFERENCES DISTINCT? ('(' attribute_name (',' attribute_name)* ')' | attribute_name) HIERARCHIES '(' hier_ref (
        ',' hier_ref
    )* ')'
    ;

dim_ref
    : (schema_name '.')? ad = id_expression (AS? da = id_expression)?
    ;

hier_ref
    : (schema_name '.')? h = id_expression (AS? ha = id_expression)? DEFAULT?
    ;

measures_clause
    : MEASURES '(' av_measure (',' av_measure)* ')'
    ;

av_measure
    : mn = id_expression (base_meas_clause | calc_meas_clause)? //classification_clause*
    ;

base_meas_clause
    : FACT /*FOR MEASURE*/ bm = id_expression meas_aggregate_clause? //FIXME inconsistent documentation
    ;

meas_aggregate_clause
    : AGGREGATE BY aggregate_function_name
    ;

calc_meas_clause
    : /*m=id_expression*/ AS '(' expression ')' //FIXME inconsistent documentation
    ;

default_measure_clause
    : DEFAULT MEASURE m = id_expression
    ;

default_aggregate_clause
    : DEFAULT AGGREGATE BY aggregate_function_name
    ;

cache_clause
    : CACHE cache_specification (',' cache_specification)*
    ;

cache_specification
    : MEASURE GROUP (
        ALL
        | '(' id_expression (',' id_expression)* ')' levels_clause (',' levels_clause)*
    )
    ;

levels_clause
    : LEVELS '(' level_specification (',' level_specification)* ')' level_group_type
    ;

level_specification
    : '(' ((d = id_expression '.')? h = id_expression '.')? l = id_expression ')'
    ;

level_group_type
    : DYNAMIC
    | MATERIALIZED (USING (schema_name '.')? t = id_expression)?
    ;

fact_columns_clause
    : FACT COLUMN f = column_name (AS? fa = id_expression (',' AS? fa = id_expression)*)?
    ;

qry_transform_clause
    : ENABLE QUERY TRANSFORM (RELY | NORELY)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-ATTRIBUTE-DIMENSION.html
create_attribute_dimension
    : CREATE (OR REPLACE)? (NOFORCE | FORCE)? ATTRIBUTE DIMENSION (schema_name '.')? ad = id_expression (
        SHARING '=' (METADATA | NONE)
    )? classification_clause* (DIMENSION TYPE (STANDARD | TIME))? ad_using_clause attributes_clause ad_level_clause+ all_clause?
    ;

ad_using_clause
    : USING source_clause (',' source_clause)* join_path_clause*
    ;

source_clause
    : (schema_name '.')? ftov = id_expression REMOTE? (AS? a = id_expression)?
    ;

join_path_clause
    : JOIN PATH jpn = id_expression ON join_condition
    ;

join_condition
    : join_condition_item (AND join_condition_item)*
    ;

join_condition_item
    : (a = id_expression '.')? column_name '=' (b = id_expression '.')? column_name
    ;

attributes_clause
    : ATTRIBUTES '(' ad_attributes_clause (',' ad_attributes_clause)* ')'
    ;

ad_attributes_clause
    : (a = id_expression '.')? column_name (AS? an = id_expression)? classification_clause*
    ;

ad_level_clause
    : LEVEL l = id_expression (NOT NULL_ | SKIP_ WHEN NULL_)? (
        LEVEL TYPE (
            STANDARD
            | YEARS
            | HALF_YEARS
            | QUARTERS
            | MONTHS
            | WEEKS
            | DAYS
            | HOURS
            | MINUTES
            | SECONDS
        )
    )? classification_clause* //inconsistent documentation - LEVEL TYPE goes after the classification_clause rule
    key_clause alternate_key_clause? (MEMBER NAME expression)? (MEMBER CAPTION expression)? (
        MEMBER DESCRIPTION expression
    )? (ORDER BY (MIN | MAX)? dim_order_clause (',' (MIN | MAX)? dim_order_clause)*)? (
        DETERMINES '(' id_expression (',' id_expression)* ')'
    )?
    ;

key_clause
    : KEY (a = id_expression | '(' id_expression (',' id_expression)* ')')
    ;

alternate_key_clause
    : ALTERNATE key_clause
    ;

dim_order_clause
    : a = id_expression (ASC | DESC)? (NULLS (FIRST | LAST))?
    ;

all_clause
    : ALL MEMBER (
        NAME expression (MEMBER CAPTION expression)?
        | CAPTION expression (MEMBER DESCRIPTION expression)?
        | DESCRIPTION expression
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-AUDIT-POLICY-Unified-Auditing.html
create_audit_policy
    : CREATE AUDIT POLICY p = id_expression privilege_audit_clause? action_audit_clause? role_audit_clause? (
        WHEN quoted_string EVALUATE PER (STATEMENT | SESSION | INSTANCE)
    )? (ONLY TOPLEVEL)? container_clause?
    ;

privilege_audit_clause
    : PRIVILEGES system_privilege (',' system_privilege)*
    ;

action_audit_clause
    : (standard_actions | component_actions | system_actions)+
    ;

system_actions
    : ACTIONS system_privilege (',' system_privilege)*
    ;

standard_actions
    : ACTIONS actions_clause (',' actions_clause)*
    ;

actions_clause
    : (object_action | ALL) ON (
        DIRECTORY directory_name
        | (MINING MODEL)? (schema_name '.')? id_expression
    )
    | (system_action | ALL)
    ;

object_action
    : ALTER
    | GRANT
    | READ
    | EXECUTE
    | AUDIT
    | COMMENT
    | DELETE
    | INDEX
    | INSERT
    | LOCK
    | SELECT
    | UPDATE
    | FLASHBACK
    | RENAME
    ;

system_action
    : id_expression // SELECT name FROM AUDITABLE_SYSTEM_ACTIONS WHERE component = 'Standard';
    | (CREATE | ALTER | DROP) JAVA
    | LOCK TABLE
    | (READ | WRITE | EXECUTE) DIRECTORY
    ;

component_actions
    : ACTIONS COMPONENT '=' (
        (DATAPUMP | DIRECT_LOAD | OLS | XS) component_action (',' component_action)*
        | DV component_action ON id_expression (',' component_action ON id_expression)*
        | PROTOCOL (FTP | HTTP | AUTHENTICATION)
    )
    ;

component_action
    : id_expression // SELECT name FROM auditable_system_actions WHERE component = 'Datapump';
    ;

role_audit_clause
    : ROLES role_name (',' role_name)*
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-CONTROLFILE.html
create_controlfile
    : CREATE CONTROLFILE REUSE? SET? DATABASE d = id_expression logfile_clause? (
        RESETLOGS
        | NORESETLOGS
    ) (DATAFILE file_specification (',' file_specification)*)? controlfile_options* character_set_clause?
    ;

controlfile_options
    : MAXLOGFILES numeric
    | MAXLOGMEMBERS numeric
    | MAXLOGHISTORY numeric
    | MAXDATAFILES numeric
    | MAXINSTANCES numeric
    | ARCHIVELOG
    | NOARCHIVELOG
    | FORCE LOGGING
    | SET STANDBY NOLOGGING FOR (DATA AVAILABILITY | LOAD PERFORMANCE)
    ;

logfile_clause
    : LOGFILE (GROUP? numeric)? file_specification (',' (GROUP? numeric)? file_specification)*
    ;

character_set_clause
    : CHARACTER SET cs = id_expression
    ;

file_specification
    : datafile_tempfile_spec
    | redo_log_file_spec
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-DISKGROUP.html
create_diskgroup
    : CREATE DISKGROUP id_expression (
        (HIGH | NORMAL | FLEX | EXTENDED (SITE sn = id_expression)? | EXTERNAL) REDUNDANCY
    )? (
        quorum_regular? (FAILGROUP fg = id_expression)? DISK qualified_disk_clause (
            ',' qualified_disk_clause
        )*
    )+ (ATTRIBUTE an = CHAR_STRING '=' av = CHAR_STRING (',' CHAR_STRING '=' CHAR_STRING)*)?
    ;

qualified_disk_clause
    : ss = CHAR_STRING (NAME dn = id_expression)? (SIZE size_clause)? force_noforce?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-EDITION.html
create_edition
    : CREATE EDITION e = id_expression (AS CHILD OF pe = id_expression)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-FLASHBACK-ARCHIVE.html
create_flashback_archive
    : CREATE FLASHBACK ARCHIVE DEFAULT? fa = id_expression TABLESPACE ts = id_expression flashback_archive_quota? (
        NO? OPTIMIZE DATA
    )? flashback_archive_retention
    ;

flashback_archive_quota
    : QUOTA UNSIGNED_INTEGER (M_LETTER | G_LETTER | T_LETTER | P_LETTER | E_LETTER)
    ;

flashback_archive_retention
    : RETENTION UNSIGNED_INTEGER (YEAR | MONTH | DAY)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-HIERARCHY.html
create_hierarchy
    : CREATE (OR REPLACE)? (NO? FORCE)? HIERARCHY (schema_name '.')? h = id_expression (
        SHARING '=' (METADATA | NONE)
    )? classification_clause* hier_using_clause level_hier_clause hier_attrs_clause?
    ;

hier_using_clause
    : USING (schema_name '.')? ad = id_expression
    ;

level_hier_clause
    : '(' (l = id_expression (CHILD OF)?)+ ')'
    ;

hier_attrs_clause
    : HIERARCHICAL ATTRIBUTES '(' hier_attr_clause ')'
    ;

hier_attr_clause
    : hier_attr_name classification_clause*
    ;

hier_attr_name
    : MEMBER_NAME
    | MEMBER_UNIQUE_NAME
    | MEMBER_CAPTION
    | MEMBER_DESCRIPTION
    | LEVEL_NAME
    | HIER_ORDER
    | DEPTH
    | IS_LEAF
    | PARENT_LEVEL_NAME
    | PARENT_UNIQUE_NAME
    ;

create_index
    : CREATE (UNIQUE | BITMAP)? INDEX index_name (IF NOT EXISTS)? ON (
        cluster_index_clause
        | table_index_clause
        | bitmap_join_index_clause
    ) (USABLE | UNUSABLE)? ((DEFERRED | IMMEDIATE) INVALIDATION)?
    ;

cluster_index_clause
    : CLUSTER cluster_name index_attributes?
    ;

cluster_name
    : (id_expression '.')? id_expression
    ;

table_index_clause
    : tableview_name table_alias? '(' index_expr (ASC | DESC)? (',' index_expr (ASC | DESC)?)* ')' index_properties?
    ;

bitmap_join_index_clause
    : tableview_name '(' (tableview_name | table_alias)? column_name (ASC | DESC)? (
        ',' (tableview_name | table_alias)? column_name (ASC | DESC)?
    )* ')' FROM tableview_name table_alias (',' tableview_name table_alias)* where_clause local_partitioned_index? index_attributes?
    ;

index_expr
    : column_name
    | expression
    ;

index_properties
    : (
        (global_partitioned_index | local_partitioned_index | index_attributes)+
        | INDEXTYPE IS (domain_index_clause | xmlindex_clause)
    )?
    ;

domain_index_clause
    : indextype local_domain_index_clause? parallel_clause? (PARAMETERS '(' odci_parameters ')')?
    ;

local_domain_index_clause
    : LOCAL (
        '(' PARTITION partition_name (PARAMETERS '(' odci_parameters ')')? (
            ',' PARTITION partition_name (PARAMETERS '(' odci_parameters ')')?
        )* ')'
    )?
    ;

xmlindex_clause
    : (XDB '.')? XMLINDEX local_xmlindex_clause? parallel_clause? //TODO xmlindex_parameters_clause?
    ;

local_xmlindex_clause
    : LOCAL (
        '(' PARTITION partition_name (
            ',' PARTITION partition_name //TODO xmlindex_parameters_clause?
        )* ')'
    )?
    ;

global_partitioned_index
    : GLOBAL PARTITION BY (
        RANGE '(' column_name (',' column_name)* ')' '(' index_partitioning_clause (
            ',' index_partitioning_clause
        )* ')'
        | HASH '(' column_name (',' column_name)* ')' (
            individual_hash_partitions
            | hash_partitions_by_quantity
        )
    )
    ;

index_partitioning_clause
    : PARTITION partition_name? VALUES LESS THAN '(' index_partitioning_values_list ')' segment_attributes_clause?
    ;

index_partitioning_values_list
    : literal (',' literal)*
    | TIMESTAMP literal (',' TIMESTAMP literal)*
    ;

local_partitioned_index
    : LOCAL (
        on_range_partitioned_table
        | on_list_partitioned_table
        | on_hash_partitioned_table
        | on_comp_partitioned_table
    )?
    ;

on_range_partitioned_table
    : '(' partitioned_table (',' partitioned_table)* ')'
    ;

on_list_partitioned_table
    : '(' partitioned_table (',' partitioned_table)* ')'
    ;

partitioned_table
    : PARTITION partition_name? (segment_attributes_clause | key_compression)* UNUSABLE?
    ;

on_hash_partitioned_table
    : STORE IN '(' tablespace (',' tablespace)* ')'
    | '(' on_hash_partitioned_clause (',' on_hash_partitioned_clause)* ')'
    ;

on_hash_partitioned_clause
    : PARTITION partition_name? (TABLESPACE tablespace)? key_compression? UNUSABLE?
    ;

on_comp_partitioned_table
    : (STORE IN '(' tablespace (',' tablespace)* ')')? '(' on_comp_partitioned_clause (
        ',' on_comp_partitioned_clause
    )* ')'
    ;

on_comp_partitioned_clause
    : PARTITION partition_name? (segment_attributes_clause | key_compression)* UNUSABLE? index_subpartition_clause?
    ;

index_subpartition_clause
    : STORE IN '(' tablespace (',' tablespace)* ')'
    | '(' index_subpartition_subclause (',' index_subpartition_subclause)* ')'
    ;

index_subpartition_subclause
    : SUBPARTITION subpartition_name? (TABLESPACE tablespace)? key_compression? UNUSABLE?
    ;

odci_parameters
    : CHAR_STRING
    ;

indextype
    : (id_expression '.')? id_expression
    ;

//https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_1010.htm#SQLRF00805
alter_index
    : ALTER INDEX index_name (alter_index_ops_set1 | alter_index_ops_set2)
    ;

alter_index_ops_set1
    : (
        deallocate_unused_clause
        | allocate_extent_clause
        | shrink_clause
        | parallel_clause
        | physical_attributes_clause
        | logging_clause
    )+
    ;

alter_index_ops_set2
    : rebuild_clause
    | PARAMETERS '(' odci_parameters ')'
    | COMPILE
    | enable_or_disable
    | UNUSABLE
    | visible_or_invisible
    | RENAME TO new_index_name
    | COALESCE
    | monitoring_nomonitoring USAGE
    | UPDATE BLOCK REFERENCES
    | alter_index_partitioning
    ;

visible_or_invisible
    : VISIBLE
    | INVISIBLE
    ;

monitoring_nomonitoring
    : MONITORING
    | NOMONITORING
    ;

rebuild_clause
    : REBUILD (PARTITION partition_name | SUBPARTITION subpartition_name | REVERSE | NOREVERSE)? (
        parallel_clause
        | TABLESPACE tablespace
        | PARAMETERS '(' odci_parameters ')'
        //TODO        | xmlindex_parameters_clause
        | ONLINE
        | physical_attributes_clause
        | key_compression
        | logging_clause
    )*
    ;

alter_index_partitioning
    : modify_index_default_attrs
    | add_hash_index_partition
    | modify_index_partition
    | rename_index_partition
    | drop_index_partition
    | split_index_partition
    | coalesce_index_partition
    | modify_index_subpartition
    ;

modify_index_default_attrs
    : MODIFY DEFAULT ATTRIBUTES (FOR PARTITION partition_name)? (
        physical_attributes_clause
        | TABLESPACE (tablespace | DEFAULT)
        | logging_clause
    )
    ;

add_hash_index_partition
    : ADD PARTITION partition_name? (TABLESPACE tablespace)? key_compression? parallel_clause?
    ;

coalesce_index_partition
    : COALESCE PARTITION parallel_clause?
    ;

modify_index_partition
    : MODIFY PARTITION partition_name (
        modify_index_partitions_ops+
        | PARAMETERS '(' odci_parameters ')'
        | COALESCE
        | UPDATE BLOCK REFERENCES
        | UNUSABLE
    )
    ;

modify_index_partitions_ops
    : deallocate_unused_clause
    | allocate_extent_clause
    | physical_attributes_clause
    | logging_clause
    | key_compression
    | shrink_clause
    ;

rename_index_partition
    : RENAME (PARTITION partition_name | SUBPARTITION subpartition_name) TO new_partition_name
    ;

drop_index_partition
    : DROP PARTITION partition_name
    ;

split_index_partition
    : SPLIT PARTITION partition_name_old AT '(' literal (',' literal)* ')' (
        INTO '(' index_partition_description ',' index_partition_description ')'
    )? parallel_clause?
    ;

index_partition_description
    : PARTITION (
        partition_name (
            (segment_attributes_clause | key_compression)+
            | PARAMETERS '(' odci_parameters ')'
        ) UNUSABLE?
    )?
    ;

modify_index_subpartition
    : MODIFY SUBPARTITION subpartition_name (UNUSABLE | modify_index_partitions_ops)
    ;

partition_name_old
    : partition_name
    ;

new_partition_name
    : partition_name
    ;

new_index_name
    : index_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-INMEMORY-JOIN-GROUP.html
alter_inmemory_join_group
    : ALTER INMEMORY JOIN GROUP (schema_name '.')? jg = id_expression (ADD | REMOVE) '(' (
        schema_name '.'
    )? t = id_expression '(' c = id_expression ')' ')'
    ;

create_user
    : CREATE USER user_object_name (IF NOT EXISTS)? (
        identified_by
        | identified_other_clause
        | user_tablespace_clause
        | quota_clause
        | profile_clause
        | password_expire_clause
        | user_lock_clause
        | user_editions_clause
        | container_clause
    )+
    ;

// The standard clauses only permit one user per statement.
// The proxy clause allows multiple users for a proxy designation.
alter_user
    : ALTER USER user_object_name (
        alter_identified_by
        | identified_other_clause
        | user_tablespace_clause
        | quota_clause
        | profile_clause
        | user_default_role_clause
        | password_expire_clause
        | user_lock_clause
        | alter_user_editions_clause
        | container_clause
        | container_data_clause
    )+
    | user_object_name (',' user_object_name)* proxy_clause
    ;

drop_user
    : DROP USER user_object_name (IF EXISTS)? CASCADE?
    ;

alter_identified_by
    : identified_by (REPLACE id_expression)?
    ;

identified_by
    : IDENTIFIED BY id_expression
    ;

identified_other_clause
    : IDENTIFIED (EXTERNALLY | GLOBALLY) (AS quoted_string)?
    ;

user_tablespace_clause
    : (DEFAULT | TEMPORARY) TABLESPACE id_expression
    ;

quota_clause
    : QUOTA (size_clause | UNLIMITED) ON id_expression
    ;

profile_clause
    : PROFILE id_expression
    ;

role_clause
    : role_name (',' role_name)*
    | ALL (EXCEPT role_name (',' role_name)*)*
    ;

user_default_role_clause
    : DEFAULT ROLE (NONE | role_clause)
    ;

password_expire_clause
    : PASSWORD EXPIRE
    ;

user_lock_clause
    : ACCOUNT (LOCK | UNLOCK)
    ;

user_editions_clause
    : ENABLE EDITIONS
    ;

alter_user_editions_clause
    : user_editions_clause (FOR regular_id (',' regular_id)*)? FORCE?
    ;

proxy_clause
    : REVOKE CONNECT THROUGH (ENTERPRISE USERS | user_object_name)
    | GRANT CONNECT THROUGH (
        ENTERPRISE USERS
        | user_object_name (WITH (NO ROLES | ROLE role_clause))? (AUTHENTICATION REQUIRED)? (
            AUTHENTICATED USING (PASSWORD | CERTIFICATE | DISTINGUISHED NAME)
        )?
    )
    ;

container_names
    : LEFT_PAREN id_expression (',' id_expression)* RIGHT_PAREN
    ;

set_container_data
    : SET CONTAINER_DATA EQUALS_OP (ALL | DEFAULT | container_names)
    ;

add_rem_container_data
    : (ADD | REMOVE) CONTAINER_DATA EQUALS_OP container_names
    ;

container_data_clause
    : set_container_data
    | add_rem_container_data (FOR container_tableview_name)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ADMINISTER-KEY-MANAGEMENT.html
administer_key_management
    : ADMINISTER KEY MANAGEMENT (
        keystore_management_clauses
        | key_management_clauses
        | secret_management_clauses
        | zero_downtime_software_patching_clauses
    )
    ;

keystore_management_clauses
    : create_keystore
    | open_keystore
    | close_keystore
    | backup_keystore
    | alter_keystore_password
    | merge_into_new_keystore
    | merge_into_existing_keystore
    | isolate_keystore
    | unite_keystore
    ;

create_keystore
    : CREATE (
        KEYSTORE ksl = CHAR_STRING
        | LOCAL? AUTO_LOGIN KEYSTORE FROM KEYSTORE ksl = CHAR_STRING
    ) IDENTIFIED BY keystore_password
    ;

open_keystore
    : SET KEYSTORE OPEN force_keystore? identified_by_store container_clause?
    ;

force_keystore
    : FORCE KEYSTORE
    ;

close_keystore
    : SET KEYSTORE CLOSE identified_by_store? container_clause?
    ;

backup_keystore
    : BACKUP KEYSTORE (USING bi = CHAR_STRING)? force_keystore? identified_by_store (
        TO ksl = CHAR_STRING
    )?
    ;

alter_keystore_password
    : ALTER KEYSTORE PASSWORD force_keystore? IDENTIFIED BY o = keystore_password SET n = keystore_password with_backup_clause?
    ;

merge_into_new_keystore
    : MERGE KEYSTORE ksl1 = CHAR_STRING identified_by_password_clause? AND KEYSTORE ksl2 = CHAR_STRING identified_by_password_clause? INTO NEW
        KEYSTORE ksl2 = CHAR_STRING identified_by_password_clause
    ;

merge_into_existing_keystore
    : MERGE KEYSTORE ksl1 = CHAR_STRING identified_by_password_clause? INTO EXISTING KEYSTORE ksl2 = CHAR_STRING identified_by_password_clause
        with_backup_clause?
    ;

isolate_keystore
    : FORCE? ISOLATE KEYSTORE IDENTIFIED BY i = keystore_password FROM ROOT KEYSTORE force_keystore? identified_by_store with_backup_clause?
    ;

unite_keystore
    : UNITE KEYSTORE IDENTIFIED BY i = keystore_password WITH ROOT KEYSTORE force_keystore? identified_by_store with_backup_clause?
    ;

key_management_clauses
    : set_key
    | create_key
    | use_key
    | set_key_tag
    | export_keys
    | import_keys
    | migrate_keys
    | reverse_migrate_keys
    | move_keys
    ;

set_key
    : SET ENCRYPTION? KEY ((mkid ':')? mk)? using_tag_clause? using_algorithm_clause? force_keystore? identified_by_store with_backup_clause?
        container_clause?
    ;

create_key
    : CREATE ENCRYPTION? KEY ((mkid ':')? mk)? using_tag_clause? using_algorithm_clause? force_keystore? identified_by_store with_backup_clause?
        container_clause?
    ;

mkid
    : CHAR_STRING
    ;

mk
    : CHAR_STRING
    ;

use_key
    : USE ENCRYPTION? KEY k = CHAR_STRING using_tag_clause? force_keystore? identified_by_store with_backup_clause?
    ;

set_key_tag
    : SET TAG t = CHAR_STRING FOR k = CHAR_STRING force_keystore? identified_by_store with_backup_clause?
    ;

export_keys
    : EXPORT ENCRYPTION? KEYS WITH SECRET secret TO filename force_keystore? identified_by_store (
        WITH IDENTIFIER IN (CHAR_STRING (',' CHAR_STRING)* | '(' subquery ')')
    )?
    ;

import_keys
    : IMPORT ENCRYPTION? KEYS WITH SECRET secret FROM filename force_keystore? identified_by_store with_backup_clause?
    ;

migrate_keys
    : SET ENCRYPTION? KEY IDENTIFIED BY hsm = secret force_keystore? MIGRATE USING keystore_password with_backup_clause?
    ;

reverse_migrate_keys
    : SET ENCRYPTION? KEY IDENTIFIED BY s = secret force_keystore? REVERSE MIGRATE USING hsm = secret
    ;

move_keys
    : MOVE ENCRYPTION? KEYS TO NEW KEYSTORE ksl1 = CHAR_STRING IDENTIFIED BY ksp1 = keystore_password FROM FORCE? KEYSTORE IDENTIFIED BY ksp =
        keystore_password (WITH IDENTIFIER IN (CHAR_STRING (',' CHAR_STRING)* | subquery))? with_backup_clause?
    ;

identified_by_store
    : IDENTIFIED BY (EXTERNAL STORE | keystore_password)
    ;

using_algorithm_clause
    : USING ALGORITHM ea = CHAR_STRING
    ;

using_tag_clause
    : USING TAG t = CHAR_STRING
    ;

secret_management_clauses
    : add_update_secret
    | delete_secret
    | add_update_secret_seps
    | delete_secret_seps
    ;

add_update_secret
    : (ADD | UPDATE) SECRET s = CHAR_STRING FOR CLIENT ci = CHAR_STRING using_tag_clause? force_keystore? identified_by_store? with_backup_clause?
    ;

delete_secret
    : DELETE SECRET FOR CLIENT ci = CHAR_STRING force_keystore? identified_by_store with_backup_clause?
    ;

add_update_secret_seps
    : (ADD | UPDATE) SECRET s = CHAR_STRING FOR CLIENT ci = CHAR_STRING using_tag_clause? TO LOCAL? AUTO_LOGIN KEYSTORE directory_path
    ;

delete_secret_seps
    : DELETE SECRET s = CHAR_STRING SQ FOR CLIENT ci = CHAR_STRING FROM LOCAL? AUTO_LOGIN KEYSTORE directory_path
    ;

zero_downtime_software_patching_clauses
    : SWITCHOVER TO? LIBRARY path FOR ALL CONTAINERS //inconsistent documentation
    ;

with_backup_clause
    : WITH BACKUP (USING bi = CHAR_STRING)?
    ;

identified_by_password_clause
    : IDENTIFIED BY keystore_password
    ;

keystore_password
    : DELIMITED_ID
    ;

path
    : CHAR_STRING
    ;

secret
    : DELIMITED_ID
    ;

// https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_4005.htm#SQLRF01105
analyze
    : (
        ANALYZE (TABLE tableview_name | INDEX index_name) partition_extention_clause?
        | ANALYZE CLUSTER cluster_name
    ) (
        validation_clauses
        | compute_clauses
        | ESTIMATE SYSTEM? STATISTICS for_clause? (SAMPLE UNSIGNED_INTEGER (ROWS | PERCENT_KEYWORD))?
        | LIST CHAINED ROWS into_clause1?
        | DELETE SYSTEM? STATISTICS)
    ;

partition_extention_clause
    : PARTITION (
        '(' partition_name ')'
        | FOR '(' partition_key_value (',' partition_key_value)* ')'
    )
    | SUBPARTITION (
        '(' subpartition_name ')'
        | FOR '(' subpartition_key_value (',' subpartition_key_value)* ')'
    )
    ;

validation_clauses
    : VALIDATE REF UPDATE (SET DANGLING TO NULL_)?
    | VALIDATE STRUCTURE (CASCADE FAST | CASCADE online_or_offline? into_clause? | CASCADE)? online_or_offline? into_clause?
    ;

compute_clauses
    : COMPUTE SYSTEM? STATISTICS for_clause?
    ;

for_clause
    : FOR (
        TABLE for_clause*
        | ALL (INDEXED? COLUMNS (SIZE UNSIGNED_INTEGER)? for_clause* | LOCAL? INDEXES)
        | COLUMNS (SIZE UNSIGNED_INTEGER)? (column_name SIZE UNSIGNED_INTEGER)+ for_clause*
    )
    ;

online_or_offline
    : OFFLINE
    | ONLINE
    ;

into_clause1
    : INTO tableview_name?
    ;

//Making assumption on partition ad subpartition key value clauses
partition_key_value
    : literal
    | TIMESTAMP quoted_string
    ;

subpartition_key_value
    : literal
    | TIMESTAMP quoted_string
    ;

//https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_4006.htm#SQLRF01106
associate_statistics
    : ASSOCIATE STATISTICS WITH (column_association | function_association) storage_table_clause?
    ;

column_association
    : COLUMNS tableview_name '.' column_name (',' tableview_name '.' column_name)* using_statistics_type
    ;

function_association
    : (
        FUNCTIONS function_name (',' function_name)*
        | PACKAGES package_name (',' package_name)*
        | TYPES type_name (',' type_name)*
        | INDEXES index_name (',' index_name)*
        | INDEXTYPES indextype_name (',' indextype_name)*
    ) (
        using_statistics_type
        | default_cost_clause (',' default_selectivity_clause)?
        | default_selectivity_clause (',' default_cost_clause)?
    )
    ;

indextype_name
    : id_expression
    ;

using_statistics_type
    : USING (statistics_type_name | NULL_)
    ;

statistics_type_name
    : regular_id
    ;

default_cost_clause
    : DEFAULT COST '(' cpu_cost ',' io_cost ',' network_cost ')'
    ;

cpu_cost
    : UNSIGNED_INTEGER
    ;

io_cost
    : UNSIGNED_INTEGER
    ;

network_cost
    : UNSIGNED_INTEGER
    ;

default_selectivity_clause
    : DEFAULT SELECTIVITY default_selectivity
    ;

default_selectivity
    : UNSIGNED_INTEGER
    ;

storage_table_clause
    : WITH (SYSTEM | USER) MANAGED STORAGE TABLES
    ;

// https://docs.oracle.com/database/121/SQLRF/statements_4008.htm#SQLRF56110
unified_auditing
    : {this.isVersion12()}? AUDIT (
        POLICY policy_name ((BY | EXCEPT) audit_user (',' audit_user)*)? (WHENEVER NOT? SUCCESSFUL)?
        | CONTEXT NAMESPACE oracle_namespace ATTRIBUTES attribute_name (',' attribute_name)* (
            BY audit_user (',' audit_user)*
        )?
    )
    ;

policy_name
    : identifier
    ;

// https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_4007.htm#SQLRF01107
// https://docs.oracle.com/database/121/SQLRF/statements_4007.htm#SQLRF01107

audit_traditional
    : AUDIT (
        audit_operation_clause (auditing_by_clause | IN SESSION CURRENT)?
        | audit_schema_object_clause
        | NETWORK
        | audit_direct_path
    ) (BY (SESSION | ACCESS))? (WHENEVER NOT? SUCCESSFUL)? audit_container_clause?
    ;

audit_direct_path
    : {this.isVersion12()}? DIRECT_PATH auditing_by_clause
    ;

audit_container_clause
    : {this.isVersion12()}? (CONTAINER EQUALS_OP (CURRENT | ALL))
    ;

audit_operation_clause
    : (
        (sql_statement_shortcut | ALL STATEMENTS?) (',' (sql_statement_shortcut | ALL STATEMENTS?))*
        | (system_privilege | ALL PRIVILEGES) (',' (system_privilege | ALL PRIVILEGES))*
    )
    ;

auditing_by_clause
    : BY audit_user (',' audit_user)*
    ;

audit_user
    : regular_id
    ;

audit_schema_object_clause
    : (sql_operation (',' sql_operation)* | ALL) auditing_on_clause
    ;

sql_operation
    : ALTER
    | AUDIT
    | COMMENT
    | DELETE
    | EXECUTE
    | FLASHBACK
    | GRANT
    | INDEX
    | INSERT
    | LOCK
    | READ
    | RENAME
    | SELECT
    | UPDATE
    ;

auditing_on_clause
    : ON (
        object_name
        | DIRECTORY regular_id
        | MINING MODEL model_name
        | {this.isVersion12()}? SQL TRANSLATION PROFILE profile_name
        | DEFAULT
    )
    ;

model_name
    : (id_expression '.')? id_expression
    ;

object_name
    : (id_expression '.')? id_expression
    ;

profile_name
    : (id_expression '.')? id_expression
    ;

sql_statement_shortcut
    : ALTER SYSTEM
    | CLUSTER
    | CONTEXT
    | DATABASE LINK
    | DIMENSION
    | DIRECTORY
    | INDEX
    | MATERIALIZED VIEW
    | NOT EXISTS
    | OUTLINE
    | {this.isVersion12()}? PLUGGABLE DATABASE
    | PROCEDURE
    | PROFILE
    | PUBLIC DATABASE LINK
    | PUBLIC SYNONYM
    | ROLE
    | ROLLBACK SEGMENT
    | SEQUENCE
    | SESSION
    | SYNONYM
    | SYSTEM AUDIT
    | SYSTEM GRANT
    | TABLE
    | TABLESPACE
    | TRIGGER
    | TYPE
    | USER
    | VIEW
    | ALTER SEQUENCE
    | ALTER TABLE
    | COMMENT TABLE
    | DELETE TABLE
    | EXECUTE PROCEDURE
    | GRANT DIRECTORY
    | GRANT PROCEDURE
    | GRANT SEQUENCE
    | GRANT TABLE
    | GRANT TYPE
    | INSERT TABLE
    | LOCK TABLE
    | SELECT SEQUENCE
    | SELECT TABLE
    | UPDATE TABLE
    ;

drop_index
    : DROP INDEX index_name (IF EXISTS)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DISASSOCIATE-STATISTICS.html
disassociate_statistics
    : DISASSOCIATE STATISTICS FROM (
        COLUMNS (schema_name '.')? tb = id_expression '.' c = id_expression (
            ',' (schema_name '.')? tb = id_expression '.' c = id_expression
        )*
        | FUNCTIONS (schema_name '.')? fn = id_expression (
            ',' (schema_name '.')? fn = id_expression
        )*
        | PACKAGES (schema_name '.')? pkg = id_expression (
            ',' (schema_name '.')? pkg = id_expression
        )*
        | TYPES (schema_name '.')? t = id_expression (',' (schema_name '.')? t = id_expression)*
        | INDEXES (schema_name '.')? ix = id_expression (',' (schema_name '.')? ix = id_expression)*
        | INDEXTYPES (schema_name '.')? it = id_expression (
            ',' (schema_name '.')? it = id_expression
        )*
    ) FORCE?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-INDEXTYPE.html
drop_indextype
    : DROP INDEXTYPE (schema_name '.')? it = id_expression FORCE?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-INMEMORY-JOIN-GROUP.html
drop_inmemory_join_group
    : DROP INMEMORY JOIN GROUP (schema_name '.')? jg = id_expression
    ;

flashback_table
    : FLASHBACK TABLE tableview_name (',' tableview_name)* TO (
        ((SCN | TIMESTAMP) expression | RESTORE POINT restore_point) ((ENABLE | DISABLE) TRIGGERS)?
        | BEFORE DROP (RENAME TO tableview_name)?
    )
    ;

restore_point
    : identifier ('.' id_expression)*
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/PURGE.html
purge_statement
    : PURGE (
        (TABLE | INDEX) id_expression
        | TABLESPACE SET? ts = id_expression (USER u = id_expression)?
        | RECYCLEBIN
        | DBA_RECYCLEBIN
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/NOAUDIT-Traditional-Auditing.html
noaudit_statement
    : NOAUDIT (
        audit_operation_clause auditing_by_clause?
        | audit_schema_object_clause
        | NETWORK
        | DIRECT_PATH LOAD auditing_by_clause?
    ) (WHENEVER NOT? SUCCESSFUL)? container_clause?
    ;

rename_object
    : RENAME object_name TO object_name
    ;

grant_statement
    : GRANT (','? (role_name | system_privilege | object_privilege paren_column_list?))+ (
        ON grant_object_name
    )? TO (grantee_name | PUBLIC) (',' (grantee_name | PUBLIC))* (WITH (ADMIN | DELEGATE) OPTION)? (
        WITH HIERARCHY OPTION
    )? (WITH GRANT OPTION)? container_clause?
    ;

container_clause
    : CONTAINER EQUALS_OP (CURRENT | ALL)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/REVOKE.html
revoke_statement
    : REVOKE (
        (revoke_system_privilege | revoke_object_privileges) container_clause?
        | revoke_roles_from_programs
    )
    ;

revoke_system_privilege
    : (system_privilege | role_name | ALL PRIVILEGES) FROM revokee_clause
    ;

revokee_clause
    : (id_expression | PUBLIC) (',' (id_expression | PUBLIC))*
    ;

revoke_object_privileges
    : (object_privilege | ALL PRIVILEGES?) (',' (object_privilege | ALL PRIVILEGES?))* on_object_clause FROM revokee_clause (
        CASCADE CONSTRAINTS
        | FORCE
    )?
    ;

on_object_clause
    : ON (
        (schema_name '.')? o = id_expression
        | USER id_expression (',' id_expression)*
        | DIRECTORY directory_name
        | EDITION edition_name
        | MINING MODEL (schema_name '.')? mmn = id_expression
        | JAVA (SOURCE | RESOURCE) (schema_name '.')? o2 = id_expression
        | SQL TRANSLATION PROFILE (schema_name '.')? p = id_expression
    )
    ;

revoke_roles_from_programs
    : (role_name (',' role_name)* | ALL) FROM program_unit (',' program_unit)*
    ;

program_unit
    : (FUNCTION | PROCEDURE | PACKAGE) (schema_name '.')? id_expression
    ;

create_dimension
    : CREATE DIMENSION identifier level_clause+ (
        hierarchy_clause
        | attribute_clause
        | extended_attribute_clause
    )+
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-DIRECTORY.html
create_directory
    : CREATE (OR REPLACE)? DIRECTORY directory_name (SHARING '=' (METADATA | NONE))? AS directory_path
    ;

directory_name
    : regular_id
    ;

directory_path
    : CHAR_STRING
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-INMEMORY-JOIN-GROUP.html
create_inmemory_join_group
    : CREATE INMEMORY JOIN GROUP (schema_name '.')? jg = id_expression '(' (schema_name '.')? t = id_expression '(' c = id_expression ')' (
        ',' (schema_name '.')? t = id_expression '(' c = id_expression ')'
    )+ ')'
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-HIERARCHY.html
drop_hierarchy
    : DROP HIERARCHY (schema_name '.')? hn = id_expression
    ;

// https://docs.oracle.com/cd/E11882_01/appdev.112/e25519/alter_library.htm#LNPLS99946
// https://docs.oracle.com/database/121/LNPLS/alter_library.htm#LNPLS99946
alter_library
    : ALTER LIBRARY library_name (
        COMPILE library_debug? compiler_parameters_clause* (REUSE SETTINGS)?
        | library_editionable
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-JAVA.html
drop_java
    : DROP JAVA (SOURCE | CLASS | RESOURCE) (schema_name '.')? id_expression
    ;

drop_library
    : DROP LIBRARY library_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-JAVA.html
create_java
    : CREATE (OR REPLACE)? (AND (RESOLVE | COMPILE))? NOFORCE? JAVA (
        (SOURCE | RESOURCE) NAMED (schema_name '.')? pn = id_expression
        | CLASS (SCHEMA id_expression)?
    ) (SHARING '=' (METADATA | NONE))? invoker_rights_clause? (
        RESOLVER '(' ('(' CHAR_STRING ','? (sn = id_expression | '-') ')')+ ')'
    )? (
        USING (
            BFILE '(' d = id_expression ',' filename ')'
            | (CLOB | BLOB | BFILE) subquery
            | CHAR_STRING
        )
        | AS CHAR_STRING
    )
    ;

create_library
    : CREATE (OR REPLACE)? (EDITIONABLE | NONEDITIONABLE)? LIBRARY plsql_library_source
    ;

plsql_library_source
    : library_name (IS | AS) quoted_string (IN directory_name)? (AGENT quoted_string)? (
        CREDENTIAL credential_name
    )?
    ;

credential_name
    : (id_expression '.')? id_expression
    ;

library_editionable
    : {this.isVersion12()}? (EDITIONABLE | NONEDITIONABLE)
    ;

library_debug
    : {this.isVersion12()}? DEBUG
    ;

compiler_parameters_clause
    : parameter_name EQUALS_OP parameter_value
    ;

parameter_value
    : regular_id
    | CHAR_STRING
    ;

library_name
    : (regular_id '.')? regular_id
    ;

alter_dimension
    : ALTER DIMENSION identifier (
        (ADD (level_clause | hierarchy_clause | attribute_clause | extended_attribute_clause))+
        | (
            DROP (
                LEVEL identifier (RESTRICT | CASCADE)?
                | HIERARCHY identifier
                | ATTRIBUTE identifier (
                    LEVEL identifier (COLUMN column_name (',' COLUMN column_name)*)?
                )?
            )
        )+
        | COMPILE
    )
    ;

level_clause
    : LEVEL identifier IS (
        table_name '.' column_name
        | '(' table_name '.' column_name (',' table_name '.' column_name)* ')'
    ) (SKIP_ WHEN NULL_)?
    ;

hierarchy_clause
    : HIERARCHY identifier '(' identifier (CHILD OF identifier)+ dimension_join_clause? ')'
    ;

dimension_join_clause
    : (JOIN KEY column_one_or_more_sub_clause REFERENCES identifier)+
    ;

attribute_clause
    : (ATTRIBUTE identifier DETERMINES column_one_or_more_sub_clause)+
    ;

extended_attribute_clause
    : ATTRIBUTE identifier (LEVEL identifier DETERMINES column_one_or_more_sub_clause)+
    ;

column_one_or_more_sub_clause
    : column_name
    | '(' column_name (',' column_name)* ')'
    ;

// https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_4004.htm#SQLRF01104
// https://docs.oracle.com/database/121/SQLRF/statements_4004.htm#SQLRF01104
alter_view
    : ALTER VIEW tableview_name (
        ADD out_of_line_constraint
        | MODIFY CONSTRAINT constraint_name (RELY | NORELY)
        | DROP (
            CONSTRAINT constraint_name
            | PRIMARY KEY
            | UNIQUE '(' column_name (',' column_name)* ')'
        )
        | COMPILE
        | READ (ONLY | WRITE)
        | alter_view_editionable?
    )
    ;

alter_view_editionable
    : {this.isVersion12()}? (EDITIONABLE | NONEDITIONABLE)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-VIEW.html
create_view
    : CREATE (OR REPLACE)? (NO? FORCE)? editioning_clause? VIEW (schema_name '.')? v = id_expression (
        IF NOT EXISTS
    )? (SHARING '=' (METADATA | EXTENDED? DATA | NONE))? view_options? (
        DEFAULT COLLATION cn = id_expression
    )? (BEQUEATH (CURRENT_USER | DEFINER))? AS select_only_statement subquery_restriction_clause? (
        CONTAINER_MAP
        | CONTAINERS_DEFAULT
    )?
    ;

editioning_clause
    : EDITIONING
    | EDITIONABLE EDITIONING?
    | NONEDITIONABLE
    ;

view_options
    : view_alias_constraint
    | object_view_clause
    | xmltype_view_clause
    ;

view_alias_constraint
    : '(' (','? (table_alias inline_constraint* | out_of_line_constraint))+ ')'
    ;

object_view_clause
    : OF (schema_name '.')? tn = id_expression (
        WITH OBJECT (IDENTIFIER | ID) (DEFAULT | '(' REGULAR_ID (',' REGULAR_ID)* ')')
        | UNDER (schema_name '.')? sv = id_expression
    ) ('(' (','? (out_of_line_constraint | REGULAR_ID inline_constraint))+ ')')*
    ;

inline_constraint
    : (CONSTRAINT constraint_name)? (
        NOT? NULL_
        | UNIQUE
        | PRIMARY KEY
        | references_clause
        | check_constraint
    ) constraint_state?
    ;

inline_ref_constraint
    : SCOPE IS tableview_name
    | WITH ROWID
    | (CONSTRAINT constraint_name)? references_clause constraint_state?
    ;

out_of_line_ref_constraint
    : SCOPE FOR '(' ref_col_or_attr = regular_id ')' IS tableview_name
    | REF '(' ref_col_or_attr = regular_id ')' WITH ROWID
    | (CONSTRAINT constraint_name)? FOREIGN KEY '(' (','? ref_col_or_attr = regular_id)+ ')' references_clause constraint_state?
    ;

out_of_line_constraint
    : (
        ((CONSTRAINT | CONSTRAINTS) constraint_name)? (
            UNIQUE '(' column_name (',' column_name)* ')'
            | PRIMARY KEY '(' column_name (',' column_name)* ')'
            | foreign_key_clause
            | CHECK '(' condition ')'
        )
    )
    constraint_state?
    parallel_clause?
    ;

constraint_state
    : (
        NOT? DEFERRABLE
        | INITIALLY (IMMEDIATE | DEFERRED)
        | (RELY | NORELY)
        | (ENABLE | DISABLE)
        | (VALIDATE | NOVALIDATE)
        | using_index_clause
    )+
    ;

xmltype_view_clause
    : OF XMLTYPE xml_schema_spec? WITH OBJECT (IDENTIFIER | ID) (
        DEFAULT
        | '(' expression (',' expression)* ')'
    )
    ;

xml_schema_spec
    : (XMLSCHEMA xml_schema_url)? ELEMENT (element | xml_schema_url '#' element) (
        STORE ALL VARRAYS AS (LOBS | TABLES)
    )? (allow_or_disallow NONSCHEMA)? (allow_or_disallow ANYSCHEMA)?
    ;

xml_schema_url
    : DELIMITED_ID
    ;

element
    : DELIMITED_ID
    ;

alter_tablespace
    : ALTER TABLESPACE tablespace (
        DEFAULT table_compression? storage_clause?
        | MINIMUM EXTENT size_clause
        | RESIZE size_clause
        | COALESCE
        | SHRINK SPACE_KEYWORD (KEEP size_clause)?
        | RENAME TO new_tablespace_name
        | begin_or_end BACKUP
        | datafile_tempfile_clauses
        | tablespace_logging_clauses
        | tablespace_group_clause
        | tablespace_state_clauses
        | autoextend_clause
        | flashback_mode_clause
        | tablespace_retention_clause
    )
    ;

datafile_tempfile_clauses
    : ADD (datafile_specification | tempfile_specification)
    | DROP (DATAFILE | TEMPFILE) (filename | UNSIGNED_INTEGER) (KEEP size_clause)?
    | SHRINK TEMPFILE (filename | UNSIGNED_INTEGER) (KEEP size_clause)?
    | RENAME DATAFILE filename (',' filename)* TO filename (',' filename)*
    | (DATAFILE | TEMPFILE) (online_or_offline)
    ;

tablespace_logging_clauses
    : logging_clause
    | NO? FORCE LOGGING
    ;

tablespace_group_clause
    : TABLESPACE GROUP (tablespace_group_name | CHAR_STRING)
    ;

tablespace_group_name
    : regular_id
    ;

tablespace_state_clauses
    : ONLINE
    | OFFLINE (NORMAL | TEMPORARY | IMMEDIATE)?
    | READ (ONLY | WRITE)
    | PERMANENT
    | TEMPORARY
    ;

flashback_mode_clause
    : FLASHBACK (ON | OFF)
    ;

new_tablespace_name
    : tablespace
    ;

create_tablespace
    : CREATE (BIGFILE | SMALLFILE)? (
        permanent_tablespace_clause
        | temporary_tablespace_clause
        | undo_tablespace_clause
    )
    ;

permanent_tablespace_clause
    : TABLESPACE id_expression (IF NOT EXISTS)? datafile_specification? (
        MINIMUM EXTENT size_clause
        | BLOCKSIZE size_clause
        | logging_clause
        | FORCE LOGGING
        | (ONLINE | OFFLINE)
        | ENCRYPTION tablespace_encryption_spec
        | DEFAULT //TODO table_compression? storage_clause?
        | extent_management_clause
        | segment_management_clause
        | flashback_mode_clause
    )*
    ;

tablespace_encryption_spec
    : USING encrypt_algorithm = CHAR_STRING
    ;

logging_clause
    : LOGGING
    | NOLOGGING
    | FILESYSTEM_LIKE_LOGGING
    ;

extent_management_clause
    : EXTENT MANAGEMENT LOCAL (AUTOALLOCATE | UNIFORM (SIZE size_clause)?)?
    ;

segment_management_clause
    : SEGMENT SPACE_KEYWORD MANAGEMENT (AUTO | MANUAL)
    ;

temporary_tablespace_clause
    : TEMPORARY TABLESPACE tablespace_name = id_expression (IF NOT EXISTS)? tempfile_specification? tablespace_group_clause? extent_management_clause?
    ;

undo_tablespace_clause
    : UNDO TABLESPACE tablespace_name = id_expression (IF NOT EXISTS)? datafile_specification? extent_management_clause? tablespace_retention_clause?
    ;

tablespace_retention_clause
    : RETENTION (GUARANTEE | NOGUARANTEE)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-TABLESPACE-SET.html
create_tablespace_set
    : CREATE TABLESPACE SET tss = id_expression (IN SHARDSPACE ss = id_expression)? (
        USING TEMPLATE '(' (DATAFILE file_specification (',' file_specification)*)? permanent_tablespace_attrs+ ')'
    )?
    ;

permanent_tablespace_attrs
    : MINIMUM EXTENT size_clause
    | BLOCKSIZE numeric K_LETTER?
    | logging_clause
    | FORCE LOGGING
    | tablespace_encryption_clause
    | default_tablespace_params
    | ONLINE
    | OFFLINE
    | extent_management_clause
    | segment_management_clause
    | flashback_mode_clause
    | lost_write_protection
    ;

tablespace_encryption_clause
    : ENCRYPTION (tablespace_encryption_spec? ENCRYPT | DECRYPT)
    ;

default_tablespace_params
    : DEFAULT default_table_compression? default_index_compression? inmmemory_clause? ilm_clause? storage_clause?
    ;

default_table_compression
    : TABLE (COMPRESS FOR (OLTP | QUERY low_high | ARCHIVE low_high) | NOCOMPRESS)
    ;

low_high
    : LOW
    | HIGH
    ;

default_index_compression
    : INDEX (COMPRESS ADVANCED low_high | NOCOMPRESS)
    ;

inmmemory_clause
    : INMEMORY inmemory_attributes? (
        TEXT (
            column_name (',' column_name)*
            | column_name USING policy_name (',' column_name USING policy_name)*
        )
    )?
    | NO INMEMORY
    ;

// asm_filename is just a charater string.  Would need to parse the string
// to find diskgroup...
datafile_specification
    : DATAFILE (','? datafile_tempfile_spec)
    ;

tempfile_specification
    : TEMPFILE (','? datafile_tempfile_spec)
    ;

datafile_tempfile_spec
    : CHAR_STRING? (SIZE size_clause)? REUSE? autoextend_clause?
    ;

redo_log_file_spec
    : (filename | '(' filename (',' filename)* ')') (SIZE size_clause)? (BLOCKSIZE size_clause)? REUSE?
    ;

autoextend_clause
    : AUTOEXTEND (OFF | ON (NEXT size_clause)? maxsize_clause?)
    ;

maxsize_clause
    : MAXSIZE (UNLIMITED | size_clause)
    ;

build_clause
    : BUILD (IMMEDIATE | DEFERRED)
    ;

parallel_clause
    : NOPARALLEL
    | PARALLEL (
        parallel_count = UNSIGNED_INTEGER parallel_instances_clause?
        // Deprecated, legacy format from Oracle 8 and prior, and while this is no longer documented,
        // the DEGREE syntax continues to be accepted by the database engine.
        | '(' DEGREE parallel_count = UNSIGNED_INTEGER parallel_instances_clause? ')'
    )?
    ;

// This is Oracle RAC specific.
// In modern Oracle, parallelism is controlled by the database initialization parameter PARALLEL_DEGREE_POLICY,
// however, the database continues to accept and record this SQL syntax if its used.
parallel_instances_clause
    : INSTANCES (UNSIGNED_INTEGER | DEFAULT)
    ;

alter_materialized_view
    : ALTER MATERIALIZED VIEW tableview_name (
        physical_attributes_clause
        | modify_mv_column_clause
        | table_compression
        | lob_storage_clause (',' lob_storage_clause)*
        | modify_lob_storage_clause (',' modify_lob_storage_clause)*
        //TODO | alter_table_partitioning
        | parallel_clause
        | logging_clause
        | allocate_extent_clause
        | deallocate_unused_clause
        | shrink_clause
        | (cache_or_nocache)
    )? alter_iot_clauses? (USING INDEX physical_attributes_clause)? alter_mv_option1? (
        enable_or_disable QUERY REWRITE
        | COMPILE
        | CONSIDER FRESH
    )?
    ;

alter_mv_option1
    : alter_mv_refresh
    //TODO  | MODIFY scoped_table_ref_constraint
    ;

alter_mv_refresh
    : REFRESH (
        FAST
        | COMPLETE
        | FORCE
        | ON (DEMAND | COMMIT)
        | START WITH expression
        | NEXT expression
        | WITH PRIMARY KEY
        | USING DEFAULT? MASTER ROLLBACK SEGMENT rollback_segment?
        | USING (ENFORCED | TRUSTED) CONSTRAINTS
    )+
    ;

rollback_segment
    : regular_id
    ;

modify_mv_column_clause
    : MODIFY '(' column_name (ENCRYPT encryption_spec | DECRYPT)? ')'
    ;

alter_materialized_view_log
    : ALTER MATERIALIZED VIEW LOG FORCE? ON tableview_name (
        physical_attributes_clause
        | add_mv_log_column_clause
        //TODO | alter_table_partitioning
        | parallel_clause
        | logging_clause
        | allocate_extent_clause
        | shrink_clause
        | move_mv_log_clause
        | cache_or_nocache
    )? mv_log_augmentation? mv_log_purge_clause?
    ;

add_mv_log_column_clause
    : ADD '(' column_name ')'
    ;

move_mv_log_clause
    : MOVE segment_attributes_clause parallel_clause?
    ;

mv_log_augmentation
    : ADD (
        (OBJECT ID | PRIMARY KEY | ROWID | SEQUENCE) ('(' column_name (',' column_name)* ')')?
        | '(' column_name (',' column_name)* ')'
    ) new_values_clause?
    ;

create_materialized_view_log
    : CREATE MATERIALIZED VIEW LOG ON tableview_name (
        (
            physical_attributes_clause
            | TABLESPACE tablespace_name = id_expression
            | logging_clause
            | (CACHE | NOCACHE)
        )+
    )? parallel_clause?
    // table_partitioning_clauses TODO
    (
        WITH (','? ( OBJECT ID | PRIMARY KEY | ROWID | SEQUENCE | COMMIT SCN))* (
            '(' ( ','? regular_id)+ ')'
        )? new_values_clause? mv_log_purge_clause?
    )*
    ;

new_values_clause
    : (INCLUDING | EXCLUDING) NEW VALUES
    ;

mv_log_purge_clause
    : PURGE (
        IMMEDIATE (SYNCHRONOUS | ASYNCHRONOUS)?
        // |START WITH CLAUSES TODO
    )
    ;

create_materialized_zonemap
    : CREATE MATERIALIZED ZONEMAP zonemap_name (LEFT_PAREN column_list RIGHT_PAREN)? zonemap_attributes? zonemap_refresh_clause? (
        (ENABLE | DISABLE) PRUNING
    )? (create_zonemap_on_table | create_zonemap_as_subquery)
    ;

alter_materialized_zonemap
    : ALTER MATERIALIZED ZONEMAP zonemap_name (
        zonemap_attributes
        | zonemap_refresh_clause
        | (ENABLE | DISABLE) PRUNING
        | COMPILE
        | REBUILD
        | UNUSABLE
    )
    ;

drop_materialized_zonemap
    : DROP MATERIALIZED ZONEMAP zonemap_name
    ;

zonemap_refresh_clause
    : REFRESH (FAST | COMPILE | FORCE)? (
        ON (DEMAND | COMMIT | LOAD | DATA MOVEMENT | LOAD DATA MOVEMENT)
    )?
    ;

zonemap_attributes
    : (
        PCTFREE numeric
        | PCTUSED numeric
        | SCALE numeric
        | TABLESPACE tablespace
        | (CACHE | NOCACHE)
    )+
    ;

zonemap_name
    : identifier ('.' id_expression)?
    ;

operator_name
    : identifier ('.' id_expression)?
    ;

operator_function_name
    : identifier ('.' id_expression)*
    ;

create_zonemap_on_table
    : ON tableview_name LEFT_PAREN column_list RIGHT_PAREN
    ;

create_zonemap_as_subquery
    : AS subquery
    ;

alter_operator
    : ALTER OPERATOR operator_name (add_binding_clause | drop_binding_clause | COMPILE)
    ;

drop_operator
    : DROP OPERATOR operator_name FORCE?
    ;

create_operator
    : CREATE (OR REPLACE)? OPERATOR operator_name BINDING binding_clause (COMMA binding_clause)* (
        SHARING '=' (METADATA | NONE)
    )?
    ;

binding_clause
    : LEFT_PAREN datatype (COMMA datatype)* RIGHT_PAREN RETURN LEFT_PAREN? datatype RIGHT_PAREN? implementation_clause? using_function_clause
    ;

add_binding_clause
    : ADD BINDING binding_clause
    ;

implementation_clause
    : ANCILLARY TO primary_operator_list
    | operator_context_clause
    ;

primary_operator_list
    : primary_operator_item (COMMA primary_operator_item)*
    ;

primary_operator_item
    : schema_object_name LEFT_PAREN datatype (COMMA datatype)* RIGHT_PAREN
    ;

operator_context_clause
    : WITH INDEX CONTEXT COMMA SCAN CONTEXT implementation_type_name (COMPUTE ANCILLARY DATA)? (
        WITH COLUMN CONTEXT
    )?
    ;

using_function_clause
    : USING operator_function_name
    ;

drop_binding_clause
    : DROP BINDING LEFT_PAREN datatype (COMMA datatype)* RIGHT_PAREN FORCE?
    ;

create_materialized_view
    : CREATE MATERIALIZED VIEW (
        IF NOT EXISTS
    )? tableview_name (OF type_name)? (
        '(' (scoped_table_ref_constraint | mv_column_alias) (
            ',' (scoped_table_ref_constraint | mv_column_alias)
        )* ')'
    )? (
        ON PREBUILT TABLE ( (WITH | WITHOUT) REDUCED PRECISION)?
        | physical_properties? (CACHE | NOCACHE)? parallel_clause? build_clause?
    ) (
        USING INDEX ((physical_attributes_clause | TABLESPACE mv_tablespace = id_expression)+)*
        | USING NO INDEX
    )? create_mv_refresh? evaluation_edition_clause? (
        (ENABLE | DISABLE) ON QUERY COMPUTATION
    )? query_rewrite_clause? (
        (ENABLE | DISABLE) CONCURRENT REFRESH
    )? annotations_clause? AS select_only_statement
    ;

scoped_table_ref_constraint
    : SCOPE FOR '(' ref_column_or_attribute = identifier ')' IS (schema_name '.')? scope_table_name_or_c_alias = identifier
    ;

mv_column_alias
    : (identifier | quoted_string) (ENCRYPT encryption_spec)? (annotations_clause | scoped_table_ref_constraint)?
    ;

create_mv_refresh
    : (
        NEVER REFRESH
        | REFRESH (
            (FAST | COMPLETE | FORCE)
            | ON (DEMAND | COMMIT | STATEMENT)
            | (START WITH | NEXT) expression
            | WITH (PRIMARY KEY | ROWID)
            | USING (
                DEFAULT (MASTER | LOCAL)? ROLLBACK SEGMENT
                | (MASTER | LOCAL)? ROLLBACK SEGMENT rollback_segment_name
            )
            | USING (ENFORCED | TRUSTED) CONSTRAINTS
        )+
    )
    ;

query_rewrite_clause
    : (ENABLE | DISABLE) QUERY REWRITE unusable_editions_clause?
    ;

unusable_editions_clause
    : UNUSABLE (
        (BEFORE | BEGINNING WITH) CURRENT EDITION
        | (BEFORE | BEGINNING WITH) EDITION edition_name
        | BEGINNING WITH NULL_ EDITION
    )
    ;

drop_materialized_view
    : DROP MATERIALIZED VIEW tableview_name (PRESERVE TABLE)?
    ;

drop_materialized_view_log
    : DROP MATERIALIZED VIEW LOG (IF EXISTS)? ON tableview_name
    ;

create_context
    : CREATE (OR REPLACE)? CONTEXT oracle_namespace USING (schema_object_name '.')? package_name (
        INITIALIZED (EXTERNALLY | GLOBALLY)
        | ACCESSED GLOBALLY
    )?
    ;

oracle_namespace
    : id_expression
    ;

//https://docs.oracle.com/cd/E11882_01/server.112/e41084/statements_5001.htm#SQLRF01201
create_cluster
    : CREATE CLUSTER cluster_name '(' column_name datatype SORT? (',' column_name datatype SORT?)* ')' (
        physical_attributes_clause
        | SIZE size_clause
        | TABLESPACE tablespace
        | INDEX
        | (SINGLE TABLE)? HASHKEYS UNSIGNED_INTEGER (HASH IS expression)?
    )* parallel_clause? (ROWDEPENDENCIES | NOROWDEPENDENCIES)? (CACHE | NOCACHE)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-PROFILE.html
create_profile
    : CREATE MANDATORY? PROFILE p = id_expression LIMIT (resource_parameters | password_parameters)+ container_clause?
    ;

resource_parameters
    : (
        SESSIONS_PER_USER
        | CPU_PER_SESSION
        | CPU_PER_CALL
        | CONNECT_TIME
        | IDLE_TIME
        | LOGICAL_READS_PER_SESSION
        | LOGICAL_READS_PER_CALL
        | COMPOSITE_LIMIT
    ) (UNSIGNED_INTEGER | UNLIMITED | DEFAULT)
    | PRIVATE_SGA (size_clause | UNLIMITED | DEFAULT)
    ;

password_parameters
    : (
        FAILED_LOGIN_ATTEMPTS
        | PASSWORD_LIFE_TIME
        | PASSWORD_REUSE_TIME
        | PASSWORD_REUSE_MAX
        | PASSWORD_LOCK_TIME
        | PASSWORD_GRACE_TIME
        | INACTIVE_ACCOUNT_TIME
    ) (expression | UNLIMITED | DEFAULT)
    | PASSWORD_VERIFY_FUNCTION (function_name | NULL_ | DEFAULT)
    | PASSWORD_ROLLOVER_TIME (expression | DEFAULT)
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-LOCKDOWN-PROFILE.html
create_lockdown_profile
    : CREATE LOCKDOWN PROFILE id_expression (static_base_profile | dynamic_base_profile)?
    ;

static_base_profile
    : FROM bp = id_expression
    ;

dynamic_base_profile
    : INCLUDING bp = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-OUTLINE.html
create_outline
    : CREATE (OR REPLACE)? (PUBLIC | PRIVATE)? OUTLINE (o = id_expression)? (
        FROM (PUBLIC | PRIVATE)? so = id_expression
    )? (FOR CATEGORY c = id_expression)? (ON statement)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-RESTORE-POINT.html
create_restore_point
    : CREATE CLEAN? RESTORE POINT rp = id_expression (FOR PLUGGABLE DATABASE pdb = id_expression)? (
        AS OF (TIMESTAMP | SCN) expression
    )? (PRESERVE | GUARANTEE FLASHBACK DATABASE)?
    ;

create_role
    : CREATE ROLE role_name role_identified_clause? container_clause?
    ;

create_table
    : CREATE (
        (GLOBAL | PRIVATE) TEMPORARY
        | SHARDED
        | DUPLICATED
        | IMMUTABLE? BLOCKCHAIN
        | IMMUTABLE
    )? TABLE (schema_name '.')? table_name (IF NOT EXISTS)? (
        SHARING '=' (METADATA | EXTENDED? DATA | NONE)
    )? (relational_table | xmltype_table | object_table) memoptimize_read_write_clause? (
        PARENT tableview_name
    )? (USAGE QUEUE)?
    ;

xmltype_table
    : OF XMLTYPE ('(' object_properties ')')? (XMLTYPE xmltype_storage)? xmlschema_spec? xmltype_virtual_columns? (
        ON COMMIT (DELETE | PRESERVE) ROWS
    )? oid_clause? oid_index_clause? physical_properties? table_properties?
    ;

xmltype_virtual_columns
    : VIRTUAL COLUMNS '(' column_name AS '(' expression ')' (',' column_name AS '(' expression ')')* ')'
    ;

xmltype_column_properties
    : XMLTYPE COLUMN? column_name xmltype_storage? xmlschema_spec?
    ;

xmltype_storage
    : STORE AS (
        OBJECT RELATIONAL
        | (SECUREFILE | BASICFILE)? (CLOB | BINARY XML) (
            lob_segname ('(' lob_parameters ')')?
            | '(' lob_parameters ')'
        )?
    )
    | STORE VARRAYS AS (LOBS | TABLES)
    ;

xmlschema_spec
    : ((XMLSCHEMA DELIMITED_ID)? ELEMENT id_expression)? (allow_or_disallow (NONSCHEMA | ANYSCHEMA))*
    ;

object_table
    : OF (schema_name '.')? object_type object_table_substitution? (
        '(' object_properties (',' object_properties)* ')'
    )? (ON COMMIT (DELETE | PRESERVE) ROWS)? oid_clause? oid_index_clause? physical_properties? table_properties?
    ;

object_type
    : regular_id
    ;

oid_index_clause
    : OIDINDEX index_name? '(' (physical_attributes_clause | TABLESPACE tablespace)+ ')'
    ;

oid_clause
    : OBJECT IDENTIFIER IS (SYSTEM GENERATED | PRIMARY KEY)
    ;

object_properties
    : (column_name | attribute_name) (DEFAULT expression)? (
        inline_constraint (',' inline_constraint)*
        | inline_ref_constraint
    )?
    | out_of_line_constraint
    | out_of_line_ref_constraint
    | supplemental_logging_props
    ;

object_table_substitution
    : NOT? SUBSTITUTABLE AT ALL LEVELS
    ;

relational_table
    : ('(' relational_property (',' relational_property)* ')')? relational_table_properties?
    ;

relational_table_properties
    : relational_table_property+
    ;

relational_table_property
    : immutable_table_clauses
    | blockchain_table_clauses
    | DEFAULT COLLATION collation_name
    | ON COMMIT ((DROP | PRESERVE) DEFINITION | (DELETE | PRESERVE) ROWS)
    | physical_properties
    | table_properties
    ;

immutable_table_clauses
    : immutable_table_no_drop_clause
    | immutable_table_no_delete_clause
    ;

immutable_table_no_drop_clause
    : NO DROP (UNTIL numeric DAYS IDLE)?
    ;

immutable_table_no_delete_clause
    : NO DELETE (LOCKED? | UNTIL numeric DAYS AFTER INSERT LOCKED?)
    ;

blockchain_table_clauses
    : blockchain_drop_table_clause blockchain_row_retention_clause blockchain_hash_and_data_format_clause
    ;

blockchain_drop_table_clause
    : NO DROP (UNTIL numeric DAYS IDLE)?
    ;

blockchain_row_retention_clause
    : NO DELETE (LOCKED? | UNTIL numeric DAYS AFTER INSERT LOCKED?)
    ;

blockchain_hash_and_data_format_clause
    : HASHING USING SHA2_512_Q VERSION V1_Q
    ;

collation_name
    : identifier
    ;

// While Oracle's documented grammar defines an explicit order of clauses, in practice these clauses can
// be specified in any order. This rule is designed to follow the grammar intent, and so semantic checks
// should exist in the listeners to deal with concepts such as duplicates.
table_properties
    : column_properties
    | read_only_clause
    | indexing_clause
    | table_partitioning_clauses
    | attribute_clustering_clause
    | (CACHE | NOCACHE)
    | result_cache_clause
    | parallel_clause
    | monitoring_nomonitoring
    | (ROWDEPENDENCIES | NOROWDEPENDENCIES)
    | enable_disable_clause
    | row_movement_clause
    | logical_replication_clause
    | flashback_archive_clause
    | physical_properties
    | ROW ARCHIVAL
    | AS select_only_statement
    | FOR EXCHANGE WITH TABLE (schema_name '.')? table_name
    | annotations_clause
    ;

read_only_clause
    : READ (ONLY | WRITE)
    ;

indexing_clause
    : INDEXING (ON | OFF)
    ;

attribute_clustering_clause
    : CLUSTERING clustering_join? cluster_clause (yes_no? ON LOAD)? (yes_no? ON DATA MOVEMENT)? zonemap_clause?
    ;

clustering_join
    : (schema_name '.')? table_name clustering_join_item (',' clustering_join_item)*
    ;

clustering_join_item
    : JOIN (schema_name '.')? table_name ON '(' equijoin_condition ')'
    ;

equijoin_condition
    : expression
    ;

cluster_clause
    : BY (LINEAR | INTERLEAVED)? ORDER clustering_columns
    ;

clustering_columns
    : clustering_column_group
    | '(' clustering_column_group (',' clustering_column_group)* ')'
    ;

clustering_column_group
    : '(' column_name (',' column_name)* ')'
    ;

yes_no
    : YES
    | NO
    ;

zonemap_clause
    : WITH MATERIALIZED ZONEMAP ('(' zonemap_name ')')?
    | WITHOUT MATERIALIZED ZONEMAP
    ;

logical_replication_clause
    : DISABLE LOGICAL REPLICATION
    | ENABLE LOGICAL REPLICATION (
        (ALL | ALLOW NOVALIDATE) KEYS
        | NO? PARTIAL JSON
    )?
    ;

table_name
    : identifier
    ;

relational_property
    : out_of_line_constraint
    | out_of_line_ref_constraint
    | column_definition
    | virtual_column_definition
    | period_definition
    | supplemental_logging_props
    ;

table_partitioning_clauses
    : range_partitions
    | list_partitions
    | hash_partitions
    | composite_range_partitions
    | composite_list_partitions
    | composite_hash_partitions
    | reference_partitioning
    | system_partitioning
    ;

range_partitions
    : PARTITION BY RANGE '(' column_name (',' column_name)* ')' (
        INTERVAL '(' expression ')' (STORE IN '(' tablespace (',' tablespace)* ')')?
    )? '(' PARTITION partition_name? range_values_clause table_partition_description (
        ',' PARTITION partition_name? range_values_clause table_partition_description
    )* ')'
    ;

list_partitions
    : PARTITION BY LIST '(' column_name ')' (
        AUTOMATIC (STORE IN '(' tablespace (',' tablespace)* ')')?
    )? (
        '(' PARTITION partition_name? list_values_clause table_partition_description (
            ',' PARTITION partition_name? list_values_clause table_partition_description
        )* ')'
    )?
    ;

hash_partitions
    : PARTITION BY HASH '(' column_name (',' column_name)* ')' (
        individual_hash_partitions
        | hash_partitions_by_quantity
    )
    ;

individual_hash_partitions
    : '(' PARTITION partition_name? partitioning_storage_clause? (
        ',' PARTITION partition_name? partitioning_storage_clause?
    )* ')'
    ;

hash_partitions_by_quantity
    : PARTITIONS hash_partition_quantity (STORE IN '(' tablespace (',' tablespace)* ')')? (
        table_compression
        | key_compression
    )? (OVERFLOW_ STORE IN '(' tablespace (',' tablespace)* ')')?
    ;

hash_partition_quantity
    : UNSIGNED_INTEGER
    ;

composite_range_partitions
    : PARTITION BY RANGE '(' column_name (',' column_name)* ')' (
        INTERVAL '(' expression ')' (STORE IN '(' tablespace (',' tablespace)* ')')?
    )? (subpartition_by_range | subpartition_by_list | subpartition_by_hash) '(' range_partition_desc (
        ',' range_partition_desc
    )* ')'
    ;

composite_list_partitions
    : PARTITION BY LIST '(' column_name ')' (
        subpartition_by_range
        | subpartition_by_list
        | subpartition_by_hash
    ) '(' list_partition_desc (',' list_partition_desc)* ')'
    ;

composite_hash_partitions
    : PARTITION BY HASH '(' (',' column_name)+ ')' (
        subpartition_by_range
        | subpartition_by_list
        | subpartition_by_hash
    ) (individual_hash_partitions | hash_partitions_by_quantity)
    ;

reference_partitioning
    : PARTITION BY REFERENCE '(' constraint_name ')' (
        '(' reference_partition_desc (',' reference_partition_desc)* ')'
    )?
    ;

reference_partition_desc
    : PARTITION partition_name? table_partition_description
    ;

system_partitioning
    : PARTITION BY SYSTEM (
        PARTITIONS UNSIGNED_INTEGER
        | reference_partition_desc (',' reference_partition_desc)*
    )?
    ;

range_partition_desc
    : PARTITION partition_name? range_values_clause? table_partition_description (
        (
            '(' (
                range_subpartition_desc (',' range_subpartition_desc)*
                | list_subpartition_desc (',' list_subpartition_desc)*
                | individual_hash_subparts (',' individual_hash_subparts)*
            ) ')'
            | hash_subparts_by_quantity
        )
    )?
    ;

list_partition_desc
    : PARTITION partition_name? list_values_clause? table_partition_description (
        (
            '(' (
                range_subpartition_desc (',' range_subpartition_desc)*
                | list_subpartition_desc (',' list_subpartition_desc)*
                | individual_hash_subparts (',' individual_hash_subparts)*
            ) ')'
            | hash_subparts_by_quantity
        )
    )?
    ;

subpartition_template
    : SUBPARTITION TEMPLATE (
        (
            '(' (
                range_subpartition_desc (',' range_subpartition_desc)*
                | list_subpartition_desc (',' list_subpartition_desc)*
                | individual_hash_subparts (',' individual_hash_subparts)*
            ) ')'
            | hash_subpartition_quantity
        )
    )
    ;

hash_subpartition_quantity
    : UNSIGNED_INTEGER
    ;

subpartition_by_range
    : SUBPARTITION BY RANGE '(' column_name (',' column_name)* ')' subpartition_template?
    ;

subpartition_by_list
    : SUBPARTITION BY LIST '(' column_name ')' subpartition_template?
    ;

subpartition_by_hash
    : SUBPARTITION BY HASH '(' column_name (',' column_name)* ')' (
        SUBPARTITIONS UNSIGNED_INTEGER (STORE IN '(' tablespace (',' tablespace)* ')')?
        | subpartition_template
    )?
    ;

subpartition_name
    : partition_name
    ;

range_subpartition_desc
    : SUBPARTITION subpartition_name? range_values_clause partitioning_storage_clause?
    ;

list_subpartition_desc
    : SUBPARTITION subpartition_name? list_values_clause partitioning_storage_clause?
    ;

individual_hash_subparts
    : SUBPARTITION subpartition_name? partitioning_storage_clause?
    ;

hash_subparts_by_quantity
    : SUBPARTITIONS UNSIGNED_INTEGER (STORE IN '(' tablespace (',' tablespace)* ')')?
    ;

range_values_clause
    : VALUES LESS THAN '(' range_values_list ')'
    ;

range_values_list
    : literal (',' literal)*
    | TIMESTAMP literal (',' TIMESTAMP literal)*
    ;

list_values_clause
    : VALUES '(' (literal (',' literal)* | TIMESTAMP literal (',' TIMESTAMP literal)* | DEFAULT) ')'
    ;

table_partition_description
    : (INTERNAL | EXTERNAL)? deferred_segment_creation? read_only_clause? indexing_clause? segment_attributes_clause? (
        table_compression
        | key_compression
    )? inmemory_table_clause? ilm_clause? (
        OVERFLOW_ segment_attributes_clause?
    )? (lob_storage_clause | varray_col_properties | nested_table_col_properties)*
    ;

partitioning_storage_clause
    : (
        TABLESPACE tablespace
        | OVERFLOW_ (TABLESPACE tablespace)?
        | table_compression
        | key_compression
        | inmemory_table_clause
        | lob_partitioning_storage
        | VARRAY varray_item STORE AS (BASICFILE | SECUREFILE)? LOB lob_segname
    )+
    ;

lob_partitioning_storage
    : LOB '(' lob_item ')' STORE AS (BASICFILE | SECUREFILE)? (
        lob_segname ('(' TABLESPACE tablespace ')')?
        | '(' TABLESPACE tablespace ')'
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/size_clause.html
// Technically, this should only allow 'K' | 'M' | 'G' | 'T' | 'P' | 'E'
// but having issues with examples/numbers01.sql line 11 "sysdate -1m"
size_clause
    : UNSIGNED_INTEGER (K_LETTER | M_LETTER | G_LETTER | T_LETTER | P_LETTER | E_LETTER)?
    ;

table_compression
    : COMPRESS (
        BASIC
        | FOR (
            OLTP
            | (QUERY | ARCHIVE) (LOW | HIGH)?
            | ALL OPERATIONS
            | DIRECT_LOAD OPERATIONS
        )
    )?
    | ROW STORE COMPRESS (BASIC | ADVANCED)?
    | COLUMN STORE COMPRESS (FOR (QUERY | ARCHIVE) (LOW | HIGH)?)? (NO? ROW LEVEL LOCKING)?
    | NOCOMPRESS
    ;

// avoid to match an empty string in
inmemory_table_clause
    : inmemory_column_clause+
    | (INMEMORY inmemory_attributes? | NO INMEMORY) inmemory_column_clause*
    ;

inmemory_attributes
    : (
        inmemory_memcompress
        | inmemory_priority
        | inmemory_distribute
        | inmemory_duplicate
    )+
    ;

inmemory_memcompress
    : MEMCOMPRESS FOR (DML | (QUERY | CAPACITY) (LOW | HIGH)?)
    | NO MEMCOMPRESS
    ;

inmemory_priority
    : PRIORITY (NONE | LOW | MEDIUM | HIGH | CRITICAL)
    ;

inmemory_distribute
    : DISTRIBUTE (AUTO | BY (ROWID RANGE | PARTITION | SUBPARTITION))? (
        FOR SERVICE (DEFAULT | ALL | identifier | NONE)
    )?
    ;

inmemory_duplicate
    : DUPLICATE ALL?
    | NO DUPLICATE
    ;

inmemory_column_clause
    : (INMEMORY inmemory_memcompress? | NO INMEMORY) '(' column_list ')'
    ;

physical_attributes_clause
    : (
        PCTFREE pctfree = UNSIGNED_INTEGER
        | PCTUSED pctused = UNSIGNED_INTEGER
        | INITRANS inittrans = UNSIGNED_INTEGER
        | MAXTRANS maxtrans = UNSIGNED_INTEGER
        | storage_clause
        | compute_clauses
    )+
    ;

storage_clause
    : STORAGE '(' (
        INITIAL initial_size = size_clause
        | NEXT next_size = size_clause
        | MINEXTENTS minextents = (UNSIGNED_INTEGER | UNLIMITED)
        | MAXEXTENTS minextents = (UNSIGNED_INTEGER | UNLIMITED)
        | PCTINCREASE pctincrease = UNSIGNED_INTEGER
        | FREELISTS freelists = UNSIGNED_INTEGER
        | FREELIST GROUPS freelist_groups = UNSIGNED_INTEGER
        | OPTIMAL (size_clause | NULL_)
        | BUFFER_POOL (KEEP | RECYCLE | DEFAULT)
        | FLASH_CACHE (KEEP | NONE | DEFAULT)
        | CELL_FLASH_CACHE (KEEP | NONE | DEFAULT)
        | ENCRYPT
    )+ ')'
    ;

deferred_segment_creation
    : SEGMENT CREATION (IMMEDIATE | DEFERRED)
    ;

segment_attributes_clause
    : (
        physical_attributes_clause
        | TABLESPACE (tablespace_name = id_expression | SET? identifier)
        | table_compression
        | logging_clause
    )+
    ;

physical_properties
    : deferred_segment_creation
    | segment_attributes_clause
    | table_compression
    | inmemory_table_clause
    | ilm_clause
    | ORGANIZATION (
        HEAP segment_attributes_clause? heap_org_table_clause
        | INDEX segment_attributes_clause? index_org_table_clause?
        | EXTERNAL external_table_clause
    )
    | EXTERNAL PARTITION ATTRIBUTES external_table_clause (REJECT LIMIT)?
    | CLUSTER cluster_name '(' column_name (',' column_name)* ')'
    ;

ilm_clause
    : ILM (
        ADD POLICY ilm_policy_clause
        | (DELETE | ENABLE | DISABLE) POLICY ilm_policy_clause
        | DELETE_ALL
        | ENABLE_ALL
        | DISABLE_ALL
    )
    ;

ilm_policy_clause
    : ilm_compression_policy
    | ilm_tiering_policy
    | ilm_inmemory_policy
    ;

ilm_compression_policy
    : table_compression segment_group ilm_after_on
    | ((ROW | COLUMN) STORE COMPRESS (ADVANCED | FOR QUERY)) ROW AFTER ilm_time_period OF NO MODIFICATION
    ;

ilm_tiering_policy
    : TIER TO tablespace (
        segment_group? (ON function_name)?
        | READ ONLY segment_group? ilm_after_on
    )
    ;

ilm_after_on
    : AFTER ilm_time_period OF (NO (ACCESS | MODIFICATION) | CREATION)
    | ON function_name
    ;

segment_group
    : SEGMENT
    | GROUP
    ;

ilm_inmemory_policy
    : (SET INMEMORY inmemory_attributes? | MODIFY INMEMORY inmemory_memcompress | NO INMEMORY) SEGMENT? ilm_after_on
    ;

ilm_time_period
    : numeric (DAY | DAYS | MONTH | MONTHS | YEAR | YEARS)
    ;

heap_org_table_clause
    : table_compression? inmemory_table_clause? ilm_clause?
    ;

external_table_clause
    : '(' (TYPE access_driver_type)? external_table_data_props ')' parallel_clause? (
        REJECT LIMIT (numeric | UNLIMITED)
    )? inmemory_table_clause?
    ;

access_driver_type
    : ORACLE_LOADER
    | ORACLE_DATAPUMP
    | ORACLE_HDFS
    | ORACLE_HIVE
    ;

external_table_data_props
    : (DEFAULT DIRECTORY external_table_directory)? (
        ACCESS PARAMETERS (
            '(' CHAR_STRING ')'
            | '(' external_table_data_format+ ')'
            | USING CLOB select_only_statement
        )
    )? (LOCATION '(' external_table_directory (',' external_table_directory)* ')')?
    ;

external_table_data_format
    : RECORDS DELIMITED BY NEWLINE_
    | COLUMN TRANSFORMS '(' external_table_transform (',' external_table_transform)* ')'
    | external_table_records
    | external_table_fields
    | external_table_datapump
    | external_table_hive
    ;

external_table_transform
    : column_name FROM (
        NULL_
        | CONSTANT quoted_string
        | (CONCAT | LOBFILE) (external_table_field | CONSTANT quoted_string)
        | (
            FROM '(' external_table_directory (',' external_table_directory)* ')'
            | CLOB
            | BLOB
            | CHARACTERSET '=' char_set_name
        )
        | STARTOF external_table_field_list '(' UNSIGNED_INTEGER ')'
    )
    ;

external_table_field
    : column_name type_name? (NOT NULL_)? default_value_part?
    ;

external_table_field_list
    : external_table_fields_clause (',' external_table_fields_clause)*
    ;

external_table_fields_clause
    : external_table_field (
        external_table_position_clause
        | external_table_datatype_clause
        | external_table_init_clause
        | external_table_lls_clause
    )*
    ;

external_table_position_clause
    : POSITION? '(' ('*'? ('+' | '-')? UNSIGNED_INTEGER?) (BINDVAR | (':' ('+' | '-')? UNSIGNED_INTEGER)) ')'
    ;

external_table_datatype_clause
    : UNSIGNED? INTEGER EXTERNAL? UNSIGNED_INTEGER? external_table_delimit_clause?
    | (DECIMAL | ZONED) (
        '(' UNSIGNED_INTEGER (',' UNSIGNED_INTEGER)? ')'
        | EXTERNAL ('(' UNSIGNED_INTEGER ')')? external_table_delimit_clause?
    )
    | ORACLE_DATE
    | ORACLE_NUMBER COUNTED?
    | FLOAT EXTERNAL? UNSIGNED_INTEGER? external_table_delimit_clause?
    | DOUBLE
    | BINARY_FLOAT EXTERNAL? UNSIGNED_INTEGER? external_table_delimit_clause?
    | BINARY_DOUBLE
    | RAW UNSIGNED_INTEGER?
    | CHAR EXTERNAL? ('(' UNSIGNED_INTEGER ')' )? external_table_delimit_clause? external_table_trim_clause? external_table_date_format_clause?
    | (VARCHAR | VARRAW | VARCHARC | VARRAWC) '(' (UNSIGNED_INTEGER ',')? UNSIGNED_INTEGER ')'
    ;

external_table_delimit_clause
    : ENCLOSED BY quoted_string (AND quoted_string)?
    | TERMINATED BY (quoted_string | WHITESPACE) (OPTIONALLY? ENCLOSED BY quoted_string (AND quoted_string)?)?
    ;

external_table_trim_clause
    : LRTRIM
    | NOTRIM
    | LTRIM
    | RTRIM
    | LDRTRIM
    ;

external_table_date_format_clause
    : DATE_FORMAT? (
        DATE
        | TIMESTAMP (WITH LOCAL? TIME ZONE)? MASK quoted_string
        | INTERVAL (YEAR_TO_MONTH | DAY_TO_SECOND)
    )
    ;

external_table_init_clause
    : (DEFAULTIF | NULLIF) external_table_condition_clause
    ;

external_table_condition_clause
    : (field_spec | '(' UNSIGNED_INTEGER BINDVAR ')') relational_operator (quoted_string | HEX_STRING_LIT | BLANKS)
    | external_table_condition_clause (AND | OR) external_table_condition_clause
    ;

external_table_lls_clause
    : LLS external_table_directory
    ;

external_table_records
    : RECORDS (
        FIXED UNSIGNED_INTEGER
        | VARIABLE UNSIGNED_INTEGER
        | DELIMITED BY (DETECTED? NEWLINE_ | quoted_string)
        | XMLTAG '('? id_expression (',' id_expression)* ')'?
    ) external_table_record_options_clause*
    | external_table_record_options_clause+
    ;

external_table_record_options_clause
    : CHARACTERSET char_set_name
    | EXTERNAL VARIABLE DATA
    | PREPROCESSOR external_table_directory
    | DATA IS (LITTLE | BIG) ENDIAN
    | BYTEORDERMARK (CHECK | NOCHECK)
    | STRING SIZES ARE IN (BYTES | CHARACTERS)
    | LOAD WHEN external_table_condition_clause
    | external_table_output_files
    | READSIZE '='? UNSIGNED_INTEGER
    | DISABLE_DIRECTORY_LINK_CHECK
    | DATE_CACHE UNSIGNED_INTEGER
    | SKIP_ UNSIGNED_INTEGER
    | IO_OPTIONS (DIRECTIO | NODIRECTIO)
    | (DNFS_ENABLE | DNFS_DISABLE)
    | DNFS_READBUFFERS UNSIGNED_INTEGER
    ;

external_table_output_files
    : (
        (NOBADFILE | NODISCARDFILE | NOLOGFILE)
        | (BADFILE | DISCARDFILE | LOGFILE) external_table_directory? filename
    )
    ;

external_table_fields
    : FIELDS
        IGNORE_CHARS_AFTER_EOR?
        (CSV (WITH | WITHOUT) EMBEDDED)?
        external_table_delimit_clause?
        external_table_trim_clause?
        (ALL FIELDS OVERRIDE THESE FIELDS)?
        (MISSING FIELD VALUES ARE NULL_)?
        (REJECT ROWS WITH ALL NULL_ FIELDS)?
        (DATE_FORMAT (DATE | TIMESTAMP) MASK quoted_string)?
        (NULLIF (EQUALS_OP | NOT_EQUAL_OP) (quoted_string | HEX_STRING_LIT | BLANKS) | NONULLIF)?
        '('? external_table_field_list? ')'?
    ;

external_table_datapump
    : ENCRYPTION (ENABLE | DISABLED)
    | NOLOGFILE
    | LOGFILE external_table_directory? filename
    | COMPRESSION (ENABLED (BASIC | LOW | MEDIUM | HIGH)? | DISABLED)?
    | HADOOP_TRAILERS (ENABLED | DISABLED) VERSION (COMPATIBLE | LATEST | quoted_string)
    | NOLOG
    | DEBUG '=' '(' UNSIGNED_INTEGER ',' UNSIGNED_INTEGER ')'
    | DATAPUMP INTERNAL TABLE tableview_name
    | TEMPLATE_TABLE tableview_name
    | JOB '(' schema_name ',' tableview_name ',' UNSIGNED_INTEGER ')'
    | WORKERID UNSIGNED_INTEGER
    | PARALLEL UNSIGNED_INTEGER
    | VERSION quoted_string
    | ENCRYPTPASSWORDISNULL
    | DBLINK quoted_string
    ;

external_table_hive
    : id_expression ('.' id_expression)* ('=' | ':') (
        tableview_name
        | external_table_hive_parameter_map
        | '[' external_table_hive_parameter_map (',' external_table_hive_parameter_map)* ']'
        | external_table_field datatype (COMMENT quoted_string)? (',' COMMENT quoted_string)*
        | SEQUENCEFILE
        | TEXTFILE
        | RCFILE
        | ORC
        | PARQUET
        | INPUTFORMAT quoted_string OUTPUTFORMAT quoted_string
        | external_table_directory
        | DELIMITED? (
            FIELDS TERMINATED BY CHARACTER (ESCAPED BY CHARACTER)
            | (COLLECTION ITEMS | MAP KEYS | LINES ) TERMINATED BY CHARACTER
            | NULL_ DEFINED AS CHARACTER
        )
        | SERDE quoted_string (
            WITH SERDEPROPERTIES (
                quoted_string '=' quoted_string (',' quoted_string '=' quoted_string)*
            )
        )?
    ) external_table_hive?
    ;

external_table_hive_parameter_map
    : LEFT_CURLY_PAREN (external_table_hive_parameter_map_entry (',' external_table_hive_parameter_map_entry)*) RIGHT_CURLY_PAREN
    ;

external_table_hive_parameter_map_entry
    : id_expression BINDVAR
    | id_expression ':' '[' id_expression (',' id_expression)* ']'
    | '[' id_expression (',' id_expression)* ']'
    ;

external_table_directory
    : directory_name COLON CHAR_STRING
    | (directory_name object_name? COLON)? CHAR_STRING
    | quoted_string
    | variable_name
    ;

row_movement_clause
    : (ENABLE | DISABLE)? ROW MOVEMENT
    ;

flashback_archive_clause
    : FLASHBACK ARCHIVE fa = id_expression?
    | NO FLASHBACK ARCHIVE
    ;

log_grp
    : UNSIGNED_INTEGER
    | identifier
    ;

supplemental_table_logging
    : ADD SUPPLEMENTAL LOG (supplemental_log_grp_clause | supplemental_id_key_clause) (
        ',' SUPPLEMENTAL LOG (supplemental_log_grp_clause | supplemental_id_key_clause)
    )*
    | DROP SUPPLEMENTAL LOG (supplemental_id_key_clause | GROUP log_grp) (
        ',' SUPPLEMENTAL LOG (supplemental_id_key_clause | GROUP log_grp)
    )*
    ;

supplemental_log_grp_clause
    : GROUP log_grp '(' column_name (NO LOG)? (',' column_name (NO LOG)?)* ')' ALWAYS?
    ;

supplemental_id_key_clause
    : DATA '(' (','? ( ALL | PRIMARY KEY | UNIQUE INDEX? | FOREIGN KEY))+ ')' COLUMNS
    ;

allocate_extent_clause
    : ALLOCATE EXTENT (
        '(' (
            SIZE size_clause
            | DATAFILE datafile = CHAR_STRING
            | INSTANCE inst_num = UNSIGNED_INTEGER
        )+ ')'
    )?
    ;

deallocate_unused_clause
    : DEALLOCATE UNUSED (KEEP size_clause)?
    ;

// CHECK is an internal, undocumented Oracle option that is allowed and sometimes specified, used to check for proper
// segment type and segment attributes allowed to shrink.
shrink_clause
    : SHRINK SPACE_KEYWORD COMPACT? CASCADE? CHECK?
    ;

records_per_block_clause
    : (MINIMIZE | NOMINIMIZE)? RECORDS_PER_BLOCK
    ;

upgrade_table_clause
    : UPGRADE (NOT? INCLUDING DATA) column_properties
    ;

truncate_table
    : TRUNCATE TABLE tableview_name ((PRESERVE | PURGE) (MATERIALIZED VIEW LOG)?)? ((DROP ALL? | REUSE) STORAGE)? CASCADE?
    ;

drop_table
    : DROP TABLE tableview_name (IF EXISTS)? (AS tableview_name)? (CASCADE (CONSTRAINT | CONSTRAINTS))? PURGE? (AS table_alias)? FORCE?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-TABLESPACE.html
drop_tablespace
    : DROP TABLESPACE ts = id_expression (IF EXISTS)? ((DROP | KEEP) QUOTA?)? including_contents_clause?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-TABLESPACE-SET.html
drop_tablespace_set
    : DROP TABLESPACE SET tss = id_expression including_contents_clause?
    ;

including_contents_clause
    : INCLUDING CONTENTS ((AND | KEEP) DATAFILES)? (CASCADE CONSTRAINTS)?
    ;

drop_view
    : DROP VIEW tableview_name (IF EXISTS)? (CASCADE CONSTRAINT)?
    ;

comment_on_column
    : COMMENT ON COLUMN column_name IS quoted_string
    ;

enable_or_disable
    : ENABLE
    | DISABLE
    ;

allow_or_disallow
    : ALLOW
    | DISALLOW
    ;

// Synonym DDL Clauses

alter_synonym
    : ALTER PUBLIC? SYNONYM (schema_name '.')? synonym_name (
        EDITIONABLE
        | NONEDITIONABLE
        | COMPILE
    )
    ;

create_synonym
    // Synonym's schema cannot be specified for public synonyms
    : CREATE (OR REPLACE)? PUBLIC SYNONYM synonym_name FOR (schema_name PERIOD)? schema_object_name (
        AT_SIGN link_name
    )?
    | CREATE (OR REPLACE)? SYNONYM (schema_name PERIOD)? synonym_name FOR (schema_name PERIOD)? schema_object_name (
        AT_SIGN (schema_name PERIOD)? link_name
    )?
    ;

drop_synonym
    : DROP PUBLIC? SYNONYM (schema_name '.')? synonym_name FORCE?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-SPFILE.html
create_spfile
    : CREATE SPFILE ('=' spfile_name)? FROM (PFILE ('=' pfile_name)? (AS COPY)? | MEMORY)
    ;

spfile_name
    : CHAR_STRING
    ;

pfile_name
    : CHAR_STRING
    ;

comment_on_table
    : COMMENT ON TABLE tableview_name IS quoted_string
    ;

comment_on_materialized
    : COMMENT ON MATERIALIZED VIEW tableview_name IS quoted_string
    ;

alter_analytic_view
    : ALTER ANALYTIC VIEW (schema_name '.')? av = id_expression (
        RENAME TO id_expression
        | COMPILE
        | alter_add_cache_clause
        | alter_drop_cache_clause
    )
    ;

alter_add_cache_clause
    : ADD CACHE MEASURE GROUP '(' (ALL | measure_list)? ')' LEVELS '(' levels_item (
        ',' levels_item
    )* ')'
    ;

levels_item
    : ((d = id_expression '.')? h = id_expression '.')? l = id_expression
    ;

measure_list
    : id_expression (',' id_expression)*
    ;

alter_drop_cache_clause
    : DROP CACHE MEASURE GROUP '(' (ALL | measure_list)? ')' LEVELS '(' levels_item (
        ',' levels_item
    )* ')'
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-ATTRIBUTE-DIMENSION.html
alter_attribute_dimension
    : ALTER ATTRIBUTE DIMENSION (schema_name '.')? ad = id_expression (
        RENAME TO nad = id_expression
        | COMPILE
    )
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-AUDIT-POLICY-Unified-Auditing.html
alter_audit_policy
    : ALTER AUDIT POLICY p = id_expression ADD? (
        privilege_audit_clause? action_audit_clause? role_audit_clause?
        | (ONLY TOPLEVEL)?
    ) DROP? (privilege_audit_clause? action_audit_clause? role_audit_clause? | (ONLY TOPLEVEL)?) (
        CONDITION (DROP | CHAR_STRING EVALUATE PER (STATEMENT | SESSION | INSTANCE))
    )?
    ;

alter_cluster
    : ALTER CLUSTER cluster_name (
        physical_attributes_clause
        | SIZE size_clause
        | allocate_extent_clause
        | deallocate_unused_clause
        | cache_or_nocache
    )+ parallel_clause?
    ;

drop_analytic_view
    : DROP ANALYTIC VIEW (schema_name '.')? av = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-ATTRIBUTE-DIMENSION.html
drop_attribute_dimension
    : DROP ATTRIBUTE DIMENSION (schema_name '.')? ad = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-AUDIT-POLICY-Unified-Auditing.html
drop_audit_policy
    : DROP AUDIT POLICY p = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-FLASHBACK-ARCHIVE.html
drop_flashback_archive
    : DROP FLASHBACK ARCHIVE fa = id_expression
    ;

drop_cluster
    : DROP CLUSTER cluster_name (INCLUDING TABLES (CASCADE CONSTRAINTS)?)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-CONTEXT.html
drop_context
    : DROP CONTEXT ns = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-DIRECTORY.html
drop_directory
    : DROP DIRECTORY dn = id_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-DISKGROUP.html
drop_diskgroup
    : DROP DISKGROUP dgn = id_expression ((FORCE? INCLUDING | EXCLUDING) CONTENTS)?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-EDITION.html
drop_edition
    : DROP EDITION e = id_expression CASCADE?
    ;

truncate_cluster
    : TRUNCATE CLUSTER cluster_name ((DROP | REUSE) STORAGE)?
    ;

cache_or_nocache
    : CACHE
    | NOCACHE
    ;

database_name
    : id_expression
    ;

alter_database
    : ALTER database_clause (
        startup_clauses
        | recovery_clauses
        | database_file_clauses
        | logfile_clauses
        | controlfile_clauses
        | standby_database_clauses
        | default_settings_clause
        | instance_clauses
        | security_clause
        | prepare_clause
        | drop_mirror_clause
        | lost_write_protection
        | cdb_fleet_clauses
        | property_clauses
        | replay_upgrade_clauses
    )
    ;

database_clause
    : PLUGGABLE? DATABASE database_name?
    ;

startup_clauses
    : MOUNT ((STANDBY | CLONE) DATABASE)?
    | OPEN (READ WRITE)? resetlogs_or_noresetlogs? upgrade_or_downgrade?
    | OPEN READ ONLY
    ;

resetlogs_or_noresetlogs
    : RESETLOGS
    | NORESETLOGS
    ;

upgrade_or_downgrade
    : UPGRADE
    | DOWNGRADE
    ;

recovery_clauses
    : general_recovery
    | managed_standby_recovery
    | begin_or_end BACKUP
    ;

begin_or_end
    : BEGIN
    | END
    ;

general_recovery
    : RECOVER AUTOMATIC? (FROM CHAR_STRING)? (
        (full_database_recovery | partial_database_recovery | LOGFILE CHAR_STRING)? (
            (TEST | ALLOW UNSIGNED_INTEGER CORRUPTION | parallel_clause)+
        )?
        | CONTINUE DEFAULT?
        | CANCEL
    )
    ;

//Need to come back to
full_database_recovery
    : STANDBY? DATABASE (
        (
            UNTIL (CANCEL | TIME CHAR_STRING | CHANGE UNSIGNED_INTEGER | CONSISTENT)
            | USING BACKUP CONTROLFILE
            | SNAPSHOT TIME CHAR_STRING
        )+
    )?
    ;

partial_database_recovery
    : TABLESPACE tablespace (',' tablespace)*
    | DATAFILE CHAR_STRING
    | filenumber (',' CHAR_STRING | filenumber)*
    | partial_database_recovery_10g
    ;

partial_database_recovery_10g
    : {this.isVersion10()}? STANDBY (
        TABLESPACE tablespace (',' tablespace)*
        | DATAFILE CHAR_STRING
        | filenumber (',' CHAR_STRING | filenumber)*
    ) UNTIL (CONSISTENT WITH)? CONTROLFILE
    ;

managed_standby_recovery
    : RECOVER (
        MANAGED STANDBY DATABASE (
            (
                USING CURRENT LOGFILE
                | DISCONNECT (FROM SESSION)?
                | NODELAY
                | UNTIL CHANGE UNSIGNED_INTEGER
                | UNTIL CONSISTENT
                | parallel_clause
            )+
            | FINISH
            | CANCEL
        )?
        | TO LOGICAL STANDBY (db_name | KEEP IDENTITY)
    )
    ;

db_name
    : regular_id
    ;

database_file_clauses
    : RENAME FILE filename (',' filename)* TO filename
    | create_datafile_clause
    | alter_datafile_clause
    | alter_tempfile_clause
    | move_datafile_clause
    ;

create_datafile_clause
    : CREATE DATAFILE (filename | filenumber) (',' (filename | filenumber))* (
        AS (
            //TODO (','? file_specification)+ |
            NEW
        )
    )?
    ;

alter_datafile_clause
    : DATAFILE (filename | filenumber) (',' (filename | filenumber))* (
        ONLINE
        | OFFLINE (FOR DROP)?
        | RESIZE size_clause
        | autoextend_clause
        | END BACKUP
    )
    ;

alter_tempfile_clause
    : TEMPFILE (filename | filenumber) (',' (filename | filenumber))* (
        RESIZE size_clause
        | autoextend_clause
        | DROP (INCLUDING DATAFILES)
        | ONLINE
        | OFFLINE
    )
    ;

move_datafile_clause
    : MOVE DATAFILE (filename | filenumber) (',' (filename | filenumber))* (TO filename)? REUSE? KEEP?
    ;

logfile_clauses
    : (ARCHIVELOG MANUAL? | NOARCHIVELOG)
    | NO? FORCE LOGGING
    | SET STANDBY NOLOGGING FOR (DATA AVAILABILITY | LOAD PERFORMANCE)
    | RENAME FILE filename (',' filename)* TO filename
    | CLEAR UNARCHIVED? LOGFILE logfile_descriptor (',' logfile_descriptor)* (
        UNRECOVERABLE DATAFILE
    )?
    | add_logfile_clauses
    | drop_logfile_clauses
    | switch_logfile_clause
    | supplemental_db_logging
    ;

add_logfile_clauses
    : ADD STANDBY? LOGFILE (
        (INSTANCE CHAR_STRING | THREAD UNSIGNED_INTEGER)? group_redo_logfile+
        | MEMBER filename REUSE? (',' filename REUSE?)* TO logfile_descriptor (
            ',' logfile_descriptor
        )*
    )
    ;

group_redo_logfile
    : (GROUP UNSIGNED_INTEGER)? redo_log_file_spec
    ;

drop_logfile_clauses
    : DROP STANDBY? LOGFILE (
        logfile_descriptor (',' logfile_descriptor)*
        | MEMBER filename (',' filename)*
    )
    ;

switch_logfile_clause
    : SWITCH ALL LOGFILES TO BLOCKSIZE UNSIGNED_INTEGER
    ;

supplemental_db_logging
    : add_or_drop SUPPLEMENTAL LOG (DATA | supplemental_id_key_clause | supplemental_plsql_clause)
    ;

add_or_drop
    : ADD
    | DROP
    ;

supplemental_plsql_clause
    : DATA FOR PROCEDURAL REPLICATION
    ;

logfile_descriptor
    : GROUP UNSIGNED_INTEGER
    | '(' filename (',' filename)* ')'
    | filename
    ;

controlfile_clauses
    : CREATE (LOGICAL | PHYSICAL)? STANDBY CONTROLFILE AS filename REUSE?
    | BACKUP CONTROLFILE TO (filename REUSE? | trace_file_clause)
    ;

trace_file_clause
    : TRACE (AS filename REUSE?)? (RESETLOGS | NORESETLOGS)?
    ;

standby_database_clauses
    : (
        activate_standby_db_clause
        | maximize_standby_db_clause
        | register_logfile_clause
        | commit_switchover_clause
        | start_standby_clause
        | stop_standby_clause
        | convert_database_clause
    ) parallel_clause?
    ;

activate_standby_db_clause
    : ACTIVATE (PHYSICAL | LOGICAL)? STANDBY DATABASE (FINISH APPLY)?
    ;

maximize_standby_db_clause
    : SET STANDBY DATABASE TO MAXIMIZE (PROTECTION | AVAILABILITY | PERFORMANCE)
    ;

register_logfile_clause
    : REGISTER (OR REPLACE)? (PHYSICAL | LOGICAL) LOGFILE //TODO (','? file_specification)+
    //TODO   (FOR logminer_session_name)?
    ;

commit_switchover_clause
    : (PREPARE | COMMIT) TO SWITCHOVER (
        (
            TO (
                ((PHYSICAL | LOGICAL)? PRIMARY | PHYSICAL? STANDBY) (
                    (WITH | WITHOUT)? SESSION SHUTDOWN (WAIT | NOWAIT)
                )?
                | LOGICAL STANDBY
            )
            | LOGICAL STANDBY
        )
        | CANCEL
    )?
    ;

start_standby_clause
    : START LOGICAL STANDBY APPLY IMMEDIATE? NODELAY? (
        NEW PRIMARY regular_id
        | INITIAL scn_value = UNSIGNED_INTEGER?
        | SKIP_ FAILED TRANSACTION
        | FINISH
    )?
    ;

stop_standby_clause
    : (STOP | ABORT) LOGICAL STANDBY APPLY
    ;

convert_database_clause
    : CONVERT TO (PHYSICAL | SNAPSHOT) STANDBY
    ;

default_settings_clause
    : DEFAULT EDITION EQUALS_OP edition_name
    | SET DEFAULT (BIGFILE | SMALLFILE) TABLESPACE
    | DEFAULT TABLESPACE tablespace
    | DEFAULT TEMPORARY TABLESPACE (tablespace | tablespace_group_name)
    | RENAME GLOBAL_NAME TO database ('.' domain)+
    | ENABLE BLOCK CHANGE TRACKING (USING FILE filename REUSE?)?
    | DISABLE BLOCK CHANGE TRACKING
    | flashback_mode_clause
    | set_time_zone_clause
    ;

set_time_zone_clause
    : SET TIME_ZONE EQUALS_OP CHAR_STRING
    ;

instance_clauses
    : enable_or_disable INSTANCE CHAR_STRING
    ;

security_clause
    : GUARD (ALL | STANDBY | NONE)
    ;

domain
    : id_expression
    ;

database
    : id_expression
    ;

edition_name
    : regular_id
    ;

filenumber
    : UNSIGNED_INTEGER
    ;

filename
    : CHAR_STRING
    ;

prepare_clause
    : PREPARE MIRROR COPY c = id_expression (WITH (UNPROTECTED | MIRROR | HIGH) REDUNDANCY)? (
        FOR DATABASE id_expression
    )?
    ;

drop_mirror_clause
    : DROP MIRROR COPY mn = id_expression
    ;

lost_write_protection
    : (ENABLE | DISABLE | REMOVE | SUSPEND) LOST WRITE PROTECTION
    ;

cdb_fleet_clauses
    : lead_cdb_clause
    | lead_cdb_uri_clause
    ;

lead_cdb_clause
    : SET LEAD_CDB '=' (TRUE | FALSE)
    ;

lead_cdb_uri_clause
    : SET LEAD_CDB_URI '=' CHAR_STRING
    ;

property_clauses
    : PROPERTY (SET | REMOVE) DEFAULT_CREDENTIAL '=' qcn = id_expression
    ;

replay_upgrade_clauses
    : UPGRADE SYNC (ON | OFF)
    ;

alter_database_link
    : ALTER SHARED? PUBLIC? DATABASE LINK local_link_name (
        CONNECT TO user_object_name IDENTIFIED BY password_value link_authentication?
        | link_authentication
    )
    ;

password_value
    : id_expression
    | numeric
    | VALUES CHAR_STRING
    ;

link_authentication
    : AUTHENTICATED BY user_object_name IDENTIFIED BY password_value
    ;

//https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/CREATE-SCHEMA.html
create_schema
    : CREATE SCHEMA AUTHORIZATION schema_name (create_table | create_view | grant_statement)*
    ;

// added by zrh
create_database
    : CREATE DATABASE database_name (
        USER (SYS | SYSTEM) IDENTIFIED BY password_value
        | CONTROLFILE REUSE
        | (MAXDATAFILES | MAXINSTANCES) UNSIGNED_INTEGER
        | NATIONAL? CHARACTER SET char_set_name
        | SET DEFAULT (BIGFILE | SMALLFILE) TABLESPACE
        | database_logging_clauses
        | tablespace_clauses
        | set_time_zone_clause
        | (BIGFILE | SMALLFILE)? USER_DATA TABLESPACE tablespace_group_name DATAFILE datafile_tempfile_spec (
            ',' datafile_tempfile_spec
        )*
        | enable_pluggable_database
    )+
    ;

database_logging_clauses
    : LOGFILE database_logging_sub_clause (',' database_logging_sub_clause)*
    | (MAXLOGFILES | MAXLOGMEMBERS | MAXLOGHISTORY) UNSIGNED_INTEGER
    | ARCHIVELOG
    | NOARCHIVELOG
    | FORCE LOGGING
    ;

database_logging_sub_clause
    : (GROUP UNSIGNED_INTEGER)? file_specification
    ;

tablespace_clauses
    : EXTENT MANAGEMENT LOCAL
    | SYSAUX? DATAFILE file_specification (',' file_specification)*
    | default_tablespace
    | default_temp_tablespace
    | undo_tablespace
    ;

enable_pluggable_database
    : ENABLE PLUGGABLE DATABASE (
        SEED file_name_convert? (SYSTEM tablespace_datafile_clauses)? (
            SYSAUX tablespace_datafile_clauses
        )?
    )? undo_mode_clause?
    ;

file_name_convert
    : FILE_NAME_CONVERT EQUALS_OP (
        '(' filename_convert_sub_clause (',' filename_convert_sub_clause)* ')'
        | NONE
    )
    ;

filename_convert_sub_clause
    : CHAR_STRING (',' CHAR_STRING)?
    ;

tablespace_datafile_clauses
    : DATAFILES (SIZE size_clause | autoextend_clause)+
    ;

undo_mode_clause
    : LOCAL UNDO (ON | OFF)
    ;

default_tablespace
    : DEFAULT TABLESPACE tablespace (DATAFILE datafile_tempfile_spec)? extent_management_clause?
    ;

default_temp_tablespace
    : (BIGFILE | SMALLFILE)? DEFAULT (
        TEMPORARY TABLESPACE
        | LOCAL TEMPORARY TABLESPACE FOR (ALL | LEAF)
    ) tablespace (TEMPFILE file_specification (',' file_specification)*)? extent_management_clause?
    ;

undo_tablespace
    : (BIGFILE | SMALLFILE)? UNDO TABLESPACE tablespace (
        DATAFILE file_specification (',' file_specification)*
    )?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/DROP-DATABASE.html
drop_database
    : DROP DATABASE (INCLUDING BACKUPS)? NOPROMPT?
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-DATABASE-LINK.html
create_database_link
    : CREATE SHARED? PUBLIC? DATABASE LINK link_name (
        CONNECT TO (
            CURRENT_USER
            | user_object_name IDENTIFIED BY password_value link_authentication?
        )
        | link_authentication
    )* (USING CHAR_STRING)?
    ;

drop_database_link
    : DROP PUBLIC? DATABASE LINK link_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/ALTER-TABLESPACE-SET.html
alter_tablespace_set
    : ALTER TABLESPACE SET tss = id_expression alter_tablespace_attrs
    ;

alter_tablespace_attrs
    : default_tablespace_params
    | MINIMUM EXTENT size_clause
    | RESIZE size_clause
    | COALESCE
    | SHRINK SPACE_KEYWORD (KEEP size_clause)?
    | RENAME TO nts = id_expression
    | (BEGIN | END) BACKUP
    | datafile_tempfile_clauses
    | tablespace_logging_clauses
    | tablespace_group_clause
    | tablespace_state_clauses
    | autoextend_clause
    | flashback_mode_clause
    | tablespace_retention_clause
    | alter_tablespace_encryption
    | lost_write_protection
    ;

alter_tablespace_encryption
    : ENCRYPTION (
        OFFLINE (tablespace_encryption_spec? ENCRYPT | DECRYPT)
        | ONLINE (tablespace_encryption_spec? (ENCRYPT | REKEY) | DECRYPT) ts_file_name_convert?
        | FINISH (ENCRYPT | REKEY | DECRYPT) ts_file_name_convert?
    )
    ;

ts_file_name_convert
    : FILE_NAME_CONVERT '=' '(' CHAR_STRING ',' CHAR_STRING (',' CHAR_STRING ',' CHAR_STRING)* ')' KEEP?
    ;

alter_role
    : ALTER ROLE role_name role_identified_clause container_clause?
    ;

role_identified_clause
    : NOT IDENTIFIED
    | IDENTIFIED (
        BY identifier
        | USING identifier ('.' id_expression)?
        | EXTERNALLY
        | GLOBALLY (AS CHAR_STRING)?
    )
    ;

alter_table
    : ALTER TABLE tableview_name (
        memoptimize_read_write_clause+ alter_table_body?
        | alter_table_body
    )
    ;

alter_table_body
    : alter_table_action enable_disable_clauses?
    | enable_disable_clauses
    ;

alter_table_action
    : alter_table_properties
    | constraint_clauses
    | column_clauses
    | alter_table_partitioning
    //TODO      | alter_external_table
    | move_table_clause
    | modify_to_partitioned
    ;

enable_disable_clauses
    : (enable_disable_clause | enable_or_disable (TABLE LOCK | ALL TRIGGERS))+
    ;

memoptimize_read_write_clause
    : NO? MEMOPTIMIZE FOR (READ | WRITE)
    ;

alter_table_properties
    : alter_table_properties_1
    | RENAME TO tableview_name
    | shrink_clause
    | READ ONLY
    | READ WRITE
    | REKEY CHAR_STRING
    | NO? ROW ARCHIVAL
    | annotations_clause
    ;

alter_table_partitioning
    : add_table_partition
    | drop_table_partition
    | merge_table_partition
    | modify_table_partition
    | split_table_partition
    | truncate_table_partition
    | exchange_table_partition
    | coalesce_table_partition
    | alter_interval_partition
    | move_table_partition
    | rename_table_partition
    ;

add_table_partition
    : ADD (
        range_partition_desc
        | list_partition_desc
        | PARTITION partition_name? (TABLESPACE tablespace)? key_compression? UNUSABLE?
    )
    ;

drop_table_partition
    : DROP (partition_extended_names | subpartition_extended_names) (
        update_index_clauses parallel_clause?
    )?
    ;

merge_table_partition
    : MERGE PARTITION partition_name AND partition_name INTO PARTITION partition_name
    ;

modify_table_partition
    : MODIFY (PARTITION | SUBPARTITION) partition_name ((ADD | DROP) list_values_clause)? (
        ADD range_subpartition_desc
    )? (REBUILD? UNUSABLE LOCAL INDEXES)? shrink_clause?
    ;

split_table_partition
    : SPLIT partition_extended_names (
        AT '(' literal (',' literal)* ')' INTO '(' range_partition_desc (',' range_partition_desc)* ')'
        | INTO '(' (
            range_partition_desc (',' range_partition_desc)*
            | list_partition_desc (',' list_partition_desc)*
        ) ')'
    ) (update_global_index_clause | update_index_clauses | ONLINE)?
    ;

truncate_table_partition
    : TRUNCATE (partition_extended_names | subpartition_extended_names) (
        (DROP ALL? | REUSE)? STORAGE
    )? CASCADE? (update_index_clauses parallel_clause?)?
    ;

exchange_table_partition
    : EXCHANGE PARTITION partition_name WITH TABLE tableview_name ((INCLUDING | EXCLUDING) INDEXES)? (
        (WITH | WITHOUT) VALIDATION
    )?
    ;

coalesce_table_partition
    : COALESCE PARTITION parallel_clause? (allow_or_disallow CLUSTERING)?
    ;

alter_interval_partition
    : SET INTERVAL '(' (constant | expression)? ')'
    ;

move_table_partition
    : MOVE (
        partition_extended_names (MAPPING TABLE)? table_partition_description
        | subpartition_extended_names indexing_clause? partitioning_storage_clause?
    ) (
        filter_condition
        | update_index_clauses
        | parallel_clause
        | allow_or_disallow CLUSTERING
        | ONLINE
    )*
    ;

filter_condition
    : INCLUDING ROWS where_clause
    ;

rename_table_partition
    : RENAME (partition_extended_names | subpartition_extended_names) TO partition_name
    ;

partition_extended_names
    : (PARTITION | PARTITIONS) (
        partition_name (',' partition_name)*
        | '(' partition_name (',' partition_name)* ')'
        | FOR '('? partition_key_value (',' partition_key_value)* ')'?
    )
    ;

subpartition_extended_names
    : (SUBPARTITION | SUBPARTITIONS) (
        partition_name (UPDATE INDEXES)?
        | '(' partition_name (',' partition_name)* ')'
        | FOR '('? subpartition_key_value (',' subpartition_key_value)* ')'?
    )
    ;

alter_table_properties_1
    : (
        physical_attributes_clause
        | logging_clause
        | table_compression
        | inmemory_table_clause
        | supplemental_table_logging
        | allocate_extent_clause
        | deallocate_unused_clause
        | (CACHE | NOCACHE)
        | RESULT_CACHE '(' MODE (DEFAULT | FORCE) ')'
        | upgrade_table_clause
        | records_per_block_clause
        | parallel_clause
        | row_movement_clause
        | logical_replication_clause
        | flashback_archive_clause
    )+ alter_iot_clauses?
    ;

alter_iot_clauses
    : index_org_table_clause
    | alter_overflow_clause
    | alter_mapping_table_clause
    | COALESCE
    ;

alter_mapping_table_clause
    : MAPPING TABLE (allocate_extent_clause | deallocate_unused_clause)
    ;

alter_overflow_clause
    : add_overflow_clause
    | OVERFLOW_ (
        segment_attributes_clause
        | allocate_extent_clause
        | shrink_clause
        | deallocate_unused_clause
    )+
    ;

add_overflow_clause
    : ADD OVERFLOW_ segment_attributes_clause? (
        '(' PARTITION segment_attributes_clause? (',' PARTITION segment_attributes_clause?)* ')'
    )?
    ;

update_index_clauses
    : update_global_index_clause
    | update_all_indexes_clause
    ;

update_global_index_clause
    : (UPDATE | INVALIDATE) GLOBAL INDEXES
    ;

update_all_indexes_clause
    : UPDATE INDEXES ('(' update_all_indexes_index_clause ')')?
    ;

update_all_indexes_index_clause
    : index_name '(' (update_index_partition | update_index_subpartition) ')' (
        ',' update_all_indexes_clause
    )*
    ;

update_index_partition
    : index_partition_description index_subpartition_clause? (',' update_index_partition)*
    ;

update_index_subpartition
    : SUBPARTITION subpartition_name? (TABLESPACE tablespace)? (',' update_index_subpartition)*
    ;

enable_disable_clause
    : (ENABLE | DISABLE) (VALIDATE | NOVALIDATE)? (
        UNIQUE '(' column_name (',' column_name)* ')'
        | PRIMARY KEY
        | CONSTRAINT constraint_name
    ) using_index_clause? exceptions_clause? CASCADE? ((KEEP | DROP) INDEX)?
    ;

using_index_clause
    : USING INDEX (index_name | '(' create_index ')' | index_properties)
    ;

index_attributes
    : (
        physical_attributes_clause
        | logging_clause
        | ONLINE
        | TABLESPACE (tablespace | DEFAULT)
        | key_compression
        | sort_or_nosort
        | REVERSE
        | visible_or_invisible
        | parallel_clause
    )+
    ;

sort_or_nosort
    : SORT
    | NOSORT
    ;

exceptions_clause
    : EXCEPTIONS INTO tableview_name
    ;

move_table_clause
    : MOVE ONLINE? segment_attributes_clause? table_compression? index_org_table_clause? (
        lob_storage_clause
        | varray_col_properties
    )* parallel_clause?
    ;

modify_to_partitioned
    : MODIFY (table_partitioning_clauses | NONPARTITIONED) filter_condition? ONLINE? update_index_clauses?
    ;

index_org_table_clause
    : (mapping_table_clause | PCTTHRESHOLD UNSIGNED_INTEGER | key_compression)+ index_org_overflow_clause?
    | index_org_overflow_clause // rule move_table_clause contains an optional block with at least one alternative that can match an empty string
    ;

mapping_table_clause
    : MAPPING TABLE
    | NOMAPPING
    ;

key_compression
    : NOCOMPRESS
    | COMPRESS UNSIGNED_INTEGER
    ;

index_org_overflow_clause
    : (INCLUDING column_name)? OVERFLOW_ segment_attributes_clause?
    ;

column_clauses
    : add_modify_drop_column_clauses
    | rename_column_clause
    | modify_collection_retrieval
    | modify_lob_storage_clause
    ;

modify_collection_retrieval
    : MODIFY NESTED TABLE collection_item RETURN AS (LOCATOR | VALUE)
    ;

collection_item
    : tableview_name
    ;

rename_column_clause
    : RENAME COLUMN old_column_name TO new_column_name
    ;

old_column_name
    : column_name
    ;

new_column_name
    : column_name
    ;

add_modify_drop_column_clauses
    : (constraint_clauses | add_column_clause | modify_column_clauses | drop_column_clause)+
    ;

drop_column_clause
    : SET UNUSED (COLUMN column_name | ('(' column_name (',' column_name)* ')')) (
        CASCADE CONSTRAINTS
        | INVALIDATE
    )*
    | DROP (COLUMN column_name | '(' column_name (',' column_name)* ')') (
        CASCADE CONSTRAINTS
        | INVALIDATE
    )* (CHECKPOINT UNSIGNED_INTEGER)?
    | DROP (UNUSED COLUMNS | COLUMNS CONTINUE) (CHECKPOINT UNSIGNED_INTEGER)
    ;

modify_column_clauses
    : MODIFY (
        '(' modify_col_properties (',' modify_col_properties)* ')'
        | '(' modify_col_visibility (',' modify_col_visibility)* ')'
        | modify_col_properties
        | modify_col_visibility
        | modify_col_substitutable
    )
    ;

modify_col_properties
    : column_name datatype? (
        DEFAULT (ON NULL_)? expression
        | identity_clause
        | DROP IDENTITY
    )? (ENCRYPT encryption_spec | DECRYPT)? inline_constraint* lob_storage_clause? annotations_clause?
    //TODO alter_xmlschema_clause
    ;

modify_col_visibility
    : column_name (VISIBLE | INVISIBLE)
    ;

modify_col_substitutable
    : COLUMN column_name NOT? SUBSTITUTABLE AT ALL LEVELS FORCE?
    ;

add_column_clause
    : ADD (
        '(' (column_definition | virtual_column_definition) (
            ',' (column_definition | virtual_column_definition)
        )* ')'
        | ( column_definition | virtual_column_definition)
    ) column_properties?
    ;

varray_col_properties
    : VARRAY varray_item (
        substitutable_column_clause? varray_storage_clause
        | substitutable_column_clause
    )
    ;

varray_storage_clause
    : STORE AS (SECUREFILE | BASICFILE)? LOB (
        lob_segname? '(' lob_storage_parameters ')'
        | lob_segname
    )?
    ;

lob_segname
    : regular_id
    | DELIMITED_ID
    ;

lob_item
    : regular_id
    | quoted_string
    | DELIMITED_ID
    ;

lob_storage_parameters
    : TABLESPACE tablespace_name = id_expression
    | (lob_parameters storage_clause?)
    | storage_clause
    ;

lob_storage_clause
    : LOB (
        '(' lob_item (',' lob_item)* ')' STORE AS (
            (SECUREFILE | BASICFILE)
            | '(' lob_storage_parameters* ')'
        )+
        | '(' lob_item ')' STORE AS (
            (SECUREFILE | BASICFILE)
            | lob_segname
            | '(' lob_storage_parameters* ')'
        )+
    )
    ;

modify_lob_storage_clause
    : MODIFY LOB '(' lob_item ')' '(' modify_lob_parameters ')'
    ;

modify_lob_parameters
    : (
        storage_clause
        | (PCTVERSION | FREEPOOLS) UNSIGNED_INTEGER
        | REBUILD FREEPOOLS
        | lob_retention_clause
        | lob_deduplicate_clause
        | lob_compression_clause
        | ENCRYPT encryption_spec
        | DECRYPT
        | CACHE
        | (CACHE | NOCACHE | CACHE READS) logging_clause?
        | allocate_extent_clause
        | shrink_clause
        | deallocate_unused_clause
    )+
    ;

lob_parameters
    : (
        (ENABLE | DISABLE) STORAGE IN ROW UNSIGNED_INTEGER?
        | CHUNK UNSIGNED_INTEGER
        | PCTVERSION UNSIGNED_INTEGER
        | FREEPOOLS UNSIGNED_INTEGER
        | lob_retention_clause
        | lob_deduplicate_clause
        | lob_compression_clause
        | ENCRYPT encryption_spec
        | DECRYPT
        | (CACHE | NOCACHE | CACHE READS) logging_clause?
    )+
    ;

lob_deduplicate_clause
    : DEDUPLICATE
    | KEEP_DUPLICATES
    ;

lob_compression_clause
    : NOCOMPRESS
    | COMPRESS (HIGH | MEDIUM | LOW)?
    ;

lob_retention_clause
    : RETENTION (MAX | MIN UNSIGNED_INTEGER | AUTO | NONE)?
    ;

encryption_spec
    : (USING CHAR_STRING)? (IDENTIFIED BY REGULAR_ID)? CHAR_STRING? (NO? SALT)?
    ;

tablespace
    : id_expression
    ;

varray_item
    : (id_expression '.')? (id_expression '.')? id_expression
    ;

column_properties
    : (
        object_type_col_properties
        | nested_table_col_properties
        | (varray_col_properties | lob_storage_clause) (
            '(' lob_partition_storage (',' lob_partition_storage)* ')'
        )? //TODO '(' ( ','? lob_partition_storage)+ ')'
        | xmltype_column_properties
    )+
    ;

lob_partition_storage
    : LOB (
        '(' lob_item (',' lob_item) ')' STORE AS (
            (SECUREFILE | BASICFILE)
            | '(' lob_storage_parameters ')'
        )+
        | '(' lob_item ')' STORE AS (
            (SECUREFILE | BASICFILE)
            | lob_segname
            | '(' lob_storage_parameters ')'
        )+
    )
    ;

period_definition
    : {this.isVersion12()}? PERIOD FOR column_name ('(' start_time_column ',' end_time_column ')')?
    ;

start_time_column
    : column_name
    ;

end_time_column
    : column_name
    ;

column_definition
    : column_name ((datatype | type_name) (COLLATE column_collation_name)?)? SORT? (
        VISIBLE
        | INVISIBLE
    )? (DEFAULT (ON NULL_)? expression | identity_clause)? (ENCRYPT encryption_spec)? (
        inline_constraint+
        | inline_ref_constraint
    )? annotations_clause?
    ;

column_collation_name
    : id_expression
    ;

identity_clause
    : GENERATED (ALWAYS | BY DEFAULT (ON NULL_)?)? AS IDENTITY identity_options_parentheses?
    ;

//https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/CREATE-TABLE.html#GUID-F9CE0CC3-13AE-4744-A43C-EAC7A71AAAB6
// NOTE to identity options
// according to the SQL Reference, identity_options be nested in parentheses.
// But statements without parentheses can also be executed successfully on a oracle database.
// See this issue for more details: https://github.com/antlr/grammars-v4/issues/3183
identity_options_parentheses
    : identity_options+
    | '(' identity_options+ ')'
    ;

identity_options
    : START WITH (numeric | LIMIT VALUE)
    | INCREMENT BY numeric
    | MAXVALUE numeric
    | NOMAXVALUE
    | MINVALUE numeric
    | NOMINVALUE
    | CYCLE
    | NOCYCLE
    | CACHE numeric
    | NOCACHE
    | ORDER
    | NOORDER
    | SCALE (EXTEND | NOEXTEND)
    | NOSCALE
    | KEEP
    | NOKEEP
    ;

virtual_column_definition
    : column_name (datatype (COLLATE column_collation_name)?)? (VISIBLE | INVISIBLE)? virtual_column_expression? VIRTUAL?
        evaluation_edition_clause? (UNUSABLE BEFORE (CURRENT EDITION | EDITION edition_name))? (
        UNUSABLE BEGINNING WITH ((CURRENT | NULL_) EDITION | EDITION edition_name)
    )? inline_constraint* by_user_for_statistics_clause?
    ;

virtual_column_expression
    : autogenerated_sequence_definition
    | (GENERATED ALWAYS?)? AS '(' expression ')'
    ;

autogenerated_sequence_definition
    : GENERATED (ALWAYS | BY DEFAULT (ON NULL_)?)? AS IDENTITY (
        '(' (sequence_start_clause | sequence_spec)* ')'
    )?
    ;

// Oracle tools and DBMS_METADATA can return this in some use cases
// This is used internally by Oracle to mark the virtual column for statistics only
by_user_for_statistics_clause
    : BY USER FOR STATISTICS
    ;

evaluation_edition_clause
    : EVALUATE USING ((CURRENT | NULL_) EDITION | EDITION edition_name)
    ;

nested_table_col_properties
    : NESTED TABLE (nested_item | COLUMN_VALUE) substitutable_column_clause? (LOCAL | GLOBAL)? STORE AS tableview_name (
        '(' ('(' object_properties ')' | physical_properties | column_properties)+ ')'
    )? (RETURN AS? (LOCATOR | VALUE))?
    ;

nested_item
    : regular_id
    ;

substitutable_column_clause
    : ELEMENT? IS OF TYPE? '(' type_name ')'
    | NOT? SUBSTITUTABLE AT ALL LEVELS
    ;

partition_name
    : regular_id
    | DELIMITED_ID
    ;

supplemental_logging_props
    : SUPPLEMENTAL LOG (supplemental_log_grp_clause | supplemental_id_key_clause)
    ;

object_type_col_properties
    : COLUMN column = regular_id substitutable_column_clause
    ;

constraint_clauses
    : ADD '(' (out_of_line_constraint (',' out_of_line_constraint)* | out_of_line_ref_constraint) ')'
    | ADD (out_of_line_constraint | out_of_line_ref_constraint)
    | MODIFY (
        CONSTRAINT constraint_name
        | PRIMARY KEY
        | UNIQUE '(' column_name (',' column_name)* ')'
    ) constraint_state CASCADE?
    | RENAME CONSTRAINT old_constraint_name TO new_constraint_name
    | drop_constraint_clause+
    ;

old_constraint_name
    : constraint_name
    ;

new_constraint_name
    : constraint_name
    ;

drop_constraint_clause
    : DROP (
        PRIMARY KEY
        | UNIQUE '(' column_name (',' column_name)* ')'
        | CONSTRAINT constraint_name
    ) CASCADE? ((KEY | DROP) INDEX)? ONLINE?
    ;

check_constraint
    : CHECK '(' condition ')' DISABLE?
    ;

foreign_key_clause
    : FOREIGN KEY paren_column_list references_clause on_delete_clause?
    ;

references_clause
    : REFERENCES tableview_name paren_column_list? (ON DELETE (CASCADE | SET NULL_))?
    ;

on_delete_clause
    : ON DELETE (CASCADE | SET NULL_)
    ;

// Anonymous PL/SQL code block

anonymous_block
    : (DECLARE seq_of_declare_specs?)? BEGIN seq_of_statements (EXCEPTION exception_handler+)? END
    ;

// Common DDL Clauses

invoker_rights_clause
    : AUTHID (CURRENT_USER | DEFINER)
    ;

call_spec
    : java_spec
    | c_spec
    ;

// Call Spec Specific Clauses

java_spec
    : LANGUAGE JAVA NAME CHAR_STRING
    ;

c_spec
    : (LANGUAGE C_LETTER | EXTERNAL) (
        NAME id_expression LIBRARY identifier
        | LIBRARY identifier (NAME id_expression)?
    ) c_agent_in_clause? (WITH CONTEXT)? c_parameters_clause?
    ;

c_agent_in_clause
    : AGENT IN '(' expressions_ ')'
    ;

c_parameters_clause
    : PARAMETERS '(' c_external_parameter (',' c_external_parameter)* ')'
    ;

c_external_parameter
    : CONTEXT
    | SELF (TDO | c_property)?
    | (parameter_name | RETURN) c_property? (BY REFERENCE)? external_datatype = regular_id?
    ;

c_property
    : INDICATOR (STRUCT | TDO)?
    | LENGTH
    | DURATION
    | MAXLEN
    | CHARSETID
    | CHARSETFORM
    ;

parameter
    : parameter_name (IN | OUT | INOUT | NOCOPY)* type_spec? default_value_part?
    ;

default_value_part
    : (ASSIGN_OP | DEFAULT) expression
    ;

// Elements Declarations

seq_of_declare_specs
    : declare_spec+
    ;

declare_spec
    : pragma_declaration
    | exception_declaration
    | procedure_spec
    | function_spec
    | variable_declaration
    | subtype_declaration
    | cursor_declaration
    | type_declaration
    | procedure_body
    | function_body
    | selection_directive
    ;

// incorporates constant_declaration
variable_declaration
    : identifier CONSTANT? type_spec (NOT? NULL_)? default_value_part? ';'
    ;

subtype_declaration
    : SUBTYPE identifier IS type_spec (RANGE expression '..' expression)? (NOT NULL_)? ';'
    ;

// cursor_declaration incorportates curscursor_body and cursor_spec

cursor_declaration
    : CURSOR identifier ('(' parameter_spec (',' parameter_spec)* ')')? (RETURN type_spec)? (
        IS select_statement
    )? ';'
    ;

parameter_spec
    : parameter_name (IN? type_spec)? default_value_part?
    ;

exception_declaration
    : identifier EXCEPTION ';'
    ;

pragma_declaration
    : PRAGMA (
        SERIALLY_REUSABLE
        | AUTONOMOUS_TRANSACTION
        | EXCEPTION_INIT '(' exception_name ',' numeric_negative ')'
        | INLINE '(' id1 = identifier ',' expression ')'
        | RESTRICT_REFERENCES '(' (identifier | DEFAULT) (',' identifier)+ ')'
        | DEPRECATE '(' identifier ( ',' CHAR_STRING)? ')'
        | UDF
    ) ';'
    ;

// Record Declaration Specific Clauses

// incorporates ref_cursor_type_definition

record_type_def
    : RECORD '(' field_spec (',' field_spec)* ')'
    ;

field_spec
    : column_name type_spec? (NOT NULL_)? default_value_part?
    ;

ref_cursor_type_def
    : REF CURSOR (RETURN type_spec)?
    ;

type_declaration
    : TYPE identifier IS (table_type_def | varray_type_def | record_type_def | ref_cursor_type_def) ';'
    ;

table_type_def
    : TABLE OF type_spec (NOT NULL_)? table_indexed_by_part?
    ;

table_indexed_by_part
    : (idx1 = INDEXED | idx2 = INDEX) BY type_spec
    ;

//https://docs.oracle.com/en/database/oracle/oracle-database/21/lnpls/collection-variable.html#GUID-89A1863C-65A1-40CF-9392-86E9FDC21BE9
varray_type_def
    : (VARRAY | VARYING? ARRAY) '(' expression ')' OF type_spec (NOT NULL_)?
    ;

// Statements

seq_of_statements
    : (pragma_declaration* statement (';' | EOF) | label_declaration | selection_directive)+
    ;

label_declaration
    : ltp1 = '<' '<' label_name '>' '>'
    ;

statement
    : body
    | block
    | assignment_statement
    | continue_statement
    | exit_statement
    | goto_statement
    | if_statement
    | loop_statement
    | forall_statement
    | null_statement
    | raise_statement
    | return_statement
    | case_statement
    | sql_statement
    | call_statement
    | pipe_row_statement
    | grant_statement
    ;

assignment_statement
    : (general_element | bind_variable) ASSIGN_OP expression
    ;

continue_statement
    : CONTINUE label_name? (WHEN condition)?
    ;

exit_statement
    : EXIT label_name? (WHEN condition)?
    ;

goto_statement
    : GOTO label_name
    ;

if_statement
    : IF condition THEN seq_of_statements elsif_part* else_part? END IF
    ;

elsif_part
    : ELSIF condition THEN seq_of_statements
    ;

else_part
    : ELSE seq_of_statements
    ;

loop_statement
    : label_declaration? (WHILE condition | FOR cursor_loop_param)? LOOP seq_of_statements END LOOP label_name?
    ;

// Loop Specific Clause

cursor_loop_param
    : index_name IN REVERSE? lower_bound range_separator = '..' upper_bound
    | record_name IN (cursor_name ('(' expressions_? ')')? | '(' select_statement ')')
    ;

//https://docs.oracle.com/en/database/oracle/oracle-database/21/lnpls/FORALL-statement.html#GUID-C45B8241-F9DF-4C93-8577-C840A25963DB
forall_statement
    : FORALL index_name IN bounds_clause (SAVE EXCEPTIONS)? (data_manipulation_language_statements | execute_immediate)
    ;

bounds_clause
    : lower_bound '..' upper_bound
    | INDICES OF general_element between_bound?
    | VALUES OF index_name
    ;

between_bound
    : BETWEEN lower_bound AND upper_bound
    ;

lower_bound
    : concatenation
    ;

upper_bound
    : concatenation
    ;

null_statement
    : NULL_
    ;

raise_statement
    : RAISE exception_name?
    ;

return_statement
    : RETURN expression?
    ;

call_statement
    : CALL? routine_name function_argument? ('.' routine_name function_argument?)* (
        INTO bind_variable
    )?
    ;

pipe_row_statement
    : PIPE ROW '(' expression ')'
    ;

selection_directive
    : DOLLAR_IF condition DOLLAR_THEN selection_directive_body? (
        DOLLAR_ELSIF condition DOLLAR_THEN selection_directive_body?
    )* (DOLLAR_ELSE selection_directive_body?)? DOLLAR_END
    ;

error_directive
    : DOLLAR_ERROR concatenation DOLLAR_END
    ;

selection_directive_body
    : (
        pragma_declaration? statement ';'
        | variable_declaration
        | error_directive
        | function_body
        | procedure_body
    )+
    ;

body
    : BEGIN seq_of_statements (EXCEPTION exception_handler+)? END label_name?
    ;

// Body Specific Clause

exception_handler
    : WHEN exception_name (OR exception_name)* THEN seq_of_statements
    ;

trigger_block
    : (DECLARE declare_spec*)? body
    ;

tps_block
    : declare_spec* body
    ;

block
    : (DECLARE declare_spec*)? body
    ;

// SQL Statements

sql_statement
    : execute_immediate
    | data_manipulation_language_statements
    | cursor_manipulation_statements
    | transaction_control_statements
    | collection_method_call
    ;

execute_immediate
    : EXECUTE IMMEDIATE expression (
        into_clause using_clause?
        | using_clause dynamic_returning_clause?
        | dynamic_returning_clause
    )?
    ;

// Execute Immediate Specific Clause

dynamic_returning_clause
    : (RETURNING | RETURN) into_clause
    ;

// DML Statements

data_manipulation_language_statements
    : merge_statement
    | lock_table_statement
    | select_statement
    | update_statement
    | delete_statement
    | insert_statement
    | explain_statement
    ;

// Cursor Manipulation Statements

cursor_manipulation_statements
    : close_statement
    | open_statement
    | fetch_statement
    | open_for_statement
    ;

close_statement
    : CLOSE cursor_name
    ;

open_statement
    : OPEN cursor_name ('(' expressions_? ')')?
    ;

fetch_statement
    : FETCH cursor_name (
        it1 = INTO variable_or_collection (',' variable_or_collection)*
        | BULK COLLECT INTO variable_or_collection (',' variable_or_collection)* (
            LIMIT (numeric | variable_or_collection)
        )?
    )
    ;

variable_or_collection
    : variable_name
    | collection_expression
    ;

open_for_statement
    : OPEN variable_name FOR (select_statement | expression) using_clause?
    ;

// Transaction Control SQL Statements

transaction_control_statements
    : set_transaction_command
    | set_constraint_command
    | commit_statement
    | rollback_statement
    | savepoint_statement
    ;

set_transaction_command
    : SET TRANSACTION (
        READ (ONLY | WRITE)
        | ISOLATION LEVEL (SERIALIZABLE | READ COMMITTED)
        | USE ROLLBACK SEGMENT rollback_segment_name
    )? (NAME quoted_string)?
    ;

set_constraint_command
    : SET (CONSTRAINT | CONSTRAINTS) (ALL | constraint_name (',' constraint_name)*) (
        IMMEDIATE
        | DEFERRED
    )
    ;

// https://docs.oracle.com/cd/E18283_01/server.112/e17118/statements_4010.htm#SQLRF01110
// https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/COMMIT.html
commit_statement
    : COMMIT WORK? write_clause? (
        COMMENT CHAR_STRING write_clause?
        | FORCE (CHAR_STRING (',' numeric)? | CORRUPT_XID CHAR_STRING | CORRUPT_XID_ALL)
    )?
    ;

write_clause
    : WRITE (
        (IMMEDIATE | BATCH)
        | (WAIT | NOWAIT)
        )*
    ;

rollback_statement
    : ROLLBACK WORK? (TO SAVEPOINT? savepoint_name | FORCE quoted_string)?
    ;

savepoint_statement
    : SAVEPOINT savepoint_name
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/collection-method.html#GUID-7AF1A3C4-D04B-4F91-9D7B-C92C75E3A300
collection_method_call // collection methods invocation that could be used as a statement
    : expression '.' (
        (DELETE | EXTEND) ('(' index += expression (',' index += expression)* ')')?
        | TRIM ('(' index += expression ')')?
    )
    ;

// Dml

/* TODO
//SHOULD BE OVERRIDEN!
compilation_unit
    : seq_of_statements* EOF
    ;

//SHOULD BE OVERRIDEN!
seq_of_statements
    : select_statement
    | update_statement
    | delete_statement
    | insert_statement
    | lock_table_statement
    | merge_statement
    | explain_statement
//    | case_statement[true]
    ;
*/

explain_statement
    : EXPLAIN PLAN (SET STATEMENT_ID '=' quoted_string)? (INTO tableview_name)? FOR (
        select_statement
        | update_statement
        | delete_statement
        | insert_statement
        | merge_statement
    )
    ;

select_only_statement
    : subquery
    ;

select_statement
    : select_only_statement (for_update_clause | order_by_clause | offset_clause | fetch_clause)*
    ;

// Select Specific Clauses
with_clause
    : WITH (function_body | procedure_body)* with_factoring_clause (',' with_factoring_clause)*
    | WITH (function_body | procedure_body)+ (with_factoring_clause (',' with_factoring_clause)*)?
    ;

with_factoring_clause
    : subquery_factoring_clause
    | subav_factoring_clause
    ;

subquery_factoring_clause
    : query_name paren_column_list? AS '(' subquery_no_with order_by_clause? ')' search_clause? cycle_clause?
    ;

search_clause
    : SEARCH (DEPTH | BREADTH) FIRST BY column_name ASC? DESC? (NULLS FIRST)? (NULLS LAST)? (
        ',' column_name ASC? DESC? (NULLS FIRST)? (NULLS LAST)?
    )* SET column_name
    ;

cycle_clause
    : CYCLE column_list SET column_name TO expression DEFAULT expression
    ;

subav_factoring_clause
    : subav_name = id_expression ANALYTIC VIEW AS '(' subav_clause ')'
    ;

subav_clause
    : USING subav_name = object_name hierarchies_clause? filter_clauses? add_calcs_clause?
    ;

hierarchies_clause
    : HIERARCHIES '(' hier_alias += object_name (',' hier_alias += object_name)* ')'
    ;

filter_clauses
    : FILTER FACT '(' filter_clause (',' filter_clause)* ')'
    ;

filter_clause
    : (MEASURES | hier_alias = object_name) TO condition
    ;

add_calcs_clause
    : ADD MEASURES '(' add_calc_meas_clause (',' add_calc_meas_clause)* ')'
    ;

add_calc_meas_clause
    : meas_name = id_expression AS '(' expression ')'
    ;

subquery
    : with_clause? subquery_basic_elements subquery_operation_part*
    ;

// A subquery that must not start with (or contain, parenthesized) a WITH clause.
// Used where Oracle rejects a CTE: inside another CTE definition and as UNION/INTERSECT/MINUS operands.
subquery_no_with
    : subquery_basic_elements subquery_operation_part*
    ;

subquery_basic_elements
    : query_block
    | '(' subquery_no_with ')'
    ;

subquery_operation_part
    : (UNION ALL? | INTERSECT | MINUS) subquery_basic_elements
    ;

query_block
    : SELECT (DISTINCT | UNIQUE | ALL)? selected_list into_clause? from_clause? where_clause? (
        hierarchical_query_clause
        | group_by_clause
    )* model_clause? order_by_clause? offset_clause? fetch_clause?
    ;

selected_list
    : '*'
    | select_list_elements (',' select_list_elements)*
    ;

from_clause
    : FROM table_ref_list
    ;

select_list_elements
    : tableview_name '.' ASTERISK
    | expression column_alias?
    ;

table_ref_list
    : table_ref (',' table_ref)*
    ;

// NOTE to PIVOT clause
// according the SQL reference this should not be possible
// according to he reality it is. Here we probably apply pivot/unpivot onto whole join clause
// eventhough it is not enclosed in parenthesis. See pivot examples 09,10,11

table_ref
    : table_ref_aux join_clause* (pivot_clause | unpivot_clause)?
    ;

table_ref_aux
    : table_ref_aux_internal flashback_query_clause* ({this.isNotStartOfJoin()}? table_alias)?
    ;

table_ref_aux_internal
    : dml_table_expression_clause (pivot_clause | unpivot_clause)?                # table_ref_aux_internal_one
    | '(' table_ref subquery_operation_part* ')' (pivot_clause | unpivot_clause)? # table_ref_aux_internal_two
    | ONLY '(' dml_table_expression_clause ')'                                    # table_ref_aux_internal_thre
    ;

join_clause
    : query_partition_clause? (CROSS | NATURAL)? (INNER | outer_join_type)? JOIN table_ref_aux query_partition_clause? (
        join_on_part
        | join_using_part
    )*
    | (CROSS | OUTER) APPLY table_ref_aux
    ;

join_on_part
    : ON condition
    ;

join_using_part
    : USING paren_column_list
    ;

outer_join_type
    : (FULL | LEFT | RIGHT) OUTER?
    ;

query_partition_clause
    : PARTITION BY (('(' (subquery | expressions_)? ')') | expressions_)
    ;

flashback_query_clause
    : VERSIONS (PERIOD_KEYWORD FOR column_name BETWEEN | BETWEEN (SCN | TIMESTAMP)) expression AND expression
    | AS OF ((SCN | TIMESTAMP | SNAPSHOT) expression | PERIOD_KEYWORD FOR column_name expression)
    ;

pivot_clause
    : PIVOT XML? '(' pivot_element (',' pivot_element)* pivot_for_clause pivot_in_clause ')' table_alias?
    ;

pivot_element
    : (numeric_function | aggregate_function_name '(' expression ')') column_alias?
    ;

pivot_for_clause
    : FOR (column_name | paren_column_list)
    ;

pivot_in_clause
    : IN '(' (subquery | ANY (',' ANY)* | pivot_in_clause_element (',' pivot_in_clause_element)*) ')'
    ;

pivot_in_clause_element
    : pivot_in_clause_elements column_alias?
    ;

pivot_in_clause_elements
    : expression
    | '(' expressions_? ')'
    ;

unpivot_clause
    : UNPIVOT ((INCLUDE | EXCLUDE) NULLS)? '(' (column_name | paren_column_list) pivot_for_clause unpivot_in_clause ')' table_alias?
    ;

unpivot_in_clause
    : IN '(' unpivot_in_elements (',' unpivot_in_elements)* ')'
    ;

unpivot_in_elements
    : (column_name | paren_column_list) (AS (constant | '(' constant (',' constant)* ')'))?
    ;

hierarchical_query_clause
    : CONNECT BY NOCYCLE? condition start_part?
    | start_part CONNECT BY NOCYCLE? condition
    ;

start_part
    : START WITH condition
    ;

group_by_clause
    : GROUP BY group_by_elements (',' group_by_elements)* having_clause?
    | having_clause (GROUP BY group_by_elements (',' group_by_elements)*)?
    ;

group_by_elements
    : grouping_sets_clause
    | rollup_cube_clause
    | expression
    ;

rollup_cube_clause
    : (ROLLUP | CUBE) '(' grouping_sets_elements (',' grouping_sets_elements)* ')'
    ;

grouping_sets_clause
    : GROUPING SETS '(' grouping_sets_elements (',' grouping_sets_elements)* ')'
    ;

grouping_sets_elements
    : rollup_cube_clause
    | '(' expressions_? ')'
    | expression
    ;

having_clause
    : HAVING condition
    ;

model_clause
    : MODEL cell_reference_options* return_rows_clause? reference_model* main_model
    ;

cell_reference_options
    : (IGNORE | KEEP) NAV
    | UNIQUE (DIMENSION | SINGLE REFERENCE)
    ;

return_rows_clause
    : RETURN (UPDATED | ALL) ROWS
    ;

reference_model
    : REFERENCE reference_model_name ON '(' subquery ')' model_column_clauses cell_reference_options*
    ;

main_model
    : (MAIN main_model_name)? model_column_clauses cell_reference_options* model_rules_clause
    ;

model_column_clauses
    : model_column_partition_part? DIMENSION BY model_column_list MEASURES model_column_list
    ;

model_column_partition_part
    : PARTITION BY model_column_list
    ;

model_column_list
    : '(' model_column (',' model_column)* ')'
    ;

model_column
    : (expression | query_block) column_alias?
    ;

model_rules_clause
    : model_rules_part? '(' (model_rules_element (',' model_rules_element)*)? ')'
    ;

model_rules_part
    : RULES (UPDATE | UPSERT ALL?)? ((AUTOMATIC | SEQUENTIAL) ORDER)? model_iterate_clause?
    ;

model_rules_element
    : (UPDATE | UPSERT ALL?)? cell_assignment order_by_clause? '=' expression
    ;

cell_assignment
    : model_expression
    ;

model_iterate_clause
    : ITERATE '(' expression ')' until_part?
    ;

until_part
    : UNTIL '(' condition ')'
    ;

order_by_clause
    : ORDER SIBLINGS? BY order_by_elements (',' order_by_elements)*
    ;

order_by_elements
    : expression (ASC | DESC)? (NULLS (FIRST | LAST))?
    ;

offset_clause
    : OFFSET expression (ROW | ROWS)
    ;

fetch_clause
    : FETCH (FIRST | NEXT) (expression PERCENT_KEYWORD?)? (ROW | ROWS) (ONLY | WITH TIES)
    ;

for_update_clause
    : FOR UPDATE for_update_of_part? for_update_options?
    ;

for_update_of_part
    : OF column_list
    ;

for_update_options
    : SKIP_ LOCKED
    | NOWAIT
    | WAIT expression
    ;

update_statement
    : UPDATE general_table_ref update_set_clause where_clause? static_returning_clause? error_logging_clause?
    ;

// Update Specific Clauses

update_set_clause
    : SET (
        column_based_update_set_clause (',' column_based_update_set_clause)*
        | VALUE '(' identifier ')' '=' expression
    )
    ;

column_based_update_set_clause
    : column_name '=' expression
    | paren_column_list '=' subquery
    ;

delete_statement
    : DELETE FROM? general_table_ref where_clause? static_returning_clause? error_logging_clause?
    ;

insert_statement
    : INSERT (single_table_insert | multi_table_insert)
    ;

// Insert Specific Clauses

single_table_insert
    : insert_into_clause (values_clause static_returning_clause? | select_statement) error_logging_clause?
    ;

multi_table_insert
    : (ALL multi_table_element+ | conditional_insert_clause) select_statement
    ;

multi_table_element
    : insert_into_clause values_clause? error_logging_clause?
    ;

conditional_insert_clause
    : (ALL | FIRST)? conditional_insert_when_part+ conditional_insert_else_part?
    ;

conditional_insert_when_part
    : WHEN condition THEN multi_table_element+
    ;

conditional_insert_else_part
    : ELSE multi_table_element+
    ;

insert_into_clause
    : INTO general_table_ref (FIELDS)? paren_column_list?
    ;

values_clause
    : VALUES (
        REGULAR_ID
        | '(' expressions_ ')' (COMMA '(' expressions_ ')')*
        | collection_expression
    )
    ;

merge_statement
    : MERGE INTO selected_tableview USING selected_tableview ON '(' condition ')' (
        merge_update_clause merge_insert_clause?
        | merge_insert_clause merge_update_clause?
    ) error_logging_clause? static_returning_clause?
    ;

// Merge Specific Clauses

merge_update_clause
    : WHEN MATCHED THEN UPDATE SET merge_element (',' merge_element)* where_clause? merge_update_delete_part?
    ;

merge_element
    : column_name '=' expression
    ;

merge_update_delete_part
    : DELETE where_clause
    ;

merge_insert_clause
    : WHEN NOT MATCHED THEN INSERT paren_column_list? values_clause where_clause?
    ;

selected_tableview
    : ( tableview_name | '(' select_statement ')' | table_collection_expression | '(' table_collection_expression ')') table_alias?
    ;

lock_table_statement
    : LOCK TABLE lock_table_element (',' lock_table_element)* IN lock_mode MODE wait_nowait_part?
    ;

wait_nowait_part
    : WAIT expression
    | NOWAIT
    ;

// Lock Specific Clauses

lock_table_element
    : tableview_name partition_extension_clause?
    ;

lock_mode
    : ROW SHARE
    | ROW EXCLUSIVE
    | SHARE UPDATE?
    | SHARE ROW EXCLUSIVE
    | EXCLUSIVE
    ;

// Common DDL Clauses

general_table_ref
    : (dml_table_expression_clause | ONLY '(' dml_table_expression_clause ')') table_alias?
    ;

static_returning_clause
    : (RETURNING | RETURN) expressions_ into_clause
    ;

error_logging_clause
    : LOG ERRORS error_logging_into_part? expression? error_logging_reject_part?
    ;

error_logging_into_part
    : INTO tableview_name
    ;

error_logging_reject_part
    : REJECT LIMIT (UNLIMITED | expression)
    ;

dml_table_expression_clause
    : table_collection_expression
    | '(' select_statement subquery_restriction_clause? ')'
    | tableview_name hierarchies_clause? sample_clause?
    | json_table_clause (AS identifier)?
    | LATERAL '(' subquery subquery_restriction_clause? ')'
    // Deprecated Oracle 10/11 RELATIONAL alias for casting object-types to relational tables
    | {this.isVersion11()}? (RELATIONAL '(' tableview_name NOT XMLTYPE ')')
    ;

table_collection_expression
    : (TABLE | THE) ('(' subquery ')' | '(' expression ')' outer_join_sign?)
    ;

subquery_restriction_clause
    : WITH (READ ONLY | CHECK OPTION (CONSTRAINT constraint_name)?)
    ;

sample_clause
    : SAMPLE BLOCK? '(' expression (',' expression)? ')' seed_part?
    ;

seed_part
    : SEED '(' expression ')'
    ;

// Expression & Condition

condition
    : expression
    | JSON_EQUAL '(' expressions_ ')'
    ;

expressions_
    : expression (',' expression)*
    ;

expression
    : cursor_expression
    | logical_expression
    ;

cursor_expression
    : CURSOR '(' subquery ')'
    ;

logical_expression
    : unary_logical_expression
    | logical_expression AND logical_expression
    | logical_expression OR logical_expression
    ;

unary_logical_expression
    : NOT? multiset_expression unary_logical_operation?
    ;

unary_logical_operation
    : IS NOT? logical_operation
    ;

logical_operation
    : (
        NULL_
        | NAN_
        | PRESENT
        | INFINITE
        | A_LETTER SET
        | EMPTY_
        | OF TYPE? '(' ONLY? type_spec (',' type_spec)* ')'
        | JSON (FORMAT JSON)? (STRICT | LAX)? ((WITH | WITHOUT) UNIQUE KEYS)?
    )
    ;

multiset_expression
    : relational_expression (multiset_type = NOT? (MEMBER | SUBMULTISET) OF? concatenation)?
    | multiset_expression MULTISET multiset_operator = (EXCEPT | INTERSECT | UNION) (
        ALL
        | DISTINCT
    )? relational_expression
    ;

relational_expression
    : relational_expression relational_operator relational_expression
    | relational_expression NOT? IN in_elements
    | compound_expression
    ;

compound_expression
    : concatenation (
        NOT? (
            IN in_elements
            | BETWEEN between_elements
            | like_type = (LIKE | LIKEC | LIKE2 | LIKE4) concatenation (ESCAPE concatenation)?
        )
    )?
    ;

relational_operator
    : '='
    | (NOT_EQUAL_OP | '<' '>' | '!' '=' | '^' '=')
    | ('<' | '>') '='?
    ;

in_elements
    : '(' subquery ')'
    | '(' concatenation (',' concatenation)* ')'
    | constant
    | bind_variable
    | general_element
    ;

between_elements
    : concatenation AND concatenation
    ;

concatenation
    : model_expression (AT (LOCAL | TIME ZONE concatenation) | interval_expression)? (
        ON OVERFLOW_ (TRUNCATE | ERROR)
    )?
    | concatenation op = DOUBLE_ASTERISK concatenation
    | concatenation op = (ASTERISK | SOLIDUS | MOD) concatenation
    | concatenation op = (PLUS_SIGN | MINUS_SIGN) concatenation
    | concatenation BAR BAR concatenation
    | concatenation COLLATE column_collation_name
    ;

interval_expression
    : DAY ('(' concatenation ')')? TO SECOND ('(' concatenation ')')?
    | YEAR ('(' concatenation ')')? TO MONTH
    ;

model_expression
    : ('-' | '+')? unary_expression ('[' model_expression_element ']')?
    ;

model_expression_element
    : (ANY | expression) (',' (ANY | expression))*
    | single_column_for_loop (',' single_column_for_loop)*
    | multi_column_for_loop
    ;

single_column_for_loop
    : FOR column_name (
        IN '(' expressions_? ')'
        | (LIKE expression)? FROM fromExpr = expression TO toExpr = expression action_type = (
            INCREMENT
            | DECREMENT
        ) action_expr = expression
    )
    ;

multi_column_for_loop
    : FOR paren_column_list IN '(' (subquery | '(' expressions_? ')') ')'
    ;

unary_expression
    : PRIOR unary_expression_core
    | CONNECT_BY_ROOT unary_expression_core
    | NEW unary_expression_core
    | OLD unary_expression_core
    | unary_expression_core (
        '.' (
            (COUNT | FIRST | LAST | LIMIT)
            | (EXISTS | NEXT | PRIOR) '(' index += expression ')'
        )
    )?
    ;

unary_expression_core
    : case_expression
    | quantified_expression
    | standard_function
    | {this.IsNotNumericFunction()}? atom
    | implicit_cursor_expression
    | selection_directive_expression
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/conditional-compilation1.html
selection_directive_expression
    : DOLLAR_IF condition DOLLAR_THEN expression (
        DOLLAR_ELSIF condition DOLLAR_THEN expression
    )* (DOLLAR_ELSE expression)? DOLLAR_END
    ;

// https://docs.oracle.com/en/database/oracle/oracle-database/21/lnpls/plsql-optimization-and-tuning.html#GUID-DAF46F06-EF3F-4B1A-A518-5238B80C69FA
implicit_cursor_expression
    : SQL (
        PERCENT_BULK_ROWCOUNT '(' index = expression ')'
        | PERCENT_BULK_EXCEPTIONS ('.' COUNT | '(' expression ')' '.' (ERROR_INDEX | ERROR_CODE))
    )
    ;

collection_expression
    : collation_name '(' expression ')' ('.' general_element_part)*
    ;

// CASE statement
case_statement
    : searched_case_statement
    | simple_case_statement
    ;

simple_case_statement
    : label_declaration? ck1 = CASE expression case_when_part_statement+ case_else_part_statement? END CASE? label_name?
    ;

searched_case_statement
    : label_declaration? ck1 = CASE case_when_part_statement+ case_else_part_statement? END CASE? label_name?
    ;

case_when_part_statement
    : WHEN expression THEN seq_of_statements
    ;

case_else_part_statement
    : ELSE seq_of_statements
    ;


// CASE expression
case_expression
    : searched_case_expression
    | simple_case_expression
    ;

simple_case_expression
    : ck1 = CASE expression case_when_part_expression+ case_else_part_expression? END CASE?
    ;

searched_case_expression
    : ck1 = CASE case_when_part_expression+ case_else_part_expression? END CASE?
    ;

case_when_part_expression
    : WHEN expression THEN expression
    ;

case_else_part_expression
    : ELSE expression
    ;

atom
    : bind_variable
    | constant
    | inquiry_directive
    | general_element outer_join_sign?
    | '(' subquery ')' subquery_operation_part*
    | '(' expression ')' ('.' general_element_part)*
    | '(' expressions_ ')'
    ;

quantified_expression
    : (SOME | EXISTS | ALL | ANY) (
        '(' select_only_statement ')'
        | '(' expression (',' expression)* ')'
    )
    ;

string_function
    : SUBSTR '(' expression ',' expression (',' expression)? ')'
    | TO_CHAR '(' (table_element | standard_function | expression) (',' quoted_string)? (
        ',' quoted_string
    )? ')'
    | DECODE '(' expressions_ ')'
    | CHR '(' concatenation USING NCHAR_CS ')'
    | NVL '(' expression ',' expression ')'
    | TRIM '(' ((LEADING | TRAILING | BOTH)? expression? FROM)? concatenation ')'
    | TO_DATE '(' (table_element | standard_function | expression) (
        DEFAULT concatenation ON CONVERSION ERROR
    )? (',' quoted_string (',' quoted_string)?)? ')'
    ;

standard_function
    : string_function
    | numeric_function_wrapper
    | json_function
    | {this.IsNotNumericFunction()}? other_function
    ;

//see as https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/JSON_ARRAY.html#GUID-46CDB3AF-5795-455B-85A8-764528CEC43B
json_function
    : JSON_ARRAY '(' json_array_element (',' json_array_element)* json_on_null_clause? json_return_clause? STRICT? ')'
    | JSON_ARRAYAGG '(' expression (FORMAT JSON)? order_by_clause? json_on_null_clause? json_return_clause? STRICT? ')'
    | JSON_OBJECT '(' json_object_content ')'
    | JSON_OBJECTAGG '(' KEY? expression VALUE expression ((NULL_ | ABSENT) ON NULL_)? (
        RETURNING (VARCHAR2 ('(' UNSIGNED_INTEGER ( BYTE | CHAR)? ')')? | CLOB | BLOB)
    )? STRICT? (WITH UNIQUE KEYS)? ')'
    | JSON_QUERY '(' expression (FORMAT JSON)? ',' CHAR_STRING json_query_returning_clause json_query_wrapper_clause? json_query_on_error_clause?
        json_query_on_empty_clause? ')'
    | JSON_SERIALIZE '(' CHAR_STRING (RETURNING json_query_return_type)? PRETTY? ASCII? TRUNCATE? (
        (NULL_ | ERROR | EMPTY_ (ARRAY | OBJECT)) ON ERROR
    )? ')'
    | JSON_TRANSFORM '(' expression ',' json_transform_op (',' json_transform_op)* ')'
    | JSON_VALUE '(' expression (FORMAT JSON)? (
        ',' CHAR_STRING? json_value_return_clause? ((ERROR | NULL_ | DEFAULT literal)? ON ERROR)? (
            (ERROR | NULL_ | DEFAULT literal)? ON EMPTY_
        )? json_value_on_mismatch_clause? ')'
    )?
    ;

json_object_content
    : (json_object_entry (',' json_object_entry)* | '*') json_on_null_clause? json_return_clause? STRICT? (
        WITH UNIQUE KEYS
    )?
    ;

json_object_entry
    : (KEY? expression (VALUE | IS)? expression | expression ':' expression | identifier) (
        FORMAT JSON
    )?
    ;

json_table_clause
    : JSON_TABLE '(' expression (FORMAT JSON)? (',' CHAR_STRING)? ((ERROR | NULL_) ON ERROR)? (
        (EMPTY_ | NULL_) ON EMPTY_
    )? json_column_clause? ')'
    ;

json_array_element
    : (expression | CHAR_STRING | NULL_ | UNSIGNED_INTEGER | json_function) (FORMAT JSON)?
    ;

json_on_null_clause
    : (NULL_ | ABSENT) ON NULL_
    ;

json_return_clause
    : RETURNING (VARCHAR2 ('(' UNSIGNED_INTEGER ( BYTE | CHAR)? ')')? | CLOB | BLOB)
    ;

json_transform_op
    : REMOVE CHAR_STRING ((IGNORE | ERROR)? ON MISSING)?
    | INSERT CHAR_STRING '=' CHAR_STRING ((REPLACE | IGNORE | ERROR) ON EXISTING)? (
        (NULL_ | IGNORE | ERROR | REMOVE)? ON NULL_
    )?
    | REPLACE CHAR_STRING '=' CHAR_STRING ((CREATE | IGNORE | ERROR) ON MISSING)? (
        (NULL_ | IGNORE | ERROR)? ON NULL_
    )?
    | expression (FORMAT JSON)?
    | APPEND CHAR_STRING '=' CHAR_STRING ((CREATE | IGNORE | ERROR) ON MISSING)? (
        (NULL_ | IGNORE | ERROR)? ON NULL_
    )?
    | SET CHAR_STRING '=' expression (FORMAT JSON)? ((REPLACE | IGNORE | ERROR) ON EXISTING)? (
        (CREATE | IGNORE | ERROR) ON MISSING
    )? ((NULL_ | IGNORE | ERROR)? ON NULL_)?
    ;

json_column_clause
    : COLUMNS '(' json_column_definition (',' json_column_definition)* ')'
    ;

json_column_definition
    : expression json_value_return_type? (EXISTS? PATH CHAR_STRING | TRUNCATE (PATH CHAR_STRING)?)? json_query_on_error_clause?
        json_query_on_empty_clause?
    | expression json_query_return_type? TRUNCATE? FORMAT JSON json_query_wrapper_clause? PATH CHAR_STRING
    | NESTED PATH? expression ('[' ASTERISK ']')? json_column_clause
    | expression FOR ORDINALITY
    ;

json_query_returning_clause
    : (RETURNING json_query_return_type)? PRETTY? ASCII?
    ;

json_query_return_type
    : VARCHAR2 ('(' UNSIGNED_INTEGER ( BYTE | CHAR)? ')')?
    | CLOB
    | BLOB
    ;

json_query_wrapper_clause
    : (WITHOUT ARRAY? WRAPPER)
    | (WITH (UNCONDITIONAL | CONDITIONAL)? ARRAY? WRAPPER)
    ;

json_query_on_error_clause
    : (ERROR | NULL_ | EMPTY_ | EMPTY_ ARRAY | EMPTY_ OBJECT)? ON ERROR
    ;

json_query_on_empty_clause
    : (ERROR | NULL_ | EMPTY_ | EMPTY_ ARRAY | EMPTY_ OBJECT)? ON EMPTY_
    ;

json_value_return_clause
    : RETURNING json_value_return_type? ASCII?
    ;

json_value_return_type
    : VARCHAR2 ('(' UNSIGNED_INTEGER ( BYTE | CHAR)? ')')? TRUNCATE?
    | CLOB
    | DATE
    | NUMBER ('(' INTEGER (',' INTEGER)? ')')?
    | TIMESTAMP (WITH TIME ZONE)?
    | SDO_GEOMETRY
    | expression (USING CASESENSITIVE MAPPING)?
    ;

json_value_on_mismatch_clause
    : (IGNORE | ERROR | NULL_) ON MISMATCH ('(' MISSING DATA | EXTRA DATA | TYPE ERROR ')')?
    ;

literal
    : CHAR_STRING
    | string_function
    | numeric
    | numeric_negative
    | MAXVALUE
    ;

numeric_function_wrapper
    : numeric_function (single_column_for_loop | multi_column_for_loop)?
    ;

numeric_function
    : SUM '(' (DISTINCT | ALL)? expression ')' (over_clause | keep_clause)?
    | COUNT '(' (ASTERISK | ((DISTINCT | UNIQUE | ALL)? concatenation)?) ')' (over_clause | keep_clause)?
    | ROUND '(' expression (',' (UNSIGNED_INTEGER | expression))? ')'
    | AVG '(' (DISTINCT | ALL)? expression ')' (over_clause | keep_clause)?
    | MIN '(' (DISTINCT | ALL)? expression ')' (over_clause | keep_clause)?
    | MAX '(' (DISTINCT | ALL)? expression ')' (over_clause | keep_clause)?
    | LEAST '(' expressions_ ')'
    | GREATEST '(' expressions_ ')'
    ;

listagg_overflow_clause
    : ON OVERFLOW_ (ERROR | TRUNCATE) CHAR_STRING? ((WITH | WITHOUT) COUNT)?
    ;

other_function
    : over_clause_keyword function_argument_analytic over_clause?
    | /*TODO stantard_function_enabling_using*/ regular_id function_argument_modeling using_clause?
    | COUNT '(' (ASTERISK | (DISTINCT | UNIQUE | ALL)? concatenation) ')' over_clause?
    | (CAST | XMLCAST) '(' (MULTISET '(' subquery ')' | concatenation) AS type_spec (
        DEFAULT concatenation ON CONVERSION ERROR
    )? (',' quoted_string (',' quoted_string)?)? ')'
    | COALESCE '(' table_element (',' (numeric | quoted_string))? ')'
    | COLLECT '(' (DISTINCT | UNIQUE)? concatenation collect_order_by_part? ')'
    | within_or_over_clause_keyword function_argument within_or_over_part+
    // Modified to allow expressions as delimiter to LISTAGG
    | LISTAGG '(' (ALL | DISTINCT | UNIQUE)? argument (',' expression)? listagg_overflow_clause? ')' (
        WITHIN GROUP '(' order_by_clause ')'
    )? over_clause?
    | cursor_name (PERCENT_ISOPEN | PERCENT_FOUND | PERCENT_NOTFOUND | PERCENT_ROWCOUNT)
    | DECOMPOSE '(' concatenation (CANONICAL | COMPATIBILITY)? ')'
    | EXTRACT '(' regular_id FROM concatenation ')'
    | (FIRST_VALUE | LAST_VALUE) function_argument_analytic respect_or_ignore_nulls? over_clause
    | (LEAD | LAG) function_argument_analytic respect_or_ignore_nulls? over_clause
    | standard_prediction_function_keyword '(' expressions_ cost_matrix_clause? using_clause? ')'
    | (TO_BINARY_DOUBLE | TO_BINARY_FLOAT | TO_NUMBER | TO_TIMESTAMP | TO_TIMESTAMP_TZ) '(' concatenation (
        DEFAULT concatenation ON CONVERSION ERROR
    )? (',' quoted_string (',' quoted_string)?)? ')'
    | (TO_DSINTERVAL | TO_YMINTERVAL) '(' concatenation (DEFAULT concatenation ON CONVERSION ERROR)? ')'
    | TRANSLATE '(' expression (USING (CHAR_CS | NCHAR_CS))? (',' expression)* ')'
    | TREAT '(' expression AS REF? type_spec ')' ('.' general_element_part)*
    | TRIM '(' ((LEADING | TRAILING | BOTH)? quoted_string? FROM)? concatenation ')'
    | VALIDATE_CONVERSION '(' concatenation AS type_spec (',' quoted_string (',' quoted_string)?)? ')'
    | XMLAGG '(' expression order_by_clause? ')' ('.' general_element_part)*
    | (XMLCOLATTVAL | XMLFOREST) '(' xml_multiuse_expression_element (
        ',' xml_multiuse_expression_element
    )* ')' ('.' general_element_part)*
    | XMLELEMENT '(' (ENTITYESCAPING | NOENTITYESCAPING)? (NAME | EVALNAME)? expression (
        /*TODO{input.LT(2).getText().equalsIgnoreCase("xmlattributes")}?*/ ',' xml_attributes_clause
    )? (',' expression column_alias?)* ')' ('.' general_element_part)*
    | XMLEXISTS '(' expression xml_passing_clause? ')'
    | XMLPARSE '(' (DOCUMENT | CONTENT) concatenation WELLFORMED? ')' ('.' general_element_part)*
    | XMLPI '(' (NAME identifier | EVALNAME concatenation) (',' concatenation)? ')' (
        '.' general_element_part
    )*
    | XMLQUERY '(' concatenation xml_passing_clause? RETURNING CONTENT (NULL_ ON EMPTY_)? ')' (
        '.' general_element_part
    )*
    | XMLROOT '(' concatenation (',' xmlroot_param_version_part)? (
        ',' xmlroot_param_standalone_part
    )? ')' ('.' general_element_part)*
    | XMLSERIALIZE '(' (DOCUMENT | CONTENT) concatenation (AS type_spec)? xmlserialize_param_enconding_part? xmlserialize_param_version_part?
        xmlserialize_param_ident_part? ((HIDE | SHOW) DEFAULTS)? ')' ('.' general_element_part)?
    | TIME CHAR_STRING
    | xmltable
    ;

over_clause_keyword
    : AVG
    | CORR
    | LAG_DIFF
    | LAG_DIFF_PERCENT
    | MAX
    | MEDIAN
    | MIN
    | NTH_VALUE
    | NTILE
    | RATIO_TO_REPORT
    | ROW_NUMBER
    | SUM
    | VARIANCE
    | REGR_
    | STDDEV
    | VAR_
    | VAR_POP
    | COVAR_
    | WM_CONCAT
    ;

within_or_over_clause_keyword
    : CUME_DIST
    | DENSE_RANK
    | PERCENT_RANK
    | PERCENTILE_CONT
    | PERCENTILE_DISC
    | RANK
    ;

standard_prediction_function_keyword
    : PREDICTION
    | PREDICTION_BOUNDS
    | PREDICTION_COST
    | PREDICTION_DETAILS
    | PREDICTION_PROBABILITY
    | PREDICTION_SET
    ;

over_clause
    : OVER '(' (
        query_partition_clause? (order_by_clause windowing_clause?)?
        | HIERARCHY th = id_expression OFFSET numeric (ACROSS ANCESTOR AT LEVEL id_expression)?
    ) ')'
    ;

windowing_clause
    : windowing_type (BETWEEN windowing_elements AND windowing_elements | windowing_elements)
    ;

windowing_type
    : ROWS
    | RANGE
    ;

windowing_elements
    : UNBOUNDED PRECEDING
    | CURRENT ROW
    | concatenation (PRECEDING | FOLLOWING)
    ;

using_clause
    : USING (ASTERISK | using_element (',' using_element)*)
    ;

using_element
    : IN expression
    | IN OUT assignable_element
    | OUT assignable_element
    | expression
    ;

// Elemento assegnabile: usato per OUT/IN OUT
assignable_element
    : general_element
    | bind_variable
    ;

collect_order_by_part
    : ORDER BY concatenation (',' concatenation)*
    ;

within_or_over_part
    : WITHIN GROUP '(' order_by_clause ')'
    | over_clause
    ;

string_delimiter
    : CHAR_STRING
    | string_function
    | string_delimiter BAR BAR string_delimiter
    | '(' string_delimiter ')'
    | id_expression
    ;

cost_matrix_clause
    : COST (
        MODEL AUTO?
        | '(' cost_class_name (',' cost_class_name)* ')' VALUES '(' expressions_? ')'
    )
    ;

xml_passing_clause
    : PASSING (BY VALUE)? expression column_alias? (',' expression column_alias?)*
    ;

xml_attributes_clause
    : XMLATTRIBUTES '(' (ENTITYESCAPING | NOENTITYESCAPING)? (SCHEMACHECK | NOSCHEMACHECK)? xml_multiuse_expression_element (
        ',' xml_multiuse_expression_element
    )* ')'
    ;

xml_namespaces_clause
    : XMLNAMESPACES '(' (concatenation column_alias)? (',' concatenation column_alias)* xml_general_default_part? ')'
    ;

xml_table_column
    : xml_column_name (FOR ORDINALITY | type_spec (PATH concatenation)? xml_general_default_part?)
    ;

xml_general_default_part
    : DEFAULT concatenation
    ;

xml_multiuse_expression_element
    : expression
        ( (AS? id_expression)
        | (AS EVALNAME expression)
        )?
    ;

xmlroot_param_version_part
    : VERSION (NO VALUE | expression)
    ;

xmlroot_param_standalone_part
    : STANDALONE (YES | NO VALUE?)
    ;

xmlserialize_param_enconding_part
    : ENCODING concatenation
    ;

xmlserialize_param_version_part
    : VERSION concatenation
    ;

xmlserialize_param_ident_part
    : NO INDENT
    | INDENT (SIZE '=' concatenation)?
    ;

// Annotations

annotations_clause
    : ANNOTATIONS '(' annotations_list ')'
    ;

annotations_list
    : (
        ADD (IF NOT EXISTS | OR REPLACE)?
        | DROP (IF EXISTS)?
        | REPLACE
    )? annotation (',' annotations_list)*
    ;

annotation
    : identifier CHAR_STRING?
    ;

// SqlPlus

sql_plus_command
    : EXIT
    | PROMPT_MESSAGE
    | SHOW (ERR | ERRORS)
    | whenever_command
    | timing_command
    | start_command
    | set_command
    | clear_command
    | execute_command
    ;

// SQL*Plus EXEC[UTE] executes a single PL/SQL statement. The command word must
// start a line so that `EXEC` used as an identifier and PL/SQL `EXECUTE
// IMMEDIATE` keep their normal meaning.
execute_command
    : {this.isLineStart()}? (EXEC | EXECUTE) statement
    ;

start_command
    : (START | AT_SIGN AT_SIGN?) sql_plus_filepath
    ;

sql_plus_filepath
    : (id_expression COLON)? (SOLIDUS | RSOLIDUS)? (
        id_expression (SOLIDUS | RSOLIDUS)
    )* id_expression PERIOD (SQL | FILE_EXT)
    ;

whenever_command
    : WHENEVER (SQLERROR | OSERROR) (
        EXIT (SUCCESS | FAILURE | WARNING | variable_name | numeric) (COMMIT | ROLLBACK)?
        | CONTINUE (COMMIT | ROLLBACK | NONE)?
    )
    ;

set_command
    : SET (
        (regular_id (ON | OFF))+
        | (regular_id (CHAR_STRING | ON | OFF | /*EXACT_NUM_LIT*/ numeric | regular_id))
     )
    ;

timing_command
    : TIMING (START timing_text = id_expression* | SHOW | STOP)?
    ;

clear_command
    : CLEAR (COLUMN? regular_id) | ALL
    ;

// Common

partition_extension_clause
    : (SUBPARTITION | PARTITION) FOR? '(' expressions_? ')'
    ;

column_alias
    : AS? (identifier | quoted_string)
    | AS
    ;

table_alias
    : identifier
    | quoted_string
    ;

where_clause
    : WHERE (CURRENT OF cursor_name | condition)
    ;

into_clause
    : (BULK COLLECT)? INTO (general_element | bind_variable) (
        ',' (general_element | bind_variable)
    )*
    ;

// Common Named Elements

xml_column_name
    : identifier
    | quoted_string
    ;

cost_class_name
    : identifier
    ;

attribute_name
    : identifier
    ;

savepoint_name
    : identifier
    ;

rollback_segment_name
    : identifier
    ;

schema_name
    : identifier
    ;

routine_name
    : identifier ('.' id_expression)* ('@' link_name)?
    ;

package_name
    : identifier
    ;

implementation_type_name
    : identifier ('.' id_expression)?
    ;

parameter_name
    : identifier
    ;

reference_model_name
    : identifier
    ;

main_model_name
    : identifier
    ;

container_tableview_name
    : identifier ('.' id_expression)?
    ;

aggregate_function_name
    : identifier ('.' id_expression)*
    ;

query_name
    : identifier
    ;

grantee_name
    : id_expression identified_by?
    ;

role_name
    : id_expression
    | CONNECT
    ;

constraint_name
    : identifier ('.' id_expression)* ('@' link_name)?
    ;

label_name
    : id_expression
    ;

type_name
    : id_expression ('.' id_expression)*
    ;

sequence_name
    : id_expression ('.' id_expression)*
    ;

exception_name
    : identifier ('.' id_expression)*
    ;

function_name
    : identifier ('.' id_expression)?
    ;

procedure_name
    : identifier ('.' id_expression)?
    ;

trigger_name
    : identifier ('.' id_expression)?
    ;

variable_name
    : (INTRODUCER char_set_name)? id_expression ('.' id_expression)?
    | bind_variable
    ;

index_name
    : identifier ('.' id_expression)?
    ;

cursor_name
    : general_element
    | bind_variable
    ;

record_name
    : identifier
    | bind_variable
    ;

link_name
    : database ('.' domain)* (AT_SIGN connection_qualifier)?
    ;

local_link_name
    : identifier
    ;

connection_qualifier
    : identifier
    ;

column_name
    : identifier ('.' id_expression)*
    ;

tableview_name
    : identifier ('.' id_expression)? (
        AT_SIGN link_name
        | /*TODO{!(input.LA(2) == BY)}?*/ partition_extension_clause
    )?
    | xmltable outer_join_sign?
    ;

xmltable
    : XMLTABLE '(' (xml_namespaces_clause ',')? concatenation xml_passing_clause? (
        RETURNING SEQUENCE BY REF
    )? (
        COLUMNS xml_table_column (',' xml_table_column)*
    )? ')' ('.' general_element_part)?
    ;

char_set_name
    : id_expression ('.' id_expression)*
    ;

synonym_name
    : identifier
    ;

// Represents a valid DB object name in DDL commands which are valid for several DB (or schema) objects.
// For instance, create synonym ... for <DB object name>, or rename <old DB object name> to <new DB object name>.
// Both are valid for sequences, tables, views, etc.
schema_object_name
    : id_expression
    ;

dir_object_name
    : id_expression
    ;

user_object_name
    : id_expression
    ;

grant_object_name
    : tableview_name
    | USER user_object_name (',' user_object_name)*
    | DIRECTORY dir_object_name
    | EDITION schema_object_name
    | MINING MODEL schema_object_name
    | JAVA (SOURCE | RESOURCE) schema_object_name
    | SQL TRANSLATION PROFILE schema_object_name
    ;

column_list
    : column_name (',' column_name)*
    ;

paren_column_list
    : LEFT_PAREN column_list RIGHT_PAREN
    ;

// PL/SQL Specs

// NOTE: In reality this applies to aggregate functions only
keep_clause
    : KEEP '(' DENSE_RANK (FIRST | LAST) (query_partition_clause | order_by_clause) ')' over_clause?
    ;

function_argument
    : '(' (argument (',' argument)*)? ')' keep_clause?
    ;

function_argument_analytic
    : '(' (argument respect_or_ignore_nulls? (',' argument respect_or_ignore_nulls?)*)? ')' keep_clause?
    ;

function_argument_modeling
    : '(' column_name (',' (numeric | NULL_) (',' (numeric | NULL_))?)? USING (
        tableview_name '.' ASTERISK
        | ASTERISK
        | expression column_alias? (',' expression column_alias?)*
    ) ')' keep_clause?
    ;

respect_or_ignore_nulls
    : (RESPECT | IGNORE) NULLS
    ;

argument
    : (identifier '=' '>')? expression
    ;

type_spec
    : datatype
    | REF? type_name (PERCENT_ROWTYPE | PERCENT_TYPE)?
    ;

datatype
    : native_datatype_element precision_part? (WITH LOCAL? TIME ZONE | CHARACTER SET char_set_name)?
    | INTERVAL (YEAR | DAY) ('(' expression ')')? TO (MONTH | SECOND) ('(' expression ')')?
    ;

precision_part
    : '(' (numeric | ASTERISK) (',' (numeric | numeric_negative))? (CHAR | BYTE)? ')'
    ;

native_datatype_element
    : BINARY_INTEGER
    | PLS_INTEGER
    | NATURAL
    | BINARY_FLOAT
    | BINARY_DOUBLE
    | NATURALN
    | POSITIVE
    | POSITIVEN
    | SIGNTYPE
    | SIMPLE_INTEGER
    | NVARCHAR2
    | DEC
    | INTEGER
    | INT
    | NUMERIC
    | SMALLINT
    | NUMBER
    | DECIMAL
    | DOUBLE PRECISION?
    | FLOAT
    | REAL
    | NCHAR
    | LONG RAW?
    | CHAR
    | CHARACTER VARYING?
    | VARCHAR2
    | VARCHAR
    | STRING
    | RAW
    | BOOLEAN
    | DATE
    | ROWID
    | UROWID
    | YEAR
    | MONTH
    | DAY
    | HOUR
    | MINUTE
    | SECOND
    | SDO_GEOMETRY
    | TIMEZONE_HOUR
    | TIMEZONE_MINUTE
    | TIMEZONE_REGION
    | TIMEZONE_ABBR
    | TIMESTAMP
    | TIMESTAMP_UNCONSTRAINED
    | TIMESTAMP_TZ_UNCONSTRAINED
    | TIMESTAMP_LTZ_UNCONSTRAINED
    | YMINTERVAL_UNCONSTRAINED
    | DSINTERVAL_UNCONSTRAINED
    | BFILE
    | BLOB
    | CLOB
    | NCLOB
    | MLSLABEL
    | XMLTYPE
    ;

bind_variable
    : (BINDVAR | ':' UNSIGNED_INTEGER)
    // Pro*C/C++ indicator variables
    (INDICATOR? (BINDVAR | ':' UNSIGNED_INTEGER))? ('.' general_element_part)*
    ;

general_element
    : general_element_part
    | general_element ('.' general_element_part)+
    | '(' general_element ')'
    ;

general_element_part
    : (INTRODUCER char_set_name)? id_expression ('@' link_name)? function_argument*
    ;

table_element
    : (INTRODUCER char_set_name)? id_expression ('.' id_expression)*
    ;

object_privilege
    : ALL PRIVILEGES?
    | ALTER
    | DEBUG
    | DELETE
    | EXECUTE
    | FLASHBACK
    | FLASHBACK ARCHIVE
    | INDEX
    | INHERIT PRIVILEGES
    | INHERIT REMOTE PRIVILEGES
    | INSERT
    | KEEP SEQUENCE
    | MERGE VIEW
    | ON COMMIT REFRESH
    | QUERY REWRITE
    | READ
    | REFERENCES
    | SELECT
    | TRANSLATE SQL
    | UNDER
    | UPDATE
    | USE
    | WRITE
    ;

//Ordered by type rather than alphabetically
system_privilege
    : ALL PRIVILEGES
    | ADVISOR
    | ADMINISTER ANY? SQL TUNING SET
    | (ALTER | CREATE | DROP) ANY SQL PROFILE
    | ADMINISTER SQL MANAGEMENT OBJECT
    | CREATE ANY? CLUSTER
    | (ALTER | DROP) ANY CLUSTER
    | (CREATE | DROP) ANY CONTEXT
    | EXEMPT REDACTION POLICY
    | ALTER DATABASE
    | (ALTER | CREATE) PUBLIC? DATABASE LINK
    | DROP PUBLIC DATABASE LINK
    | DEBUG CONNECT SESSION
    | DEBUG ANY PROCEDURE
    | ANALYZE ANY DICTIONARY
    | CREATE ANY? DIMENSION
    | (ALTER | DROP) ANY DIMENSION
    | (CREATE | DROP) ANY DIRECTORY
    | (CREATE | DROP) ANY EDITION
    | FLASHBACK (ARCHIVE ADMINISTER | ANY TABLE)
    | (ALTER | CREATE | DROP) ANY INDEX
    | CREATE ANY? INDEXTYPE
    | (ALTER | DROP | EXECUTE) ANY INDEXTYPE
    | CREATE (ANY | EXTERNAL)? JOB
    | EXECUTE ANY (CLASS | PROGRAM)
    | MANAGE SCHEDULER
    | ADMINISTER KEY MANAGEMENT
    | CREATE ANY? LIBRARY
    | (ALTER | DROP | EXECUTE) ANY LIBRARY
    | LOGMINING
    | CREATE ANY? MATERIALIZED VIEW
    | (ALTER | DROP) ANY MATERIALIZED VIEW
    | GLOBAL? QUERY REWRITE
    | ON COMMIT REFRESH
    | CREATE ANY? MINING MODEL
    | (ALTER | DROP | SELECT | COMMENT) ANY MINING MODEL
    | CREATE ANY? CUBE
    | (ALTER | DROP | SELECT | UPDATE) ANY CUBE
    | CREATE ANY? MEASURE FOLDER
    | (DELETE | DROP | INSERT) ANY MEASURE FOLDER
    | CREATE ANY? CUBE DIMENSION
    | (ALTER | DELETE | DROP | INSERT | SELECT | UPDATE) ANY CUBE DIMENSION
    | CREATE ANY? CUBE BUILD PROCESS
    | (DROP | UPDATE) ANY CUBE BUILD PROCESS
    | CREATE ANY? OPERATOR
    | (ALTER | DROP | EXECUTE) ANY OPERATOR
    | (CREATE | ALTER | DROP) ANY OUTLINE
    | CREATE PLUGGABLE DATABASE
    | SET CONTAINER
    | CREATE ANY? PROCEDURE
    | (ALTER | DROP | EXECUTE) ANY PROCEDURE
    | (CREATE | ALTER | DROP) PROFILE
    | CREATE ROLE
    | (ALTER | DROP | GRANT) ANY ROLE
    | (CREATE | ALTER | DROP) ROLLBACK SEGMENT
    | CREATE ANY? SEQUENCE
    | (ALTER | DROP | SELECT) ANY SEQUENCE
    | (ALTER | CREATE | RESTRICTED) SESSION
    | ALTER RESOURCE COST
    | CREATE ANY? SQL TRANSLATION PROFILE
    | (ALTER | DROP | USE) ANY SQL TRANSLATION PROFILE
    | TRANSLATE ANY SQL
    | CREATE ANY? SYNONYM
    | DROP ANY SYNONYM
    | (CREATE | DROP) PUBLIC SYNONYM
    | CREATE ANY? TABLE
    | (ALTER | BACKUP | COMMENT | DELETE | DROP | INSERT | LOCK | READ | SELECT | UPDATE) ANY TABLE
    | (CREATE | ALTER | DROP | MANAGE | UNLIMITED) TABLESPACE
    | CREATE ANY? TRIGGER
    | (ALTER | DROP) ANY TRIGGER
    | ADMINISTER DATABASE TRIGGER
    | CREATE ANY? TYPE
    | (ALTER | DROP | EXECUTE | UNDER) ANY TYPE
    | (CREATE | ALTER | DROP) USER
    | CREATE ANY? VIEW
    | (DROP | UNDER | MERGE) ANY VIEW
    | (ANALYZE | AUDIT) ANY
    | BECOME USER
    | CHANGE NOTIFICATION
    | EXEMPT ACCESS POLICY
    | FORCE ANY? TRANSACTION
    | GRANT ANY OBJECT? PRIVILEGE
    | INHERIT ANY PRIVILEGES
    | KEEP DATE TIME
    | KEEP SYSGUID
    | PURGE DBA_RECYCLEBIN
    | RESUMABLE
    | SELECT ANY (DICTIONARY | TRANSACTION)
    | SYSBACKUP
    | SYSDBA
    | SYSDG
    | SYSKM
    | SYSOPER
    ;

// $>

// $<Lexer Mappings

constant
    : TIMESTAMP (quoted_string | bind_variable) (AT TIME ZONE quoted_string)?
    | INTERVAL (quoted_string | bind_variable | general_element_part) (
        YEAR
        | MONTH
        | DAY
        | HOUR
        | MINUTE
        | SECOND
    ) ('(' (UNSIGNED_INTEGER | bind_variable) (',' (UNSIGNED_INTEGER | bind_variable))? ')')? (
        TO (MONTH | DAY | HOUR | MINUTE | SECOND ('(' (UNSIGNED_INTEGER | bind_variable) ')')?)
    )?
    | numeric
    | DATE quoted_string
    | quoted_string
    | NULL_
    | TRUE
    | FALSE
    | DBTIMEZONE
    | SESSIONTIMEZONE
    | MINVALUE
    | MAXVALUE
    | DEFAULT
    ;

numeric
    : UNSIGNED_INTEGER '.'?
    | APPROXIMATE_NUM_LIT
    ;

numeric_negative
    : MINUS_SIGN numeric
    ;

quoted_string
    : CHAR_STRING
    //| CHAR_STRING_PERL
    | NATIONAL_CHAR_STRING_LIT
    ;

identifier
    : (INTRODUCER char_set_name)? id_expression
    ;

id_expression
    : regular_id
    | DELIMITED_ID
    ;

inquiry_directive
    : INQUIRY_DIRECTIVE
    ;

outer_join_sign
    : '(' '+' ')'
    ;

regular_id
    : non_reserved_keywords_pre12c
    | non_reserved_keywords_in_12c
    | non_reserved_keywords_in_18c
    | REGULAR_ID
    | AUDIT
    | ITEMS
    | BYTES
    | LINES
    | RECORDS
    | NEWLINE_
    | FIELD
    | MASK
    | ABSENT
    | A_LETTER
    | AGENT
    | AGGREGATE
    | ANALYZE
    | AUTONOMOUS_TRANSACTION
    | BACKINGFILE
    | BATCH
    | BINARY_INTEGER
    | BOOLEAN
    | C_LETTER
    | CHAR
    | CHARSETID
    | CHARSETFORM
    | CLUSTER
    | CONSTRUCTOR
    | CUSTOMDATUM
    | CASESENSITIVE
    | COUNTED
    | DATE
    | DECIMAL
    | DELETE
    | DEPRECATE
    | DETECTED
    | DETERMINISTIC
    | DISABLED
    | DSINTERVAL_UNCONSTRAINED
    | DURATION
    | E_LETTER
    | ENABLED
    | ENCLOSED
    | ERROR_INDEX
    | ERROR_CODE
    | ERR
    | EXCEPTION
    | EXCEPTION_INIT
    | EXCEPTIONS
    | EXISTS
    | EXEC
    | EXIT
    | EXTEND
    | FIELDS
    | FILE_EXT
    | FILESTORE
    | FLOAT
    | FORALL
    | G_LETTER
    | INDICES
    | INOUT
    | INTEGER
    | INTERNAL
    | JSON_TRANSFORM
    | K_LETTER
    | LANGUAGE
    | LONG
    | LOOP
    | MAXLEN
    | MOUNTPOINT
    | M_LETTER
    | MISSING
    | MISMATCH
    | NUMBER
    | ORADATA
    | ORC
    | OSERROR
    | OUT
    | OVERRIDING
    | P_LETTER
    | PARALLEL_ENABLE
    | PIPELINED
    | PLS_INTEGER
    | PMEM
    | POSITIVE
    | POSITIVEN
    | PRAGMA
    | PUBLIC
    | RAISE
    | RAW
    | RECORD
    | REF
    | RENAME
    | RESTRICT_REFERENCES
    | RESULT
    | SDO_GEOMETRY
    | SELF
    | SERIALLY_REUSABLE
    | SET
    | SEQ
    | SHARDSPACE
    | SIGNTYPE
    | SIMPLE_INTEGER
    | SMALLINT
    | STRUCT
    | SQLDATA
    | SQLERROR
    | SUBTYPE
    | T_LETTER
    | TDO
    | TIMESTAMP_LTZ_UNCONSTRAINED
    | TIMESTAMP_TZ_UNCONSTRAINED
    | TIMESTAMP_UNCONSTRAINED
    | TIMEZONE
    | TRIGGER
    | UDF
    | VARCHAR
    | VARCHAR2
    | VARIABLE
    | WARNING
    | WHILE
    | WM_CONCAT
    | XMLAGG
    | YMINTERVAL_UNCONSTRAINED
    | REGR_
    | VAR_
    | VALUE
    | COVAR_
    | DATE_FORMAT
    | CSV
    | CHARACTERSET
    ;

non_reserved_keywords_in_18c
    : PERSISTABLE
    | POLYMORPHIC
    ;

non_reserved_keywords_in_12c
    : ACL
    | ACCESSIBLE
    | ACROSS
    | ACTION
    | ACTIONS
    | ACTIVE
    | ACTIVE_DATA
    | ACTIVITY
    | ADAPTIVE_PLAN
    | ADVANCED
    | AFD_DISKSTRING
    | ALTERNATE
    | ALGORITHM
    | ANALYTIC
    | ANCESTOR
    | ANOMALY
    | ANSI_REARCH
    | APPLICATION
    | APPROX_COUNT_DISTINCT
    | ARCHIVAL
    | ARCHIVED
    | ASIS
    | ASSIGN
    | AUTO_LOGIN
    | AUTO_REOPTIMIZE
    | AVRO
    | BACKGROUND
    | BACKUPS
    | BATCHSIZE
    | BATCH_TABLE_ACCESS_BY_ROWID
    | BEGINNING
    | BEQUEATH
    | BITMAP_AND
    | BLOCKCHAIN
    | BSON
    | CACHING
    | CALCULATED
    | CALLBACK
    | CAPACITY
    | CAPTION
    | CDBDEFAULT
    | CLASSIFICATION
    | CLASSIFIER
    | CLAUSE
    | CLEAN
    | CLEANUP
    | CLIENT
    | CLUSTERING
    | CLUSTER_DETAILS
    | CLUSTER_DISTANCE
    | COLLATE
    | COLLATION
    | COMMON
    | COMMON_DATA
    | COMPONENT
    | COMPONENTS
    | CONDITION
    | CONDITIONAL
    | CONTAINERS
    | CONTAINERS_DEFAULT
    | CONTAINER_DATA
    | CONTAINER_MAP
    | CONVERSION
    | CON_DBID_TO_ID
    | CON_GUID_TO_ID
    | CON_ID
    | CON_NAME_TO_ID
    | CON_UID_TO_ID
    | COOKIE
    | COPY
    | CREATE_FILE_DEST
    | CREDENTIAL
    | CRITICAL
    | CUBE_AJ
    | CUBE_SJ
    | DATAMOVEMENT
    | DATAOBJ_TO_MAT_PARTITION
    | DATAPUMP
    | DATA_SECURITY_REWRITE_LIMIT
    | DAYS
    | DB_UNIQUE_NAME
    | DECORRELATE
    | DEFAULT_CREDENTIAL
    | DEFAULT_COLLATION
    | DEFINE
    | DEFINITION
    | DELEGATE
    | DELETE_ALL
    | DESCRIPTION
    | DESTROY
    | DIMENSIONS
    | DISABLE_ALL
    | DISABLE_PARALLEL_DML
    | DISCARD
    | DISTRIBUTE
    | DUPLICATE
    | DUPLICATED
    | DV
    | EDITIONABLE
    | ELIM_GROUPBY
    | EM
    | ENABLE_ALL
    | ENABLE_PARALLEL_DML
    | EQUIPART
    | EVAL
    | EVALUATE
    | EXISTING
    | EXPRESS
    | EXTENDED
    | EXTRACTCLOBXML
    | FACTOR
    | FAILOVER
    | FAILURE
    | FAMILY
    | FAR
    | FASTSTART
    | FEATURE
    | FEATURE_DETAILS
    | FETCH
    | FILE_NAME_CONVERT
    | FILEGROUP
    | FIXED_VIEW_DATA
    | FLEX
    | FORMAT
    | FTP
    | GATHER_OPTIMIZER_STATISTICS
    | GET
    | HALF_YEARS
    | HASHING
    | HIER_ORDER
    | HIERARCHICAL
    | HOURS
    | HTTP
    | H_LETTER
    | IDLE
    | ILM
    | IMMUTABLE
    | INACTIVE
    | INACTIVE_ACCOUNT_TIME
    | INDEXING
    | INHERIT
    | INMEMORY
    | INMEMORY_PRUNING
    | INPLACE
    | INTERLEAVED
    | INVALIDATION
    | ISOLATE
    | IS_LEAF
    | JSON
    | JSONGET
    | JSONPARSE
    | JSON_ARRAY
    | JSON_ARRAYAGG
    | JSON_EQUAL
    | JSON_EXISTS
    | JSON_EXISTS2
    | JSON_OBJECT
    | JSON_OBJECTAGG
    | JSON_QUERY
    | JSON_SERIALIZE
    | JSON_TABLE
    | JSON_TEXTCONTAINS
    | JSON_TEXTCONTAINS2
    | JSON_VALUE
    | KEYSTORE
    | LABEL
    | LAX
    | LEAD_CDB
    | LEAD_CDB_URI
    | LEVEL_NAME
    | LIFECYCLE
    | LINEAR
    | LOCKDOWN
    | LOCKING
    | LOGMINING
    | LOST
    | MANDATORY
    | MAP
    | MATCH
    | MATCHES
    | MATCH_NUMBER
    | MATCH_RECOGNIZE
    | MAX_SHARED_TEMP_SIZE
    | MEMCOMPRESS
    | METADATA
    | MEMBER_CAPTION
    | MEMBER_DESCRIPTION
    | MEMBER_NAME
    | MEMBER_UNIQUE_NAME
    | MEMOPTIMIZE
    | MINUTES
    | MODEL_NB
    | MODEL_SV
    | MODIFICATION
    | MODULE
    | MONTHS
    | MULTIDIMENSIONAL
    | NEG
    | NOCOPY
    | NOKEEP
    | NONEDITIONABLE
    | NONPARTITIONED
    | NOPARTITION
    | NORELOCATE
    | NOREPLAY
    | NO_ADAPTIVE_PLAN
    | NO_ANSI_REARCH
    | NO_AUTO_REOPTIMIZE
    | NO_BATCH_TABLE_ACCESS_BY_ROWID
    | NO_CLUSTERING
    | NO_COMMON_DATA
    | NO_DATA_SECURITY_REWRITE
    | NO_DECORRELATE
    | NO_ELIM_GROUPBY
    | NO_GATHER_OPTIMIZER_STATISTICS
    | NO_INMEMORY
    | NO_INMEMORY_PRUNING
    | NO_OBJECT_LINK
    | NO_PARTIAL_JOIN
    | NO_PARTIAL_ROLLUP_PUSHDOWN
    | NO_PQ_CONCURRENT_UNION
    | NO_PQ_REPLICATE
    | NO_PQ_SKEW
    | NOPROMPT
    | NO_PX_FAULT_TOLERANCE
    | NO_ROOT_SW_FOR_LOCAL
    | NO_SQL_TRANSLATION
    | NO_USE_CUBE
    | NO_USE_VECTOR_AGGREGATION
    | NO_VECTOR_TRANSFORM
    | NO_VECTOR_TRANSFORM_DIMS
    | NO_VECTOR_TRANSFORM_FACT
    | NO_ZONEMAP
    | OBJ_ID
    | OFFSET
    | OLS
    | OMIT
    | ONE
    | ORACLE_DATAPUMP
    | ORACLE_HDFS
    | ORACLE_HIVE
    | ORACLE_LOADER
    | ORA_CHECK_ACL
    | ORA_CHECK_PRIVILEGE
    | ORA_CLUSTERING
    | ORA_INVOKING_USER
    | ORA_INVOKING_USERID
    | ORA_INVOKING_XS_USER
    | ORA_INVOKING_XS_USER_GUID
    | ORA_RAWCOMPARE
    | ORA_RAWCONCAT
    | ORA_WRITE_TIME
    | PARENT_LEVEL_NAME
    | PARENT_UNIQUE_NAME
    | PASSWORD_ROLLOVER_TIME
    | PARTIAL
    | PARTIAL_JOIN
    | PARTIAL_ROLLUP_PUSHDOWN
    | PAST
    | PATCH
    | PATH_PREFIX
    | PATTERN
    | PER
    | PERIOD
    | PERIOD_KEYWORD
    | PERMUTE
    | PLUGGABLE
    | POOL_16K
    | POOL_2K
    | POOL_32K
    | POOL_4K
    | POOL_8K
    | PQ_CONCURRENT_UNION
    | PQ_DISTRIBUTE_WINDOW
    | PQ_FILTER
    | PQ_REPLICATE
    | PQ_SKEW
    | PRELOAD
    | PRETTY
    | PREV
    | PRINTBLOBTOCLOB
    | PRIORITY
    | PRIVILEGED
    | PROPERTY
    | PROTOCOL
    | PROXY
    | PRUNING
    | PX_FAULT_TOLERANCE
    | QUARTERS
    | QUOTAGROUP
    | REALM
    | REDEFINE
    | RELOCATE
    | REMOTE
    | RESTART
    | ROLESET
    | ROWID_MAPPING_TABLE
    | RUNNING
    | SAVE
    | SCRUB
    | SDO_GEOM_MBR
    | SECONDS
    | SECRET
    | SERIAL
    | SERVICES
    | SERVICE_NAME_CONVERT
    | SHARDED
    | SHARING
    | SHELFLIFE
    | SITE
    | SOURCE_FILE_DIRECTORY
    | SOURCE_FILE_NAME_CONVERT
    | SQL_TRANSLATION_PROFILE
    | STANDARD
    | STANDARD_HASH
    | STANDBYS
    | STATE
    | STATEMENT
    | STREAM
    | SUBSCRIBE
    | SUBSET
    | SUCCESS
    | SYS
    | SYSBACKUP
    | SYSDG
    | SYSGUID
    | SYSKM
    | SYSOBJ
    | SYS_CHECK_PRIVILEGE
    | SYS_GET_COL_ACLIDS
    | SYS_MKXTI
    | SYS_OP_CYCLED_SEQ
    | SYS_OP_HASH
    | SYS_OP_KEY_VECTOR_CREATE
    | SYS_OP_KEY_VECTOR_FILTER
    | SYS_OP_KEY_VECTOR_FILTER_LIST
    | SYS_OP_KEY_VECTOR_SUCCEEDED
    | SYS_OP_KEY_VECTOR_USE
    | SYS_OP_PART_ID
    | SYS_OP_ZONE_ID
    | SYS_RAW_TO_XSID
    | SYS_XSID_TO_RAW
    | SYS_ZMAP_FILTER
    | SYS_ZMAP_REFRESH
    | TAG
    | TEXT
    | TIER
    | TIES
    | TO_ACLID
    | TRANSFORM
    | TRANSLATION
    | TRUST
    | UCS2
    | UNCONDITIONAL
    | UNITE
    | UNMATCHED
    | UNPLUG
    | UNSUBSCRIBE
    | USABLE
    | USER_DATA
    | USER_TABLESPACES
    | USE_CUBE
    | USE_HIDDEN_PARTITIONS
    | USE_VECTOR_AGGREGATION
    | USING_NO_EXPAND
    | USING_NLS_COMP
    | UTF16BE
    | UTF16LE
    | UTF32
    | UTF8
    | V1
    | V2
    | VALIDATE_CONVERSION
    | VALID_TIME_END
    | VECTOR_TRANSFORM
    | VECTOR_TRANSFORM_DIMS
    | VECTOR_TRANSFORM_FACT
    | VERIFIER
    | VIOLATION
    | VISIBILITY
    | WEEK
    | WEEKS
    | WITH_PLSQL
    | WRAPPER
    | XS
    | YEARS
    | ZONEMAP
    ;

non_reserved_keywords_pre12c
    : ABORT
    | ABS
    | ACCESSED
    | ACCESS
    | ACCOUNT
    | ACOS
    | ACTIVATE
    | ACTIVE_COMPONENT
    | ACTIVE_FUNCTION
    | ACTIVE_TAG
    | ADD_COLUMN
    | ADD_GROUP
    | ADD_MONTHS
    | ADD
    | ADJ_DATE
    | ADMINISTER
    | ADMINISTRATOR
    | ADMIN
    | ADVISE
    | ADVISOR
    | AFTER
    | ALIAS
    | ALLOCATE
    | ALLOW
    | ALL_ROWS
    | ALWAYS
    | ANALYZE
    | ANCILLARY
    | AND_EQUAL
    | ANTIJOIN
    | ANYSCHEMA
    | APPENDCHILDXML
    | APPEND
    | APPEND_VALUES
    | APPLY
    | ARCHIVELOG
    | ARCHIVE
    | ARRAY
    | ASCII
    | ASCIISTR
    | ASIN
    | ASSEMBLY
    | ASSOCIATE
    | ASYNCHRONOUS
    | ASYNC
    | ATAN2
    | ATAN
    | AT
    | ATTRIBUTE
    | ATTRIBUTES
    | AUTHENTICATED
    | AUTHENTICATION
    | AUTHID
    | AUTHORIZATION
    | AUTOALLOCATE
    | AUTOEXTEND
    | AUTOMATIC
    | AUTO
    | AVAILABILITY
    | AVG
    | BACKUP
    | BASICFILE
    | BASIC
    | BATCH
    | BECOME
    | BEFORE
    | BEGIN
    | BEGIN_OUTLINE_DATA
    | BEHALF
    | BFILE
    | BFILENAME
    | BIGFILE
    | BINARY_DOUBLE_INFINITY
    | BINARY_DOUBLE
    | BINARY_DOUBLE_NAN
    | BINARY_FLOAT_INFINITY
    | BINARY_FLOAT
    | BINARY_FLOAT_NAN
    | BINARY
    | BIND_AWARE
    | BINDING
    | BIN_TO_NUM
    | BITAND
    | BITMAP
    | BITMAPS
    | BITMAP_TREE
    | BITS
    | BLOB
    | BLOCK
    | BLOCK_RANGE
    | BLOCKSIZE
    | BLOCKS
    | BODY
    | BOTH
    | BOUND
    | BRANCH
    | BREADTH
    | BROADCAST
    | BUFFER_CACHE
    | BUFFER
    | BUFFER_POOL
    | BUILD
    | BULK
    | BYPASS_RECURSIVE_CHECK
    | BYPASS_UJVC
    | BYTE
    | CACHE_CB
    | CACHE_INSTANCES
    | CACHE
    | CACHE_TEMP_TABLE
    | CALL
    | CANCEL
    | CARDINALITY
    | CASCADE
    | CASE
    | CAST
    | CATEGORY
    | CEIL
    | CELL_FLASH_CACHE
    | CERTIFICATE
    | CFILE
    | CHAINED
    | CHANGE_DUPKEY_ERROR_INDEX
    | CHANGE
    | CHARACTER
    | CHAR_CS
    | CHARTOROWID
    | CHECK_ACL_REWRITE
    | CHECKPOINT
    | CHILD
    | CHOOSE
    | CHR
    | CHUNK
    | CLASS
    | CLEAR
    | CLOB
    | CLONE
    | CLOSE_CACHED_OPEN_CURSORS
    | CLOSE
    | CLUSTER_BY_ROWID
    | CLUSTER_ID
    | CLUSTERING_FACTOR
    | CLUSTER_PROBABILITY
    | CLUSTER_SET
    | COALESCE
    | COALESCE_SQ
    | COARSE
    | CO_AUTH_IND
    | COLD
    | COLLECT
    | COLUMNAR
    | COLUMN_AUTH_INDICATOR
    | COLUMN
    | COLUMNS
    | COLUMN_STATS
    | COLUMN_VALUE
    | COMMENT
    | COMMIT
    | COMMITTED
    | COMPACT
    | COMPATIBILITY
    | COMPILE
    | COMPLETE
    | COMPLIANCE
    | COMPOSE
    | COMPOSITE_LIMIT
    | COMPOSITE
    | COMPOUND
    | COMPUTE
    | CONCAT
    | CONFIRM
    | CONFORMING
    | CONNECT_BY_CB_WHR_ONLY
    | CONNECT_BY_COMBINE_SW
    | CONNECT_BY_COST_BASED
    | CONNECT_BY_ELIM_DUPS
    | CONNECT_BY_FILTERING
    | CONNECT_BY_ISCYCLE
    | CONNECT_BY_ISLEAF
    | CONNECT_BY_ROOT
    | CONNECT_TIME
    | CONSIDER
    | CONSISTENT
    | CONSTANT
    | CONST
    | CONSTRAINT
    | CONSTRAINTS
    | CONTAINER
    | CONTENT
    | CONTENTS
    | CONTEXT
    | CONTINUE
    | CONTROLFILE
    | CONVERT
    | CORR_K
    | CORR
    | CORR_S
    | CORRUPTION
    | CORRUPT_XID_ALL
    | CORRUPT_XID
    | COSH
    | COS
    | COST
    | COST_XML_QUERY_REWRITE
    | COUNT
    | COVAR_POP
    | COVAR_SAMP
    | CPU_COSTING
    | CPU_PER_CALL
    | CPU_PER_SESSION
    | CRASH
    | CREATE_STORED_OUTLINES
    | CREATION
    | CROSSEDITION
    | CROSS
    | CSCONVERT
    | CUBE_GB
    | CUBE
    | CUME_DISTM
    | CUME_DIST
    | CURRENT_DATE
    | CURRENT
    | CURRENT_SCHEMA
    | CURRENT_TIME
    | CURRENT_TIMESTAMP
    | CURRENT_USER
    | CURRENTV
    | CURSOR
    | CURSOR_SHARING_EXACT
    | CURSOR_SPECIFIC_SEGMENT
    | CV
    | CYCLE
    | DANGLING
    | DATABASE
    | DATAFILE
    | DATAFILES
    | DATA
    | DATAOBJNO
    | DATAOBJ_TO_PARTITION
    | DATE_MODE
    | DAY
    | DBA
    | DBA_RECYCLEBIN
    | DBLINK
    | DBMS_STATS
    | DB_ROLE_CHANGE
    | DBTIMEZONE
    | DB_VERSION
    | DDL
    | DEALLOCATE
    | DEBUGGER
    | DEBUG
    | DECLARE
    | DEC
    | DECOMPOSE
    | DECREMENT
    | DECR
    | DECRYPT
    | DEDUPLICATE
    | DEFAULTS
    | DEFERRABLE
    | DEFERRED
    | DEFINED
    | DEFINER
    | DEGREE
    | DELAY
    | DELETEXML
    | DEMAND
    | DENSE_RANKM
    | DENSE_RANK
    | DEPENDENT
    | DEPTH
    | DEQUEUE
    | DEREF
    | DEREF_NO_REWRITE
    | DETACHED
    | DETERMINES
    | DICTIONARY
    | DIMENSION
    | DIRECT_LOAD
    | DIRECTORY
    | DIRECT_PATH
    | DISABLE
    | DISABLE_PRESET
    | DISABLE_RPKE
    | DISALLOW
    | DISASSOCIATE
    | DISCONNECT
    | DISKGROUP
    | DISK
    | DISKS
    | DISMOUNT
    | DISTINGUISHED
    | DISTRIBUTED
    | DML
    | DML_UPDATE
    | DOCFIDELITY
    | DOCUMENT
    | DOMAIN_INDEX_FILTER
    | DOMAIN_INDEX_NO_SORT
    | DOMAIN_INDEX_SORT
    | DOUBLE
    | DOWNGRADE
    | DRIVING_SITE
    | DROP_COLUMN
    | DROP_GROUP
    | DST_UPGRADE_INSERT_CONV
    | DUMP
    | DYNAMIC
    | DYNAMIC_SAMPLING_EST_CDN
    | DYNAMIC_SAMPLING
    | EACH
    | EDITIONING
    | EDITION
    | EDITIONS
    | ELEMENT
    | ELIMINATE_JOIN
    | ELIMINATE_OBY
    | ELIMINATE_OUTER_JOIN
    | EMPTY_BLOB
    | EMPTY_CLOB
    | EMPTY_
    | ENABLE
    | ENABLE_PRESET
    | ENCODING
    | ENCRYPTION
    | ENCRYPT
    | END_OUTLINE_DATA
    | ENFORCED
    | ENFORCE
    | ENQUEUE
    | ENTERPRISE
    | ENTITYESCAPING
    | ENTRY
    | ERROR_ARGUMENT
    | ERROR
    | ERROR_ON_OVERLAP_TIME
    | ERRORS
    | ESCAPE
    | ESTIMATE
    | EVALNAME
    | EVALUATION
    | EVENTS
    | EVERY
    | EXCEPTIONS
    | EXCEPT
    | EXCHANGE
    | EXCLUDE
    | EXCLUDING
    | EXECUTE
    | EXEMPT
    | EXISTSNODE
    | EXPAND_GSET_TO_UNION
    | EXPAND_TABLE
    | EXPIRE
    | EXPLAIN
    | EXPLOSION
    | EXP
    | EXPORT
    | EXPR_CORR_CHECK
    | EXTENDS
    | EXTENT
    | EXTENTS
    | EXTERNALLY
    | EXTERNAL
    | EXTRACT
    | EXTRACTVALUE
    | EXTRA
    | FACILITY
    | FACT
    | FACTORIZE_JOIN
    | FAILED_LOGIN_ATTEMPTS
    | FAILED
    | FAILGROUP
    | FALSE
    | FAST
    | FBTSCAN
    | FEATURE_ID
    | FEATURE_SET
    | FEATURE_VALUE
    | FILE
    | FILESYSTEM_LIKE_LOGGING
    | FILTER
    | FINAL
    | FINE
    | FINISH
    | FIRSTM
    | FIRST
    | FIRST_ROWS
    | FIRST_VALUE
    | FLAGGER
    | FLASHBACK
    | FLASH_CACHE
    | FLOB
    | FLOOR
    | FLUSH
    | FOLDER
    | FOLLOWING
    | FOLLOWS
    | FORCE
    | FORCE_XML_QUERY_REWRITE
    | FOREIGN
    | FOREVER
    | FORWARD
    | FRAGMENT_NUMBER
    | FREELIST
    | FREELISTS
    | FREEPOOLS
    | FRESH
    | FROM_TZ
    | FULL
    | FULL_OUTER_JOIN_TO_OUTER
    | FUNCTION
    | FUNCTIONS
    | GATHER_PLAN_STATISTICS
    | GBY_CONC_ROLLUP
    | GBY_PUSHDOWN
    | GENERATED
    | GLOBALLY
    | GLOBAL
    | GLOBAL_NAME
    | GLOBAL_TOPIC_ENABLED
    | GREATEST
    | GROUP_BY
    | GROUP_ID
    | GROUPING_ID
    | GROUPING
    | GROUPS
    | GUARANTEED
    | GUARANTEE
    | GUARD
    | HASH_AJ
    | HASHKEYS
    | HASH
    | HASH_SJ
    | HEADER
    | HEAP
    | HELP
    | HEXTORAW
    | HEXTOREF
    | HIDDEN_KEYWORD
    | HIDE
    | HIERARCHY
    | HIGH
    | HINTSET_BEGIN
    | HINTSET_END
    | HOT
    | HOUR
    | HWM_BROKERED
    | HYBRID
    | IDENTIFIER
    | IDENTITY
    | IDGENERATORS
    | IDLE_TIME
    | ID
    | IF
    | IGNORE
    | IGNORE_OPTIM_EMBEDDED_HINTS
    | IGNORE_ROW_ON_DUPKEY_INDEX
    | IGNORE_WHERE_CLAUSE
    | IMMEDIATE
    | IMPACT
    | IMPORT
    | INCLUDE
    | INCLUDE_VERSION
    | INCLUDING
    | INCREMENTAL
    | INCREMENT
    | INCR
    | INDENT
    | INDEX_ASC
    | INDEX_COMBINE
    | INDEX_DESC
    | INDEXED
    | INDEXES
    | INDEX_FFS
    | INDEX_FILTER
    | INDEX_JOIN
    | INDEX_ROWS
    | INDEX_RRS
    | INDEX_RS_ASC
    | INDEX_RS_DESC
    | INDEX_RS
    | INDEX_SCAN
    | INDEX_SKIP_SCAN
    | INDEX_SS_ASC
    | INDEX_SS_DESC
    | INDEX_SS
    | INDEX_STATS
    | INDEXTYPE
    | INDEXTYPES
    | INDICATOR
    | INFINITE
    | INFORMATIONAL
    | INITCAP
    | INITIALIZED
    | INITIALLY
    | INITIAL
    | INITRANS
    | INLINE
    | INLINE_XMLTYPE_NT
    | IN_MEMORY_METADATA
    | INNER
    | INSERTCHILDXMLAFTER
    | INSERTCHILDXMLBEFORE
    | INSERTCHILDXML
    | INSERTXMLAFTER
    | INSERTXMLBEFORE
    | INSTANCE
    | INSTANCES
    | INSTANTIABLE
    | INSTANTLY
    | INSTEAD
    | INSTR2
    | INSTR4
    | INSTRB
    | INSTRC
    | INSTR
    | INTERMEDIATE
    | INTERNAL_CONVERT
    | INTERNAL_USE
    | INTERPRETED
    | INTERVAL
    | INT
    | INVALIDATE
    | INVISIBLE
    | IN_XQUERY
    | ISOLATION_LEVEL
    | ISOLATION
    | ITERATE
    | ITERATION_NUMBER
    | JAVA
    | JOB
    | JOIN
    | KEEP_DUPLICATES
    | KEEP
    | KERBEROS
    | KEY_LENGTH
    | KEY
    | KEYSIZE
    | KEYS
    | KILL
    | LAG
    | LAST_DAY
    | LAST
    | LAST_VALUE
    | LATERAL
    | LAYER
    | LDAP_REGISTRATION_ENABLED
    | LDAP_REGISTRATION
    | LDAP_REG_SYNC_INTERVAL
    | LEADING
    | LEAD
    | LEAF
    | LEAST
    | LEFT
    | LENGTH2
    | LENGTH4
    | LENGTHB
    | LENGTHC
    | LENGTH
    | LESS
    | LEVEL
    | LEVELS
    | LIBRARY
    | LIFE
    | LIFETIME
    | LIKE2
    | LIKE4
    | LIKEC
    | LIKE_EXPAND
    | LIMIT
    | LINK
    | LISTAGG
    | LIST
    | LN
    | LNNVL
    | LOAD
    | LOB
    | LOBNVL
    | LOBS
    | LOCAL_INDEXES
    | LOCAL
    | LOCALTIME
    | LOCALTIMESTAMP
    | LOCATION
    | LOCATOR
    | LOCKED
    | LOGFILE
    | LOGFILES
    | LOGGING
    | LOGICAL
    | LOGICAL_READS_PER_CALL
    | LOGICAL_READS_PER_SESSION
    | LOG
    | LOGOFF
    | LOGON
    | LOG_READ_ONLY_VIOLATIONS
    | LOWER
    | LOW
    | LPAD
    | LTRIM
    | MAIN
    | MAKE_REF
    | MANAGED
    | MANAGEMENT
    | MANAGE
    | MANAGER
    | MANUAL
    | MAPPING
    | MASTER
    | MATCHED
    | MATERIALIZED
    | MATERIALIZE
    | MAXARCHLOGS
    | MAXDATAFILES
    | MAXEXTENTS
    | MAXIMIZE
    | MAXINSTANCES
    | MAXLOGFILES
    | MAXLOGHISTORY
    | MAXLOGMEMBERS
    | MAX
    | MAXSIZE
    | MAXTRANS
    | MAXVALUE
    | MEASURE
    | MEASURES
    | MEDIAN
    | MEDIUM
    | MEMBER
    | MEMOPTIMIZE
    | MEMORY
    | MERGEACTIONS
    | MERGE_AJ
    | MERGE_CONST_ON
    | MERGE
    | MERGE_SJ
    | METHOD
    | MIGRATE
    | MIGRATION
    | MINEXTENTS
    | MINIMIZE
    | MINIMUM
    | MINING
    | MIN
    | MINUS_NULL
    | MINUTE
    | MINVALUE
    | MIRRORCOLD
    | MIRRORHOT
    | MIRROR
    | MLSLABEL
    | MODEL_COMPILE_SUBQUERY
    | MODEL_DONTVERIFY_UNIQUENESS
    | MODEL_DYNAMIC_SUBQUERY
    | MODEL_MIN_ANALYSIS
    | MODEL
    | MODEL_NO_ANALYSIS
    | MODEL_PBY
    | MODEL_PUSH_REF
    | MODIFY_COLUMN_TYPE
    | MODIFY
    | MOD
    | MONITORING
    | MONITOR
    | MONTH
    | MONTHS_BETWEEN
    | MOUNT
    | MOUNTPATH
    | MOVEMENT
    | MOVE
    | MULTISET
    | MV_MERGE
    | NAMED
    | NAME
    | NAMESPACE
    | NAN_
    | NANVL
    | NATIONAL
    | NATIVE_FULL_OUTER_JOIN
    | NATIVE
    | NATURAL
    | NAV
    | NCHAR_CS
    | NCHAR
    | NCHR
    | NCLOB
    | NEEDED
    | NESTED
    | NESTED_TABLE_FAST_INSERT
    | NESTED_TABLE_GET_REFS
    | NESTED_TABLE_ID
    | NESTED_TABLE_SET_REFS
    | NESTED_TABLE_SET_SETID
    | NETWORK
    | NEVER
    | NEW
    | NEW_TIME
    | NEXT_DAY
    | NEXT
    | NL_AJ
    | NLJ_BATCHING
    | NLJ_INDEX_FILTER
    | NLJ_INDEX_SCAN
    | NLJ_PREFETCH
    | NLS_CALENDAR
    | NLS_CHARACTERSET
    | NLS_CHARSET_DECL_LEN
    | NLS_CHARSET_ID
    | NLS_CHARSET_NAME
    | NLS_COMP
    | NLS_CURRENCY
    | NLS_DATE_FORMAT
    | NLS_DATE_LANGUAGE
    | NLS_INITCAP
    | NLS_ISO_CURRENCY
    | NL_SJ
    | NLS_LANG
    | NLS_LANGUAGE
    | NLS_LENGTH_SEMANTICS
    | NLS_LOWER
    | NLS_NCHAR_CONV_EXCP
    | NLS_NUMERIC_CHARACTERS
    | NLS_SORT
    | NLSSORT
    | NLS_SPECIAL_CHARS
    | NLS_TERRITORY
    | NLS_UPPER
    | NO_ACCESS
    | NOAPPEND
    | NOARCHIVELOG
    | NOAUDIT
    | NO_BASETABLE_MULTIMV_REWRITE
    | NO_BIND_AWARE
    | NO_BUFFER
    | NOCACHE
    | NO_CARTESIAN
    | NO_CHECK_ACL_REWRITE
    | NO_CLUSTER_BY_ROWID
    | NO_COALESCE_SQ
    | NO_CONNECT_BY_CB_WHR_ONLY
    | NO_CONNECT_BY_COMBINE_SW
    | NO_CONNECT_BY_COST_BASED
    | NO_CONNECT_BY_ELIM_DUPS
    | NO_CONNECT_BY_FILTERING
    | NO_COST_XML_QUERY_REWRITE
    | NO_CPU_COSTING
    | NOCPU_COSTING
    | NOCYCLE
    | NODELAY
    | NO_DOMAIN_INDEX_FILTER
    | NO_DST_UPGRADE_INSERT_CONV
    | NO_ELIMINATE_JOIN
    | NO_ELIMINATE_OBY
    | NO_ELIMINATE_OUTER_JOIN
    | NOENTITYESCAPING
    | NO_EXPAND_GSET_TO_UNION
    | NO_EXPAND
    | NO_EXPAND_TABLE
    | NO_FACT
    | NO_FACTORIZE_JOIN
    | NO_FILTERING
    | NOFORCE
    | NO_FULL_OUTER_JOIN_TO_OUTER
    | NO_GBY_PUSHDOWN
    | NOGUARANTEE
    | NO_INDEX_FFS
    | NO_INDEX
    | NO_INDEX_SS
    | NO_LOAD
    | NOLOCAL
    | NOLOGGING
    | NOMAPPING
    | NOMAXVALUE
    | NO_MERGE
    | NOMINIMIZE
    | NOMINVALUE
    | NO_MODEL_PUSH_REF
    | NO_MONITORING
    | NOMONITORING
    | NO_MONITOR
    | NO_MULTIMV_REWRITE
    | NO
    | NO_NATIVE_FULL_OUTER_JOIN
    | NONBLOCKING
    | NONE
    | NO_NLJ_BATCHING
    | NO_NLJ_PREFETCH
    | NONSCHEMA
    | NOORDER
    | NO_ORDER_ROLLUPS
    | NO_OUTER_JOIN_TO_ANTI
    | NO_OUTER_JOIN_TO_INNER
    | NOOVERRIDE
    | NO_PARALLEL_INDEX
    | NOPARALLEL_INDEX
    | NO_PARALLEL
    | NOPARALLEL
    | NO_PARTIAL_COMMIT
    | NO_PLACE_DISTINCT
    | NO_PLACE_GROUP_BY
    | NO_PQ_MAP
    | NO_PRUNE_GSETS
    | NO_PULL_PRED
    | NO_PUSH_PRED
    | NO_PUSH_SUBQ
    | NO_PX_JOIN_FILTER
    | NO_QKN_BUFF
    | NO_QUERY_TRANSFORMATION
    | NO_REF_CASCADE
    | NORELY
    | NOREPAIR
    | NORESETLOGS
    | NO_RESULT_CACHE
    | NOREVERSE
    | NO_REWRITE
    | NOREWRITE
    | NORMAL
    | NOROWDEPENDENCIES
    | NOSCHEMACHECK
    | NOSEGMENT
    | NO_SEMIJOIN
    | NO_SEMI_TO_INNER
    | NO_SET_TO_JOIN
    | NOSORT
    | NO_SQL_TUNE
    | NO_STAR_TRANSFORMATION
    | NO_STATEMENT_QUEUING
    | NO_STATS_GSETS
    | NOSTRICT
    | NO_SUBQUERY_PRUNING
    | NO_SUBSTRB_PAD
    | NO_SWAP_JOIN_INPUTS
    | NOSWITCH
    | NO_TABLE_LOOKUP_BY_NL
    | NO_TEMP_TABLE
    | NOTHING
    | NOTIFICATION
    | NO_TRANSFORM_DISTINCT_AGG
    | NO_UNNEST
    | NO_USE_HASH_AGGREGATION
    | NO_USE_HASH_GBY_FOR_PUSHDOWN
    | NO_USE_HASH
    | NO_USE_INVISIBLE_INDEXES
    | NO_USE_MERGE
    | NO_USE_NL
    | NOVALIDATE
    | NO_XDB_FASTPATH_INSERT
    | NO_XML_DML_REWRITE
    | NO_XMLINDEX_REWRITE_IN_SELECT
    | NO_XMLINDEX_REWRITE
    | NO_XML_QUERY_REWRITE
    | NTH_VALUE
    | NTILE
    | NULLIF
    | NULLS
    | NUMERIC
    | NUM_INDEX_KEYS
    | NUMTODSINTERVAL
    | NUMTOYMINTERVAL
    | NVARCHAR2
    | NVL2
    | NVL
    | OBJECT2XML
    | OBJECT
    | OBJNO
    | OBJNO_REUSE
    | OCCURENCES
    | OFFLINE
    | OFF
    | OIDINDEX
    | OID
    | OLAP
    | OLD
    | OLD_PUSH_PRED
    | OLTP
    | ONLINE
    | ONLY
    | OPAQUE
    | OPAQUE_TRANSFORM
    | OPAQUE_XCANONICAL
    | OPCODE
    | OPEN
    | OPERATIONS
    | OPERATOR
    | OPT_ESTIMATE
    | OPTIMAL
    | OPTIMIZE
    | OPTIMIZER_FEATURES_ENABLE
    | OPTIMIZER_GOAL
    | OPT_PARAM
    | ORA_BRANCH
    | ORADEBUG
    | ORA_DST_AFFECTED
    | ORA_DST_CONVERT
    | ORA_DST_ERROR
    | ORA_GET_ACLIDS
    | ORA_GET_PRIVILEGES
    | ORA_HASH
    | ORA_ROWSCN
    | ORA_ROWSCN_RAW
    | ORA_ROWVERSION
    | ORA_TABVERSION
    | ORDERED
    | ORDERED_PREDICATES
    | ORDINALITY
    | OR_EXPAND
    | ORGANIZATION
    | OR_PREDICATES
    | OTHER
    | OUTER_JOIN_TO_ANTI
    | OUTER_JOIN_TO_INNER
    | OUTER
    | OUTLINE_LEAF
    | OUTLINE
    | OUT_OF_LINE
    | OVERFLOW_
    | OVERFLOW_NOMOVE
    | OVERLAPS
    | OVER
    | OVERRIDE
    | OWNER
    | OWNERSHIP
    | OWN
    | PACKAGE
    | PACKAGES
    | PARALLEL_INDEX
    | PARALLEL
    | PARAMETERS
    | PARAM
    | PARENT
    | PARITY
    | PARTIALLY
    | PARTITION_HASH
    | PARTITION_LIST
    | PARTITION
    | PARTITION_RANGE
    | PARTITIONS
    | PARTNUMINST
    | PASSING
    | PASSWORD_GRACE_TIME
    | PASSWORD_LIFE_TIME
    | PASSWORD_LOCK_TIME
    | PASSWORD
    | PASSWORD_REUSE_MAX
    | PASSWORD_REUSE_TIME
    | PASSWORD_VERIFY_FUNCTION
    | PATH
    | PATHS
    | PBL_HS_BEGIN
    | PBL_HS_END
    | PCTINCREASE
    | PCTTHRESHOLD
    | PCTUSED
    | PCTVERSION
    | PENDING
    | PERCENTILE_CONT
    | PERCENTILE_DISC
    | PERCENT_KEYWORD
    | PERCENT_RANKM
    | PERCENT_RANK
    | PERFORMANCE
    | PERMANENT
    | PERMISSION
    | PFILE
    | PHYSICAL
    | PIKEY
    | PIV_GB
    | PIVOT
    | PIV_SSF
    | PLACE_DISTINCT
    | PLACE_GROUP_BY
    | PLAN
    | PLSCOPE_SETTINGS
    | PLSQL_CCFLAGS
    | PLSQL_CODE_TYPE
    | PLSQL_DEBUG
    | PLSQL_OPTIMIZE_LEVEL
    | PLSQL_WARNINGS
    | POINT
    | POLICY
    | POST_TRANSACTION
    | POWERMULTISET_BY_CARDINALITY
    | POWERMULTISET
    | POWER
    | POSITION
    | PQ_DISTRIBUTE
    | PQ_MAP
    | PQ_NOMAP
    | PREBUILT
    | PRECEDES
    | PRECEDING
    | PRECISION
    | PRECOMPUTE_SUBQUERY
    | PREDICATE_REORDERS
    | PREDICTION_BOUNDS
    | PREDICTION_COST
    | PREDICTION_DETAILS
    | PREDICTION
    | PREDICTION_PROBABILITY
    | PREDICTION_SET
    | PREPARE
    | PRESENT
    | PRESENTNNV
    | PRESENTV
    | PRESERVE
    | PRESERVE_OID
    | PREVIOUS
    | PRIMARY
    | PRIVATE
    | PRIVATE_SGA
    | PRIVILEGE
    | PRIVILEGES
    | PROCEDURAL
    | PROCEDURE
    | PROCESS
    | PROFILE
    | PROGRAM
    | PROJECT
    | PROPAGATE
    | PROTECTED
    | PROTECTION
    | PULL_PRED
    | PURGE
    | PUSH_PRED
    | PUSH_SUBQ
    | PX_GRANULE
    | PX_JOIN_FILTER
    | QB_NAME
    | QUERY_BLOCK
    | QUERY
    | QUEUE_CURR
    | QUEUE
    | QUEUE_ROWP
    | QUIESCE
    | QUORUM
    | QUOTA
    | RANDOM_LOCAL
    | RANDOM
    | RANGE
    | RANKM
    | RANK
    | RAPIDLY
    | RATIO_TO_REPORT
    | RAWTOHEX
    | RAWTONHEX
    | RBA
    | RBO_OUTLINE
    | RDBA
    | READ
    | READS
    | REAL
    | REBALANCE
    | REBUILD
    | RECORDS_PER_BLOCK
    | RECOVERABLE
    | RECOVER
    | RECOVERY
    | RECYCLEBIN
    | RECYCLE
    | REDACTION
    | REDO
    | REDUCED
    | REDUNDANCY
    | REF_CASCADE_CURSOR
    | REFERENCED
    | REFERENCE
    | REFERENCES
    | REFERENCING
    | REF
    | REFRESH
    | REFTOHEX
    | REGEXP_COUNT
    | REGEXP_INSTR
    | REGEXP_LIKE
    | REGEXP_REPLACE
    | REGEXP_SUBSTR
    | REGISTER
    | REGR_AVGX
    | REGR_AVGY
    | REGR_COUNT
    | REGR_INTERCEPT
    | REGR_R2
    | REGR_SLOPE
    | REGR_SXX
    | REGR_SXY
    | REGR_SYY
    | REGULAR
    | REJECT
    | REKEY
    | RELATIONAL
    | RELY
    | REMAINDER
    | REMOTE_MAPPED
    | REMOVE
    | REPAIR
    | REPEAT
    | REPLACE
    | REPLICATION
    | REQUIRED
    | RESETLOGS
    | RESET
    | RESIZE
    | RESOLVE
    | RESOLVER
    | RESPECT
    | RESTORE_AS_INTERVALS
    | RESTORE
    | RESTRICT_ALL_REF_CONS
    | RESTRICTED
    | RESTRICT
    | RESULT_CACHE
    | RESUMABLE
    | RESUME
    | RETENTION
    | RETRY_ON_ROW_CHANGE
    | RETURNING
    | RETURN
    | REUSE
    | REVERSE
    | REWRITE
    | REWRITE_OR_ERROR
    | RIGHT
    | ROLE
    | ROLES
    | ROLLBACK
    | ROLLING
    | ROLLUP
    | ROOT
    | ROUND
    | ROWDEPENDENCIES
    | ROWID
    | ROWIDTOCHAR
    | ROWIDTONCHAR
    | ROW_LENGTH
    | ROW
    | ROW_NUMBER
    | ROWNUM
    | ROWS
    | RPAD
    | RTRIM
    | RULE
    | RULES
    | SALT
    | SAMPLE
    | SAVE_AS_INTERVALS
    | SAVEPOINT
    | SB4
    | SCALE
    | SCALE_ROWS
    | SCAN_INSTANCES
    | SCAN
    | SCHEDULER
    | SCHEMACHECK
    | SCHEMA
    | SCN_ASCENDING
    | SCN
    | SCOPE
    | SD_ALL
    | SD_INHIBIT
    | SD_SHOW
    | SEARCH
    | SECOND
    | SECUREFILE_DBA
    | SECUREFILE
    | SECURITY
    | SEED
    | SEG_BLOCK
    | SEG_FILE
    | SEGMENT
    | SELECTIVITY
    | SEMIJOIN_DRIVER
    | SEMIJOIN
    | SEMI_TO_INNER
    | SEQUENCED
    | SEQUENCE
    | SEQUENTIAL
    | SERIALIZABLE
    | SERVERERROR
    | SERVICE
    | SESSION_CACHED_CURSORS
    | SESSION
    | SESSIONS_PER_USER
    | SESSIONTIMEZONE
    | SESSIONTZNAME
    | SETS
    | SETTINGS
    | SET_TO_JOIN
    | SEVERE
    | SHARED
    | SHARED_POOL
    | SHOW
    | SHRINK
    | SHUTDOWN
    | SIBLINGS
    | SID
    | SIGNAL_COMPONENT
    | SIGNAL_FUNCTION
    | SIGN
    | SIMPLE
    | SINGLE
    | SINGLETASK
    | SINH
    | SIN
    | SKIP_EXT_OPTIMIZER
    | SKIP_
    | SKIP_UNQ_UNUSABLE_IDX
    | SKIP_UNUSABLE_INDEXES
    | SMALLFILE
    | SNAPSHOT
    | SOME
    | SORT
    | SOUNDEX
    | SOURCE
    | SPACE_KEYWORD
    | SPECIFICATION
    | SPFILE
    | SPLIT
    | SPREADSHEET
    | SQLLDR
    | SQL
    | SQL_TRACE
    | SQL_MACRO
    | SQRT
    | STALE
    | STANDALONE
    | STANDBY_MAX_DATA_DELAY
    | STANDBY
    | STAR
    | STAR_TRANSFORMATION
    | STARTUP
    | STATEMENT_ID
    | STATEMENT_QUEUING
    | STATEMENTS
    | STATIC
    | STATISTICS
    | STATS_BINOMIAL_TEST
    | STATS_CROSSTAB
    | STATS_F_TEST
    | STATS_KS_TEST
    | STATS_MODE
    | STATS_MW_TEST
    | STATS_ONE_WAY_ANOVA
    | STATS_T_TEST_INDEP
    | STATS_T_TEST_INDEPU
    | STATS_T_TEST_ONE
    | STATS_T_TEST_PAIRED
    | STATS_WSR_TEST
    | STDDEV
    | STDDEV_POP
    | STDDEV_SAMP
    | STOP
    | STORAGE
    | STORE
    | STREAMS
    | STRICT
    | STRING
    | STRIPE_COLUMNS
    | STRIPE_WIDTH
    | STRIP
    | STRUCTURE
    | SUBMULTISET
    | SUBPARTITION
    | SUBPARTITION_REL
    | SUBPARTITIONS
    | SUBQUERIES
    | SUBQUERY_PRUNING
    | SUBSTITUTABLE
    | SUBSTR2
    | SUBSTR4
    | SUBSTRB
    | SUBSTRC
    | SUBSTR
    | SUCCESSFUL
    | SUMMARY
    | SUM
    | SUPPLEMENTAL
    | SUSPEND
    | SWAP_JOIN_INPUTS
    | SWITCH
    | SWITCHOVER
    | SYNCHRONOUS
    | SYNC
    | SYS
    | SYSASM
    | SYS_AUDIT
    | SYSAUX
    | SYS_CHECKACL
    | SYS_CONNECT_BY_PATH
    | SYS_CONTEXT
    | SYSDATE
    | SYSDBA
    | SYS_DBURIGEN
    | SYS_DL_CURSOR
    | SYS_DM_RXFORM_CHR
    | SYS_DM_RXFORM_NUM
    | SYS_DOM_COMPARE
    | SYS_DST_PRIM2SEC
    | SYS_DST_SEC2PRIM
    | SYS_ET_BFILE_TO_RAW
    | SYS_ET_BLOB_TO_IMAGE
    | SYS_ET_IMAGE_TO_BLOB
    | SYS_ET_RAW_TO_BFILE
    | SYS_EXTPDTXT
    | SYS_EXTRACT_UTC
    | SYS_FBT_INSDEL
    | SYS_FILTER_ACLS
    | SYS_FNMATCHES
    | SYS_FNREPLACE
    | SYS_GET_ACLIDS
    | SYS_GET_PRIVILEGES
    | SYS_GETTOKENID
    | SYS_GETXTIVAL
    | SYS_GUID
    | SYS_MAKEXML
    | SYS_MAKE_XMLNODEID
    | SYS_MKXMLATTR
    | SYS_OP_ADT2BIN
    | SYS_OP_ADTCONS
    | SYS_OP_ALSCRVAL
    | SYS_OP_ATG
    | SYS_OP_BIN2ADT
    | SYS_OP_BITVEC
    | SYS_OP_BL2R
    | SYS_OP_BLOOM_FILTER_LIST
    | SYS_OP_BLOOM_FILTER
    | SYS_OP_C2C
    | SYS_OP_CAST
    | SYS_OP_CEG
    | SYS_OP_CL2C
    | SYS_OP_COMBINED_HASH
    | SYS_OP_COMP
    | SYS_OP_CONVERT
    | SYS_OP_COUNTCHG
    | SYS_OP_CSCONV
    | SYS_OP_CSCONVTEST
    | SYS_OP_CSR
    | SYS_OP_CSX_PATCH
    | SYS_OP_DECOMP
    | SYS_OP_DESCEND
    | SYS_OP_DISTINCT
    | SYS_OP_DRA
    | SYS_OP_DUMP
    | SYS_OP_DV_CHECK
    | SYS_OP_ENFORCE_NOT_NULL
    | SYSOPER
    | SYS_OP_EXTRACT
    | SYS_OP_GROUPING
    | SYS_OP_GUID
    | SYS_OP_IIX
    | SYS_OP_ITR
    | SYS_OP_LBID
    | SYS_OP_LOBLOC2BLOB
    | SYS_OP_LOBLOC2CLOB
    | SYS_OP_LOBLOC2ID
    | SYS_OP_LOBLOC2NCLOB
    | SYS_OP_LOBLOC2TYP
    | SYS_OP_LSVI
    | SYS_OP_LVL
    | SYS_OP_MAKEOID
    | SYS_OP_MAP_NONNULL
    | SYS_OP_MSR
    | SYS_OP_NICOMBINE
    | SYS_OP_NIEXTRACT
    | SYS_OP_NII
    | SYS_OP_NIX
    | SYS_OP_NOEXPAND
    | SYS_OP_NTCIMG
    | SYS_OP_NUMTORAW
    | SYS_OP_OIDVALUE
    | SYS_OP_OPNSIZE
    | SYS_OP_PAR_1
    | SYS_OP_PARGID_1
    | SYS_OP_PARGID
    | SYS_OP_PAR
    | SYS_OP_PIVOT
    | SYS_OP_R2O
    | SYS_OP_RAWTONUM
    | SYS_OP_RDTM
    | SYS_OP_REF
    | SYS_OP_RMTD
    | SYS_OP_ROWIDTOOBJ
    | SYS_OP_RPB
    | SYS_OPTLOBPRBSC
    | SYS_OP_TOSETID
    | SYS_OP_TPR
    | SYS_OP_TRTB
    | SYS_OPTXICMP
    | SYS_OPTXQCASTASNQ
    | SYS_OP_UNDESCEND
    | SYS_OP_VECAND
    | SYS_OP_VECBIT
    | SYS_OP_VECOR
    | SYS_OP_VECXOR
    | SYS_OP_VERSION
    | SYS_OP_VREF
    | SYS_OP_VVD
    | SYS_OP_XMLCONS_FOR_CSX
    | SYS_OP_XPTHATG
    | SYS_OP_XPTHIDX
    | SYS_OP_XPTHOP
    | SYS_OP_XTXT2SQLT
    | SYS_ORDERKEY_DEPTH
    | SYS_ORDERKEY_MAXCHILD
    | SYS_ORDERKEY_PARENT
    | SYS_PARALLEL_TXN
    | SYS_PATHID_IS_ATTR
    | SYS_PATHID_IS_NMSPC
    | SYS_PATHID_LASTNAME
    | SYS_PATHID_LASTNMSPC
    | SYS_PATH_REVERSE
    | SYS_PXQEXTRACT
    | SYS_RID_ORDER
    | SYS_ROW_DELTA
    | SYS_SC_2_XMLT
    | SYS_SYNRCIREDO
    | SYSTEM_DEFINED
    | SYSTEM
    | SYSTIMESTAMP
    | SYS_TYPEID
    | SYS_UMAKEXML
    | SYS_XMLANALYZE
    | SYS_XMLCONTAINS
    | SYS_XMLCONV
    | SYS_XMLEXNSURI
    | SYS_XMLGEN
    | SYS_XMLI_LOC_ISNODE
    | SYS_XMLI_LOC_ISTEXT
    | SYS_XMLINSTR
    | SYS_XMLLOCATOR_GETSVAL
    | SYS_XMLNODEID_GETCID
    | SYS_XMLNODEID_GETLOCATOR
    | SYS_XMLNODEID_GETOKEY
    | SYS_XMLNODEID_GETPATHID
    | SYS_XMLNODEID_GETPTRID
    | SYS_XMLNODEID_GETRID
    | SYS_XMLNODEID_GETSVAL
    | SYS_XMLNODEID_GETTID
    | SYS_XMLNODEID
    | SYS_XMLT_2_SC
    | SYS_XMLTRANSLATE
    | SYS_XMLTYPE2SQL
    | SYS_XQ_ASQLCNV
    | SYS_XQ_ATOMCNVCHK
    | SYS_XQBASEURI
    | SYS_XQCASTABLEERRH
    | SYS_XQCODEP2STR
    | SYS_XQCODEPEQ
    | SYS_XQCON2SEQ
    | SYS_XQCONCAT
    | SYS_XQDELETE
    | SYS_XQDFLTCOLATION
    | SYS_XQDOC
    | SYS_XQDOCURI
    | SYS_XQDURDIV
    | SYS_XQED4URI
    | SYS_XQENDSWITH
    | SYS_XQERRH
    | SYS_XQERR
    | SYS_XQESHTMLURI
    | SYS_XQEXLOBVAL
    | SYS_XQEXSTWRP
    | SYS_XQEXTRACT
    | SYS_XQEXTRREF
    | SYS_XQEXVAL
    | SYS_XQFB2STR
    | SYS_XQFNBOOL
    | SYS_XQFNCMP
    | SYS_XQFNDATIM
    | SYS_XQFNLNAME
    | SYS_XQFNNM
    | SYS_XQFNNSURI
    | SYS_XQFNPREDTRUTH
    | SYS_XQFNQNM
    | SYS_XQFNROOT
    | SYS_XQFORMATNUM
    | SYS_XQFTCONTAIN
    | SYS_XQFUNCR
    | SYS_XQGETCONTENT
    | SYS_XQINDXOF
    | SYS_XQINSERT
    | SYS_XQINSPFX
    | SYS_XQIRI2URI
    | SYS_XQLANG
    | SYS_XQLLNMFRMQNM
    | SYS_XQMKNODEREF
    | SYS_XQNILLED
    | SYS_XQNODENAME
    | SYS_XQNORMSPACE
    | SYS_XQNORMUCODE
    | SYS_XQ_NRNG
    | SYS_XQNSP4PFX
    | SYS_XQNSPFRMQNM
    | SYS_XQPFXFRMQNM
    | SYS_XQ_PKSQL2XML
    | SYS_XQPOLYABS
    | SYS_XQPOLYADD
    | SYS_XQPOLYCEL
    | SYS_XQPOLYCSTBL
    | SYS_XQPOLYCST
    | SYS_XQPOLYDIV
    | SYS_XQPOLYFLR
    | SYS_XQPOLYMOD
    | SYS_XQPOLYMUL
    | SYS_XQPOLYRND
    | SYS_XQPOLYSQRT
    | SYS_XQPOLYSUB
    | SYS_XQPOLYUMUS
    | SYS_XQPOLYUPLS
    | SYS_XQPOLYVEQ
    | SYS_XQPOLYVGE
    | SYS_XQPOLYVGT
    | SYS_XQPOLYVLE
    | SYS_XQPOLYVLT
    | SYS_XQPOLYVNE
    | SYS_XQREF2VAL
    | SYS_XQRENAME
    | SYS_XQREPLACE
    | SYS_XQRESVURI
    | SYS_XQRNDHALF2EVN
    | SYS_XQRSLVQNM
    | SYS_XQRYENVPGET
    | SYS_XQRYVARGET
    | SYS_XQRYWRP
    | SYS_XQSEQ2CON4XC
    | SYS_XQSEQ2CON
    | SYS_XQSEQDEEPEQ
    | SYS_XQSEQINSB
    | SYS_XQSEQRM
    | SYS_XQSEQRVS
    | SYS_XQSEQSUB
    | SYS_XQSEQTYPMATCH
    | SYS_XQSTARTSWITH
    | SYS_XQSTATBURI
    | SYS_XQSTR2CODEP
    | SYS_XQSTRJOIN
    | SYS_XQSUBSTRAFT
    | SYS_XQSUBSTRBEF
    | SYS_XQTOKENIZE
    | SYS_XQTREATAS
    | SYS_XQ_UPKXML2SQL
    | SYS_XQXFORM
    | TABLE
    | TABLE_LOOKUP_BY_NL
    | TABLES
    | TABLESPACE
    | TABLESPACE_NO
    | TABLE_STATS
    | TABNO
    | TANH
    | TAN
    | TBLORIDXPARTNUM
    | TEMPFILE
    | TEMPLATE
    | TEMPLATE_TABLE
    | TEMPORARY
    | TEMP_TABLE
    | TEST
    | THAN
    | THE
    | THEN
    | THREAD
    | THROUGH
    | TIME
    | TIMING
    | TIMEOUT
    | TIMES
    | TIMESTAMP
    | TIMEZONE
    | TIMEZONE_ABBR
    | TIMEZONE_HOUR
    | TIMEZONE_MINUTE
    | TIME_ZONE
    | TIMEZONE_OFFSET
    | TIMEZONE_REGION
    | TIV_GB
    | TIV_SSF
    | TO_BINARY_DOUBLE
    | TO_BINARY_FLOAT
    | TO_BLOB
    | TO_CHAR
    | TO_CLOB
    | TO_DATE
    | TO_DSINTERVAL
    | TO_LOB
    | TO_MULTI_BYTE
    | TO_NCHAR
    | TO_NCLOB
    | TO_NUMBER
    | TOPLEVEL
    | TO_SINGLE_BYTE
    | TO_TIME
    | TO_TIMESTAMP
    | TO_TIMESTAMP_TZ
    | TO_TIME_TZ
    | TO_YMINTERVAL
    | TRACE
    | TRACING
    | TRACKING
    | TRAILING
    | TRANSACTION
    | TRANSFORM_DISTINCT_AGG
    | TRANSITIONAL
    | TRANSITION
    | TRANSLATE
    | TREAT
    | TRIGGERS
    | TRIM
    | TRUE
    | TRUNCATE
    | TRUNC
    | TRUSTED
    | TUNING
    | TX
    | TYPE
    | TYPES
    | TZ_OFFSET
    | UB2
    | UBA
    | UID
    | UNARCHIVED
    | UNBOUNDED
    | UNBOUND
    | UNDER
    | UNDO
    | UNDROP
    | UNIFORM
    | UNISTR
    | UNLIMITED
    | UNLOAD
    | UNLOCK
    | UNNEST_INNERJ_DISTINCT_VIEW
    | UNNEST
    | UNNEST_NOSEMIJ_NODISTINCTVIEW
    | UNNEST_SEMIJ_VIEW
    | UNPACKED
    | UNPIVOT
    | UNPROTECTED
    | UNQUIESCE
    | UNRECOVERABLE
    | UNRESTRICTED
    | UNTIL
    | UNUSABLE
    | UNUSED
    | UPDATABLE
    | UPDATED
    | UPDATEXML
    | UPD_INDEXES
    | UPD_JOININDEX
    | UPGRADE
    | UPPER
    | UPSERT
    | UROWID
    | USAGE
    | USE_ANTI
    | USE_CONCAT
    | USE_HASH_AGGREGATION
    | USE_HASH_GBY_FOR_PUSHDOWN
    | USE_HASH
    | USE_INVISIBLE_INDEXES
    | USE_MERGE_CARTESIAN
    | USE_MERGE
    | USE
    | USE_NL
    | USE_NL_WITH_INDEX
    | USE_PRIVATE_OUTLINES
    | USER_DEFINED
    | USERENV
    | USERGROUP
    | USER
    | USER_RECYCLEBIN
    | USERS
    | USE_SEMI
    | USE_STORED_OUTLINES
    | USE_TTT_FOR_GSETS
    | USE_WEAK_NAME_RESL
    | USING
    | VALIDATE
    | VALIDATION
    | VALUE
    | VARIANCE
    | VAR_POP
    | VARRAY
    | VARRAYS
    | VAR_SAMP
    | VARYING
    | VECTOR_READ
    | VECTOR_READ_TRACE
    | VERIFY
    | VERSIONING
    | VERSION
    | VERSIONS_ENDSCN
    | VERSIONS_ENDTIME
    | VERSIONS
    | VERSIONS_OPERATION
    | VERSIONS_STARTSCN
    | VERSIONS_STARTTIME
    | VERSIONS_XID
    | VIRTUAL
    | VISIBLE
    | VOLUME
    | VSIZE
    | WAIT
    | WALLET
    | WELLFORMED
    | WHENEVER
    | WHEN
    | WHITESPACE
    | WIDTH_BUCKET
    | WITHIN
    | WITHOUT
    | WORK
    | WRAPPED
    | WRITE
    | XDB_FASTPATH_INSERT
    | X_DYN_PRUNE
    | XID
    | XML2OBJECT
    | XMLATTRIBUTES
    | XMLCAST
    | XMLCDATA
    | XMLCOLATTVAL
    | XMLCOMMENT
    | XMLCONCAT
    | XMLDIFF
    | XML_DML_RWT_STMT
    | XMLELEMENT
    | XMLEXISTS2
    | XMLEXISTS
    | XMLFOREST
    | XMLINDEX_REWRITE_IN_SELECT
    | XMLINDEX_REWRITE
    | XMLINDEX_SEL_IDX_TBL
    | XMLISNODE
    | XMLISVALID
    | XML
    | XMLNAMESPACES
    | XMLPARSE
    | XMLPATCH
    | XMLPI
    | XMLQUERY
    | XMLQUERYVAL
    | XMLROOT
    | XMLSCHEMA
    | XMLSERIALIZE
    | XMLTABLE
    | XMLTRANSFORMBLOB
    | XMLTRANSFORM
    | XMLTYPE
    | XPATHTABLE
    | XS_SYS_CONTEXT
    | YEAR
    | YES
    | ZONE
    ;
