
import { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from "antlr4ng";

import { PlSqlParserBase } from "./PlSqlParserBase.js"

import { Sql_scriptContext } from "./PlSqlParser.js";
import { Script_unitContext } from "./PlSqlParser.js";
import { TerminatorContext } from "./PlSqlParser.js";
import { Plsql_unitContext } from "./PlSqlParser.js";
import { Sql_unitContext } from "./PlSqlParser.js";
import { Alter_diskgroupContext } from "./PlSqlParser.js";
import { Add_disk_clauseContext } from "./PlSqlParser.js";
import { Drop_disk_clauseContext } from "./PlSqlParser.js";
import { Resize_disk_clauseContext } from "./PlSqlParser.js";
import { Replace_disk_clauseContext } from "./PlSqlParser.js";
import { Wait_nowaitContext } from "./PlSqlParser.js";
import { Rename_disk_clauseContext } from "./PlSqlParser.js";
import { Disk_online_clauseContext } from "./PlSqlParser.js";
import { Disk_offline_clauseContext } from "./PlSqlParser.js";
import { Timeout_clauseContext } from "./PlSqlParser.js";
import { Rebalance_diskgroup_clauseContext } from "./PlSqlParser.js";
import { PhaseContext } from "./PlSqlParser.js";
import { Check_diskgroup_clauseContext } from "./PlSqlParser.js";
import { Diskgroup_template_clausesContext } from "./PlSqlParser.js";
import { Qualified_template_clauseContext } from "./PlSqlParser.js";
import { Redundancy_clauseContext } from "./PlSqlParser.js";
import { Striping_clauseContext } from "./PlSqlParser.js";
import { Force_noforceContext } from "./PlSqlParser.js";
import { Diskgroup_directory_clausesContext } from "./PlSqlParser.js";
import { Dir_nameContext } from "./PlSqlParser.js";
import { Diskgroup_alias_clausesContext } from "./PlSqlParser.js";
import { Diskgroup_volume_clausesContext } from "./PlSqlParser.js";
import { Add_volume_clauseContext } from "./PlSqlParser.js";
import { Modify_volume_clauseContext } from "./PlSqlParser.js";
import { Diskgroup_attributesContext } from "./PlSqlParser.js";
import { Drop_diskgroup_file_clauseContext } from "./PlSqlParser.js";
import { Convert_redundancy_clauseContext } from "./PlSqlParser.js";
import { Usergroup_clausesContext } from "./PlSqlParser.js";
import { User_clausesContext } from "./PlSqlParser.js";
import { File_permissions_clauseContext } from "./PlSqlParser.js";
import { File_owner_clauseContext } from "./PlSqlParser.js";
import { Scrub_clauseContext } from "./PlSqlParser.js";
import { Quotagroup_clausesContext } from "./PlSqlParser.js";
import { Property_nameContext } from "./PlSqlParser.js";
import { Property_valueContext } from "./PlSqlParser.js";
import { Filegroup_clausesContext } from "./PlSqlParser.js";
import { Add_filegroup_clauseContext } from "./PlSqlParser.js";
import { Modify_filegroup_clauseContext } from "./PlSqlParser.js";
import { Move_to_filegroup_clauseContext } from "./PlSqlParser.js";
import { Drop_filegroup_clauseContext } from "./PlSqlParser.js";
import { Quorum_regularContext } from "./PlSqlParser.js";
import { Undrop_disk_clauseContext } from "./PlSqlParser.js";
import { Diskgroup_availabilityContext } from "./PlSqlParser.js";
import { Enable_disable_volumeContext } from "./PlSqlParser.js";
import { Drop_functionContext } from "./PlSqlParser.js";
import { Alter_flashback_archiveContext } from "./PlSqlParser.js";
import { Alter_hierarchyContext } from "./PlSqlParser.js";
import { Alter_functionContext } from "./PlSqlParser.js";
import { Alter_javaContext } from "./PlSqlParser.js";
import { Match_stringContext } from "./PlSqlParser.js";
import { Create_function_bodyContext } from "./PlSqlParser.js";
import { Sql_macro_bodyContext } from "./PlSqlParser.js";
import { Parallel_enable_clauseContext } from "./PlSqlParser.js";
import { Partition_by_clauseContext } from "./PlSqlParser.js";
import { Result_cache_clauseContext } from "./PlSqlParser.js";
import { Accessible_by_clauseContext } from "./PlSqlParser.js";
import { Default_collation_clauseContext } from "./PlSqlParser.js";
import { Aggregate_clauseContext } from "./PlSqlParser.js";
import { Pipelined_using_clauseContext } from "./PlSqlParser.js";
import { AccessorContext } from "./PlSqlParser.js";
import { Relies_on_partContext } from "./PlSqlParser.js";
import { Streaming_clauseContext } from "./PlSqlParser.js";
import { Alter_outlineContext } from "./PlSqlParser.js";
import { Outline_optionsContext } from "./PlSqlParser.js";
import { Alter_lockdown_profileContext } from "./PlSqlParser.js";
import { Lockdown_featureContext } from "./PlSqlParser.js";
import { Lockdown_optionsContext } from "./PlSqlParser.js";
import { Lockdown_statementsContext } from "./PlSqlParser.js";
import { Statement_clausesContext } from "./PlSqlParser.js";
import { Clause_optionsContext } from "./PlSqlParser.js";
import { Option_valuesContext } from "./PlSqlParser.js";
import { String_listContext } from "./PlSqlParser.js";
import { Disable_enableContext } from "./PlSqlParser.js";
import { Drop_lockdown_profileContext } from "./PlSqlParser.js";
import { Drop_packageContext } from "./PlSqlParser.js";
import { Alter_packageContext } from "./PlSqlParser.js";
import { Create_packageContext } from "./PlSqlParser.js";
import { Create_package_bodyContext } from "./PlSqlParser.js";
import { Package_obj_specContext } from "./PlSqlParser.js";
import { Procedure_specContext } from "./PlSqlParser.js";
import { Function_specContext } from "./PlSqlParser.js";
import { Package_obj_bodyContext } from "./PlSqlParser.js";
import { Alter_pmem_filestoreContext } from "./PlSqlParser.js";
import { Drop_pmem_filestoreContext } from "./PlSqlParser.js";
import { Drop_procedureContext } from "./PlSqlParser.js";
import { Alter_procedureContext } from "./PlSqlParser.js";
import { Function_bodyContext } from "./PlSqlParser.js";
import { Procedure_bodyContext } from "./PlSqlParser.js";
import { Create_procedure_bodyContext } from "./PlSqlParser.js";
import { Alter_resource_costContext } from "./PlSqlParser.js";
import { Drop_outlineContext } from "./PlSqlParser.js";
import { Alter_rollback_segmentContext } from "./PlSqlParser.js";
import { Drop_restore_pointContext } from "./PlSqlParser.js";
import { Drop_rollback_segmentContext } from "./PlSqlParser.js";
import { Drop_roleContext } from "./PlSqlParser.js";
import { Create_pmem_filestoreContext } from "./PlSqlParser.js";
import { Pmem_filestore_optionsContext } from "./PlSqlParser.js";
import { File_pathContext } from "./PlSqlParser.js";
import { Create_rollback_segmentContext } from "./PlSqlParser.js";
import { Drop_triggerContext } from "./PlSqlParser.js";
import { Alter_triggerContext } from "./PlSqlParser.js";
import { Create_triggerContext } from "./PlSqlParser.js";
import { Trigger_follows_clauseContext } from "./PlSqlParser.js";
import { Trigger_when_clauseContext } from "./PlSqlParser.js";
import { Simple_dml_triggerContext } from "./PlSqlParser.js";
import { For_each_rowContext } from "./PlSqlParser.js";
import { Compound_dml_triggerContext } from "./PlSqlParser.js";
import { Non_dml_triggerContext } from "./PlSqlParser.js";
import { Trigger_bodyContext } from "./PlSqlParser.js";
import { Compound_trigger_blockContext } from "./PlSqlParser.js";
import { Timing_point_sectionContext } from "./PlSqlParser.js";
import { Non_dml_eventContext } from "./PlSqlParser.js";
import { Dml_event_clauseContext } from "./PlSqlParser.js";
import { Dml_event_elementContext } from "./PlSqlParser.js";
import { Dml_event_nested_clauseContext } from "./PlSqlParser.js";
import { Referencing_clauseContext } from "./PlSqlParser.js";
import { Referencing_elementContext } from "./PlSqlParser.js";
import { Drop_typeContext } from "./PlSqlParser.js";
import { Alter_typeContext } from "./PlSqlParser.js";
import { Compile_type_clauseContext } from "./PlSqlParser.js";
import { Replace_type_clauseContext } from "./PlSqlParser.js";
import { Alter_method_specContext } from "./PlSqlParser.js";
import { Alter_method_elementContext } from "./PlSqlParser.js";
import { Alter_attribute_definitionContext } from "./PlSqlParser.js";
import { Alter_collection_clausesContext } from "./PlSqlParser.js";
import { Dependent_handling_clauseContext } from "./PlSqlParser.js";
import { Dependent_exceptions_partContext } from "./PlSqlParser.js";
import { Create_typeContext } from "./PlSqlParser.js";
import { Create_type_specContext } from "./PlSqlParser.js";
import { Create_type_bodyContext } from "./PlSqlParser.js";
import { Type_definitionContext } from "./PlSqlParser.js";
import { Object_type_defContext } from "./PlSqlParser.js";
import { Object_as_partContext } from "./PlSqlParser.js";
import { Object_under_partContext } from "./PlSqlParser.js";
import { Nested_table_type_defContext } from "./PlSqlParser.js";
import { Sqlj_object_typeContext } from "./PlSqlParser.js";
import { Type_bodyContext } from "./PlSqlParser.js";
import { Type_body_elementsContext } from "./PlSqlParser.js";
import { Map_order_func_declarationContext } from "./PlSqlParser.js";
import { Subprog_decl_in_typeContext } from "./PlSqlParser.js";
import { Proc_decl_in_typeContext } from "./PlSqlParser.js";
import { Func_decl_in_typeContext } from "./PlSqlParser.js";
import { Constructor_declarationContext } from "./PlSqlParser.js";
import { Modifier_clauseContext } from "./PlSqlParser.js";
import { Object_member_specContext } from "./PlSqlParser.js";
import { Sqlj_object_type_attrContext } from "./PlSqlParser.js";
import { Element_specContext } from "./PlSqlParser.js";
import { Element_spec_optionsContext } from "./PlSqlParser.js";
import { Subprogram_specContext } from "./PlSqlParser.js";
import { Overriding_subprogram_specContext } from "./PlSqlParser.js";
import { Overriding_function_specContext } from "./PlSqlParser.js";
import { Overriding_procedure_specContext } from "./PlSqlParser.js";
import { Type_procedure_specContext } from "./PlSqlParser.js";
import { Type_function_specContext } from "./PlSqlParser.js";
import { Constructor_specContext } from "./PlSqlParser.js";
import { Map_order_function_specContext } from "./PlSqlParser.js";
import { Pragma_clauseContext } from "./PlSqlParser.js";
import { Pragma_elementsContext } from "./PlSqlParser.js";
import { Type_elements_parameterContext } from "./PlSqlParser.js";
import { Drop_sequenceContext } from "./PlSqlParser.js";
import { Alter_sequenceContext } from "./PlSqlParser.js";
import { Alter_sessionContext } from "./PlSqlParser.js";
import { Alter_session_set_clauseContext } from "./PlSqlParser.js";
import { Create_sequenceContext } from "./PlSqlParser.js";
import { Sequence_specContext } from "./PlSqlParser.js";
import { Sequence_start_clauseContext } from "./PlSqlParser.js";
import { Create_analytic_viewContext } from "./PlSqlParser.js";
import { Classification_clauseContext } from "./PlSqlParser.js";
import { Caption_clauseContext } from "./PlSqlParser.js";
import { Description_clauseContext } from "./PlSqlParser.js";
import { Classification_itemContext } from "./PlSqlParser.js";
import { LanguageContext } from "./PlSqlParser.js";
import { Cav_using_clauseContext } from "./PlSqlParser.js";
import { Dim_by_clauseContext } from "./PlSqlParser.js";
import { Dim_keyContext } from "./PlSqlParser.js";
import { Dim_refContext } from "./PlSqlParser.js";
import { Hier_refContext } from "./PlSqlParser.js";
import { Measures_clauseContext } from "./PlSqlParser.js";
import { Av_measureContext } from "./PlSqlParser.js";
import { Base_meas_clauseContext } from "./PlSqlParser.js";
import { Meas_aggregate_clauseContext } from "./PlSqlParser.js";
import { Calc_meas_clauseContext } from "./PlSqlParser.js";
import { Default_measure_clauseContext } from "./PlSqlParser.js";
import { Default_aggregate_clauseContext } from "./PlSqlParser.js";
import { Cache_clauseContext } from "./PlSqlParser.js";
import { Cache_specificationContext } from "./PlSqlParser.js";
import { Levels_clauseContext } from "./PlSqlParser.js";
import { Level_specificationContext } from "./PlSqlParser.js";
import { Level_group_typeContext } from "./PlSqlParser.js";
import { Fact_columns_clauseContext } from "./PlSqlParser.js";
import { Qry_transform_clauseContext } from "./PlSqlParser.js";
import { Create_attribute_dimensionContext } from "./PlSqlParser.js";
import { Ad_using_clauseContext } from "./PlSqlParser.js";
import { Source_clauseContext } from "./PlSqlParser.js";
import { Join_path_clauseContext } from "./PlSqlParser.js";
import { Join_conditionContext } from "./PlSqlParser.js";
import { Join_condition_itemContext } from "./PlSqlParser.js";
import { Attributes_clauseContext } from "./PlSqlParser.js";
import { Ad_attributes_clauseContext } from "./PlSqlParser.js";
import { Ad_level_clauseContext } from "./PlSqlParser.js";
import { Key_clauseContext } from "./PlSqlParser.js";
import { Alternate_key_clauseContext } from "./PlSqlParser.js";
import { Dim_order_clauseContext } from "./PlSqlParser.js";
import { All_clauseContext } from "./PlSqlParser.js";
import { Create_audit_policyContext } from "./PlSqlParser.js";
import { Privilege_audit_clauseContext } from "./PlSqlParser.js";
import { Action_audit_clauseContext } from "./PlSqlParser.js";
import { System_actionsContext } from "./PlSqlParser.js";
import { Standard_actionsContext } from "./PlSqlParser.js";
import { Actions_clauseContext } from "./PlSqlParser.js";
import { Object_actionContext } from "./PlSqlParser.js";
import { System_actionContext } from "./PlSqlParser.js";
import { Component_actionsContext } from "./PlSqlParser.js";
import { Component_actionContext } from "./PlSqlParser.js";
import { Role_audit_clauseContext } from "./PlSqlParser.js";
import { Create_controlfileContext } from "./PlSqlParser.js";
import { Controlfile_optionsContext } from "./PlSqlParser.js";
import { Logfile_clauseContext } from "./PlSqlParser.js";
import { Character_set_clauseContext } from "./PlSqlParser.js";
import { File_specificationContext } from "./PlSqlParser.js";
import { Create_diskgroupContext } from "./PlSqlParser.js";
import { Qualified_disk_clauseContext } from "./PlSqlParser.js";
import { Create_editionContext } from "./PlSqlParser.js";
import { Create_flashback_archiveContext } from "./PlSqlParser.js";
import { Flashback_archive_quotaContext } from "./PlSqlParser.js";
import { Flashback_archive_retentionContext } from "./PlSqlParser.js";
import { Create_hierarchyContext } from "./PlSqlParser.js";
import { Hier_using_clauseContext } from "./PlSqlParser.js";
import { Level_hier_clauseContext } from "./PlSqlParser.js";
import { Hier_attrs_clauseContext } from "./PlSqlParser.js";
import { Hier_attr_clauseContext } from "./PlSqlParser.js";
import { Hier_attr_nameContext } from "./PlSqlParser.js";
import { Create_indexContext } from "./PlSqlParser.js";
import { Cluster_index_clauseContext } from "./PlSqlParser.js";
import { Cluster_nameContext } from "./PlSqlParser.js";
import { Table_index_clauseContext } from "./PlSqlParser.js";
import { Bitmap_join_index_clauseContext } from "./PlSqlParser.js";
import { Index_exprContext } from "./PlSqlParser.js";
import { Index_propertiesContext } from "./PlSqlParser.js";
import { Domain_index_clauseContext } from "./PlSqlParser.js";
import { Local_domain_index_clauseContext } from "./PlSqlParser.js";
import { Xmlindex_clauseContext } from "./PlSqlParser.js";
import { Local_xmlindex_clauseContext } from "./PlSqlParser.js";
import { Global_partitioned_indexContext } from "./PlSqlParser.js";
import { Index_partitioning_clauseContext } from "./PlSqlParser.js";
import { Index_partitioning_values_listContext } from "./PlSqlParser.js";
import { Local_partitioned_indexContext } from "./PlSqlParser.js";
import { On_range_partitioned_tableContext } from "./PlSqlParser.js";
import { On_list_partitioned_tableContext } from "./PlSqlParser.js";
import { Partitioned_tableContext } from "./PlSqlParser.js";
import { On_hash_partitioned_tableContext } from "./PlSqlParser.js";
import { On_hash_partitioned_clauseContext } from "./PlSqlParser.js";
import { On_comp_partitioned_tableContext } from "./PlSqlParser.js";
import { On_comp_partitioned_clauseContext } from "./PlSqlParser.js";
import { Index_subpartition_clauseContext } from "./PlSqlParser.js";
import { Index_subpartition_subclauseContext } from "./PlSqlParser.js";
import { Odci_parametersContext } from "./PlSqlParser.js";
import { IndextypeContext } from "./PlSqlParser.js";
import { Alter_indexContext } from "./PlSqlParser.js";
import { Alter_index_ops_set1Context } from "./PlSqlParser.js";
import { Alter_index_ops_set2Context } from "./PlSqlParser.js";
import { Visible_or_invisibleContext } from "./PlSqlParser.js";
import { Monitoring_nomonitoringContext } from "./PlSqlParser.js";
import { Rebuild_clauseContext } from "./PlSqlParser.js";
import { Alter_index_partitioningContext } from "./PlSqlParser.js";
import { Modify_index_default_attrsContext } from "./PlSqlParser.js";
import { Add_hash_index_partitionContext } from "./PlSqlParser.js";
import { Coalesce_index_partitionContext } from "./PlSqlParser.js";
import { Modify_index_partitionContext } from "./PlSqlParser.js";
import { Modify_index_partitions_opsContext } from "./PlSqlParser.js";
import { Rename_index_partitionContext } from "./PlSqlParser.js";
import { Drop_index_partitionContext } from "./PlSqlParser.js";
import { Split_index_partitionContext } from "./PlSqlParser.js";
import { Index_partition_descriptionContext } from "./PlSqlParser.js";
import { Modify_index_subpartitionContext } from "./PlSqlParser.js";
import { Partition_name_oldContext } from "./PlSqlParser.js";
import { New_partition_nameContext } from "./PlSqlParser.js";
import { New_index_nameContext } from "./PlSqlParser.js";
import { Alter_inmemory_join_groupContext } from "./PlSqlParser.js";
import { Create_userContext } from "./PlSqlParser.js";
import { Alter_userContext } from "./PlSqlParser.js";
import { Drop_userContext } from "./PlSqlParser.js";
import { Alter_identified_byContext } from "./PlSqlParser.js";
import { Identified_byContext } from "./PlSqlParser.js";
import { Identified_other_clauseContext } from "./PlSqlParser.js";
import { User_tablespace_clauseContext } from "./PlSqlParser.js";
import { Quota_clauseContext } from "./PlSqlParser.js";
import { Profile_clauseContext } from "./PlSqlParser.js";
import { Role_clauseContext } from "./PlSqlParser.js";
import { User_default_role_clauseContext } from "./PlSqlParser.js";
import { Password_expire_clauseContext } from "./PlSqlParser.js";
import { User_lock_clauseContext } from "./PlSqlParser.js";
import { User_editions_clauseContext } from "./PlSqlParser.js";
import { Alter_user_editions_clauseContext } from "./PlSqlParser.js";
import { Proxy_clauseContext } from "./PlSqlParser.js";
import { Container_namesContext } from "./PlSqlParser.js";
import { Set_container_dataContext } from "./PlSqlParser.js";
import { Add_rem_container_dataContext } from "./PlSqlParser.js";
import { Container_data_clauseContext } from "./PlSqlParser.js";
import { Administer_key_managementContext } from "./PlSqlParser.js";
import { Keystore_management_clausesContext } from "./PlSqlParser.js";
import { Create_keystoreContext } from "./PlSqlParser.js";
import { Open_keystoreContext } from "./PlSqlParser.js";
import { Force_keystoreContext } from "./PlSqlParser.js";
import { Close_keystoreContext } from "./PlSqlParser.js";
import { Backup_keystoreContext } from "./PlSqlParser.js";
import { Alter_keystore_passwordContext } from "./PlSqlParser.js";
import { Merge_into_new_keystoreContext } from "./PlSqlParser.js";
import { Merge_into_existing_keystoreContext } from "./PlSqlParser.js";
import { Isolate_keystoreContext } from "./PlSqlParser.js";
import { Unite_keystoreContext } from "./PlSqlParser.js";
import { Key_management_clausesContext } from "./PlSqlParser.js";
import { Set_keyContext } from "./PlSqlParser.js";
import { Create_keyContext } from "./PlSqlParser.js";
import { MkidContext } from "./PlSqlParser.js";
import { MkContext } from "./PlSqlParser.js";
import { Use_keyContext } from "./PlSqlParser.js";
import { Set_key_tagContext } from "./PlSqlParser.js";
import { Export_keysContext } from "./PlSqlParser.js";
import { Import_keysContext } from "./PlSqlParser.js";
import { Migrate_keysContext } from "./PlSqlParser.js";
import { Reverse_migrate_keysContext } from "./PlSqlParser.js";
import { Move_keysContext } from "./PlSqlParser.js";
import { Identified_by_storeContext } from "./PlSqlParser.js";
import { Using_algorithm_clauseContext } from "./PlSqlParser.js";
import { Using_tag_clauseContext } from "./PlSqlParser.js";
import { Secret_management_clausesContext } from "./PlSqlParser.js";
import { Add_update_secretContext } from "./PlSqlParser.js";
import { Delete_secretContext } from "./PlSqlParser.js";
import { Add_update_secret_sepsContext } from "./PlSqlParser.js";
import { Delete_secret_sepsContext } from "./PlSqlParser.js";
import { Zero_downtime_software_patching_clausesContext } from "./PlSqlParser.js";
import { With_backup_clauseContext } from "./PlSqlParser.js";
import { Identified_by_password_clauseContext } from "./PlSqlParser.js";
import { Keystore_passwordContext } from "./PlSqlParser.js";
import { PathContext } from "./PlSqlParser.js";
import { SecretContext } from "./PlSqlParser.js";
import { AnalyzeContext } from "./PlSqlParser.js";
import { Partition_extention_clauseContext } from "./PlSqlParser.js";
import { Validation_clausesContext } from "./PlSqlParser.js";
import { Compute_clausesContext } from "./PlSqlParser.js";
import { For_clauseContext } from "./PlSqlParser.js";
import { Online_or_offlineContext } from "./PlSqlParser.js";
import { Into_clause1Context } from "./PlSqlParser.js";
import { Partition_key_valueContext } from "./PlSqlParser.js";
import { Subpartition_key_valueContext } from "./PlSqlParser.js";
import { Associate_statisticsContext } from "./PlSqlParser.js";
import { Column_associationContext } from "./PlSqlParser.js";
import { Function_associationContext } from "./PlSqlParser.js";
import { Indextype_nameContext } from "./PlSqlParser.js";
import { Using_statistics_typeContext } from "./PlSqlParser.js";
import { Statistics_type_nameContext } from "./PlSqlParser.js";
import { Default_cost_clauseContext } from "./PlSqlParser.js";
import { Cpu_costContext } from "./PlSqlParser.js";
import { Io_costContext } from "./PlSqlParser.js";
import { Network_costContext } from "./PlSqlParser.js";
import { Default_selectivity_clauseContext } from "./PlSqlParser.js";
import { Default_selectivityContext } from "./PlSqlParser.js";
import { Storage_table_clauseContext } from "./PlSqlParser.js";
import { Unified_auditingContext } from "./PlSqlParser.js";
import { Policy_nameContext } from "./PlSqlParser.js";
import { Audit_traditionalContext } from "./PlSqlParser.js";
import { Audit_direct_pathContext } from "./PlSqlParser.js";
import { Audit_container_clauseContext } from "./PlSqlParser.js";
import { Audit_operation_clauseContext } from "./PlSqlParser.js";
import { Auditing_by_clauseContext } from "./PlSqlParser.js";
import { Audit_userContext } from "./PlSqlParser.js";
import { Audit_schema_object_clauseContext } from "./PlSqlParser.js";
import { Sql_operationContext } from "./PlSqlParser.js";
import { Auditing_on_clauseContext } from "./PlSqlParser.js";
import { Model_nameContext } from "./PlSqlParser.js";
import { Object_nameContext } from "./PlSqlParser.js";
import { Profile_nameContext } from "./PlSqlParser.js";
import { Sql_statement_shortcutContext } from "./PlSqlParser.js";
import { Drop_indexContext } from "./PlSqlParser.js";
import { Disassociate_statisticsContext } from "./PlSqlParser.js";
import { Drop_indextypeContext } from "./PlSqlParser.js";
import { Drop_inmemory_join_groupContext } from "./PlSqlParser.js";
import { Flashback_tableContext } from "./PlSqlParser.js";
import { Restore_pointContext } from "./PlSqlParser.js";
import { Purge_statementContext } from "./PlSqlParser.js";
import { Noaudit_statementContext } from "./PlSqlParser.js";
import { Rename_objectContext } from "./PlSqlParser.js";
import { Grant_statementContext } from "./PlSqlParser.js";
import { Container_clauseContext } from "./PlSqlParser.js";
import { Revoke_statementContext } from "./PlSqlParser.js";
import { Revoke_system_privilegeContext } from "./PlSqlParser.js";
import { Revokee_clauseContext } from "./PlSqlParser.js";
import { Revoke_object_privilegesContext } from "./PlSqlParser.js";
import { On_object_clauseContext } from "./PlSqlParser.js";
import { Revoke_roles_from_programsContext } from "./PlSqlParser.js";
import { Program_unitContext } from "./PlSqlParser.js";
import { Create_dimensionContext } from "./PlSqlParser.js";
import { Create_directoryContext } from "./PlSqlParser.js";
import { Directory_nameContext } from "./PlSqlParser.js";
import { Directory_pathContext } from "./PlSqlParser.js";
import { Create_inmemory_join_groupContext } from "./PlSqlParser.js";
import { Drop_hierarchyContext } from "./PlSqlParser.js";
import { Alter_libraryContext } from "./PlSqlParser.js";
import { Drop_javaContext } from "./PlSqlParser.js";
import { Drop_libraryContext } from "./PlSqlParser.js";
import { Create_javaContext } from "./PlSqlParser.js";
import { Create_libraryContext } from "./PlSqlParser.js";
import { Plsql_library_sourceContext } from "./PlSqlParser.js";
import { Credential_nameContext } from "./PlSqlParser.js";
import { Library_editionableContext } from "./PlSqlParser.js";
import { Library_debugContext } from "./PlSqlParser.js";
import { Compiler_parameters_clauseContext } from "./PlSqlParser.js";
import { Parameter_valueContext } from "./PlSqlParser.js";
import { Library_nameContext } from "./PlSqlParser.js";
import { Alter_dimensionContext } from "./PlSqlParser.js";
import { Level_clauseContext } from "./PlSqlParser.js";
import { Hierarchy_clauseContext } from "./PlSqlParser.js";
import { Dimension_join_clauseContext } from "./PlSqlParser.js";
import { Attribute_clauseContext } from "./PlSqlParser.js";
import { Extended_attribute_clauseContext } from "./PlSqlParser.js";
import { Column_one_or_more_sub_clauseContext } from "./PlSqlParser.js";
import { Alter_viewContext } from "./PlSqlParser.js";
import { Alter_view_editionableContext } from "./PlSqlParser.js";
import { Create_viewContext } from "./PlSqlParser.js";
import { Editioning_clauseContext } from "./PlSqlParser.js";
import { View_optionsContext } from "./PlSqlParser.js";
import { View_alias_constraintContext } from "./PlSqlParser.js";
import { Object_view_clauseContext } from "./PlSqlParser.js";
import { Inline_constraintContext } from "./PlSqlParser.js";
import { Inline_ref_constraintContext } from "./PlSqlParser.js";
import { Out_of_line_ref_constraintContext } from "./PlSqlParser.js";
import { Out_of_line_constraintContext } from "./PlSqlParser.js";
import { Constraint_stateContext } from "./PlSqlParser.js";
import { Xmltype_view_clauseContext } from "./PlSqlParser.js";
import { Xml_schema_specContext } from "./PlSqlParser.js";
import { Xml_schema_urlContext } from "./PlSqlParser.js";
import { ElementContext } from "./PlSqlParser.js";
import { Alter_tablespaceContext } from "./PlSqlParser.js";
import { Datafile_tempfile_clausesContext } from "./PlSqlParser.js";
import { Tablespace_logging_clausesContext } from "./PlSqlParser.js";
import { Tablespace_group_clauseContext } from "./PlSqlParser.js";
import { Tablespace_group_nameContext } from "./PlSqlParser.js";
import { Tablespace_state_clausesContext } from "./PlSqlParser.js";
import { Flashback_mode_clauseContext } from "./PlSqlParser.js";
import { New_tablespace_nameContext } from "./PlSqlParser.js";
import { Create_tablespaceContext } from "./PlSqlParser.js";
import { Permanent_tablespace_clauseContext } from "./PlSqlParser.js";
import { Tablespace_encryption_specContext } from "./PlSqlParser.js";
import { Logging_clauseContext } from "./PlSqlParser.js";
import { Extent_management_clauseContext } from "./PlSqlParser.js";
import { Segment_management_clauseContext } from "./PlSqlParser.js";
import { Temporary_tablespace_clauseContext } from "./PlSqlParser.js";
import { Undo_tablespace_clauseContext } from "./PlSqlParser.js";
import { Tablespace_retention_clauseContext } from "./PlSqlParser.js";
import { Create_tablespace_setContext } from "./PlSqlParser.js";
import { Permanent_tablespace_attrsContext } from "./PlSqlParser.js";
import { Tablespace_encryption_clauseContext } from "./PlSqlParser.js";
import { Default_tablespace_paramsContext } from "./PlSqlParser.js";
import { Default_table_compressionContext } from "./PlSqlParser.js";
import { Low_highContext } from "./PlSqlParser.js";
import { Default_index_compressionContext } from "./PlSqlParser.js";
import { Inmmemory_clauseContext } from "./PlSqlParser.js";
import { Datafile_specificationContext } from "./PlSqlParser.js";
import { Tempfile_specificationContext } from "./PlSqlParser.js";
import { Datafile_tempfile_specContext } from "./PlSqlParser.js";
import { Redo_log_file_specContext } from "./PlSqlParser.js";
import { Autoextend_clauseContext } from "./PlSqlParser.js";
import { Maxsize_clauseContext } from "./PlSqlParser.js";
import { Build_clauseContext } from "./PlSqlParser.js";
import { Parallel_clauseContext } from "./PlSqlParser.js";
import { Parallel_instances_clauseContext } from "./PlSqlParser.js";
import { Alter_materialized_viewContext } from "./PlSqlParser.js";
import { Alter_mv_option1Context } from "./PlSqlParser.js";
import { Alter_mv_refreshContext } from "./PlSqlParser.js";
import { Rollback_segmentContext } from "./PlSqlParser.js";
import { Modify_mv_column_clauseContext } from "./PlSqlParser.js";
import { Alter_materialized_view_logContext } from "./PlSqlParser.js";
import { Add_mv_log_column_clauseContext } from "./PlSqlParser.js";
import { Move_mv_log_clauseContext } from "./PlSqlParser.js";
import { Mv_log_augmentationContext } from "./PlSqlParser.js";
import { Create_materialized_view_logContext } from "./PlSqlParser.js";
import { New_values_clauseContext } from "./PlSqlParser.js";
import { Mv_log_purge_clauseContext } from "./PlSqlParser.js";
import { Create_materialized_zonemapContext } from "./PlSqlParser.js";
import { Alter_materialized_zonemapContext } from "./PlSqlParser.js";
import { Drop_materialized_zonemapContext } from "./PlSqlParser.js";
import { Zonemap_refresh_clauseContext } from "./PlSqlParser.js";
import { Zonemap_attributesContext } from "./PlSqlParser.js";
import { Zonemap_nameContext } from "./PlSqlParser.js";
import { Operator_nameContext } from "./PlSqlParser.js";
import { Operator_function_nameContext } from "./PlSqlParser.js";
import { Create_zonemap_on_tableContext } from "./PlSqlParser.js";
import { Create_zonemap_as_subqueryContext } from "./PlSqlParser.js";
import { Alter_operatorContext } from "./PlSqlParser.js";
import { Drop_operatorContext } from "./PlSqlParser.js";
import { Create_operatorContext } from "./PlSqlParser.js";
import { Binding_clauseContext } from "./PlSqlParser.js";
import { Add_binding_clauseContext } from "./PlSqlParser.js";
import { Implementation_clauseContext } from "./PlSqlParser.js";
import { Primary_operator_listContext } from "./PlSqlParser.js";
import { Primary_operator_itemContext } from "./PlSqlParser.js";
import { Operator_context_clauseContext } from "./PlSqlParser.js";
import { Using_function_clauseContext } from "./PlSqlParser.js";
import { Drop_binding_clauseContext } from "./PlSqlParser.js";
import { Create_materialized_viewContext } from "./PlSqlParser.js";
import { Scoped_table_ref_constraintContext } from "./PlSqlParser.js";
import { Mv_column_aliasContext } from "./PlSqlParser.js";
import { Create_mv_refreshContext } from "./PlSqlParser.js";
import { Query_rewrite_clauseContext } from "./PlSqlParser.js";
import { Unusable_editions_clauseContext } from "./PlSqlParser.js";
import { Drop_materialized_viewContext } from "./PlSqlParser.js";
import { Drop_materialized_view_logContext } from "./PlSqlParser.js";
import { Create_contextContext } from "./PlSqlParser.js";
import { Oracle_namespaceContext } from "./PlSqlParser.js";
import { Create_clusterContext } from "./PlSqlParser.js";
import { Create_profileContext } from "./PlSqlParser.js";
import { Resource_parametersContext } from "./PlSqlParser.js";
import { Password_parametersContext } from "./PlSqlParser.js";
import { Create_lockdown_profileContext } from "./PlSqlParser.js";
import { Static_base_profileContext } from "./PlSqlParser.js";
import { Dynamic_base_profileContext } from "./PlSqlParser.js";
import { Create_outlineContext } from "./PlSqlParser.js";
import { Create_restore_pointContext } from "./PlSqlParser.js";
import { Create_roleContext } from "./PlSqlParser.js";
import { Create_tableContext } from "./PlSqlParser.js";
import { Xmltype_tableContext } from "./PlSqlParser.js";
import { Xmltype_virtual_columnsContext } from "./PlSqlParser.js";
import { Xmltype_column_propertiesContext } from "./PlSqlParser.js";
import { Xmltype_storageContext } from "./PlSqlParser.js";
import { Xmlschema_specContext } from "./PlSqlParser.js";
import { Object_tableContext } from "./PlSqlParser.js";
import { Object_typeContext } from "./PlSqlParser.js";
import { Oid_index_clauseContext } from "./PlSqlParser.js";
import { Oid_clauseContext } from "./PlSqlParser.js";
import { Object_propertiesContext } from "./PlSqlParser.js";
import { Object_table_substitutionContext } from "./PlSqlParser.js";
import { Relational_tableContext } from "./PlSqlParser.js";
import { Relational_table_propertiesContext } from "./PlSqlParser.js";
import { Relational_table_propertyContext } from "./PlSqlParser.js";
import { Immutable_table_clausesContext } from "./PlSqlParser.js";
import { Immutable_table_no_drop_clauseContext } from "./PlSqlParser.js";
import { Immutable_table_no_delete_clauseContext } from "./PlSqlParser.js";
import { Blockchain_table_clausesContext } from "./PlSqlParser.js";
import { Blockchain_drop_table_clauseContext } from "./PlSqlParser.js";
import { Blockchain_row_retention_clauseContext } from "./PlSqlParser.js";
import { Blockchain_hash_and_data_format_clauseContext } from "./PlSqlParser.js";
import { Collation_nameContext } from "./PlSqlParser.js";
import { Table_propertiesContext } from "./PlSqlParser.js";
import { Read_only_clauseContext } from "./PlSqlParser.js";
import { Indexing_clauseContext } from "./PlSqlParser.js";
import { Attribute_clustering_clauseContext } from "./PlSqlParser.js";
import { Clustering_joinContext } from "./PlSqlParser.js";
import { Clustering_join_itemContext } from "./PlSqlParser.js";
import { Equijoin_conditionContext } from "./PlSqlParser.js";
import { Cluster_clauseContext } from "./PlSqlParser.js";
import { Clustering_columnsContext } from "./PlSqlParser.js";
import { Clustering_column_groupContext } from "./PlSqlParser.js";
import { Yes_noContext } from "./PlSqlParser.js";
import { Zonemap_clauseContext } from "./PlSqlParser.js";
import { Logical_replication_clauseContext } from "./PlSqlParser.js";
import { Table_nameContext } from "./PlSqlParser.js";
import { Relational_propertyContext } from "./PlSqlParser.js";
import { Table_partitioning_clausesContext } from "./PlSqlParser.js";
import { Range_partitionsContext } from "./PlSqlParser.js";
import { List_partitionsContext } from "./PlSqlParser.js";
import { Hash_partitionsContext } from "./PlSqlParser.js";
import { Individual_hash_partitionsContext } from "./PlSqlParser.js";
import { Hash_partitions_by_quantityContext } from "./PlSqlParser.js";
import { Hash_partition_quantityContext } from "./PlSqlParser.js";
import { Composite_range_partitionsContext } from "./PlSqlParser.js";
import { Composite_list_partitionsContext } from "./PlSqlParser.js";
import { Composite_hash_partitionsContext } from "./PlSqlParser.js";
import { Reference_partitioningContext } from "./PlSqlParser.js";
import { Reference_partition_descContext } from "./PlSqlParser.js";
import { System_partitioningContext } from "./PlSqlParser.js";
import { Range_partition_descContext } from "./PlSqlParser.js";
import { List_partition_descContext } from "./PlSqlParser.js";
import { Subpartition_templateContext } from "./PlSqlParser.js";
import { Hash_subpartition_quantityContext } from "./PlSqlParser.js";
import { Subpartition_by_rangeContext } from "./PlSqlParser.js";
import { Subpartition_by_listContext } from "./PlSqlParser.js";
import { Subpartition_by_hashContext } from "./PlSqlParser.js";
import { Subpartition_nameContext } from "./PlSqlParser.js";
import { Range_subpartition_descContext } from "./PlSqlParser.js";
import { List_subpartition_descContext } from "./PlSqlParser.js";
import { Individual_hash_subpartsContext } from "./PlSqlParser.js";
import { Hash_subparts_by_quantityContext } from "./PlSqlParser.js";
import { Range_values_clauseContext } from "./PlSqlParser.js";
import { Range_values_listContext } from "./PlSqlParser.js";
import { List_values_clauseContext } from "./PlSqlParser.js";
import { Table_partition_descriptionContext } from "./PlSqlParser.js";
import { Partitioning_storage_clauseContext } from "./PlSqlParser.js";
import { Lob_partitioning_storageContext } from "./PlSqlParser.js";
import { Size_clauseContext } from "./PlSqlParser.js";
import { Table_compressionContext } from "./PlSqlParser.js";
import { Inmemory_table_clauseContext } from "./PlSqlParser.js";
import { Inmemory_attributesContext } from "./PlSqlParser.js";
import { Inmemory_memcompressContext } from "./PlSqlParser.js";
import { Inmemory_priorityContext } from "./PlSqlParser.js";
import { Inmemory_distributeContext } from "./PlSqlParser.js";
import { Inmemory_duplicateContext } from "./PlSqlParser.js";
import { Inmemory_column_clauseContext } from "./PlSqlParser.js";
import { Physical_attributes_clauseContext } from "./PlSqlParser.js";
import { Storage_clauseContext } from "./PlSqlParser.js";
import { Deferred_segment_creationContext } from "./PlSqlParser.js";
import { Segment_attributes_clauseContext } from "./PlSqlParser.js";
import { Physical_propertiesContext } from "./PlSqlParser.js";
import { Ilm_clauseContext } from "./PlSqlParser.js";
import { Ilm_policy_clauseContext } from "./PlSqlParser.js";
import { Ilm_compression_policyContext } from "./PlSqlParser.js";
import { Ilm_tiering_policyContext } from "./PlSqlParser.js";
import { Ilm_after_onContext } from "./PlSqlParser.js";
import { Segment_groupContext } from "./PlSqlParser.js";
import { Ilm_inmemory_policyContext } from "./PlSqlParser.js";
import { Ilm_time_periodContext } from "./PlSqlParser.js";
import { Heap_org_table_clauseContext } from "./PlSqlParser.js";
import { External_table_clauseContext } from "./PlSqlParser.js";
import { Access_driver_typeContext } from "./PlSqlParser.js";
import { External_table_data_propsContext } from "./PlSqlParser.js";
import { External_table_data_formatContext } from "./PlSqlParser.js";
import { External_table_transformContext } from "./PlSqlParser.js";
import { External_table_fieldContext } from "./PlSqlParser.js";
import { External_table_field_listContext } from "./PlSqlParser.js";
import { External_table_fields_clauseContext } from "./PlSqlParser.js";
import { External_table_position_clauseContext } from "./PlSqlParser.js";
import { External_table_datatype_clauseContext } from "./PlSqlParser.js";
import { External_table_delimit_clauseContext } from "./PlSqlParser.js";
import { External_table_trim_clauseContext } from "./PlSqlParser.js";
import { External_table_date_format_clauseContext } from "./PlSqlParser.js";
import { External_table_init_clauseContext } from "./PlSqlParser.js";
import { External_table_condition_clauseContext } from "./PlSqlParser.js";
import { External_table_lls_clauseContext } from "./PlSqlParser.js";
import { External_table_recordsContext } from "./PlSqlParser.js";
import { External_table_record_options_clauseContext } from "./PlSqlParser.js";
import { External_table_output_filesContext } from "./PlSqlParser.js";
import { External_table_fieldsContext } from "./PlSqlParser.js";
import { External_table_datapumpContext } from "./PlSqlParser.js";
import { External_table_hiveContext } from "./PlSqlParser.js";
import { External_table_hive_parameter_mapContext } from "./PlSqlParser.js";
import { External_table_hive_parameter_map_entryContext } from "./PlSqlParser.js";
import { External_table_directoryContext } from "./PlSqlParser.js";
import { Row_movement_clauseContext } from "./PlSqlParser.js";
import { Flashback_archive_clauseContext } from "./PlSqlParser.js";
import { Log_grpContext } from "./PlSqlParser.js";
import { Supplemental_table_loggingContext } from "./PlSqlParser.js";
import { Supplemental_log_grp_clauseContext } from "./PlSqlParser.js";
import { Supplemental_id_key_clauseContext } from "./PlSqlParser.js";
import { Allocate_extent_clauseContext } from "./PlSqlParser.js";
import { Deallocate_unused_clauseContext } from "./PlSqlParser.js";
import { Shrink_clauseContext } from "./PlSqlParser.js";
import { Records_per_block_clauseContext } from "./PlSqlParser.js";
import { Upgrade_table_clauseContext } from "./PlSqlParser.js";
import { Truncate_tableContext } from "./PlSqlParser.js";
import { Drop_tableContext } from "./PlSqlParser.js";
import { Drop_tablespaceContext } from "./PlSqlParser.js";
import { Drop_tablespace_setContext } from "./PlSqlParser.js";
import { Including_contents_clauseContext } from "./PlSqlParser.js";
import { Drop_viewContext } from "./PlSqlParser.js";
import { Comment_on_columnContext } from "./PlSqlParser.js";
import { Enable_or_disableContext } from "./PlSqlParser.js";
import { Allow_or_disallowContext } from "./PlSqlParser.js";
import { Alter_synonymContext } from "./PlSqlParser.js";
import { Create_synonymContext } from "./PlSqlParser.js";
import { Drop_synonymContext } from "./PlSqlParser.js";
import { Create_spfileContext } from "./PlSqlParser.js";
import { Spfile_nameContext } from "./PlSqlParser.js";
import { Pfile_nameContext } from "./PlSqlParser.js";
import { Comment_on_tableContext } from "./PlSqlParser.js";
import { Comment_on_materializedContext } from "./PlSqlParser.js";
import { Alter_analytic_viewContext } from "./PlSqlParser.js";
import { Alter_add_cache_clauseContext } from "./PlSqlParser.js";
import { Levels_itemContext } from "./PlSqlParser.js";
import { Measure_listContext } from "./PlSqlParser.js";
import { Alter_drop_cache_clauseContext } from "./PlSqlParser.js";
import { Alter_attribute_dimensionContext } from "./PlSqlParser.js";
import { Alter_audit_policyContext } from "./PlSqlParser.js";
import { Alter_clusterContext } from "./PlSqlParser.js";
import { Drop_analytic_viewContext } from "./PlSqlParser.js";
import { Drop_attribute_dimensionContext } from "./PlSqlParser.js";
import { Drop_audit_policyContext } from "./PlSqlParser.js";
import { Drop_flashback_archiveContext } from "./PlSqlParser.js";
import { Drop_clusterContext } from "./PlSqlParser.js";
import { Drop_contextContext } from "./PlSqlParser.js";
import { Drop_directoryContext } from "./PlSqlParser.js";
import { Drop_diskgroupContext } from "./PlSqlParser.js";
import { Drop_editionContext } from "./PlSqlParser.js";
import { Truncate_clusterContext } from "./PlSqlParser.js";
import { Cache_or_nocacheContext } from "./PlSqlParser.js";
import { Database_nameContext } from "./PlSqlParser.js";
import { Alter_databaseContext } from "./PlSqlParser.js";
import { Database_clauseContext } from "./PlSqlParser.js";
import { Startup_clausesContext } from "./PlSqlParser.js";
import { Resetlogs_or_noresetlogsContext } from "./PlSqlParser.js";
import { Upgrade_or_downgradeContext } from "./PlSqlParser.js";
import { Recovery_clausesContext } from "./PlSqlParser.js";
import { Begin_or_endContext } from "./PlSqlParser.js";
import { General_recoveryContext } from "./PlSqlParser.js";
import { Full_database_recoveryContext } from "./PlSqlParser.js";
import { Partial_database_recoveryContext } from "./PlSqlParser.js";
import { Partial_database_recovery_10gContext } from "./PlSqlParser.js";
import { Managed_standby_recoveryContext } from "./PlSqlParser.js";
import { Db_nameContext } from "./PlSqlParser.js";
import { Database_file_clausesContext } from "./PlSqlParser.js";
import { Create_datafile_clauseContext } from "./PlSqlParser.js";
import { Alter_datafile_clauseContext } from "./PlSqlParser.js";
import { Alter_tempfile_clauseContext } from "./PlSqlParser.js";
import { Move_datafile_clauseContext } from "./PlSqlParser.js";
import { Logfile_clausesContext } from "./PlSqlParser.js";
import { Add_logfile_clausesContext } from "./PlSqlParser.js";
import { Group_redo_logfileContext } from "./PlSqlParser.js";
import { Drop_logfile_clausesContext } from "./PlSqlParser.js";
import { Switch_logfile_clauseContext } from "./PlSqlParser.js";
import { Supplemental_db_loggingContext } from "./PlSqlParser.js";
import { Add_or_dropContext } from "./PlSqlParser.js";
import { Supplemental_plsql_clauseContext } from "./PlSqlParser.js";
import { Logfile_descriptorContext } from "./PlSqlParser.js";
import { Controlfile_clausesContext } from "./PlSqlParser.js";
import { Trace_file_clauseContext } from "./PlSqlParser.js";
import { Standby_database_clausesContext } from "./PlSqlParser.js";
import { Activate_standby_db_clauseContext } from "./PlSqlParser.js";
import { Maximize_standby_db_clauseContext } from "./PlSqlParser.js";
import { Register_logfile_clauseContext } from "./PlSqlParser.js";
import { Commit_switchover_clauseContext } from "./PlSqlParser.js";
import { Start_standby_clauseContext } from "./PlSqlParser.js";
import { Stop_standby_clauseContext } from "./PlSqlParser.js";
import { Convert_database_clauseContext } from "./PlSqlParser.js";
import { Default_settings_clauseContext } from "./PlSqlParser.js";
import { Set_time_zone_clauseContext } from "./PlSqlParser.js";
import { Instance_clausesContext } from "./PlSqlParser.js";
import { Security_clauseContext } from "./PlSqlParser.js";
import { DomainContext } from "./PlSqlParser.js";
import { DatabaseContext } from "./PlSqlParser.js";
import { Edition_nameContext } from "./PlSqlParser.js";
import { FilenumberContext } from "./PlSqlParser.js";
import { FilenameContext } from "./PlSqlParser.js";
import { Prepare_clauseContext } from "./PlSqlParser.js";
import { Drop_mirror_clauseContext } from "./PlSqlParser.js";
import { Lost_write_protectionContext } from "./PlSqlParser.js";
import { Cdb_fleet_clausesContext } from "./PlSqlParser.js";
import { Lead_cdb_clauseContext } from "./PlSqlParser.js";
import { Lead_cdb_uri_clauseContext } from "./PlSqlParser.js";
import { Property_clausesContext } from "./PlSqlParser.js";
import { Replay_upgrade_clausesContext } from "./PlSqlParser.js";
import { Alter_database_linkContext } from "./PlSqlParser.js";
import { Password_valueContext } from "./PlSqlParser.js";
import { Link_authenticationContext } from "./PlSqlParser.js";
import { Create_schemaContext } from "./PlSqlParser.js";
import { Create_databaseContext } from "./PlSqlParser.js";
import { Database_logging_clausesContext } from "./PlSqlParser.js";
import { Database_logging_sub_clauseContext } from "./PlSqlParser.js";
import { Tablespace_clausesContext } from "./PlSqlParser.js";
import { Enable_pluggable_databaseContext } from "./PlSqlParser.js";
import { File_name_convertContext } from "./PlSqlParser.js";
import { Filename_convert_sub_clauseContext } from "./PlSqlParser.js";
import { Tablespace_datafile_clausesContext } from "./PlSqlParser.js";
import { Undo_mode_clauseContext } from "./PlSqlParser.js";
import { Default_tablespaceContext } from "./PlSqlParser.js";
import { Default_temp_tablespaceContext } from "./PlSqlParser.js";
import { Undo_tablespaceContext } from "./PlSqlParser.js";
import { Drop_databaseContext } from "./PlSqlParser.js";
import { Create_database_linkContext } from "./PlSqlParser.js";
import { Drop_database_linkContext } from "./PlSqlParser.js";
import { Alter_tablespace_setContext } from "./PlSqlParser.js";
import { Alter_tablespace_attrsContext } from "./PlSqlParser.js";
import { Alter_tablespace_encryptionContext } from "./PlSqlParser.js";
import { Ts_file_name_convertContext } from "./PlSqlParser.js";
import { Alter_roleContext } from "./PlSqlParser.js";
import { Role_identified_clauseContext } from "./PlSqlParser.js";
import { Alter_tableContext } from "./PlSqlParser.js";
import { Alter_table_bodyContext } from "./PlSqlParser.js";
import { Alter_table_actionContext } from "./PlSqlParser.js";
import { Enable_disable_clausesContext } from "./PlSqlParser.js";
import { Memoptimize_read_write_clauseContext } from "./PlSqlParser.js";
import { Alter_table_propertiesContext } from "./PlSqlParser.js";
import { Alter_table_partitioningContext } from "./PlSqlParser.js";
import { Add_table_partitionContext } from "./PlSqlParser.js";
import { Drop_table_partitionContext } from "./PlSqlParser.js";
import { Merge_table_partitionContext } from "./PlSqlParser.js";
import { Modify_table_partitionContext } from "./PlSqlParser.js";
import { Split_table_partitionContext } from "./PlSqlParser.js";
import { Truncate_table_partitionContext } from "./PlSqlParser.js";
import { Exchange_table_partitionContext } from "./PlSqlParser.js";
import { Coalesce_table_partitionContext } from "./PlSqlParser.js";
import { Alter_interval_partitionContext } from "./PlSqlParser.js";
import { Move_table_partitionContext } from "./PlSqlParser.js";
import { Filter_conditionContext } from "./PlSqlParser.js";
import { Rename_table_partitionContext } from "./PlSqlParser.js";
import { Partition_extended_namesContext } from "./PlSqlParser.js";
import { Subpartition_extended_namesContext } from "./PlSqlParser.js";
import { Alter_table_properties_1Context } from "./PlSqlParser.js";
import { Alter_iot_clausesContext } from "./PlSqlParser.js";
import { Alter_mapping_table_clauseContext } from "./PlSqlParser.js";
import { Alter_overflow_clauseContext } from "./PlSqlParser.js";
import { Add_overflow_clauseContext } from "./PlSqlParser.js";
import { Update_index_clausesContext } from "./PlSqlParser.js";
import { Update_global_index_clauseContext } from "./PlSqlParser.js";
import { Update_all_indexes_clauseContext } from "./PlSqlParser.js";
import { Update_all_indexes_index_clauseContext } from "./PlSqlParser.js";
import { Update_index_partitionContext } from "./PlSqlParser.js";
import { Update_index_subpartitionContext } from "./PlSqlParser.js";
import { Enable_disable_clauseContext } from "./PlSqlParser.js";
import { Using_index_clauseContext } from "./PlSqlParser.js";
import { Index_attributesContext } from "./PlSqlParser.js";
import { Sort_or_nosortContext } from "./PlSqlParser.js";
import { Exceptions_clauseContext } from "./PlSqlParser.js";
import { Move_table_clauseContext } from "./PlSqlParser.js";
import { Modify_to_partitionedContext } from "./PlSqlParser.js";
import { Index_org_table_clauseContext } from "./PlSqlParser.js";
import { Mapping_table_clauseContext } from "./PlSqlParser.js";
import { Key_compressionContext } from "./PlSqlParser.js";
import { Index_org_overflow_clauseContext } from "./PlSqlParser.js";
import { Column_clausesContext } from "./PlSqlParser.js";
import { Modify_collection_retrievalContext } from "./PlSqlParser.js";
import { Collection_itemContext } from "./PlSqlParser.js";
import { Rename_column_clauseContext } from "./PlSqlParser.js";
import { Old_column_nameContext } from "./PlSqlParser.js";
import { New_column_nameContext } from "./PlSqlParser.js";
import { Add_modify_drop_column_clausesContext } from "./PlSqlParser.js";
import { Drop_column_clauseContext } from "./PlSqlParser.js";
import { Modify_column_clausesContext } from "./PlSqlParser.js";
import { Modify_col_propertiesContext } from "./PlSqlParser.js";
import { Modify_col_visibilityContext } from "./PlSqlParser.js";
import { Modify_col_substitutableContext } from "./PlSqlParser.js";
import { Add_column_clauseContext } from "./PlSqlParser.js";
import { Varray_col_propertiesContext } from "./PlSqlParser.js";
import { Varray_storage_clauseContext } from "./PlSqlParser.js";
import { Lob_segnameContext } from "./PlSqlParser.js";
import { Lob_itemContext } from "./PlSqlParser.js";
import { Lob_storage_parametersContext } from "./PlSqlParser.js";
import { Lob_storage_clauseContext } from "./PlSqlParser.js";
import { Modify_lob_storage_clauseContext } from "./PlSqlParser.js";
import { Modify_lob_parametersContext } from "./PlSqlParser.js";
import { Lob_parametersContext } from "./PlSqlParser.js";
import { Lob_deduplicate_clauseContext } from "./PlSqlParser.js";
import { Lob_compression_clauseContext } from "./PlSqlParser.js";
import { Lob_retention_clauseContext } from "./PlSqlParser.js";
import { Encryption_specContext } from "./PlSqlParser.js";
import { TablespaceContext } from "./PlSqlParser.js";
import { Varray_itemContext } from "./PlSqlParser.js";
import { Column_propertiesContext } from "./PlSqlParser.js";
import { Lob_partition_storageContext } from "./PlSqlParser.js";
import { Period_definitionContext } from "./PlSqlParser.js";
import { Start_time_columnContext } from "./PlSqlParser.js";
import { End_time_columnContext } from "./PlSqlParser.js";
import { Column_definitionContext } from "./PlSqlParser.js";
import { Column_collation_nameContext } from "./PlSqlParser.js";
import { Identity_clauseContext } from "./PlSqlParser.js";
import { Identity_options_parenthesesContext } from "./PlSqlParser.js";
import { Identity_optionsContext } from "./PlSqlParser.js";
import { Virtual_column_definitionContext } from "./PlSqlParser.js";
import { Virtual_column_expressionContext } from "./PlSqlParser.js";
import { Autogenerated_sequence_definitionContext } from "./PlSqlParser.js";
import { By_user_for_statistics_clauseContext } from "./PlSqlParser.js";
import { Evaluation_edition_clauseContext } from "./PlSqlParser.js";
import { Nested_table_col_propertiesContext } from "./PlSqlParser.js";
import { Nested_itemContext } from "./PlSqlParser.js";
import { Substitutable_column_clauseContext } from "./PlSqlParser.js";
import { Partition_nameContext } from "./PlSqlParser.js";
import { Supplemental_logging_propsContext } from "./PlSqlParser.js";
import { Object_type_col_propertiesContext } from "./PlSqlParser.js";
import { Constraint_clausesContext } from "./PlSqlParser.js";
import { Old_constraint_nameContext } from "./PlSqlParser.js";
import { New_constraint_nameContext } from "./PlSqlParser.js";
import { Drop_constraint_clauseContext } from "./PlSqlParser.js";
import { Check_constraintContext } from "./PlSqlParser.js";
import { Foreign_key_clauseContext } from "./PlSqlParser.js";
import { References_clauseContext } from "./PlSqlParser.js";
import { On_delete_clauseContext } from "./PlSqlParser.js";
import { Anonymous_blockContext } from "./PlSqlParser.js";
import { Invoker_rights_clauseContext } from "./PlSqlParser.js";
import { Call_specContext } from "./PlSqlParser.js";
import { Java_specContext } from "./PlSqlParser.js";
import { C_specContext } from "./PlSqlParser.js";
import { C_agent_in_clauseContext } from "./PlSqlParser.js";
import { C_parameters_clauseContext } from "./PlSqlParser.js";
import { C_external_parameterContext } from "./PlSqlParser.js";
import { C_propertyContext } from "./PlSqlParser.js";
import { ParameterContext } from "./PlSqlParser.js";
import { Default_value_partContext } from "./PlSqlParser.js";
import { Seq_of_declare_specsContext } from "./PlSqlParser.js";
import { Declare_specContext } from "./PlSqlParser.js";
import { Variable_declarationContext } from "./PlSqlParser.js";
import { Subtype_declarationContext } from "./PlSqlParser.js";
import { Cursor_declarationContext } from "./PlSqlParser.js";
import { Parameter_specContext } from "./PlSqlParser.js";
import { Exception_declarationContext } from "./PlSqlParser.js";
import { Pragma_declarationContext } from "./PlSqlParser.js";
import { Record_type_defContext } from "./PlSqlParser.js";
import { Field_specContext } from "./PlSqlParser.js";
import { Ref_cursor_type_defContext } from "./PlSqlParser.js";
import { Type_declarationContext } from "./PlSqlParser.js";
import { Table_type_defContext } from "./PlSqlParser.js";
import { Table_indexed_by_partContext } from "./PlSqlParser.js";
import { Varray_type_defContext } from "./PlSqlParser.js";
import { Seq_of_statementsContext } from "./PlSqlParser.js";
import { Label_declarationContext } from "./PlSqlParser.js";
import { StatementContext } from "./PlSqlParser.js";
import { Assignment_statementContext } from "./PlSqlParser.js";
import { Continue_statementContext } from "./PlSqlParser.js";
import { Exit_statementContext } from "./PlSqlParser.js";
import { Goto_statementContext } from "./PlSqlParser.js";
import { If_statementContext } from "./PlSqlParser.js";
import { Elsif_partContext } from "./PlSqlParser.js";
import { Else_partContext } from "./PlSqlParser.js";
import { Loop_statementContext } from "./PlSqlParser.js";
import { Cursor_loop_paramContext } from "./PlSqlParser.js";
import { Forall_statementContext } from "./PlSqlParser.js";
import { Bounds_clauseContext } from "./PlSqlParser.js";
import { Between_boundContext } from "./PlSqlParser.js";
import { Lower_boundContext } from "./PlSqlParser.js";
import { Upper_boundContext } from "./PlSqlParser.js";
import { Null_statementContext } from "./PlSqlParser.js";
import { Raise_statementContext } from "./PlSqlParser.js";
import { Return_statementContext } from "./PlSqlParser.js";
import { Call_statementContext } from "./PlSqlParser.js";
import { Pipe_row_statementContext } from "./PlSqlParser.js";
import { Selection_directiveContext } from "./PlSqlParser.js";
import { Error_directiveContext } from "./PlSqlParser.js";
import { Selection_directive_bodyContext } from "./PlSqlParser.js";
import { BodyContext } from "./PlSqlParser.js";
import { Exception_handlerContext } from "./PlSqlParser.js";
import { Trigger_blockContext } from "./PlSqlParser.js";
import { Tps_blockContext } from "./PlSqlParser.js";
import { BlockContext } from "./PlSqlParser.js";
import { Sql_statementContext } from "./PlSqlParser.js";
import { Execute_immediateContext } from "./PlSqlParser.js";
import { Dynamic_returning_clauseContext } from "./PlSqlParser.js";
import { Data_manipulation_language_statementsContext } from "./PlSqlParser.js";
import { Cursor_manipulation_statementsContext } from "./PlSqlParser.js";
import { Close_statementContext } from "./PlSqlParser.js";
import { Open_statementContext } from "./PlSqlParser.js";
import { Fetch_statementContext } from "./PlSqlParser.js";
import { Variable_or_collectionContext } from "./PlSqlParser.js";
import { Open_for_statementContext } from "./PlSqlParser.js";
import { Transaction_control_statementsContext } from "./PlSqlParser.js";
import { Set_transaction_commandContext } from "./PlSqlParser.js";
import { Set_constraint_commandContext } from "./PlSqlParser.js";
import { Commit_statementContext } from "./PlSqlParser.js";
import { Write_clauseContext } from "./PlSqlParser.js";
import { Rollback_statementContext } from "./PlSqlParser.js";
import { Savepoint_statementContext } from "./PlSqlParser.js";
import { Collection_method_callContext } from "./PlSqlParser.js";
import { Explain_statementContext } from "./PlSqlParser.js";
import { Select_only_statementContext } from "./PlSqlParser.js";
import { Select_statementContext } from "./PlSqlParser.js";
import { With_clauseContext } from "./PlSqlParser.js";
import { With_factoring_clauseContext } from "./PlSqlParser.js";
import { Subquery_factoring_clauseContext } from "./PlSqlParser.js";
import { Search_clauseContext } from "./PlSqlParser.js";
import { Cycle_clauseContext } from "./PlSqlParser.js";
import { Subav_factoring_clauseContext } from "./PlSqlParser.js";
import { Subav_clauseContext } from "./PlSqlParser.js";
import { Hierarchies_clauseContext } from "./PlSqlParser.js";
import { Filter_clausesContext } from "./PlSqlParser.js";
import { Filter_clauseContext } from "./PlSqlParser.js";
import { Add_calcs_clauseContext } from "./PlSqlParser.js";
import { Add_calc_meas_clauseContext } from "./PlSqlParser.js";
import { SubqueryContext } from "./PlSqlParser.js";
import { Subquery_no_withContext } from "./PlSqlParser.js";
import { Subquery_basic_elementsContext } from "./PlSqlParser.js";
import { Subquery_operation_partContext } from "./PlSqlParser.js";
import { Query_blockContext } from "./PlSqlParser.js";
import { Selected_listContext } from "./PlSqlParser.js";
import { From_clauseContext } from "./PlSqlParser.js";
import { Select_list_elementsContext } from "./PlSqlParser.js";
import { Table_ref_listContext } from "./PlSqlParser.js";
import { Table_refContext } from "./PlSqlParser.js";
import { Table_ref_auxContext } from "./PlSqlParser.js";
import { Table_ref_aux_internal_oneContext } from "./PlSqlParser.js";
import { Table_ref_aux_internal_twoContext } from "./PlSqlParser.js";
import { Table_ref_aux_internal_threContext } from "./PlSqlParser.js";
import { Join_clauseContext } from "./PlSqlParser.js";
import { Join_on_partContext } from "./PlSqlParser.js";
import { Join_using_partContext } from "./PlSqlParser.js";
import { Outer_join_typeContext } from "./PlSqlParser.js";
import { Query_partition_clauseContext } from "./PlSqlParser.js";
import { Flashback_query_clauseContext } from "./PlSqlParser.js";
import { Pivot_clauseContext } from "./PlSqlParser.js";
import { Pivot_elementContext } from "./PlSqlParser.js";
import { Pivot_for_clauseContext } from "./PlSqlParser.js";
import { Pivot_in_clauseContext } from "./PlSqlParser.js";
import { Pivot_in_clause_elementContext } from "./PlSqlParser.js";
import { Pivot_in_clause_elementsContext } from "./PlSqlParser.js";
import { Unpivot_clauseContext } from "./PlSqlParser.js";
import { Unpivot_in_clauseContext } from "./PlSqlParser.js";
import { Unpivot_in_elementsContext } from "./PlSqlParser.js";
import { Hierarchical_query_clauseContext } from "./PlSqlParser.js";
import { Start_partContext } from "./PlSqlParser.js";
import { Group_by_clauseContext } from "./PlSqlParser.js";
import { Group_by_elementsContext } from "./PlSqlParser.js";
import { Rollup_cube_clauseContext } from "./PlSqlParser.js";
import { Grouping_sets_clauseContext } from "./PlSqlParser.js";
import { Grouping_sets_elementsContext } from "./PlSqlParser.js";
import { Having_clauseContext } from "./PlSqlParser.js";
import { Model_clauseContext } from "./PlSqlParser.js";
import { Cell_reference_optionsContext } from "./PlSqlParser.js";
import { Return_rows_clauseContext } from "./PlSqlParser.js";
import { Reference_modelContext } from "./PlSqlParser.js";
import { Main_modelContext } from "./PlSqlParser.js";
import { Model_column_clausesContext } from "./PlSqlParser.js";
import { Model_column_partition_partContext } from "./PlSqlParser.js";
import { Model_column_listContext } from "./PlSqlParser.js";
import { Model_columnContext } from "./PlSqlParser.js";
import { Model_rules_clauseContext } from "./PlSqlParser.js";
import { Model_rules_partContext } from "./PlSqlParser.js";
import { Model_rules_elementContext } from "./PlSqlParser.js";
import { Cell_assignmentContext } from "./PlSqlParser.js";
import { Model_iterate_clauseContext } from "./PlSqlParser.js";
import { Until_partContext } from "./PlSqlParser.js";
import { Order_by_clauseContext } from "./PlSqlParser.js";
import { Order_by_elementsContext } from "./PlSqlParser.js";
import { Offset_clauseContext } from "./PlSqlParser.js";
import { Fetch_clauseContext } from "./PlSqlParser.js";
import { For_update_clauseContext } from "./PlSqlParser.js";
import { For_update_of_partContext } from "./PlSqlParser.js";
import { For_update_optionsContext } from "./PlSqlParser.js";
import { Update_statementContext } from "./PlSqlParser.js";
import { Update_set_clauseContext } from "./PlSqlParser.js";
import { Column_based_update_set_clauseContext } from "./PlSqlParser.js";
import { Delete_statementContext } from "./PlSqlParser.js";
import { Insert_statementContext } from "./PlSqlParser.js";
import { Single_table_insertContext } from "./PlSqlParser.js";
import { Multi_table_insertContext } from "./PlSqlParser.js";
import { Multi_table_elementContext } from "./PlSqlParser.js";
import { Conditional_insert_clauseContext } from "./PlSqlParser.js";
import { Conditional_insert_when_partContext } from "./PlSqlParser.js";
import { Conditional_insert_else_partContext } from "./PlSqlParser.js";
import { Insert_into_clauseContext } from "./PlSqlParser.js";
import { Values_clauseContext } from "./PlSqlParser.js";
import { Merge_statementContext } from "./PlSqlParser.js";
import { Merge_update_clauseContext } from "./PlSqlParser.js";
import { Merge_elementContext } from "./PlSqlParser.js";
import { Merge_update_delete_partContext } from "./PlSqlParser.js";
import { Merge_insert_clauseContext } from "./PlSqlParser.js";
import { Selected_tableviewContext } from "./PlSqlParser.js";
import { Lock_table_statementContext } from "./PlSqlParser.js";
import { Wait_nowait_partContext } from "./PlSqlParser.js";
import { Lock_table_elementContext } from "./PlSqlParser.js";
import { Lock_modeContext } from "./PlSqlParser.js";
import { General_table_refContext } from "./PlSqlParser.js";
import { Static_returning_clauseContext } from "./PlSqlParser.js";
import { Error_logging_clauseContext } from "./PlSqlParser.js";
import { Error_logging_into_partContext } from "./PlSqlParser.js";
import { Error_logging_reject_partContext } from "./PlSqlParser.js";
import { Dml_table_expression_clauseContext } from "./PlSqlParser.js";
import { Table_collection_expressionContext } from "./PlSqlParser.js";
import { Subquery_restriction_clauseContext } from "./PlSqlParser.js";
import { Sample_clauseContext } from "./PlSqlParser.js";
import { Seed_partContext } from "./PlSqlParser.js";
import { ConditionContext } from "./PlSqlParser.js";
import { Expressions_Context } from "./PlSqlParser.js";
import { ExpressionContext } from "./PlSqlParser.js";
import { Cursor_expressionContext } from "./PlSqlParser.js";
import { Logical_expressionContext } from "./PlSqlParser.js";
import { Unary_logical_expressionContext } from "./PlSqlParser.js";
import { Unary_logical_operationContext } from "./PlSqlParser.js";
import { Logical_operationContext } from "./PlSqlParser.js";
import { Multiset_expressionContext } from "./PlSqlParser.js";
import { Relational_expressionContext } from "./PlSqlParser.js";
import { Compound_expressionContext } from "./PlSqlParser.js";
import { Relational_operatorContext } from "./PlSqlParser.js";
import { In_elementsContext } from "./PlSqlParser.js";
import { Between_elementsContext } from "./PlSqlParser.js";
import { ConcatenationContext } from "./PlSqlParser.js";
import { Interval_expressionContext } from "./PlSqlParser.js";
import { Model_expressionContext } from "./PlSqlParser.js";
import { Model_expression_elementContext } from "./PlSqlParser.js";
import { Single_column_for_loopContext } from "./PlSqlParser.js";
import { Multi_column_for_loopContext } from "./PlSqlParser.js";
import { Unary_expressionContext } from "./PlSqlParser.js";
import { Unary_expression_coreContext } from "./PlSqlParser.js";
import { Selection_directive_expressionContext } from "./PlSqlParser.js";
import { Implicit_cursor_expressionContext } from "./PlSqlParser.js";
import { Collection_expressionContext } from "./PlSqlParser.js";
import { Case_statementContext } from "./PlSqlParser.js";
import { Simple_case_statementContext } from "./PlSqlParser.js";
import { Searched_case_statementContext } from "./PlSqlParser.js";
import { Case_when_part_statementContext } from "./PlSqlParser.js";
import { Case_else_part_statementContext } from "./PlSqlParser.js";
import { Case_expressionContext } from "./PlSqlParser.js";
import { Simple_case_expressionContext } from "./PlSqlParser.js";
import { Searched_case_expressionContext } from "./PlSqlParser.js";
import { Case_when_part_expressionContext } from "./PlSqlParser.js";
import { Case_else_part_expressionContext } from "./PlSqlParser.js";
import { AtomContext } from "./PlSqlParser.js";
import { Quantified_expressionContext } from "./PlSqlParser.js";
import { String_functionContext } from "./PlSqlParser.js";
import { Standard_functionContext } from "./PlSqlParser.js";
import { Json_functionContext } from "./PlSqlParser.js";
import { Json_object_contentContext } from "./PlSqlParser.js";
import { Json_object_entryContext } from "./PlSqlParser.js";
import { Json_table_clauseContext } from "./PlSqlParser.js";
import { Json_array_elementContext } from "./PlSqlParser.js";
import { Json_on_null_clauseContext } from "./PlSqlParser.js";
import { Json_return_clauseContext } from "./PlSqlParser.js";
import { Json_transform_opContext } from "./PlSqlParser.js";
import { Json_column_clauseContext } from "./PlSqlParser.js";
import { Json_column_definitionContext } from "./PlSqlParser.js";
import { Json_query_returning_clauseContext } from "./PlSqlParser.js";
import { Json_query_return_typeContext } from "./PlSqlParser.js";
import { Json_query_wrapper_clauseContext } from "./PlSqlParser.js";
import { Json_query_on_error_clauseContext } from "./PlSqlParser.js";
import { Json_query_on_empty_clauseContext } from "./PlSqlParser.js";
import { Json_value_return_clauseContext } from "./PlSqlParser.js";
import { Json_value_return_typeContext } from "./PlSqlParser.js";
import { Json_value_on_mismatch_clauseContext } from "./PlSqlParser.js";
import { LiteralContext } from "./PlSqlParser.js";
import { Numeric_function_wrapperContext } from "./PlSqlParser.js";
import { Numeric_functionContext } from "./PlSqlParser.js";
import { Listagg_overflow_clauseContext } from "./PlSqlParser.js";
import { Other_functionContext } from "./PlSqlParser.js";
import { Over_clause_keywordContext } from "./PlSqlParser.js";
import { Within_or_over_clause_keywordContext } from "./PlSqlParser.js";
import { Standard_prediction_function_keywordContext } from "./PlSqlParser.js";
import { Over_clauseContext } from "./PlSqlParser.js";
import { Windowing_clauseContext } from "./PlSqlParser.js";
import { Windowing_typeContext } from "./PlSqlParser.js";
import { Windowing_elementsContext } from "./PlSqlParser.js";
import { Using_clauseContext } from "./PlSqlParser.js";
import { Using_elementContext } from "./PlSqlParser.js";
import { Assignable_elementContext } from "./PlSqlParser.js";
import { Collect_order_by_partContext } from "./PlSqlParser.js";
import { Within_or_over_partContext } from "./PlSqlParser.js";
import { String_delimiterContext } from "./PlSqlParser.js";
import { Cost_matrix_clauseContext } from "./PlSqlParser.js";
import { Xml_passing_clauseContext } from "./PlSqlParser.js";
import { Xml_attributes_clauseContext } from "./PlSqlParser.js";
import { Xml_namespaces_clauseContext } from "./PlSqlParser.js";
import { Xml_table_columnContext } from "./PlSqlParser.js";
import { Xml_general_default_partContext } from "./PlSqlParser.js";
import { Xml_multiuse_expression_elementContext } from "./PlSqlParser.js";
import { Xmlroot_param_version_partContext } from "./PlSqlParser.js";
import { Xmlroot_param_standalone_partContext } from "./PlSqlParser.js";
import { Xmlserialize_param_enconding_partContext } from "./PlSqlParser.js";
import { Xmlserialize_param_version_partContext } from "./PlSqlParser.js";
import { Xmlserialize_param_ident_partContext } from "./PlSqlParser.js";
import { Annotations_clauseContext } from "./PlSqlParser.js";
import { Annotations_listContext } from "./PlSqlParser.js";
import { AnnotationContext } from "./PlSqlParser.js";
import { Sql_plus_commandContext } from "./PlSqlParser.js";
import { Execute_commandContext } from "./PlSqlParser.js";
import { Start_commandContext } from "./PlSqlParser.js";
import { Sql_plus_filepathContext } from "./PlSqlParser.js";
import { Whenever_commandContext } from "./PlSqlParser.js";
import { Set_commandContext } from "./PlSqlParser.js";
import { Timing_commandContext } from "./PlSqlParser.js";
import { Clear_commandContext } from "./PlSqlParser.js";
import { Partition_extension_clauseContext } from "./PlSqlParser.js";
import { Column_aliasContext } from "./PlSqlParser.js";
import { Table_aliasContext } from "./PlSqlParser.js";
import { Where_clauseContext } from "./PlSqlParser.js";
import { Into_clauseContext } from "./PlSqlParser.js";
import { Xml_column_nameContext } from "./PlSqlParser.js";
import { Cost_class_nameContext } from "./PlSqlParser.js";
import { Attribute_nameContext } from "./PlSqlParser.js";
import { Savepoint_nameContext } from "./PlSqlParser.js";
import { Rollback_segment_nameContext } from "./PlSqlParser.js";
import { Schema_nameContext } from "./PlSqlParser.js";
import { Routine_nameContext } from "./PlSqlParser.js";
import { Package_nameContext } from "./PlSqlParser.js";
import { Implementation_type_nameContext } from "./PlSqlParser.js";
import { Parameter_nameContext } from "./PlSqlParser.js";
import { Reference_model_nameContext } from "./PlSqlParser.js";
import { Main_model_nameContext } from "./PlSqlParser.js";
import { Container_tableview_nameContext } from "./PlSqlParser.js";
import { Aggregate_function_nameContext } from "./PlSqlParser.js";
import { Query_nameContext } from "./PlSqlParser.js";
import { Grantee_nameContext } from "./PlSqlParser.js";
import { Role_nameContext } from "./PlSqlParser.js";
import { Constraint_nameContext } from "./PlSqlParser.js";
import { Label_nameContext } from "./PlSqlParser.js";
import { Type_nameContext } from "./PlSqlParser.js";
import { Sequence_nameContext } from "./PlSqlParser.js";
import { Exception_nameContext } from "./PlSqlParser.js";
import { Function_nameContext } from "./PlSqlParser.js";
import { Procedure_nameContext } from "./PlSqlParser.js";
import { Trigger_nameContext } from "./PlSqlParser.js";
import { Variable_nameContext } from "./PlSqlParser.js";
import { Index_nameContext } from "./PlSqlParser.js";
import { Cursor_nameContext } from "./PlSqlParser.js";
import { Record_nameContext } from "./PlSqlParser.js";
import { Link_nameContext } from "./PlSqlParser.js";
import { Local_link_nameContext } from "./PlSqlParser.js";
import { Connection_qualifierContext } from "./PlSqlParser.js";
import { Column_nameContext } from "./PlSqlParser.js";
import { Tableview_nameContext } from "./PlSqlParser.js";
import { XmltableContext } from "./PlSqlParser.js";
import { Char_set_nameContext } from "./PlSqlParser.js";
import { Synonym_nameContext } from "./PlSqlParser.js";
import { Schema_object_nameContext } from "./PlSqlParser.js";
import { Dir_object_nameContext } from "./PlSqlParser.js";
import { User_object_nameContext } from "./PlSqlParser.js";
import { Grant_object_nameContext } from "./PlSqlParser.js";
import { Column_listContext } from "./PlSqlParser.js";
import { Paren_column_listContext } from "./PlSqlParser.js";
import { Keep_clauseContext } from "./PlSqlParser.js";
import { Function_argumentContext } from "./PlSqlParser.js";
import { Function_argument_analyticContext } from "./PlSqlParser.js";
import { Function_argument_modelingContext } from "./PlSqlParser.js";
import { Respect_or_ignore_nullsContext } from "./PlSqlParser.js";
import { ArgumentContext } from "./PlSqlParser.js";
import { Type_specContext } from "./PlSqlParser.js";
import { DatatypeContext } from "./PlSqlParser.js";
import { Precision_partContext } from "./PlSqlParser.js";
import { Native_datatype_elementContext } from "./PlSqlParser.js";
import { Bind_variableContext } from "./PlSqlParser.js";
import { General_elementContext } from "./PlSqlParser.js";
import { General_element_partContext } from "./PlSqlParser.js";
import { Table_elementContext } from "./PlSqlParser.js";
import { Object_privilegeContext } from "./PlSqlParser.js";
import { System_privilegeContext } from "./PlSqlParser.js";
import { ConstantContext } from "./PlSqlParser.js";
import { NumericContext } from "./PlSqlParser.js";
import { Numeric_negativeContext } from "./PlSqlParser.js";
import { Quoted_stringContext } from "./PlSqlParser.js";
import { IdentifierContext } from "./PlSqlParser.js";
import { Id_expressionContext } from "./PlSqlParser.js";
import { Inquiry_directiveContext } from "./PlSqlParser.js";
import { Outer_join_signContext } from "./PlSqlParser.js";
import { Regular_idContext } from "./PlSqlParser.js";
import { Non_reserved_keywords_in_18cContext } from "./PlSqlParser.js";
import { Non_reserved_keywords_in_12cContext } from "./PlSqlParser.js";
import { Non_reserved_keywords_pre12cContext } from "./PlSqlParser.js";


/**
 * This interface defines a complete listener for a parse tree produced by
 * `PlSqlParser`.
 */
export class PlSqlParserListener implements ParseTreeListener {
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_script`.
     * @param ctx the parse tree
     */
    enterSql_script?: (ctx: Sql_scriptContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_script`.
     * @param ctx the parse tree
     */
    exitSql_script?: (ctx: Sql_scriptContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.script_unit`.
     * @param ctx the parse tree
     */
    enterScript_unit?: (ctx: Script_unitContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.script_unit`.
     * @param ctx the parse tree
     */
    exitScript_unit?: (ctx: Script_unitContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.terminator`.
     * @param ctx the parse tree
     */
    enterTerminator?: (ctx: TerminatorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.terminator`.
     * @param ctx the parse tree
     */
    exitTerminator?: (ctx: TerminatorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.plsql_unit`.
     * @param ctx the parse tree
     */
    enterPlsql_unit?: (ctx: Plsql_unitContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.plsql_unit`.
     * @param ctx the parse tree
     */
    exitPlsql_unit?: (ctx: Plsql_unitContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_unit`.
     * @param ctx the parse tree
     */
    enterSql_unit?: (ctx: Sql_unitContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_unit`.
     * @param ctx the parse tree
     */
    exitSql_unit?: (ctx: Sql_unitContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_diskgroup`.
     * @param ctx the parse tree
     */
    enterAlter_diskgroup?: (ctx: Alter_diskgroupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_diskgroup`.
     * @param ctx the parse tree
     */
    exitAlter_diskgroup?: (ctx: Alter_diskgroupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_disk_clause`.
     * @param ctx the parse tree
     */
    enterAdd_disk_clause?: (ctx: Add_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_disk_clause`.
     * @param ctx the parse tree
     */
    exitAdd_disk_clause?: (ctx: Add_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_disk_clause`.
     * @param ctx the parse tree
     */
    enterDrop_disk_clause?: (ctx: Drop_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_disk_clause`.
     * @param ctx the parse tree
     */
    exitDrop_disk_clause?: (ctx: Drop_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.resize_disk_clause`.
     * @param ctx the parse tree
     */
    enterResize_disk_clause?: (ctx: Resize_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.resize_disk_clause`.
     * @param ctx the parse tree
     */
    exitResize_disk_clause?: (ctx: Resize_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.replace_disk_clause`.
     * @param ctx the parse tree
     */
    enterReplace_disk_clause?: (ctx: Replace_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.replace_disk_clause`.
     * @param ctx the parse tree
     */
    exitReplace_disk_clause?: (ctx: Replace_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.wait_nowait`.
     * @param ctx the parse tree
     */
    enterWait_nowait?: (ctx: Wait_nowaitContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.wait_nowait`.
     * @param ctx the parse tree
     */
    exitWait_nowait?: (ctx: Wait_nowaitContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rename_disk_clause`.
     * @param ctx the parse tree
     */
    enterRename_disk_clause?: (ctx: Rename_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rename_disk_clause`.
     * @param ctx the parse tree
     */
    exitRename_disk_clause?: (ctx: Rename_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.disk_online_clause`.
     * @param ctx the parse tree
     */
    enterDisk_online_clause?: (ctx: Disk_online_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.disk_online_clause`.
     * @param ctx the parse tree
     */
    exitDisk_online_clause?: (ctx: Disk_online_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.disk_offline_clause`.
     * @param ctx the parse tree
     */
    enterDisk_offline_clause?: (ctx: Disk_offline_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.disk_offline_clause`.
     * @param ctx the parse tree
     */
    exitDisk_offline_clause?: (ctx: Disk_offline_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.timeout_clause`.
     * @param ctx the parse tree
     */
    enterTimeout_clause?: (ctx: Timeout_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.timeout_clause`.
     * @param ctx the parse tree
     */
    exitTimeout_clause?: (ctx: Timeout_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rebalance_diskgroup_clause`.
     * @param ctx the parse tree
     */
    enterRebalance_diskgroup_clause?: (ctx: Rebalance_diskgroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rebalance_diskgroup_clause`.
     * @param ctx the parse tree
     */
    exitRebalance_diskgroup_clause?: (ctx: Rebalance_diskgroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.phase`.
     * @param ctx the parse tree
     */
    enterPhase?: (ctx: PhaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.phase`.
     * @param ctx the parse tree
     */
    exitPhase?: (ctx: PhaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.check_diskgroup_clause`.
     * @param ctx the parse tree
     */
    enterCheck_diskgroup_clause?: (ctx: Check_diskgroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.check_diskgroup_clause`.
     * @param ctx the parse tree
     */
    exitCheck_diskgroup_clause?: (ctx: Check_diskgroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_template_clauses`.
     * @param ctx the parse tree
     */
    enterDiskgroup_template_clauses?: (ctx: Diskgroup_template_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_template_clauses`.
     * @param ctx the parse tree
     */
    exitDiskgroup_template_clauses?: (ctx: Diskgroup_template_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.qualified_template_clause`.
     * @param ctx the parse tree
     */
    enterQualified_template_clause?: (ctx: Qualified_template_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.qualified_template_clause`.
     * @param ctx the parse tree
     */
    exitQualified_template_clause?: (ctx: Qualified_template_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.redundancy_clause`.
     * @param ctx the parse tree
     */
    enterRedundancy_clause?: (ctx: Redundancy_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.redundancy_clause`.
     * @param ctx the parse tree
     */
    exitRedundancy_clause?: (ctx: Redundancy_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.striping_clause`.
     * @param ctx the parse tree
     */
    enterStriping_clause?: (ctx: Striping_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.striping_clause`.
     * @param ctx the parse tree
     */
    exitStriping_clause?: (ctx: Striping_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.force_noforce`.
     * @param ctx the parse tree
     */
    enterForce_noforce?: (ctx: Force_noforceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.force_noforce`.
     * @param ctx the parse tree
     */
    exitForce_noforce?: (ctx: Force_noforceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_directory_clauses`.
     * @param ctx the parse tree
     */
    enterDiskgroup_directory_clauses?: (ctx: Diskgroup_directory_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_directory_clauses`.
     * @param ctx the parse tree
     */
    exitDiskgroup_directory_clauses?: (ctx: Diskgroup_directory_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dir_name`.
     * @param ctx the parse tree
     */
    enterDir_name?: (ctx: Dir_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dir_name`.
     * @param ctx the parse tree
     */
    exitDir_name?: (ctx: Dir_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_alias_clauses`.
     * @param ctx the parse tree
     */
    enterDiskgroup_alias_clauses?: (ctx: Diskgroup_alias_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_alias_clauses`.
     * @param ctx the parse tree
     */
    exitDiskgroup_alias_clauses?: (ctx: Diskgroup_alias_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_volume_clauses`.
     * @param ctx the parse tree
     */
    enterDiskgroup_volume_clauses?: (ctx: Diskgroup_volume_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_volume_clauses`.
     * @param ctx the parse tree
     */
    exitDiskgroup_volume_clauses?: (ctx: Diskgroup_volume_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_volume_clause`.
     * @param ctx the parse tree
     */
    enterAdd_volume_clause?: (ctx: Add_volume_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_volume_clause`.
     * @param ctx the parse tree
     */
    exitAdd_volume_clause?: (ctx: Add_volume_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_volume_clause`.
     * @param ctx the parse tree
     */
    enterModify_volume_clause?: (ctx: Modify_volume_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_volume_clause`.
     * @param ctx the parse tree
     */
    exitModify_volume_clause?: (ctx: Modify_volume_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_attributes`.
     * @param ctx the parse tree
     */
    enterDiskgroup_attributes?: (ctx: Diskgroup_attributesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_attributes`.
     * @param ctx the parse tree
     */
    exitDiskgroup_attributes?: (ctx: Diskgroup_attributesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_diskgroup_file_clause`.
     * @param ctx the parse tree
     */
    enterDrop_diskgroup_file_clause?: (ctx: Drop_diskgroup_file_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_diskgroup_file_clause`.
     * @param ctx the parse tree
     */
    exitDrop_diskgroup_file_clause?: (ctx: Drop_diskgroup_file_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.convert_redundancy_clause`.
     * @param ctx the parse tree
     */
    enterConvert_redundancy_clause?: (ctx: Convert_redundancy_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.convert_redundancy_clause`.
     * @param ctx the parse tree
     */
    exitConvert_redundancy_clause?: (ctx: Convert_redundancy_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.usergroup_clauses`.
     * @param ctx the parse tree
     */
    enterUsergroup_clauses?: (ctx: Usergroup_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.usergroup_clauses`.
     * @param ctx the parse tree
     */
    exitUsergroup_clauses?: (ctx: Usergroup_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_clauses`.
     * @param ctx the parse tree
     */
    enterUser_clauses?: (ctx: User_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_clauses`.
     * @param ctx the parse tree
     */
    exitUser_clauses?: (ctx: User_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.file_permissions_clause`.
     * @param ctx the parse tree
     */
    enterFile_permissions_clause?: (ctx: File_permissions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.file_permissions_clause`.
     * @param ctx the parse tree
     */
    exitFile_permissions_clause?: (ctx: File_permissions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.file_owner_clause`.
     * @param ctx the parse tree
     */
    enterFile_owner_clause?: (ctx: File_owner_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.file_owner_clause`.
     * @param ctx the parse tree
     */
    exitFile_owner_clause?: (ctx: File_owner_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.scrub_clause`.
     * @param ctx the parse tree
     */
    enterScrub_clause?: (ctx: Scrub_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.scrub_clause`.
     * @param ctx the parse tree
     */
    exitScrub_clause?: (ctx: Scrub_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.quotagroup_clauses`.
     * @param ctx the parse tree
     */
    enterQuotagroup_clauses?: (ctx: Quotagroup_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.quotagroup_clauses`.
     * @param ctx the parse tree
     */
    exitQuotagroup_clauses?: (ctx: Quotagroup_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.property_name`.
     * @param ctx the parse tree
     */
    enterProperty_name?: (ctx: Property_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.property_name`.
     * @param ctx the parse tree
     */
    exitProperty_name?: (ctx: Property_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.property_value`.
     * @param ctx the parse tree
     */
    enterProperty_value?: (ctx: Property_valueContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.property_value`.
     * @param ctx the parse tree
     */
    exitProperty_value?: (ctx: Property_valueContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filegroup_clauses`.
     * @param ctx the parse tree
     */
    enterFilegroup_clauses?: (ctx: Filegroup_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filegroup_clauses`.
     * @param ctx the parse tree
     */
    exitFilegroup_clauses?: (ctx: Filegroup_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_filegroup_clause`.
     * @param ctx the parse tree
     */
    enterAdd_filegroup_clause?: (ctx: Add_filegroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_filegroup_clause`.
     * @param ctx the parse tree
     */
    exitAdd_filegroup_clause?: (ctx: Add_filegroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_filegroup_clause`.
     * @param ctx the parse tree
     */
    enterModify_filegroup_clause?: (ctx: Modify_filegroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_filegroup_clause`.
     * @param ctx the parse tree
     */
    exitModify_filegroup_clause?: (ctx: Modify_filegroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_to_filegroup_clause`.
     * @param ctx the parse tree
     */
    enterMove_to_filegroup_clause?: (ctx: Move_to_filegroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_to_filegroup_clause`.
     * @param ctx the parse tree
     */
    exitMove_to_filegroup_clause?: (ctx: Move_to_filegroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_filegroup_clause`.
     * @param ctx the parse tree
     */
    enterDrop_filegroup_clause?: (ctx: Drop_filegroup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_filegroup_clause`.
     * @param ctx the parse tree
     */
    exitDrop_filegroup_clause?: (ctx: Drop_filegroup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.quorum_regular`.
     * @param ctx the parse tree
     */
    enterQuorum_regular?: (ctx: Quorum_regularContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.quorum_regular`.
     * @param ctx the parse tree
     */
    exitQuorum_regular?: (ctx: Quorum_regularContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.undrop_disk_clause`.
     * @param ctx the parse tree
     */
    enterUndrop_disk_clause?: (ctx: Undrop_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.undrop_disk_clause`.
     * @param ctx the parse tree
     */
    exitUndrop_disk_clause?: (ctx: Undrop_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.diskgroup_availability`.
     * @param ctx the parse tree
     */
    enterDiskgroup_availability?: (ctx: Diskgroup_availabilityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.diskgroup_availability`.
     * @param ctx the parse tree
     */
    exitDiskgroup_availability?: (ctx: Diskgroup_availabilityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.enable_disable_volume`.
     * @param ctx the parse tree
     */
    enterEnable_disable_volume?: (ctx: Enable_disable_volumeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.enable_disable_volume`.
     * @param ctx the parse tree
     */
    exitEnable_disable_volume?: (ctx: Enable_disable_volumeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_function`.
     * @param ctx the parse tree
     */
    enterDrop_function?: (ctx: Drop_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_function`.
     * @param ctx the parse tree
     */
    exitDrop_function?: (ctx: Drop_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_flashback_archive`.
     * @param ctx the parse tree
     */
    enterAlter_flashback_archive?: (ctx: Alter_flashback_archiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_flashback_archive`.
     * @param ctx the parse tree
     */
    exitAlter_flashback_archive?: (ctx: Alter_flashback_archiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_hierarchy`.
     * @param ctx the parse tree
     */
    enterAlter_hierarchy?: (ctx: Alter_hierarchyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_hierarchy`.
     * @param ctx the parse tree
     */
    exitAlter_hierarchy?: (ctx: Alter_hierarchyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_function`.
     * @param ctx the parse tree
     */
    enterAlter_function?: (ctx: Alter_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_function`.
     * @param ctx the parse tree
     */
    exitAlter_function?: (ctx: Alter_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_java`.
     * @param ctx the parse tree
     */
    enterAlter_java?: (ctx: Alter_javaContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_java`.
     * @param ctx the parse tree
     */
    exitAlter_java?: (ctx: Alter_javaContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.match_string`.
     * @param ctx the parse tree
     */
    enterMatch_string?: (ctx: Match_stringContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.match_string`.
     * @param ctx the parse tree
     */
    exitMatch_string?: (ctx: Match_stringContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_function_body`.
     * @param ctx the parse tree
     */
    enterCreate_function_body?: (ctx: Create_function_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_function_body`.
     * @param ctx the parse tree
     */
    exitCreate_function_body?: (ctx: Create_function_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_macro_body`.
     * @param ctx the parse tree
     */
    enterSql_macro_body?: (ctx: Sql_macro_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_macro_body`.
     * @param ctx the parse tree
     */
    exitSql_macro_body?: (ctx: Sql_macro_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parallel_enable_clause`.
     * @param ctx the parse tree
     */
    enterParallel_enable_clause?: (ctx: Parallel_enable_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parallel_enable_clause`.
     * @param ctx the parse tree
     */
    exitParallel_enable_clause?: (ctx: Parallel_enable_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_by_clause`.
     * @param ctx the parse tree
     */
    enterPartition_by_clause?: (ctx: Partition_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_by_clause`.
     * @param ctx the parse tree
     */
    exitPartition_by_clause?: (ctx: Partition_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.result_cache_clause`.
     * @param ctx the parse tree
     */
    enterResult_cache_clause?: (ctx: Result_cache_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.result_cache_clause`.
     * @param ctx the parse tree
     */
    exitResult_cache_clause?: (ctx: Result_cache_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.accessible_by_clause`.
     * @param ctx the parse tree
     */
    enterAccessible_by_clause?: (ctx: Accessible_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.accessible_by_clause`.
     * @param ctx the parse tree
     */
    exitAccessible_by_clause?: (ctx: Accessible_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_collation_clause`.
     * @param ctx the parse tree
     */
    enterDefault_collation_clause?: (ctx: Default_collation_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_collation_clause`.
     * @param ctx the parse tree
     */
    exitDefault_collation_clause?: (ctx: Default_collation_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.aggregate_clause`.
     * @param ctx the parse tree
     */
    enterAggregate_clause?: (ctx: Aggregate_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.aggregate_clause`.
     * @param ctx the parse tree
     */
    exitAggregate_clause?: (ctx: Aggregate_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pipelined_using_clause`.
     * @param ctx the parse tree
     */
    enterPipelined_using_clause?: (ctx: Pipelined_using_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pipelined_using_clause`.
     * @param ctx the parse tree
     */
    exitPipelined_using_clause?: (ctx: Pipelined_using_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.accessor`.
     * @param ctx the parse tree
     */
    enterAccessor?: (ctx: AccessorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.accessor`.
     * @param ctx the parse tree
     */
    exitAccessor?: (ctx: AccessorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relies_on_part`.
     * @param ctx the parse tree
     */
    enterRelies_on_part?: (ctx: Relies_on_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relies_on_part`.
     * @param ctx the parse tree
     */
    exitRelies_on_part?: (ctx: Relies_on_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.streaming_clause`.
     * @param ctx the parse tree
     */
    enterStreaming_clause?: (ctx: Streaming_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.streaming_clause`.
     * @param ctx the parse tree
     */
    exitStreaming_clause?: (ctx: Streaming_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_outline`.
     * @param ctx the parse tree
     */
    enterAlter_outline?: (ctx: Alter_outlineContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_outline`.
     * @param ctx the parse tree
     */
    exitAlter_outline?: (ctx: Alter_outlineContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.outline_options`.
     * @param ctx the parse tree
     */
    enterOutline_options?: (ctx: Outline_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.outline_options`.
     * @param ctx the parse tree
     */
    exitOutline_options?: (ctx: Outline_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_lockdown_profile`.
     * @param ctx the parse tree
     */
    enterAlter_lockdown_profile?: (ctx: Alter_lockdown_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_lockdown_profile`.
     * @param ctx the parse tree
     */
    exitAlter_lockdown_profile?: (ctx: Alter_lockdown_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lockdown_feature`.
     * @param ctx the parse tree
     */
    enterLockdown_feature?: (ctx: Lockdown_featureContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lockdown_feature`.
     * @param ctx the parse tree
     */
    exitLockdown_feature?: (ctx: Lockdown_featureContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lockdown_options`.
     * @param ctx the parse tree
     */
    enterLockdown_options?: (ctx: Lockdown_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lockdown_options`.
     * @param ctx the parse tree
     */
    exitLockdown_options?: (ctx: Lockdown_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lockdown_statements`.
     * @param ctx the parse tree
     */
    enterLockdown_statements?: (ctx: Lockdown_statementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lockdown_statements`.
     * @param ctx the parse tree
     */
    exitLockdown_statements?: (ctx: Lockdown_statementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.statement_clauses`.
     * @param ctx the parse tree
     */
    enterStatement_clauses?: (ctx: Statement_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.statement_clauses`.
     * @param ctx the parse tree
     */
    exitStatement_clauses?: (ctx: Statement_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clause_options`.
     * @param ctx the parse tree
     */
    enterClause_options?: (ctx: Clause_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clause_options`.
     * @param ctx the parse tree
     */
    exitClause_options?: (ctx: Clause_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.option_values`.
     * @param ctx the parse tree
     */
    enterOption_values?: (ctx: Option_valuesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.option_values`.
     * @param ctx the parse tree
     */
    exitOption_values?: (ctx: Option_valuesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.string_list`.
     * @param ctx the parse tree
     */
    enterString_list?: (ctx: String_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.string_list`.
     * @param ctx the parse tree
     */
    exitString_list?: (ctx: String_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.disable_enable`.
     * @param ctx the parse tree
     */
    enterDisable_enable?: (ctx: Disable_enableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.disable_enable`.
     * @param ctx the parse tree
     */
    exitDisable_enable?: (ctx: Disable_enableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_lockdown_profile`.
     * @param ctx the parse tree
     */
    enterDrop_lockdown_profile?: (ctx: Drop_lockdown_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_lockdown_profile`.
     * @param ctx the parse tree
     */
    exitDrop_lockdown_profile?: (ctx: Drop_lockdown_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_package`.
     * @param ctx the parse tree
     */
    enterDrop_package?: (ctx: Drop_packageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_package`.
     * @param ctx the parse tree
     */
    exitDrop_package?: (ctx: Drop_packageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_package`.
     * @param ctx the parse tree
     */
    enterAlter_package?: (ctx: Alter_packageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_package`.
     * @param ctx the parse tree
     */
    exitAlter_package?: (ctx: Alter_packageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_package`.
     * @param ctx the parse tree
     */
    enterCreate_package?: (ctx: Create_packageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_package`.
     * @param ctx the parse tree
     */
    exitCreate_package?: (ctx: Create_packageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_package_body`.
     * @param ctx the parse tree
     */
    enterCreate_package_body?: (ctx: Create_package_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_package_body`.
     * @param ctx the parse tree
     */
    exitCreate_package_body?: (ctx: Create_package_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.package_obj_spec`.
     * @param ctx the parse tree
     */
    enterPackage_obj_spec?: (ctx: Package_obj_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.package_obj_spec`.
     * @param ctx the parse tree
     */
    exitPackage_obj_spec?: (ctx: Package_obj_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.procedure_spec`.
     * @param ctx the parse tree
     */
    enterProcedure_spec?: (ctx: Procedure_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.procedure_spec`.
     * @param ctx the parse tree
     */
    exitProcedure_spec?: (ctx: Procedure_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_spec`.
     * @param ctx the parse tree
     */
    enterFunction_spec?: (ctx: Function_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_spec`.
     * @param ctx the parse tree
     */
    exitFunction_spec?: (ctx: Function_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.package_obj_body`.
     * @param ctx the parse tree
     */
    enterPackage_obj_body?: (ctx: Package_obj_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.package_obj_body`.
     * @param ctx the parse tree
     */
    exitPackage_obj_body?: (ctx: Package_obj_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_pmem_filestore`.
     * @param ctx the parse tree
     */
    enterAlter_pmem_filestore?: (ctx: Alter_pmem_filestoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_pmem_filestore`.
     * @param ctx the parse tree
     */
    exitAlter_pmem_filestore?: (ctx: Alter_pmem_filestoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_pmem_filestore`.
     * @param ctx the parse tree
     */
    enterDrop_pmem_filestore?: (ctx: Drop_pmem_filestoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_pmem_filestore`.
     * @param ctx the parse tree
     */
    exitDrop_pmem_filestore?: (ctx: Drop_pmem_filestoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_procedure`.
     * @param ctx the parse tree
     */
    enterDrop_procedure?: (ctx: Drop_procedureContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_procedure`.
     * @param ctx the parse tree
     */
    exitDrop_procedure?: (ctx: Drop_procedureContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_procedure`.
     * @param ctx the parse tree
     */
    enterAlter_procedure?: (ctx: Alter_procedureContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_procedure`.
     * @param ctx the parse tree
     */
    exitAlter_procedure?: (ctx: Alter_procedureContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_body`.
     * @param ctx the parse tree
     */
    enterFunction_body?: (ctx: Function_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_body`.
     * @param ctx the parse tree
     */
    exitFunction_body?: (ctx: Function_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.procedure_body`.
     * @param ctx the parse tree
     */
    enterProcedure_body?: (ctx: Procedure_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.procedure_body`.
     * @param ctx the parse tree
     */
    exitProcedure_body?: (ctx: Procedure_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_procedure_body`.
     * @param ctx the parse tree
     */
    enterCreate_procedure_body?: (ctx: Create_procedure_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_procedure_body`.
     * @param ctx the parse tree
     */
    exitCreate_procedure_body?: (ctx: Create_procedure_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_resource_cost`.
     * @param ctx the parse tree
     */
    enterAlter_resource_cost?: (ctx: Alter_resource_costContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_resource_cost`.
     * @param ctx the parse tree
     */
    exitAlter_resource_cost?: (ctx: Alter_resource_costContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_outline`.
     * @param ctx the parse tree
     */
    enterDrop_outline?: (ctx: Drop_outlineContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_outline`.
     * @param ctx the parse tree
     */
    exitDrop_outline?: (ctx: Drop_outlineContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_rollback_segment`.
     * @param ctx the parse tree
     */
    enterAlter_rollback_segment?: (ctx: Alter_rollback_segmentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_rollback_segment`.
     * @param ctx the parse tree
     */
    exitAlter_rollback_segment?: (ctx: Alter_rollback_segmentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_restore_point`.
     * @param ctx the parse tree
     */
    enterDrop_restore_point?: (ctx: Drop_restore_pointContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_restore_point`.
     * @param ctx the parse tree
     */
    exitDrop_restore_point?: (ctx: Drop_restore_pointContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_rollback_segment`.
     * @param ctx the parse tree
     */
    enterDrop_rollback_segment?: (ctx: Drop_rollback_segmentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_rollback_segment`.
     * @param ctx the parse tree
     */
    exitDrop_rollback_segment?: (ctx: Drop_rollback_segmentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_role`.
     * @param ctx the parse tree
     */
    enterDrop_role?: (ctx: Drop_roleContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_role`.
     * @param ctx the parse tree
     */
    exitDrop_role?: (ctx: Drop_roleContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_pmem_filestore`.
     * @param ctx the parse tree
     */
    enterCreate_pmem_filestore?: (ctx: Create_pmem_filestoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_pmem_filestore`.
     * @param ctx the parse tree
     */
    exitCreate_pmem_filestore?: (ctx: Create_pmem_filestoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pmem_filestore_options`.
     * @param ctx the parse tree
     */
    enterPmem_filestore_options?: (ctx: Pmem_filestore_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pmem_filestore_options`.
     * @param ctx the parse tree
     */
    exitPmem_filestore_options?: (ctx: Pmem_filestore_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.file_path`.
     * @param ctx the parse tree
     */
    enterFile_path?: (ctx: File_pathContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.file_path`.
     * @param ctx the parse tree
     */
    exitFile_path?: (ctx: File_pathContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_rollback_segment`.
     * @param ctx the parse tree
     */
    enterCreate_rollback_segment?: (ctx: Create_rollback_segmentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_rollback_segment`.
     * @param ctx the parse tree
     */
    exitCreate_rollback_segment?: (ctx: Create_rollback_segmentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_trigger`.
     * @param ctx the parse tree
     */
    enterDrop_trigger?: (ctx: Drop_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_trigger`.
     * @param ctx the parse tree
     */
    exitDrop_trigger?: (ctx: Drop_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_trigger`.
     * @param ctx the parse tree
     */
    enterAlter_trigger?: (ctx: Alter_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_trigger`.
     * @param ctx the parse tree
     */
    exitAlter_trigger?: (ctx: Alter_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_trigger`.
     * @param ctx the parse tree
     */
    enterCreate_trigger?: (ctx: Create_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_trigger`.
     * @param ctx the parse tree
     */
    exitCreate_trigger?: (ctx: Create_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trigger_follows_clause`.
     * @param ctx the parse tree
     */
    enterTrigger_follows_clause?: (ctx: Trigger_follows_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trigger_follows_clause`.
     * @param ctx the parse tree
     */
    exitTrigger_follows_clause?: (ctx: Trigger_follows_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trigger_when_clause`.
     * @param ctx the parse tree
     */
    enterTrigger_when_clause?: (ctx: Trigger_when_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trigger_when_clause`.
     * @param ctx the parse tree
     */
    exitTrigger_when_clause?: (ctx: Trigger_when_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.simple_dml_trigger`.
     * @param ctx the parse tree
     */
    enterSimple_dml_trigger?: (ctx: Simple_dml_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.simple_dml_trigger`.
     * @param ctx the parse tree
     */
    exitSimple_dml_trigger?: (ctx: Simple_dml_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.for_each_row`.
     * @param ctx the parse tree
     */
    enterFor_each_row?: (ctx: For_each_rowContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.for_each_row`.
     * @param ctx the parse tree
     */
    exitFor_each_row?: (ctx: For_each_rowContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compound_dml_trigger`.
     * @param ctx the parse tree
     */
    enterCompound_dml_trigger?: (ctx: Compound_dml_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compound_dml_trigger`.
     * @param ctx the parse tree
     */
    exitCompound_dml_trigger?: (ctx: Compound_dml_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.non_dml_trigger`.
     * @param ctx the parse tree
     */
    enterNon_dml_trigger?: (ctx: Non_dml_triggerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.non_dml_trigger`.
     * @param ctx the parse tree
     */
    exitNon_dml_trigger?: (ctx: Non_dml_triggerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trigger_body`.
     * @param ctx the parse tree
     */
    enterTrigger_body?: (ctx: Trigger_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trigger_body`.
     * @param ctx the parse tree
     */
    exitTrigger_body?: (ctx: Trigger_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compound_trigger_block`.
     * @param ctx the parse tree
     */
    enterCompound_trigger_block?: (ctx: Compound_trigger_blockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compound_trigger_block`.
     * @param ctx the parse tree
     */
    exitCompound_trigger_block?: (ctx: Compound_trigger_blockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.timing_point_section`.
     * @param ctx the parse tree
     */
    enterTiming_point_section?: (ctx: Timing_point_sectionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.timing_point_section`.
     * @param ctx the parse tree
     */
    exitTiming_point_section?: (ctx: Timing_point_sectionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.non_dml_event`.
     * @param ctx the parse tree
     */
    enterNon_dml_event?: (ctx: Non_dml_eventContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.non_dml_event`.
     * @param ctx the parse tree
     */
    exitNon_dml_event?: (ctx: Non_dml_eventContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dml_event_clause`.
     * @param ctx the parse tree
     */
    enterDml_event_clause?: (ctx: Dml_event_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dml_event_clause`.
     * @param ctx the parse tree
     */
    exitDml_event_clause?: (ctx: Dml_event_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dml_event_element`.
     * @param ctx the parse tree
     */
    enterDml_event_element?: (ctx: Dml_event_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dml_event_element`.
     * @param ctx the parse tree
     */
    exitDml_event_element?: (ctx: Dml_event_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dml_event_nested_clause`.
     * @param ctx the parse tree
     */
    enterDml_event_nested_clause?: (ctx: Dml_event_nested_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dml_event_nested_clause`.
     * @param ctx the parse tree
     */
    exitDml_event_nested_clause?: (ctx: Dml_event_nested_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.referencing_clause`.
     * @param ctx the parse tree
     */
    enterReferencing_clause?: (ctx: Referencing_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.referencing_clause`.
     * @param ctx the parse tree
     */
    exitReferencing_clause?: (ctx: Referencing_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.referencing_element`.
     * @param ctx the parse tree
     */
    enterReferencing_element?: (ctx: Referencing_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.referencing_element`.
     * @param ctx the parse tree
     */
    exitReferencing_element?: (ctx: Referencing_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_type`.
     * @param ctx the parse tree
     */
    enterDrop_type?: (ctx: Drop_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_type`.
     * @param ctx the parse tree
     */
    exitDrop_type?: (ctx: Drop_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_type`.
     * @param ctx the parse tree
     */
    enterAlter_type?: (ctx: Alter_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_type`.
     * @param ctx the parse tree
     */
    exitAlter_type?: (ctx: Alter_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compile_type_clause`.
     * @param ctx the parse tree
     */
    enterCompile_type_clause?: (ctx: Compile_type_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compile_type_clause`.
     * @param ctx the parse tree
     */
    exitCompile_type_clause?: (ctx: Compile_type_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.replace_type_clause`.
     * @param ctx the parse tree
     */
    enterReplace_type_clause?: (ctx: Replace_type_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.replace_type_clause`.
     * @param ctx the parse tree
     */
    exitReplace_type_clause?: (ctx: Replace_type_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_method_spec`.
     * @param ctx the parse tree
     */
    enterAlter_method_spec?: (ctx: Alter_method_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_method_spec`.
     * @param ctx the parse tree
     */
    exitAlter_method_spec?: (ctx: Alter_method_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_method_element`.
     * @param ctx the parse tree
     */
    enterAlter_method_element?: (ctx: Alter_method_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_method_element`.
     * @param ctx the parse tree
     */
    exitAlter_method_element?: (ctx: Alter_method_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_attribute_definition`.
     * @param ctx the parse tree
     */
    enterAlter_attribute_definition?: (ctx: Alter_attribute_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_attribute_definition`.
     * @param ctx the parse tree
     */
    exitAlter_attribute_definition?: (ctx: Alter_attribute_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_collection_clauses`.
     * @param ctx the parse tree
     */
    enterAlter_collection_clauses?: (ctx: Alter_collection_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_collection_clauses`.
     * @param ctx the parse tree
     */
    exitAlter_collection_clauses?: (ctx: Alter_collection_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dependent_handling_clause`.
     * @param ctx the parse tree
     */
    enterDependent_handling_clause?: (ctx: Dependent_handling_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dependent_handling_clause`.
     * @param ctx the parse tree
     */
    exitDependent_handling_clause?: (ctx: Dependent_handling_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dependent_exceptions_part`.
     * @param ctx the parse tree
     */
    enterDependent_exceptions_part?: (ctx: Dependent_exceptions_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dependent_exceptions_part`.
     * @param ctx the parse tree
     */
    exitDependent_exceptions_part?: (ctx: Dependent_exceptions_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_type`.
     * @param ctx the parse tree
     */
    enterCreate_type?: (ctx: Create_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_type`.
     * @param ctx the parse tree
     */
    exitCreate_type?: (ctx: Create_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_type_spec`.
     * @param ctx the parse tree
     */
    enterCreate_type_spec?: (ctx: Create_type_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_type_spec`.
     * @param ctx the parse tree
     */
    exitCreate_type_spec?: (ctx: Create_type_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_type_body`.
     * @param ctx the parse tree
     */
    enterCreate_type_body?: (ctx: Create_type_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_type_body`.
     * @param ctx the parse tree
     */
    exitCreate_type_body?: (ctx: Create_type_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_definition`.
     * @param ctx the parse tree
     */
    enterType_definition?: (ctx: Type_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_definition`.
     * @param ctx the parse tree
     */
    exitType_definition?: (ctx: Type_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_type_def`.
     * @param ctx the parse tree
     */
    enterObject_type_def?: (ctx: Object_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_type_def`.
     * @param ctx the parse tree
     */
    exitObject_type_def?: (ctx: Object_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_as_part`.
     * @param ctx the parse tree
     */
    enterObject_as_part?: (ctx: Object_as_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_as_part`.
     * @param ctx the parse tree
     */
    exitObject_as_part?: (ctx: Object_as_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_under_part`.
     * @param ctx the parse tree
     */
    enterObject_under_part?: (ctx: Object_under_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_under_part`.
     * @param ctx the parse tree
     */
    exitObject_under_part?: (ctx: Object_under_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.nested_table_type_def`.
     * @param ctx the parse tree
     */
    enterNested_table_type_def?: (ctx: Nested_table_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.nested_table_type_def`.
     * @param ctx the parse tree
     */
    exitNested_table_type_def?: (ctx: Nested_table_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sqlj_object_type`.
     * @param ctx the parse tree
     */
    enterSqlj_object_type?: (ctx: Sqlj_object_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sqlj_object_type`.
     * @param ctx the parse tree
     */
    exitSqlj_object_type?: (ctx: Sqlj_object_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_body`.
     * @param ctx the parse tree
     */
    enterType_body?: (ctx: Type_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_body`.
     * @param ctx the parse tree
     */
    exitType_body?: (ctx: Type_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_body_elements`.
     * @param ctx the parse tree
     */
    enterType_body_elements?: (ctx: Type_body_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_body_elements`.
     * @param ctx the parse tree
     */
    exitType_body_elements?: (ctx: Type_body_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.map_order_func_declaration`.
     * @param ctx the parse tree
     */
    enterMap_order_func_declaration?: (ctx: Map_order_func_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.map_order_func_declaration`.
     * @param ctx the parse tree
     */
    exitMap_order_func_declaration?: (ctx: Map_order_func_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subprog_decl_in_type`.
     * @param ctx the parse tree
     */
    enterSubprog_decl_in_type?: (ctx: Subprog_decl_in_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subprog_decl_in_type`.
     * @param ctx the parse tree
     */
    exitSubprog_decl_in_type?: (ctx: Subprog_decl_in_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.proc_decl_in_type`.
     * @param ctx the parse tree
     */
    enterProc_decl_in_type?: (ctx: Proc_decl_in_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.proc_decl_in_type`.
     * @param ctx the parse tree
     */
    exitProc_decl_in_type?: (ctx: Proc_decl_in_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.func_decl_in_type`.
     * @param ctx the parse tree
     */
    enterFunc_decl_in_type?: (ctx: Func_decl_in_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.func_decl_in_type`.
     * @param ctx the parse tree
     */
    exitFunc_decl_in_type?: (ctx: Func_decl_in_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constructor_declaration`.
     * @param ctx the parse tree
     */
    enterConstructor_declaration?: (ctx: Constructor_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constructor_declaration`.
     * @param ctx the parse tree
     */
    exitConstructor_declaration?: (ctx: Constructor_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modifier_clause`.
     * @param ctx the parse tree
     */
    enterModifier_clause?: (ctx: Modifier_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modifier_clause`.
     * @param ctx the parse tree
     */
    exitModifier_clause?: (ctx: Modifier_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_member_spec`.
     * @param ctx the parse tree
     */
    enterObject_member_spec?: (ctx: Object_member_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_member_spec`.
     * @param ctx the parse tree
     */
    exitObject_member_spec?: (ctx: Object_member_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sqlj_object_type_attr`.
     * @param ctx the parse tree
     */
    enterSqlj_object_type_attr?: (ctx: Sqlj_object_type_attrContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sqlj_object_type_attr`.
     * @param ctx the parse tree
     */
    exitSqlj_object_type_attr?: (ctx: Sqlj_object_type_attrContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.element_spec`.
     * @param ctx the parse tree
     */
    enterElement_spec?: (ctx: Element_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.element_spec`.
     * @param ctx the parse tree
     */
    exitElement_spec?: (ctx: Element_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.element_spec_options`.
     * @param ctx the parse tree
     */
    enterElement_spec_options?: (ctx: Element_spec_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.element_spec_options`.
     * @param ctx the parse tree
     */
    exitElement_spec_options?: (ctx: Element_spec_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subprogram_spec`.
     * @param ctx the parse tree
     */
    enterSubprogram_spec?: (ctx: Subprogram_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subprogram_spec`.
     * @param ctx the parse tree
     */
    exitSubprogram_spec?: (ctx: Subprogram_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.overriding_subprogram_spec`.
     * @param ctx the parse tree
     */
    enterOverriding_subprogram_spec?: (ctx: Overriding_subprogram_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.overriding_subprogram_spec`.
     * @param ctx the parse tree
     */
    exitOverriding_subprogram_spec?: (ctx: Overriding_subprogram_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.overriding_function_spec`.
     * @param ctx the parse tree
     */
    enterOverriding_function_spec?: (ctx: Overriding_function_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.overriding_function_spec`.
     * @param ctx the parse tree
     */
    exitOverriding_function_spec?: (ctx: Overriding_function_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.overriding_procedure_spec`.
     * @param ctx the parse tree
     */
    enterOverriding_procedure_spec?: (ctx: Overriding_procedure_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.overriding_procedure_spec`.
     * @param ctx the parse tree
     */
    exitOverriding_procedure_spec?: (ctx: Overriding_procedure_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_procedure_spec`.
     * @param ctx the parse tree
     */
    enterType_procedure_spec?: (ctx: Type_procedure_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_procedure_spec`.
     * @param ctx the parse tree
     */
    exitType_procedure_spec?: (ctx: Type_procedure_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_function_spec`.
     * @param ctx the parse tree
     */
    enterType_function_spec?: (ctx: Type_function_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_function_spec`.
     * @param ctx the parse tree
     */
    exitType_function_spec?: (ctx: Type_function_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constructor_spec`.
     * @param ctx the parse tree
     */
    enterConstructor_spec?: (ctx: Constructor_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constructor_spec`.
     * @param ctx the parse tree
     */
    exitConstructor_spec?: (ctx: Constructor_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.map_order_function_spec`.
     * @param ctx the parse tree
     */
    enterMap_order_function_spec?: (ctx: Map_order_function_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.map_order_function_spec`.
     * @param ctx the parse tree
     */
    exitMap_order_function_spec?: (ctx: Map_order_function_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pragma_clause`.
     * @param ctx the parse tree
     */
    enterPragma_clause?: (ctx: Pragma_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pragma_clause`.
     * @param ctx the parse tree
     */
    exitPragma_clause?: (ctx: Pragma_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pragma_elements`.
     * @param ctx the parse tree
     */
    enterPragma_elements?: (ctx: Pragma_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pragma_elements`.
     * @param ctx the parse tree
     */
    exitPragma_elements?: (ctx: Pragma_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_elements_parameter`.
     * @param ctx the parse tree
     */
    enterType_elements_parameter?: (ctx: Type_elements_parameterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_elements_parameter`.
     * @param ctx the parse tree
     */
    exitType_elements_parameter?: (ctx: Type_elements_parameterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_sequence`.
     * @param ctx the parse tree
     */
    enterDrop_sequence?: (ctx: Drop_sequenceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_sequence`.
     * @param ctx the parse tree
     */
    exitDrop_sequence?: (ctx: Drop_sequenceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_sequence`.
     * @param ctx the parse tree
     */
    enterAlter_sequence?: (ctx: Alter_sequenceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_sequence`.
     * @param ctx the parse tree
     */
    exitAlter_sequence?: (ctx: Alter_sequenceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_session`.
     * @param ctx the parse tree
     */
    enterAlter_session?: (ctx: Alter_sessionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_session`.
     * @param ctx the parse tree
     */
    exitAlter_session?: (ctx: Alter_sessionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_session_set_clause`.
     * @param ctx the parse tree
     */
    enterAlter_session_set_clause?: (ctx: Alter_session_set_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_session_set_clause`.
     * @param ctx the parse tree
     */
    exitAlter_session_set_clause?: (ctx: Alter_session_set_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_sequence`.
     * @param ctx the parse tree
     */
    enterCreate_sequence?: (ctx: Create_sequenceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_sequence`.
     * @param ctx the parse tree
     */
    exitCreate_sequence?: (ctx: Create_sequenceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sequence_spec`.
     * @param ctx the parse tree
     */
    enterSequence_spec?: (ctx: Sequence_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sequence_spec`.
     * @param ctx the parse tree
     */
    exitSequence_spec?: (ctx: Sequence_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sequence_start_clause`.
     * @param ctx the parse tree
     */
    enterSequence_start_clause?: (ctx: Sequence_start_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sequence_start_clause`.
     * @param ctx the parse tree
     */
    exitSequence_start_clause?: (ctx: Sequence_start_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_analytic_view`.
     * @param ctx the parse tree
     */
    enterCreate_analytic_view?: (ctx: Create_analytic_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_analytic_view`.
     * @param ctx the parse tree
     */
    exitCreate_analytic_view?: (ctx: Create_analytic_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.classification_clause`.
     * @param ctx the parse tree
     */
    enterClassification_clause?: (ctx: Classification_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.classification_clause`.
     * @param ctx the parse tree
     */
    exitClassification_clause?: (ctx: Classification_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.caption_clause`.
     * @param ctx the parse tree
     */
    enterCaption_clause?: (ctx: Caption_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.caption_clause`.
     * @param ctx the parse tree
     */
    exitCaption_clause?: (ctx: Caption_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.description_clause`.
     * @param ctx the parse tree
     */
    enterDescription_clause?: (ctx: Description_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.description_clause`.
     * @param ctx the parse tree
     */
    exitDescription_clause?: (ctx: Description_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.classification_item`.
     * @param ctx the parse tree
     */
    enterClassification_item?: (ctx: Classification_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.classification_item`.
     * @param ctx the parse tree
     */
    exitClassification_item?: (ctx: Classification_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.language`.
     * @param ctx the parse tree
     */
    enterLanguage?: (ctx: LanguageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.language`.
     * @param ctx the parse tree
     */
    exitLanguage?: (ctx: LanguageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cav_using_clause`.
     * @param ctx the parse tree
     */
    enterCav_using_clause?: (ctx: Cav_using_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cav_using_clause`.
     * @param ctx the parse tree
     */
    exitCav_using_clause?: (ctx: Cav_using_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dim_by_clause`.
     * @param ctx the parse tree
     */
    enterDim_by_clause?: (ctx: Dim_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dim_by_clause`.
     * @param ctx the parse tree
     */
    exitDim_by_clause?: (ctx: Dim_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dim_key`.
     * @param ctx the parse tree
     */
    enterDim_key?: (ctx: Dim_keyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dim_key`.
     * @param ctx the parse tree
     */
    exitDim_key?: (ctx: Dim_keyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dim_ref`.
     * @param ctx the parse tree
     */
    enterDim_ref?: (ctx: Dim_refContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dim_ref`.
     * @param ctx the parse tree
     */
    exitDim_ref?: (ctx: Dim_refContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hier_ref`.
     * @param ctx the parse tree
     */
    enterHier_ref?: (ctx: Hier_refContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hier_ref`.
     * @param ctx the parse tree
     */
    exitHier_ref?: (ctx: Hier_refContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.measures_clause`.
     * @param ctx the parse tree
     */
    enterMeasures_clause?: (ctx: Measures_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.measures_clause`.
     * @param ctx the parse tree
     */
    exitMeasures_clause?: (ctx: Measures_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.av_measure`.
     * @param ctx the parse tree
     */
    enterAv_measure?: (ctx: Av_measureContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.av_measure`.
     * @param ctx the parse tree
     */
    exitAv_measure?: (ctx: Av_measureContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.base_meas_clause`.
     * @param ctx the parse tree
     */
    enterBase_meas_clause?: (ctx: Base_meas_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.base_meas_clause`.
     * @param ctx the parse tree
     */
    exitBase_meas_clause?: (ctx: Base_meas_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.meas_aggregate_clause`.
     * @param ctx the parse tree
     */
    enterMeas_aggregate_clause?: (ctx: Meas_aggregate_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.meas_aggregate_clause`.
     * @param ctx the parse tree
     */
    exitMeas_aggregate_clause?: (ctx: Meas_aggregate_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.calc_meas_clause`.
     * @param ctx the parse tree
     */
    enterCalc_meas_clause?: (ctx: Calc_meas_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.calc_meas_clause`.
     * @param ctx the parse tree
     */
    exitCalc_meas_clause?: (ctx: Calc_meas_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_measure_clause`.
     * @param ctx the parse tree
     */
    enterDefault_measure_clause?: (ctx: Default_measure_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_measure_clause`.
     * @param ctx the parse tree
     */
    exitDefault_measure_clause?: (ctx: Default_measure_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_aggregate_clause`.
     * @param ctx the parse tree
     */
    enterDefault_aggregate_clause?: (ctx: Default_aggregate_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_aggregate_clause`.
     * @param ctx the parse tree
     */
    exitDefault_aggregate_clause?: (ctx: Default_aggregate_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cache_clause`.
     * @param ctx the parse tree
     */
    enterCache_clause?: (ctx: Cache_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cache_clause`.
     * @param ctx the parse tree
     */
    exitCache_clause?: (ctx: Cache_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cache_specification`.
     * @param ctx the parse tree
     */
    enterCache_specification?: (ctx: Cache_specificationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cache_specification`.
     * @param ctx the parse tree
     */
    exitCache_specification?: (ctx: Cache_specificationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.levels_clause`.
     * @param ctx the parse tree
     */
    enterLevels_clause?: (ctx: Levels_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.levels_clause`.
     * @param ctx the parse tree
     */
    exitLevels_clause?: (ctx: Levels_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.level_specification`.
     * @param ctx the parse tree
     */
    enterLevel_specification?: (ctx: Level_specificationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.level_specification`.
     * @param ctx the parse tree
     */
    exitLevel_specification?: (ctx: Level_specificationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.level_group_type`.
     * @param ctx the parse tree
     */
    enterLevel_group_type?: (ctx: Level_group_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.level_group_type`.
     * @param ctx the parse tree
     */
    exitLevel_group_type?: (ctx: Level_group_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.fact_columns_clause`.
     * @param ctx the parse tree
     */
    enterFact_columns_clause?: (ctx: Fact_columns_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.fact_columns_clause`.
     * @param ctx the parse tree
     */
    exitFact_columns_clause?: (ctx: Fact_columns_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.qry_transform_clause`.
     * @param ctx the parse tree
     */
    enterQry_transform_clause?: (ctx: Qry_transform_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.qry_transform_clause`.
     * @param ctx the parse tree
     */
    exitQry_transform_clause?: (ctx: Qry_transform_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_attribute_dimension`.
     * @param ctx the parse tree
     */
    enterCreate_attribute_dimension?: (ctx: Create_attribute_dimensionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_attribute_dimension`.
     * @param ctx the parse tree
     */
    exitCreate_attribute_dimension?: (ctx: Create_attribute_dimensionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ad_using_clause`.
     * @param ctx the parse tree
     */
    enterAd_using_clause?: (ctx: Ad_using_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ad_using_clause`.
     * @param ctx the parse tree
     */
    exitAd_using_clause?: (ctx: Ad_using_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.source_clause`.
     * @param ctx the parse tree
     */
    enterSource_clause?: (ctx: Source_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.source_clause`.
     * @param ctx the parse tree
     */
    exitSource_clause?: (ctx: Source_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_path_clause`.
     * @param ctx the parse tree
     */
    enterJoin_path_clause?: (ctx: Join_path_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_path_clause`.
     * @param ctx the parse tree
     */
    exitJoin_path_clause?: (ctx: Join_path_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_condition`.
     * @param ctx the parse tree
     */
    enterJoin_condition?: (ctx: Join_conditionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_condition`.
     * @param ctx the parse tree
     */
    exitJoin_condition?: (ctx: Join_conditionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_condition_item`.
     * @param ctx the parse tree
     */
    enterJoin_condition_item?: (ctx: Join_condition_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_condition_item`.
     * @param ctx the parse tree
     */
    exitJoin_condition_item?: (ctx: Join_condition_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.attributes_clause`.
     * @param ctx the parse tree
     */
    enterAttributes_clause?: (ctx: Attributes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.attributes_clause`.
     * @param ctx the parse tree
     */
    exitAttributes_clause?: (ctx: Attributes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ad_attributes_clause`.
     * @param ctx the parse tree
     */
    enterAd_attributes_clause?: (ctx: Ad_attributes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ad_attributes_clause`.
     * @param ctx the parse tree
     */
    exitAd_attributes_clause?: (ctx: Ad_attributes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ad_level_clause`.
     * @param ctx the parse tree
     */
    enterAd_level_clause?: (ctx: Ad_level_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ad_level_clause`.
     * @param ctx the parse tree
     */
    exitAd_level_clause?: (ctx: Ad_level_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.key_clause`.
     * @param ctx the parse tree
     */
    enterKey_clause?: (ctx: Key_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.key_clause`.
     * @param ctx the parse tree
     */
    exitKey_clause?: (ctx: Key_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alternate_key_clause`.
     * @param ctx the parse tree
     */
    enterAlternate_key_clause?: (ctx: Alternate_key_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alternate_key_clause`.
     * @param ctx the parse tree
     */
    exitAlternate_key_clause?: (ctx: Alternate_key_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dim_order_clause`.
     * @param ctx the parse tree
     */
    enterDim_order_clause?: (ctx: Dim_order_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dim_order_clause`.
     * @param ctx the parse tree
     */
    exitDim_order_clause?: (ctx: Dim_order_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.all_clause`.
     * @param ctx the parse tree
     */
    enterAll_clause?: (ctx: All_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.all_clause`.
     * @param ctx the parse tree
     */
    exitAll_clause?: (ctx: All_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_audit_policy`.
     * @param ctx the parse tree
     */
    enterCreate_audit_policy?: (ctx: Create_audit_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_audit_policy`.
     * @param ctx the parse tree
     */
    exitCreate_audit_policy?: (ctx: Create_audit_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.privilege_audit_clause`.
     * @param ctx the parse tree
     */
    enterPrivilege_audit_clause?: (ctx: Privilege_audit_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.privilege_audit_clause`.
     * @param ctx the parse tree
     */
    exitPrivilege_audit_clause?: (ctx: Privilege_audit_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.action_audit_clause`.
     * @param ctx the parse tree
     */
    enterAction_audit_clause?: (ctx: Action_audit_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.action_audit_clause`.
     * @param ctx the parse tree
     */
    exitAction_audit_clause?: (ctx: Action_audit_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.system_actions`.
     * @param ctx the parse tree
     */
    enterSystem_actions?: (ctx: System_actionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.system_actions`.
     * @param ctx the parse tree
     */
    exitSystem_actions?: (ctx: System_actionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.standard_actions`.
     * @param ctx the parse tree
     */
    enterStandard_actions?: (ctx: Standard_actionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.standard_actions`.
     * @param ctx the parse tree
     */
    exitStandard_actions?: (ctx: Standard_actionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.actions_clause`.
     * @param ctx the parse tree
     */
    enterActions_clause?: (ctx: Actions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.actions_clause`.
     * @param ctx the parse tree
     */
    exitActions_clause?: (ctx: Actions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_action`.
     * @param ctx the parse tree
     */
    enterObject_action?: (ctx: Object_actionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_action`.
     * @param ctx the parse tree
     */
    exitObject_action?: (ctx: Object_actionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.system_action`.
     * @param ctx the parse tree
     */
    enterSystem_action?: (ctx: System_actionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.system_action`.
     * @param ctx the parse tree
     */
    exitSystem_action?: (ctx: System_actionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.component_actions`.
     * @param ctx the parse tree
     */
    enterComponent_actions?: (ctx: Component_actionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.component_actions`.
     * @param ctx the parse tree
     */
    exitComponent_actions?: (ctx: Component_actionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.component_action`.
     * @param ctx the parse tree
     */
    enterComponent_action?: (ctx: Component_actionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.component_action`.
     * @param ctx the parse tree
     */
    exitComponent_action?: (ctx: Component_actionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.role_audit_clause`.
     * @param ctx the parse tree
     */
    enterRole_audit_clause?: (ctx: Role_audit_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.role_audit_clause`.
     * @param ctx the parse tree
     */
    exitRole_audit_clause?: (ctx: Role_audit_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_controlfile`.
     * @param ctx the parse tree
     */
    enterCreate_controlfile?: (ctx: Create_controlfileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_controlfile`.
     * @param ctx the parse tree
     */
    exitCreate_controlfile?: (ctx: Create_controlfileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.controlfile_options`.
     * @param ctx the parse tree
     */
    enterControlfile_options?: (ctx: Controlfile_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.controlfile_options`.
     * @param ctx the parse tree
     */
    exitControlfile_options?: (ctx: Controlfile_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logfile_clause`.
     * @param ctx the parse tree
     */
    enterLogfile_clause?: (ctx: Logfile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logfile_clause`.
     * @param ctx the parse tree
     */
    exitLogfile_clause?: (ctx: Logfile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.character_set_clause`.
     * @param ctx the parse tree
     */
    enterCharacter_set_clause?: (ctx: Character_set_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.character_set_clause`.
     * @param ctx the parse tree
     */
    exitCharacter_set_clause?: (ctx: Character_set_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.file_specification`.
     * @param ctx the parse tree
     */
    enterFile_specification?: (ctx: File_specificationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.file_specification`.
     * @param ctx the parse tree
     */
    exitFile_specification?: (ctx: File_specificationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_diskgroup`.
     * @param ctx the parse tree
     */
    enterCreate_diskgroup?: (ctx: Create_diskgroupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_diskgroup`.
     * @param ctx the parse tree
     */
    exitCreate_diskgroup?: (ctx: Create_diskgroupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.qualified_disk_clause`.
     * @param ctx the parse tree
     */
    enterQualified_disk_clause?: (ctx: Qualified_disk_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.qualified_disk_clause`.
     * @param ctx the parse tree
     */
    exitQualified_disk_clause?: (ctx: Qualified_disk_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_edition`.
     * @param ctx the parse tree
     */
    enterCreate_edition?: (ctx: Create_editionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_edition`.
     * @param ctx the parse tree
     */
    exitCreate_edition?: (ctx: Create_editionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_flashback_archive`.
     * @param ctx the parse tree
     */
    enterCreate_flashback_archive?: (ctx: Create_flashback_archiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_flashback_archive`.
     * @param ctx the parse tree
     */
    exitCreate_flashback_archive?: (ctx: Create_flashback_archiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_archive_quota`.
     * @param ctx the parse tree
     */
    enterFlashback_archive_quota?: (ctx: Flashback_archive_quotaContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_archive_quota`.
     * @param ctx the parse tree
     */
    exitFlashback_archive_quota?: (ctx: Flashback_archive_quotaContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_archive_retention`.
     * @param ctx the parse tree
     */
    enterFlashback_archive_retention?: (ctx: Flashback_archive_retentionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_archive_retention`.
     * @param ctx the parse tree
     */
    exitFlashback_archive_retention?: (ctx: Flashback_archive_retentionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_hierarchy`.
     * @param ctx the parse tree
     */
    enterCreate_hierarchy?: (ctx: Create_hierarchyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_hierarchy`.
     * @param ctx the parse tree
     */
    exitCreate_hierarchy?: (ctx: Create_hierarchyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hier_using_clause`.
     * @param ctx the parse tree
     */
    enterHier_using_clause?: (ctx: Hier_using_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hier_using_clause`.
     * @param ctx the parse tree
     */
    exitHier_using_clause?: (ctx: Hier_using_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.level_hier_clause`.
     * @param ctx the parse tree
     */
    enterLevel_hier_clause?: (ctx: Level_hier_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.level_hier_clause`.
     * @param ctx the parse tree
     */
    exitLevel_hier_clause?: (ctx: Level_hier_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hier_attrs_clause`.
     * @param ctx the parse tree
     */
    enterHier_attrs_clause?: (ctx: Hier_attrs_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hier_attrs_clause`.
     * @param ctx the parse tree
     */
    exitHier_attrs_clause?: (ctx: Hier_attrs_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hier_attr_clause`.
     * @param ctx the parse tree
     */
    enterHier_attr_clause?: (ctx: Hier_attr_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hier_attr_clause`.
     * @param ctx the parse tree
     */
    exitHier_attr_clause?: (ctx: Hier_attr_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hier_attr_name`.
     * @param ctx the parse tree
     */
    enterHier_attr_name?: (ctx: Hier_attr_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hier_attr_name`.
     * @param ctx the parse tree
     */
    exitHier_attr_name?: (ctx: Hier_attr_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_index`.
     * @param ctx the parse tree
     */
    enterCreate_index?: (ctx: Create_indexContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_index`.
     * @param ctx the parse tree
     */
    exitCreate_index?: (ctx: Create_indexContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cluster_index_clause`.
     * @param ctx the parse tree
     */
    enterCluster_index_clause?: (ctx: Cluster_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cluster_index_clause`.
     * @param ctx the parse tree
     */
    exitCluster_index_clause?: (ctx: Cluster_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cluster_name`.
     * @param ctx the parse tree
     */
    enterCluster_name?: (ctx: Cluster_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cluster_name`.
     * @param ctx the parse tree
     */
    exitCluster_name?: (ctx: Cluster_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_index_clause`.
     * @param ctx the parse tree
     */
    enterTable_index_clause?: (ctx: Table_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_index_clause`.
     * @param ctx the parse tree
     */
    exitTable_index_clause?: (ctx: Table_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.bitmap_join_index_clause`.
     * @param ctx the parse tree
     */
    enterBitmap_join_index_clause?: (ctx: Bitmap_join_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.bitmap_join_index_clause`.
     * @param ctx the parse tree
     */
    exitBitmap_join_index_clause?: (ctx: Bitmap_join_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_expr`.
     * @param ctx the parse tree
     */
    enterIndex_expr?: (ctx: Index_exprContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_expr`.
     * @param ctx the parse tree
     */
    exitIndex_expr?: (ctx: Index_exprContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_properties`.
     * @param ctx the parse tree
     */
    enterIndex_properties?: (ctx: Index_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_properties`.
     * @param ctx the parse tree
     */
    exitIndex_properties?: (ctx: Index_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.domain_index_clause`.
     * @param ctx the parse tree
     */
    enterDomain_index_clause?: (ctx: Domain_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.domain_index_clause`.
     * @param ctx the parse tree
     */
    exitDomain_index_clause?: (ctx: Domain_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.local_domain_index_clause`.
     * @param ctx the parse tree
     */
    enterLocal_domain_index_clause?: (ctx: Local_domain_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.local_domain_index_clause`.
     * @param ctx the parse tree
     */
    exitLocal_domain_index_clause?: (ctx: Local_domain_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlindex_clause`.
     * @param ctx the parse tree
     */
    enterXmlindex_clause?: (ctx: Xmlindex_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlindex_clause`.
     * @param ctx the parse tree
     */
    exitXmlindex_clause?: (ctx: Xmlindex_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.local_xmlindex_clause`.
     * @param ctx the parse tree
     */
    enterLocal_xmlindex_clause?: (ctx: Local_xmlindex_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.local_xmlindex_clause`.
     * @param ctx the parse tree
     */
    exitLocal_xmlindex_clause?: (ctx: Local_xmlindex_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.global_partitioned_index`.
     * @param ctx the parse tree
     */
    enterGlobal_partitioned_index?: (ctx: Global_partitioned_indexContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.global_partitioned_index`.
     * @param ctx the parse tree
     */
    exitGlobal_partitioned_index?: (ctx: Global_partitioned_indexContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_partitioning_clause`.
     * @param ctx the parse tree
     */
    enterIndex_partitioning_clause?: (ctx: Index_partitioning_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_partitioning_clause`.
     * @param ctx the parse tree
     */
    exitIndex_partitioning_clause?: (ctx: Index_partitioning_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_partitioning_values_list`.
     * @param ctx the parse tree
     */
    enterIndex_partitioning_values_list?: (ctx: Index_partitioning_values_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_partitioning_values_list`.
     * @param ctx the parse tree
     */
    exitIndex_partitioning_values_list?: (ctx: Index_partitioning_values_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.local_partitioned_index`.
     * @param ctx the parse tree
     */
    enterLocal_partitioned_index?: (ctx: Local_partitioned_indexContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.local_partitioned_index`.
     * @param ctx the parse tree
     */
    exitLocal_partitioned_index?: (ctx: Local_partitioned_indexContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_range_partitioned_table`.
     * @param ctx the parse tree
     */
    enterOn_range_partitioned_table?: (ctx: On_range_partitioned_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_range_partitioned_table`.
     * @param ctx the parse tree
     */
    exitOn_range_partitioned_table?: (ctx: On_range_partitioned_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_list_partitioned_table`.
     * @param ctx the parse tree
     */
    enterOn_list_partitioned_table?: (ctx: On_list_partitioned_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_list_partitioned_table`.
     * @param ctx the parse tree
     */
    exitOn_list_partitioned_table?: (ctx: On_list_partitioned_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partitioned_table`.
     * @param ctx the parse tree
     */
    enterPartitioned_table?: (ctx: Partitioned_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partitioned_table`.
     * @param ctx the parse tree
     */
    exitPartitioned_table?: (ctx: Partitioned_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_hash_partitioned_table`.
     * @param ctx the parse tree
     */
    enterOn_hash_partitioned_table?: (ctx: On_hash_partitioned_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_hash_partitioned_table`.
     * @param ctx the parse tree
     */
    exitOn_hash_partitioned_table?: (ctx: On_hash_partitioned_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_hash_partitioned_clause`.
     * @param ctx the parse tree
     */
    enterOn_hash_partitioned_clause?: (ctx: On_hash_partitioned_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_hash_partitioned_clause`.
     * @param ctx the parse tree
     */
    exitOn_hash_partitioned_clause?: (ctx: On_hash_partitioned_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_comp_partitioned_table`.
     * @param ctx the parse tree
     */
    enterOn_comp_partitioned_table?: (ctx: On_comp_partitioned_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_comp_partitioned_table`.
     * @param ctx the parse tree
     */
    exitOn_comp_partitioned_table?: (ctx: On_comp_partitioned_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_comp_partitioned_clause`.
     * @param ctx the parse tree
     */
    enterOn_comp_partitioned_clause?: (ctx: On_comp_partitioned_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_comp_partitioned_clause`.
     * @param ctx the parse tree
     */
    exitOn_comp_partitioned_clause?: (ctx: On_comp_partitioned_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_subpartition_clause`.
     * @param ctx the parse tree
     */
    enterIndex_subpartition_clause?: (ctx: Index_subpartition_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_subpartition_clause`.
     * @param ctx the parse tree
     */
    exitIndex_subpartition_clause?: (ctx: Index_subpartition_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_subpartition_subclause`.
     * @param ctx the parse tree
     */
    enterIndex_subpartition_subclause?: (ctx: Index_subpartition_subclauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_subpartition_subclause`.
     * @param ctx the parse tree
     */
    exitIndex_subpartition_subclause?: (ctx: Index_subpartition_subclauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.odci_parameters`.
     * @param ctx the parse tree
     */
    enterOdci_parameters?: (ctx: Odci_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.odci_parameters`.
     * @param ctx the parse tree
     */
    exitOdci_parameters?: (ctx: Odci_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.indextype`.
     * @param ctx the parse tree
     */
    enterIndextype?: (ctx: IndextypeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.indextype`.
     * @param ctx the parse tree
     */
    exitIndextype?: (ctx: IndextypeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_index`.
     * @param ctx the parse tree
     */
    enterAlter_index?: (ctx: Alter_indexContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_index`.
     * @param ctx the parse tree
     */
    exitAlter_index?: (ctx: Alter_indexContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_index_ops_set1`.
     * @param ctx the parse tree
     */
    enterAlter_index_ops_set1?: (ctx: Alter_index_ops_set1Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_index_ops_set1`.
     * @param ctx the parse tree
     */
    exitAlter_index_ops_set1?: (ctx: Alter_index_ops_set1Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_index_ops_set2`.
     * @param ctx the parse tree
     */
    enterAlter_index_ops_set2?: (ctx: Alter_index_ops_set2Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_index_ops_set2`.
     * @param ctx the parse tree
     */
    exitAlter_index_ops_set2?: (ctx: Alter_index_ops_set2Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.visible_or_invisible`.
     * @param ctx the parse tree
     */
    enterVisible_or_invisible?: (ctx: Visible_or_invisibleContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.visible_or_invisible`.
     * @param ctx the parse tree
     */
    exitVisible_or_invisible?: (ctx: Visible_or_invisibleContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.monitoring_nomonitoring`.
     * @param ctx the parse tree
     */
    enterMonitoring_nomonitoring?: (ctx: Monitoring_nomonitoringContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.monitoring_nomonitoring`.
     * @param ctx the parse tree
     */
    exitMonitoring_nomonitoring?: (ctx: Monitoring_nomonitoringContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rebuild_clause`.
     * @param ctx the parse tree
     */
    enterRebuild_clause?: (ctx: Rebuild_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rebuild_clause`.
     * @param ctx the parse tree
     */
    exitRebuild_clause?: (ctx: Rebuild_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_index_partitioning`.
     * @param ctx the parse tree
     */
    enterAlter_index_partitioning?: (ctx: Alter_index_partitioningContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_index_partitioning`.
     * @param ctx the parse tree
     */
    exitAlter_index_partitioning?: (ctx: Alter_index_partitioningContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_index_default_attrs`.
     * @param ctx the parse tree
     */
    enterModify_index_default_attrs?: (ctx: Modify_index_default_attrsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_index_default_attrs`.
     * @param ctx the parse tree
     */
    exitModify_index_default_attrs?: (ctx: Modify_index_default_attrsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_hash_index_partition`.
     * @param ctx the parse tree
     */
    enterAdd_hash_index_partition?: (ctx: Add_hash_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_hash_index_partition`.
     * @param ctx the parse tree
     */
    exitAdd_hash_index_partition?: (ctx: Add_hash_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.coalesce_index_partition`.
     * @param ctx the parse tree
     */
    enterCoalesce_index_partition?: (ctx: Coalesce_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.coalesce_index_partition`.
     * @param ctx the parse tree
     */
    exitCoalesce_index_partition?: (ctx: Coalesce_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_index_partition`.
     * @param ctx the parse tree
     */
    enterModify_index_partition?: (ctx: Modify_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_index_partition`.
     * @param ctx the parse tree
     */
    exitModify_index_partition?: (ctx: Modify_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_index_partitions_ops`.
     * @param ctx the parse tree
     */
    enterModify_index_partitions_ops?: (ctx: Modify_index_partitions_opsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_index_partitions_ops`.
     * @param ctx the parse tree
     */
    exitModify_index_partitions_ops?: (ctx: Modify_index_partitions_opsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rename_index_partition`.
     * @param ctx the parse tree
     */
    enterRename_index_partition?: (ctx: Rename_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rename_index_partition`.
     * @param ctx the parse tree
     */
    exitRename_index_partition?: (ctx: Rename_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_index_partition`.
     * @param ctx the parse tree
     */
    enterDrop_index_partition?: (ctx: Drop_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_index_partition`.
     * @param ctx the parse tree
     */
    exitDrop_index_partition?: (ctx: Drop_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.split_index_partition`.
     * @param ctx the parse tree
     */
    enterSplit_index_partition?: (ctx: Split_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.split_index_partition`.
     * @param ctx the parse tree
     */
    exitSplit_index_partition?: (ctx: Split_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_partition_description`.
     * @param ctx the parse tree
     */
    enterIndex_partition_description?: (ctx: Index_partition_descriptionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_partition_description`.
     * @param ctx the parse tree
     */
    exitIndex_partition_description?: (ctx: Index_partition_descriptionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_index_subpartition`.
     * @param ctx the parse tree
     */
    enterModify_index_subpartition?: (ctx: Modify_index_subpartitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_index_subpartition`.
     * @param ctx the parse tree
     */
    exitModify_index_subpartition?: (ctx: Modify_index_subpartitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_name_old`.
     * @param ctx the parse tree
     */
    enterPartition_name_old?: (ctx: Partition_name_oldContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_name_old`.
     * @param ctx the parse tree
     */
    exitPartition_name_old?: (ctx: Partition_name_oldContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_partition_name`.
     * @param ctx the parse tree
     */
    enterNew_partition_name?: (ctx: New_partition_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_partition_name`.
     * @param ctx the parse tree
     */
    exitNew_partition_name?: (ctx: New_partition_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_index_name`.
     * @param ctx the parse tree
     */
    enterNew_index_name?: (ctx: New_index_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_index_name`.
     * @param ctx the parse tree
     */
    exitNew_index_name?: (ctx: New_index_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_inmemory_join_group`.
     * @param ctx the parse tree
     */
    enterAlter_inmemory_join_group?: (ctx: Alter_inmemory_join_groupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_inmemory_join_group`.
     * @param ctx the parse tree
     */
    exitAlter_inmemory_join_group?: (ctx: Alter_inmemory_join_groupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_user`.
     * @param ctx the parse tree
     */
    enterCreate_user?: (ctx: Create_userContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_user`.
     * @param ctx the parse tree
     */
    exitCreate_user?: (ctx: Create_userContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_user`.
     * @param ctx the parse tree
     */
    enterAlter_user?: (ctx: Alter_userContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_user`.
     * @param ctx the parse tree
     */
    exitAlter_user?: (ctx: Alter_userContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_user`.
     * @param ctx the parse tree
     */
    enterDrop_user?: (ctx: Drop_userContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_user`.
     * @param ctx the parse tree
     */
    exitDrop_user?: (ctx: Drop_userContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_identified_by`.
     * @param ctx the parse tree
     */
    enterAlter_identified_by?: (ctx: Alter_identified_byContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_identified_by`.
     * @param ctx the parse tree
     */
    exitAlter_identified_by?: (ctx: Alter_identified_byContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identified_by`.
     * @param ctx the parse tree
     */
    enterIdentified_by?: (ctx: Identified_byContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identified_by`.
     * @param ctx the parse tree
     */
    exitIdentified_by?: (ctx: Identified_byContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identified_other_clause`.
     * @param ctx the parse tree
     */
    enterIdentified_other_clause?: (ctx: Identified_other_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identified_other_clause`.
     * @param ctx the parse tree
     */
    exitIdentified_other_clause?: (ctx: Identified_other_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_tablespace_clause`.
     * @param ctx the parse tree
     */
    enterUser_tablespace_clause?: (ctx: User_tablespace_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_tablespace_clause`.
     * @param ctx the parse tree
     */
    exitUser_tablespace_clause?: (ctx: User_tablespace_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.quota_clause`.
     * @param ctx the parse tree
     */
    enterQuota_clause?: (ctx: Quota_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.quota_clause`.
     * @param ctx the parse tree
     */
    exitQuota_clause?: (ctx: Quota_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.profile_clause`.
     * @param ctx the parse tree
     */
    enterProfile_clause?: (ctx: Profile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.profile_clause`.
     * @param ctx the parse tree
     */
    exitProfile_clause?: (ctx: Profile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.role_clause`.
     * @param ctx the parse tree
     */
    enterRole_clause?: (ctx: Role_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.role_clause`.
     * @param ctx the parse tree
     */
    exitRole_clause?: (ctx: Role_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_default_role_clause`.
     * @param ctx the parse tree
     */
    enterUser_default_role_clause?: (ctx: User_default_role_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_default_role_clause`.
     * @param ctx the parse tree
     */
    exitUser_default_role_clause?: (ctx: User_default_role_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.password_expire_clause`.
     * @param ctx the parse tree
     */
    enterPassword_expire_clause?: (ctx: Password_expire_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.password_expire_clause`.
     * @param ctx the parse tree
     */
    exitPassword_expire_clause?: (ctx: Password_expire_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_lock_clause`.
     * @param ctx the parse tree
     */
    enterUser_lock_clause?: (ctx: User_lock_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_lock_clause`.
     * @param ctx the parse tree
     */
    exitUser_lock_clause?: (ctx: User_lock_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_editions_clause`.
     * @param ctx the parse tree
     */
    enterUser_editions_clause?: (ctx: User_editions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_editions_clause`.
     * @param ctx the parse tree
     */
    exitUser_editions_clause?: (ctx: User_editions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_user_editions_clause`.
     * @param ctx the parse tree
     */
    enterAlter_user_editions_clause?: (ctx: Alter_user_editions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_user_editions_clause`.
     * @param ctx the parse tree
     */
    exitAlter_user_editions_clause?: (ctx: Alter_user_editions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.proxy_clause`.
     * @param ctx the parse tree
     */
    enterProxy_clause?: (ctx: Proxy_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.proxy_clause`.
     * @param ctx the parse tree
     */
    exitProxy_clause?: (ctx: Proxy_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.container_names`.
     * @param ctx the parse tree
     */
    enterContainer_names?: (ctx: Container_namesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.container_names`.
     * @param ctx the parse tree
     */
    exitContainer_names?: (ctx: Container_namesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_container_data`.
     * @param ctx the parse tree
     */
    enterSet_container_data?: (ctx: Set_container_dataContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_container_data`.
     * @param ctx the parse tree
     */
    exitSet_container_data?: (ctx: Set_container_dataContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_rem_container_data`.
     * @param ctx the parse tree
     */
    enterAdd_rem_container_data?: (ctx: Add_rem_container_dataContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_rem_container_data`.
     * @param ctx the parse tree
     */
    exitAdd_rem_container_data?: (ctx: Add_rem_container_dataContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.container_data_clause`.
     * @param ctx the parse tree
     */
    enterContainer_data_clause?: (ctx: Container_data_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.container_data_clause`.
     * @param ctx the parse tree
     */
    exitContainer_data_clause?: (ctx: Container_data_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.administer_key_management`.
     * @param ctx the parse tree
     */
    enterAdminister_key_management?: (ctx: Administer_key_managementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.administer_key_management`.
     * @param ctx the parse tree
     */
    exitAdminister_key_management?: (ctx: Administer_key_managementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.keystore_management_clauses`.
     * @param ctx the parse tree
     */
    enterKeystore_management_clauses?: (ctx: Keystore_management_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.keystore_management_clauses`.
     * @param ctx the parse tree
     */
    exitKeystore_management_clauses?: (ctx: Keystore_management_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_keystore`.
     * @param ctx the parse tree
     */
    enterCreate_keystore?: (ctx: Create_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_keystore`.
     * @param ctx the parse tree
     */
    exitCreate_keystore?: (ctx: Create_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.open_keystore`.
     * @param ctx the parse tree
     */
    enterOpen_keystore?: (ctx: Open_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.open_keystore`.
     * @param ctx the parse tree
     */
    exitOpen_keystore?: (ctx: Open_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.force_keystore`.
     * @param ctx the parse tree
     */
    enterForce_keystore?: (ctx: Force_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.force_keystore`.
     * @param ctx the parse tree
     */
    exitForce_keystore?: (ctx: Force_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.close_keystore`.
     * @param ctx the parse tree
     */
    enterClose_keystore?: (ctx: Close_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.close_keystore`.
     * @param ctx the parse tree
     */
    exitClose_keystore?: (ctx: Close_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.backup_keystore`.
     * @param ctx the parse tree
     */
    enterBackup_keystore?: (ctx: Backup_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.backup_keystore`.
     * @param ctx the parse tree
     */
    exitBackup_keystore?: (ctx: Backup_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_keystore_password`.
     * @param ctx the parse tree
     */
    enterAlter_keystore_password?: (ctx: Alter_keystore_passwordContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_keystore_password`.
     * @param ctx the parse tree
     */
    exitAlter_keystore_password?: (ctx: Alter_keystore_passwordContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_into_new_keystore`.
     * @param ctx the parse tree
     */
    enterMerge_into_new_keystore?: (ctx: Merge_into_new_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_into_new_keystore`.
     * @param ctx the parse tree
     */
    exitMerge_into_new_keystore?: (ctx: Merge_into_new_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_into_existing_keystore`.
     * @param ctx the parse tree
     */
    enterMerge_into_existing_keystore?: (ctx: Merge_into_existing_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_into_existing_keystore`.
     * @param ctx the parse tree
     */
    exitMerge_into_existing_keystore?: (ctx: Merge_into_existing_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.isolate_keystore`.
     * @param ctx the parse tree
     */
    enterIsolate_keystore?: (ctx: Isolate_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.isolate_keystore`.
     * @param ctx the parse tree
     */
    exitIsolate_keystore?: (ctx: Isolate_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unite_keystore`.
     * @param ctx the parse tree
     */
    enterUnite_keystore?: (ctx: Unite_keystoreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unite_keystore`.
     * @param ctx the parse tree
     */
    exitUnite_keystore?: (ctx: Unite_keystoreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.key_management_clauses`.
     * @param ctx the parse tree
     */
    enterKey_management_clauses?: (ctx: Key_management_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.key_management_clauses`.
     * @param ctx the parse tree
     */
    exitKey_management_clauses?: (ctx: Key_management_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_key`.
     * @param ctx the parse tree
     */
    enterSet_key?: (ctx: Set_keyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_key`.
     * @param ctx the parse tree
     */
    exitSet_key?: (ctx: Set_keyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_key`.
     * @param ctx the parse tree
     */
    enterCreate_key?: (ctx: Create_keyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_key`.
     * @param ctx the parse tree
     */
    exitCreate_key?: (ctx: Create_keyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mkid`.
     * @param ctx the parse tree
     */
    enterMkid?: (ctx: MkidContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mkid`.
     * @param ctx the parse tree
     */
    exitMkid?: (ctx: MkidContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mk`.
     * @param ctx the parse tree
     */
    enterMk?: (ctx: MkContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mk`.
     * @param ctx the parse tree
     */
    exitMk?: (ctx: MkContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.use_key`.
     * @param ctx the parse tree
     */
    enterUse_key?: (ctx: Use_keyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.use_key`.
     * @param ctx the parse tree
     */
    exitUse_key?: (ctx: Use_keyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_key_tag`.
     * @param ctx the parse tree
     */
    enterSet_key_tag?: (ctx: Set_key_tagContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_key_tag`.
     * @param ctx the parse tree
     */
    exitSet_key_tag?: (ctx: Set_key_tagContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.export_keys`.
     * @param ctx the parse tree
     */
    enterExport_keys?: (ctx: Export_keysContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.export_keys`.
     * @param ctx the parse tree
     */
    exitExport_keys?: (ctx: Export_keysContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.import_keys`.
     * @param ctx the parse tree
     */
    enterImport_keys?: (ctx: Import_keysContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.import_keys`.
     * @param ctx the parse tree
     */
    exitImport_keys?: (ctx: Import_keysContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.migrate_keys`.
     * @param ctx the parse tree
     */
    enterMigrate_keys?: (ctx: Migrate_keysContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.migrate_keys`.
     * @param ctx the parse tree
     */
    exitMigrate_keys?: (ctx: Migrate_keysContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.reverse_migrate_keys`.
     * @param ctx the parse tree
     */
    enterReverse_migrate_keys?: (ctx: Reverse_migrate_keysContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.reverse_migrate_keys`.
     * @param ctx the parse tree
     */
    exitReverse_migrate_keys?: (ctx: Reverse_migrate_keysContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_keys`.
     * @param ctx the parse tree
     */
    enterMove_keys?: (ctx: Move_keysContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_keys`.
     * @param ctx the parse tree
     */
    exitMove_keys?: (ctx: Move_keysContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identified_by_store`.
     * @param ctx the parse tree
     */
    enterIdentified_by_store?: (ctx: Identified_by_storeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identified_by_store`.
     * @param ctx the parse tree
     */
    exitIdentified_by_store?: (ctx: Identified_by_storeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_algorithm_clause`.
     * @param ctx the parse tree
     */
    enterUsing_algorithm_clause?: (ctx: Using_algorithm_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_algorithm_clause`.
     * @param ctx the parse tree
     */
    exitUsing_algorithm_clause?: (ctx: Using_algorithm_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_tag_clause`.
     * @param ctx the parse tree
     */
    enterUsing_tag_clause?: (ctx: Using_tag_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_tag_clause`.
     * @param ctx the parse tree
     */
    exitUsing_tag_clause?: (ctx: Using_tag_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.secret_management_clauses`.
     * @param ctx the parse tree
     */
    enterSecret_management_clauses?: (ctx: Secret_management_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.secret_management_clauses`.
     * @param ctx the parse tree
     */
    exitSecret_management_clauses?: (ctx: Secret_management_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_update_secret`.
     * @param ctx the parse tree
     */
    enterAdd_update_secret?: (ctx: Add_update_secretContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_update_secret`.
     * @param ctx the parse tree
     */
    exitAdd_update_secret?: (ctx: Add_update_secretContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.delete_secret`.
     * @param ctx the parse tree
     */
    enterDelete_secret?: (ctx: Delete_secretContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.delete_secret`.
     * @param ctx the parse tree
     */
    exitDelete_secret?: (ctx: Delete_secretContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_update_secret_seps`.
     * @param ctx the parse tree
     */
    enterAdd_update_secret_seps?: (ctx: Add_update_secret_sepsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_update_secret_seps`.
     * @param ctx the parse tree
     */
    exitAdd_update_secret_seps?: (ctx: Add_update_secret_sepsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.delete_secret_seps`.
     * @param ctx the parse tree
     */
    enterDelete_secret_seps?: (ctx: Delete_secret_sepsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.delete_secret_seps`.
     * @param ctx the parse tree
     */
    exitDelete_secret_seps?: (ctx: Delete_secret_sepsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.zero_downtime_software_patching_clauses`.
     * @param ctx the parse tree
     */
    enterZero_downtime_software_patching_clauses?: (ctx: Zero_downtime_software_patching_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.zero_downtime_software_patching_clauses`.
     * @param ctx the parse tree
     */
    exitZero_downtime_software_patching_clauses?: (ctx: Zero_downtime_software_patching_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.with_backup_clause`.
     * @param ctx the parse tree
     */
    enterWith_backup_clause?: (ctx: With_backup_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.with_backup_clause`.
     * @param ctx the parse tree
     */
    exitWith_backup_clause?: (ctx: With_backup_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identified_by_password_clause`.
     * @param ctx the parse tree
     */
    enterIdentified_by_password_clause?: (ctx: Identified_by_password_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identified_by_password_clause`.
     * @param ctx the parse tree
     */
    exitIdentified_by_password_clause?: (ctx: Identified_by_password_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.keystore_password`.
     * @param ctx the parse tree
     */
    enterKeystore_password?: (ctx: Keystore_passwordContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.keystore_password`.
     * @param ctx the parse tree
     */
    exitKeystore_password?: (ctx: Keystore_passwordContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.path`.
     * @param ctx the parse tree
     */
    enterPath?: (ctx: PathContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.path`.
     * @param ctx the parse tree
     */
    exitPath?: (ctx: PathContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.secret`.
     * @param ctx the parse tree
     */
    enterSecret?: (ctx: SecretContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.secret`.
     * @param ctx the parse tree
     */
    exitSecret?: (ctx: SecretContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.analyze`.
     * @param ctx the parse tree
     */
    enterAnalyze?: (ctx: AnalyzeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.analyze`.
     * @param ctx the parse tree
     */
    exitAnalyze?: (ctx: AnalyzeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_extention_clause`.
     * @param ctx the parse tree
     */
    enterPartition_extention_clause?: (ctx: Partition_extention_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_extention_clause`.
     * @param ctx the parse tree
     */
    exitPartition_extention_clause?: (ctx: Partition_extention_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.validation_clauses`.
     * @param ctx the parse tree
     */
    enterValidation_clauses?: (ctx: Validation_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.validation_clauses`.
     * @param ctx the parse tree
     */
    exitValidation_clauses?: (ctx: Validation_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compute_clauses`.
     * @param ctx the parse tree
     */
    enterCompute_clauses?: (ctx: Compute_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compute_clauses`.
     * @param ctx the parse tree
     */
    exitCompute_clauses?: (ctx: Compute_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.for_clause`.
     * @param ctx the parse tree
     */
    enterFor_clause?: (ctx: For_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.for_clause`.
     * @param ctx the parse tree
     */
    exitFor_clause?: (ctx: For_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.online_or_offline`.
     * @param ctx the parse tree
     */
    enterOnline_or_offline?: (ctx: Online_or_offlineContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.online_or_offline`.
     * @param ctx the parse tree
     */
    exitOnline_or_offline?: (ctx: Online_or_offlineContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.into_clause1`.
     * @param ctx the parse tree
     */
    enterInto_clause1?: (ctx: Into_clause1Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.into_clause1`.
     * @param ctx the parse tree
     */
    exitInto_clause1?: (ctx: Into_clause1Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_key_value`.
     * @param ctx the parse tree
     */
    enterPartition_key_value?: (ctx: Partition_key_valueContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_key_value`.
     * @param ctx the parse tree
     */
    exitPartition_key_value?: (ctx: Partition_key_valueContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_key_value`.
     * @param ctx the parse tree
     */
    enterSubpartition_key_value?: (ctx: Subpartition_key_valueContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_key_value`.
     * @param ctx the parse tree
     */
    exitSubpartition_key_value?: (ctx: Subpartition_key_valueContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.associate_statistics`.
     * @param ctx the parse tree
     */
    enterAssociate_statistics?: (ctx: Associate_statisticsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.associate_statistics`.
     * @param ctx the parse tree
     */
    exitAssociate_statistics?: (ctx: Associate_statisticsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_association`.
     * @param ctx the parse tree
     */
    enterColumn_association?: (ctx: Column_associationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_association`.
     * @param ctx the parse tree
     */
    exitColumn_association?: (ctx: Column_associationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_association`.
     * @param ctx the parse tree
     */
    enterFunction_association?: (ctx: Function_associationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_association`.
     * @param ctx the parse tree
     */
    exitFunction_association?: (ctx: Function_associationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.indextype_name`.
     * @param ctx the parse tree
     */
    enterIndextype_name?: (ctx: Indextype_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.indextype_name`.
     * @param ctx the parse tree
     */
    exitIndextype_name?: (ctx: Indextype_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_statistics_type`.
     * @param ctx the parse tree
     */
    enterUsing_statistics_type?: (ctx: Using_statistics_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_statistics_type`.
     * @param ctx the parse tree
     */
    exitUsing_statistics_type?: (ctx: Using_statistics_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.statistics_type_name`.
     * @param ctx the parse tree
     */
    enterStatistics_type_name?: (ctx: Statistics_type_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.statistics_type_name`.
     * @param ctx the parse tree
     */
    exitStatistics_type_name?: (ctx: Statistics_type_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_cost_clause`.
     * @param ctx the parse tree
     */
    enterDefault_cost_clause?: (ctx: Default_cost_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_cost_clause`.
     * @param ctx the parse tree
     */
    exitDefault_cost_clause?: (ctx: Default_cost_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cpu_cost`.
     * @param ctx the parse tree
     */
    enterCpu_cost?: (ctx: Cpu_costContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cpu_cost`.
     * @param ctx the parse tree
     */
    exitCpu_cost?: (ctx: Cpu_costContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.io_cost`.
     * @param ctx the parse tree
     */
    enterIo_cost?: (ctx: Io_costContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.io_cost`.
     * @param ctx the parse tree
     */
    exitIo_cost?: (ctx: Io_costContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.network_cost`.
     * @param ctx the parse tree
     */
    enterNetwork_cost?: (ctx: Network_costContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.network_cost`.
     * @param ctx the parse tree
     */
    exitNetwork_cost?: (ctx: Network_costContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_selectivity_clause`.
     * @param ctx the parse tree
     */
    enterDefault_selectivity_clause?: (ctx: Default_selectivity_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_selectivity_clause`.
     * @param ctx the parse tree
     */
    exitDefault_selectivity_clause?: (ctx: Default_selectivity_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_selectivity`.
     * @param ctx the parse tree
     */
    enterDefault_selectivity?: (ctx: Default_selectivityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_selectivity`.
     * @param ctx the parse tree
     */
    exitDefault_selectivity?: (ctx: Default_selectivityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.storage_table_clause`.
     * @param ctx the parse tree
     */
    enterStorage_table_clause?: (ctx: Storage_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.storage_table_clause`.
     * @param ctx the parse tree
     */
    exitStorage_table_clause?: (ctx: Storage_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unified_auditing`.
     * @param ctx the parse tree
     */
    enterUnified_auditing?: (ctx: Unified_auditingContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unified_auditing`.
     * @param ctx the parse tree
     */
    exitUnified_auditing?: (ctx: Unified_auditingContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.policy_name`.
     * @param ctx the parse tree
     */
    enterPolicy_name?: (ctx: Policy_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.policy_name`.
     * @param ctx the parse tree
     */
    exitPolicy_name?: (ctx: Policy_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_traditional`.
     * @param ctx the parse tree
     */
    enterAudit_traditional?: (ctx: Audit_traditionalContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_traditional`.
     * @param ctx the parse tree
     */
    exitAudit_traditional?: (ctx: Audit_traditionalContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_direct_path`.
     * @param ctx the parse tree
     */
    enterAudit_direct_path?: (ctx: Audit_direct_pathContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_direct_path`.
     * @param ctx the parse tree
     */
    exitAudit_direct_path?: (ctx: Audit_direct_pathContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_container_clause`.
     * @param ctx the parse tree
     */
    enterAudit_container_clause?: (ctx: Audit_container_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_container_clause`.
     * @param ctx the parse tree
     */
    exitAudit_container_clause?: (ctx: Audit_container_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_operation_clause`.
     * @param ctx the parse tree
     */
    enterAudit_operation_clause?: (ctx: Audit_operation_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_operation_clause`.
     * @param ctx the parse tree
     */
    exitAudit_operation_clause?: (ctx: Audit_operation_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.auditing_by_clause`.
     * @param ctx the parse tree
     */
    enterAuditing_by_clause?: (ctx: Auditing_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.auditing_by_clause`.
     * @param ctx the parse tree
     */
    exitAuditing_by_clause?: (ctx: Auditing_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_user`.
     * @param ctx the parse tree
     */
    enterAudit_user?: (ctx: Audit_userContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_user`.
     * @param ctx the parse tree
     */
    exitAudit_user?: (ctx: Audit_userContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.audit_schema_object_clause`.
     * @param ctx the parse tree
     */
    enterAudit_schema_object_clause?: (ctx: Audit_schema_object_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.audit_schema_object_clause`.
     * @param ctx the parse tree
     */
    exitAudit_schema_object_clause?: (ctx: Audit_schema_object_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_operation`.
     * @param ctx the parse tree
     */
    enterSql_operation?: (ctx: Sql_operationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_operation`.
     * @param ctx the parse tree
     */
    exitSql_operation?: (ctx: Sql_operationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.auditing_on_clause`.
     * @param ctx the parse tree
     */
    enterAuditing_on_clause?: (ctx: Auditing_on_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.auditing_on_clause`.
     * @param ctx the parse tree
     */
    exitAuditing_on_clause?: (ctx: Auditing_on_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_name`.
     * @param ctx the parse tree
     */
    enterModel_name?: (ctx: Model_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_name`.
     * @param ctx the parse tree
     */
    exitModel_name?: (ctx: Model_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_name`.
     * @param ctx the parse tree
     */
    enterObject_name?: (ctx: Object_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_name`.
     * @param ctx the parse tree
     */
    exitObject_name?: (ctx: Object_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.profile_name`.
     * @param ctx the parse tree
     */
    enterProfile_name?: (ctx: Profile_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.profile_name`.
     * @param ctx the parse tree
     */
    exitProfile_name?: (ctx: Profile_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_statement_shortcut`.
     * @param ctx the parse tree
     */
    enterSql_statement_shortcut?: (ctx: Sql_statement_shortcutContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_statement_shortcut`.
     * @param ctx the parse tree
     */
    exitSql_statement_shortcut?: (ctx: Sql_statement_shortcutContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_index`.
     * @param ctx the parse tree
     */
    enterDrop_index?: (ctx: Drop_indexContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_index`.
     * @param ctx the parse tree
     */
    exitDrop_index?: (ctx: Drop_indexContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.disassociate_statistics`.
     * @param ctx the parse tree
     */
    enterDisassociate_statistics?: (ctx: Disassociate_statisticsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.disassociate_statistics`.
     * @param ctx the parse tree
     */
    exitDisassociate_statistics?: (ctx: Disassociate_statisticsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_indextype`.
     * @param ctx the parse tree
     */
    enterDrop_indextype?: (ctx: Drop_indextypeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_indextype`.
     * @param ctx the parse tree
     */
    exitDrop_indextype?: (ctx: Drop_indextypeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_inmemory_join_group`.
     * @param ctx the parse tree
     */
    enterDrop_inmemory_join_group?: (ctx: Drop_inmemory_join_groupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_inmemory_join_group`.
     * @param ctx the parse tree
     */
    exitDrop_inmemory_join_group?: (ctx: Drop_inmemory_join_groupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_table`.
     * @param ctx the parse tree
     */
    enterFlashback_table?: (ctx: Flashback_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_table`.
     * @param ctx the parse tree
     */
    exitFlashback_table?: (ctx: Flashback_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.restore_point`.
     * @param ctx the parse tree
     */
    enterRestore_point?: (ctx: Restore_pointContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.restore_point`.
     * @param ctx the parse tree
     */
    exitRestore_point?: (ctx: Restore_pointContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.purge_statement`.
     * @param ctx the parse tree
     */
    enterPurge_statement?: (ctx: Purge_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.purge_statement`.
     * @param ctx the parse tree
     */
    exitPurge_statement?: (ctx: Purge_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.noaudit_statement`.
     * @param ctx the parse tree
     */
    enterNoaudit_statement?: (ctx: Noaudit_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.noaudit_statement`.
     * @param ctx the parse tree
     */
    exitNoaudit_statement?: (ctx: Noaudit_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rename_object`.
     * @param ctx the parse tree
     */
    enterRename_object?: (ctx: Rename_objectContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rename_object`.
     * @param ctx the parse tree
     */
    exitRename_object?: (ctx: Rename_objectContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.grant_statement`.
     * @param ctx the parse tree
     */
    enterGrant_statement?: (ctx: Grant_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.grant_statement`.
     * @param ctx the parse tree
     */
    exitGrant_statement?: (ctx: Grant_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.container_clause`.
     * @param ctx the parse tree
     */
    enterContainer_clause?: (ctx: Container_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.container_clause`.
     * @param ctx the parse tree
     */
    exitContainer_clause?: (ctx: Container_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.revoke_statement`.
     * @param ctx the parse tree
     */
    enterRevoke_statement?: (ctx: Revoke_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.revoke_statement`.
     * @param ctx the parse tree
     */
    exitRevoke_statement?: (ctx: Revoke_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.revoke_system_privilege`.
     * @param ctx the parse tree
     */
    enterRevoke_system_privilege?: (ctx: Revoke_system_privilegeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.revoke_system_privilege`.
     * @param ctx the parse tree
     */
    exitRevoke_system_privilege?: (ctx: Revoke_system_privilegeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.revokee_clause`.
     * @param ctx the parse tree
     */
    enterRevokee_clause?: (ctx: Revokee_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.revokee_clause`.
     * @param ctx the parse tree
     */
    exitRevokee_clause?: (ctx: Revokee_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.revoke_object_privileges`.
     * @param ctx the parse tree
     */
    enterRevoke_object_privileges?: (ctx: Revoke_object_privilegesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.revoke_object_privileges`.
     * @param ctx the parse tree
     */
    exitRevoke_object_privileges?: (ctx: Revoke_object_privilegesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_object_clause`.
     * @param ctx the parse tree
     */
    enterOn_object_clause?: (ctx: On_object_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_object_clause`.
     * @param ctx the parse tree
     */
    exitOn_object_clause?: (ctx: On_object_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.revoke_roles_from_programs`.
     * @param ctx the parse tree
     */
    enterRevoke_roles_from_programs?: (ctx: Revoke_roles_from_programsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.revoke_roles_from_programs`.
     * @param ctx the parse tree
     */
    exitRevoke_roles_from_programs?: (ctx: Revoke_roles_from_programsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.program_unit`.
     * @param ctx the parse tree
     */
    enterProgram_unit?: (ctx: Program_unitContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.program_unit`.
     * @param ctx the parse tree
     */
    exitProgram_unit?: (ctx: Program_unitContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_dimension`.
     * @param ctx the parse tree
     */
    enterCreate_dimension?: (ctx: Create_dimensionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_dimension`.
     * @param ctx the parse tree
     */
    exitCreate_dimension?: (ctx: Create_dimensionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_directory`.
     * @param ctx the parse tree
     */
    enterCreate_directory?: (ctx: Create_directoryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_directory`.
     * @param ctx the parse tree
     */
    exitCreate_directory?: (ctx: Create_directoryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.directory_name`.
     * @param ctx the parse tree
     */
    enterDirectory_name?: (ctx: Directory_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.directory_name`.
     * @param ctx the parse tree
     */
    exitDirectory_name?: (ctx: Directory_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.directory_path`.
     * @param ctx the parse tree
     */
    enterDirectory_path?: (ctx: Directory_pathContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.directory_path`.
     * @param ctx the parse tree
     */
    exitDirectory_path?: (ctx: Directory_pathContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_inmemory_join_group`.
     * @param ctx the parse tree
     */
    enterCreate_inmemory_join_group?: (ctx: Create_inmemory_join_groupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_inmemory_join_group`.
     * @param ctx the parse tree
     */
    exitCreate_inmemory_join_group?: (ctx: Create_inmemory_join_groupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_hierarchy`.
     * @param ctx the parse tree
     */
    enterDrop_hierarchy?: (ctx: Drop_hierarchyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_hierarchy`.
     * @param ctx the parse tree
     */
    exitDrop_hierarchy?: (ctx: Drop_hierarchyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_library`.
     * @param ctx the parse tree
     */
    enterAlter_library?: (ctx: Alter_libraryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_library`.
     * @param ctx the parse tree
     */
    exitAlter_library?: (ctx: Alter_libraryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_java`.
     * @param ctx the parse tree
     */
    enterDrop_java?: (ctx: Drop_javaContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_java`.
     * @param ctx the parse tree
     */
    exitDrop_java?: (ctx: Drop_javaContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_library`.
     * @param ctx the parse tree
     */
    enterDrop_library?: (ctx: Drop_libraryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_library`.
     * @param ctx the parse tree
     */
    exitDrop_library?: (ctx: Drop_libraryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_java`.
     * @param ctx the parse tree
     */
    enterCreate_java?: (ctx: Create_javaContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_java`.
     * @param ctx the parse tree
     */
    exitCreate_java?: (ctx: Create_javaContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_library`.
     * @param ctx the parse tree
     */
    enterCreate_library?: (ctx: Create_libraryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_library`.
     * @param ctx the parse tree
     */
    exitCreate_library?: (ctx: Create_libraryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.plsql_library_source`.
     * @param ctx the parse tree
     */
    enterPlsql_library_source?: (ctx: Plsql_library_sourceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.plsql_library_source`.
     * @param ctx the parse tree
     */
    exitPlsql_library_source?: (ctx: Plsql_library_sourceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.credential_name`.
     * @param ctx the parse tree
     */
    enterCredential_name?: (ctx: Credential_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.credential_name`.
     * @param ctx the parse tree
     */
    exitCredential_name?: (ctx: Credential_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.library_editionable`.
     * @param ctx the parse tree
     */
    enterLibrary_editionable?: (ctx: Library_editionableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.library_editionable`.
     * @param ctx the parse tree
     */
    exitLibrary_editionable?: (ctx: Library_editionableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.library_debug`.
     * @param ctx the parse tree
     */
    enterLibrary_debug?: (ctx: Library_debugContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.library_debug`.
     * @param ctx the parse tree
     */
    exitLibrary_debug?: (ctx: Library_debugContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compiler_parameters_clause`.
     * @param ctx the parse tree
     */
    enterCompiler_parameters_clause?: (ctx: Compiler_parameters_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compiler_parameters_clause`.
     * @param ctx the parse tree
     */
    exitCompiler_parameters_clause?: (ctx: Compiler_parameters_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parameter_value`.
     * @param ctx the parse tree
     */
    enterParameter_value?: (ctx: Parameter_valueContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parameter_value`.
     * @param ctx the parse tree
     */
    exitParameter_value?: (ctx: Parameter_valueContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.library_name`.
     * @param ctx the parse tree
     */
    enterLibrary_name?: (ctx: Library_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.library_name`.
     * @param ctx the parse tree
     */
    exitLibrary_name?: (ctx: Library_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_dimension`.
     * @param ctx the parse tree
     */
    enterAlter_dimension?: (ctx: Alter_dimensionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_dimension`.
     * @param ctx the parse tree
     */
    exitAlter_dimension?: (ctx: Alter_dimensionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.level_clause`.
     * @param ctx the parse tree
     */
    enterLevel_clause?: (ctx: Level_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.level_clause`.
     * @param ctx the parse tree
     */
    exitLevel_clause?: (ctx: Level_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hierarchy_clause`.
     * @param ctx the parse tree
     */
    enterHierarchy_clause?: (ctx: Hierarchy_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hierarchy_clause`.
     * @param ctx the parse tree
     */
    exitHierarchy_clause?: (ctx: Hierarchy_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dimension_join_clause`.
     * @param ctx the parse tree
     */
    enterDimension_join_clause?: (ctx: Dimension_join_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dimension_join_clause`.
     * @param ctx the parse tree
     */
    exitDimension_join_clause?: (ctx: Dimension_join_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.attribute_clause`.
     * @param ctx the parse tree
     */
    enterAttribute_clause?: (ctx: Attribute_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.attribute_clause`.
     * @param ctx the parse tree
     */
    exitAttribute_clause?: (ctx: Attribute_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.extended_attribute_clause`.
     * @param ctx the parse tree
     */
    enterExtended_attribute_clause?: (ctx: Extended_attribute_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.extended_attribute_clause`.
     * @param ctx the parse tree
     */
    exitExtended_attribute_clause?: (ctx: Extended_attribute_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_one_or_more_sub_clause`.
     * @param ctx the parse tree
     */
    enterColumn_one_or_more_sub_clause?: (ctx: Column_one_or_more_sub_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_one_or_more_sub_clause`.
     * @param ctx the parse tree
     */
    exitColumn_one_or_more_sub_clause?: (ctx: Column_one_or_more_sub_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_view`.
     * @param ctx the parse tree
     */
    enterAlter_view?: (ctx: Alter_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_view`.
     * @param ctx the parse tree
     */
    exitAlter_view?: (ctx: Alter_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_view_editionable`.
     * @param ctx the parse tree
     */
    enterAlter_view_editionable?: (ctx: Alter_view_editionableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_view_editionable`.
     * @param ctx the parse tree
     */
    exitAlter_view_editionable?: (ctx: Alter_view_editionableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_view`.
     * @param ctx the parse tree
     */
    enterCreate_view?: (ctx: Create_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_view`.
     * @param ctx the parse tree
     */
    exitCreate_view?: (ctx: Create_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.editioning_clause`.
     * @param ctx the parse tree
     */
    enterEditioning_clause?: (ctx: Editioning_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.editioning_clause`.
     * @param ctx the parse tree
     */
    exitEditioning_clause?: (ctx: Editioning_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.view_options`.
     * @param ctx the parse tree
     */
    enterView_options?: (ctx: View_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.view_options`.
     * @param ctx the parse tree
     */
    exitView_options?: (ctx: View_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.view_alias_constraint`.
     * @param ctx the parse tree
     */
    enterView_alias_constraint?: (ctx: View_alias_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.view_alias_constraint`.
     * @param ctx the parse tree
     */
    exitView_alias_constraint?: (ctx: View_alias_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_view_clause`.
     * @param ctx the parse tree
     */
    enterObject_view_clause?: (ctx: Object_view_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_view_clause`.
     * @param ctx the parse tree
     */
    exitObject_view_clause?: (ctx: Object_view_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inline_constraint`.
     * @param ctx the parse tree
     */
    enterInline_constraint?: (ctx: Inline_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inline_constraint`.
     * @param ctx the parse tree
     */
    exitInline_constraint?: (ctx: Inline_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inline_ref_constraint`.
     * @param ctx the parse tree
     */
    enterInline_ref_constraint?: (ctx: Inline_ref_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inline_ref_constraint`.
     * @param ctx the parse tree
     */
    exitInline_ref_constraint?: (ctx: Inline_ref_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.out_of_line_ref_constraint`.
     * @param ctx the parse tree
     */
    enterOut_of_line_ref_constraint?: (ctx: Out_of_line_ref_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.out_of_line_ref_constraint`.
     * @param ctx the parse tree
     */
    exitOut_of_line_ref_constraint?: (ctx: Out_of_line_ref_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.out_of_line_constraint`.
     * @param ctx the parse tree
     */
    enterOut_of_line_constraint?: (ctx: Out_of_line_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.out_of_line_constraint`.
     * @param ctx the parse tree
     */
    exitOut_of_line_constraint?: (ctx: Out_of_line_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constraint_state`.
     * @param ctx the parse tree
     */
    enterConstraint_state?: (ctx: Constraint_stateContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constraint_state`.
     * @param ctx the parse tree
     */
    exitConstraint_state?: (ctx: Constraint_stateContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltype_view_clause`.
     * @param ctx the parse tree
     */
    enterXmltype_view_clause?: (ctx: Xmltype_view_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltype_view_clause`.
     * @param ctx the parse tree
     */
    exitXmltype_view_clause?: (ctx: Xmltype_view_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_schema_spec`.
     * @param ctx the parse tree
     */
    enterXml_schema_spec?: (ctx: Xml_schema_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_schema_spec`.
     * @param ctx the parse tree
     */
    exitXml_schema_spec?: (ctx: Xml_schema_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_schema_url`.
     * @param ctx the parse tree
     */
    enterXml_schema_url?: (ctx: Xml_schema_urlContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_schema_url`.
     * @param ctx the parse tree
     */
    exitXml_schema_url?: (ctx: Xml_schema_urlContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.element`.
     * @param ctx the parse tree
     */
    enterElement?: (ctx: ElementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.element`.
     * @param ctx the parse tree
     */
    exitElement?: (ctx: ElementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_tablespace`.
     * @param ctx the parse tree
     */
    enterAlter_tablespace?: (ctx: Alter_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_tablespace`.
     * @param ctx the parse tree
     */
    exitAlter_tablespace?: (ctx: Alter_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.datafile_tempfile_clauses`.
     * @param ctx the parse tree
     */
    enterDatafile_tempfile_clauses?: (ctx: Datafile_tempfile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.datafile_tempfile_clauses`.
     * @param ctx the parse tree
     */
    exitDatafile_tempfile_clauses?: (ctx: Datafile_tempfile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_logging_clauses`.
     * @param ctx the parse tree
     */
    enterTablespace_logging_clauses?: (ctx: Tablespace_logging_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_logging_clauses`.
     * @param ctx the parse tree
     */
    exitTablespace_logging_clauses?: (ctx: Tablespace_logging_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_group_clause`.
     * @param ctx the parse tree
     */
    enterTablespace_group_clause?: (ctx: Tablespace_group_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_group_clause`.
     * @param ctx the parse tree
     */
    exitTablespace_group_clause?: (ctx: Tablespace_group_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_group_name`.
     * @param ctx the parse tree
     */
    enterTablespace_group_name?: (ctx: Tablespace_group_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_group_name`.
     * @param ctx the parse tree
     */
    exitTablespace_group_name?: (ctx: Tablespace_group_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_state_clauses`.
     * @param ctx the parse tree
     */
    enterTablespace_state_clauses?: (ctx: Tablespace_state_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_state_clauses`.
     * @param ctx the parse tree
     */
    exitTablespace_state_clauses?: (ctx: Tablespace_state_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_mode_clause`.
     * @param ctx the parse tree
     */
    enterFlashback_mode_clause?: (ctx: Flashback_mode_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_mode_clause`.
     * @param ctx the parse tree
     */
    exitFlashback_mode_clause?: (ctx: Flashback_mode_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_tablespace_name`.
     * @param ctx the parse tree
     */
    enterNew_tablespace_name?: (ctx: New_tablespace_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_tablespace_name`.
     * @param ctx the parse tree
     */
    exitNew_tablespace_name?: (ctx: New_tablespace_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_tablespace`.
     * @param ctx the parse tree
     */
    enterCreate_tablespace?: (ctx: Create_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_tablespace`.
     * @param ctx the parse tree
     */
    exitCreate_tablespace?: (ctx: Create_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.permanent_tablespace_clause`.
     * @param ctx the parse tree
     */
    enterPermanent_tablespace_clause?: (ctx: Permanent_tablespace_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.permanent_tablespace_clause`.
     * @param ctx the parse tree
     */
    exitPermanent_tablespace_clause?: (ctx: Permanent_tablespace_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_encryption_spec`.
     * @param ctx the parse tree
     */
    enterTablespace_encryption_spec?: (ctx: Tablespace_encryption_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_encryption_spec`.
     * @param ctx the parse tree
     */
    exitTablespace_encryption_spec?: (ctx: Tablespace_encryption_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logging_clause`.
     * @param ctx the parse tree
     */
    enterLogging_clause?: (ctx: Logging_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logging_clause`.
     * @param ctx the parse tree
     */
    exitLogging_clause?: (ctx: Logging_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.extent_management_clause`.
     * @param ctx the parse tree
     */
    enterExtent_management_clause?: (ctx: Extent_management_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.extent_management_clause`.
     * @param ctx the parse tree
     */
    exitExtent_management_clause?: (ctx: Extent_management_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.segment_management_clause`.
     * @param ctx the parse tree
     */
    enterSegment_management_clause?: (ctx: Segment_management_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.segment_management_clause`.
     * @param ctx the parse tree
     */
    exitSegment_management_clause?: (ctx: Segment_management_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.temporary_tablespace_clause`.
     * @param ctx the parse tree
     */
    enterTemporary_tablespace_clause?: (ctx: Temporary_tablespace_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.temporary_tablespace_clause`.
     * @param ctx the parse tree
     */
    exitTemporary_tablespace_clause?: (ctx: Temporary_tablespace_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.undo_tablespace_clause`.
     * @param ctx the parse tree
     */
    enterUndo_tablespace_clause?: (ctx: Undo_tablespace_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.undo_tablespace_clause`.
     * @param ctx the parse tree
     */
    exitUndo_tablespace_clause?: (ctx: Undo_tablespace_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_retention_clause`.
     * @param ctx the parse tree
     */
    enterTablespace_retention_clause?: (ctx: Tablespace_retention_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_retention_clause`.
     * @param ctx the parse tree
     */
    exitTablespace_retention_clause?: (ctx: Tablespace_retention_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_tablespace_set`.
     * @param ctx the parse tree
     */
    enterCreate_tablespace_set?: (ctx: Create_tablespace_setContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_tablespace_set`.
     * @param ctx the parse tree
     */
    exitCreate_tablespace_set?: (ctx: Create_tablespace_setContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.permanent_tablespace_attrs`.
     * @param ctx the parse tree
     */
    enterPermanent_tablespace_attrs?: (ctx: Permanent_tablespace_attrsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.permanent_tablespace_attrs`.
     * @param ctx the parse tree
     */
    exitPermanent_tablespace_attrs?: (ctx: Permanent_tablespace_attrsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_encryption_clause`.
     * @param ctx the parse tree
     */
    enterTablespace_encryption_clause?: (ctx: Tablespace_encryption_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_encryption_clause`.
     * @param ctx the parse tree
     */
    exitTablespace_encryption_clause?: (ctx: Tablespace_encryption_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_tablespace_params`.
     * @param ctx the parse tree
     */
    enterDefault_tablespace_params?: (ctx: Default_tablespace_paramsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_tablespace_params`.
     * @param ctx the parse tree
     */
    exitDefault_tablespace_params?: (ctx: Default_tablespace_paramsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_table_compression`.
     * @param ctx the parse tree
     */
    enterDefault_table_compression?: (ctx: Default_table_compressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_table_compression`.
     * @param ctx the parse tree
     */
    exitDefault_table_compression?: (ctx: Default_table_compressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.low_high`.
     * @param ctx the parse tree
     */
    enterLow_high?: (ctx: Low_highContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.low_high`.
     * @param ctx the parse tree
     */
    exitLow_high?: (ctx: Low_highContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_index_compression`.
     * @param ctx the parse tree
     */
    enterDefault_index_compression?: (ctx: Default_index_compressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_index_compression`.
     * @param ctx the parse tree
     */
    exitDefault_index_compression?: (ctx: Default_index_compressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmmemory_clause`.
     * @param ctx the parse tree
     */
    enterInmmemory_clause?: (ctx: Inmmemory_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmmemory_clause`.
     * @param ctx the parse tree
     */
    exitInmmemory_clause?: (ctx: Inmmemory_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.datafile_specification`.
     * @param ctx the parse tree
     */
    enterDatafile_specification?: (ctx: Datafile_specificationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.datafile_specification`.
     * @param ctx the parse tree
     */
    exitDatafile_specification?: (ctx: Datafile_specificationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tempfile_specification`.
     * @param ctx the parse tree
     */
    enterTempfile_specification?: (ctx: Tempfile_specificationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tempfile_specification`.
     * @param ctx the parse tree
     */
    exitTempfile_specification?: (ctx: Tempfile_specificationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.datafile_tempfile_spec`.
     * @param ctx the parse tree
     */
    enterDatafile_tempfile_spec?: (ctx: Datafile_tempfile_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.datafile_tempfile_spec`.
     * @param ctx the parse tree
     */
    exitDatafile_tempfile_spec?: (ctx: Datafile_tempfile_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.redo_log_file_spec`.
     * @param ctx the parse tree
     */
    enterRedo_log_file_spec?: (ctx: Redo_log_file_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.redo_log_file_spec`.
     * @param ctx the parse tree
     */
    exitRedo_log_file_spec?: (ctx: Redo_log_file_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.autoextend_clause`.
     * @param ctx the parse tree
     */
    enterAutoextend_clause?: (ctx: Autoextend_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.autoextend_clause`.
     * @param ctx the parse tree
     */
    exitAutoextend_clause?: (ctx: Autoextend_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.maxsize_clause`.
     * @param ctx the parse tree
     */
    enterMaxsize_clause?: (ctx: Maxsize_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.maxsize_clause`.
     * @param ctx the parse tree
     */
    exitMaxsize_clause?: (ctx: Maxsize_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.build_clause`.
     * @param ctx the parse tree
     */
    enterBuild_clause?: (ctx: Build_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.build_clause`.
     * @param ctx the parse tree
     */
    exitBuild_clause?: (ctx: Build_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parallel_clause`.
     * @param ctx the parse tree
     */
    enterParallel_clause?: (ctx: Parallel_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parallel_clause`.
     * @param ctx the parse tree
     */
    exitParallel_clause?: (ctx: Parallel_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parallel_instances_clause`.
     * @param ctx the parse tree
     */
    enterParallel_instances_clause?: (ctx: Parallel_instances_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parallel_instances_clause`.
     * @param ctx the parse tree
     */
    exitParallel_instances_clause?: (ctx: Parallel_instances_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_materialized_view`.
     * @param ctx the parse tree
     */
    enterAlter_materialized_view?: (ctx: Alter_materialized_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_materialized_view`.
     * @param ctx the parse tree
     */
    exitAlter_materialized_view?: (ctx: Alter_materialized_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_mv_option1`.
     * @param ctx the parse tree
     */
    enterAlter_mv_option1?: (ctx: Alter_mv_option1Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_mv_option1`.
     * @param ctx the parse tree
     */
    exitAlter_mv_option1?: (ctx: Alter_mv_option1Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_mv_refresh`.
     * @param ctx the parse tree
     */
    enterAlter_mv_refresh?: (ctx: Alter_mv_refreshContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_mv_refresh`.
     * @param ctx the parse tree
     */
    exitAlter_mv_refresh?: (ctx: Alter_mv_refreshContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rollback_segment`.
     * @param ctx the parse tree
     */
    enterRollback_segment?: (ctx: Rollback_segmentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rollback_segment`.
     * @param ctx the parse tree
     */
    exitRollback_segment?: (ctx: Rollback_segmentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_mv_column_clause`.
     * @param ctx the parse tree
     */
    enterModify_mv_column_clause?: (ctx: Modify_mv_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_mv_column_clause`.
     * @param ctx the parse tree
     */
    exitModify_mv_column_clause?: (ctx: Modify_mv_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_materialized_view_log`.
     * @param ctx the parse tree
     */
    enterAlter_materialized_view_log?: (ctx: Alter_materialized_view_logContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_materialized_view_log`.
     * @param ctx the parse tree
     */
    exitAlter_materialized_view_log?: (ctx: Alter_materialized_view_logContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_mv_log_column_clause`.
     * @param ctx the parse tree
     */
    enterAdd_mv_log_column_clause?: (ctx: Add_mv_log_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_mv_log_column_clause`.
     * @param ctx the parse tree
     */
    exitAdd_mv_log_column_clause?: (ctx: Add_mv_log_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_mv_log_clause`.
     * @param ctx the parse tree
     */
    enterMove_mv_log_clause?: (ctx: Move_mv_log_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_mv_log_clause`.
     * @param ctx the parse tree
     */
    exitMove_mv_log_clause?: (ctx: Move_mv_log_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mv_log_augmentation`.
     * @param ctx the parse tree
     */
    enterMv_log_augmentation?: (ctx: Mv_log_augmentationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mv_log_augmentation`.
     * @param ctx the parse tree
     */
    exitMv_log_augmentation?: (ctx: Mv_log_augmentationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_materialized_view_log`.
     * @param ctx the parse tree
     */
    enterCreate_materialized_view_log?: (ctx: Create_materialized_view_logContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_materialized_view_log`.
     * @param ctx the parse tree
     */
    exitCreate_materialized_view_log?: (ctx: Create_materialized_view_logContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_values_clause`.
     * @param ctx the parse tree
     */
    enterNew_values_clause?: (ctx: New_values_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_values_clause`.
     * @param ctx the parse tree
     */
    exitNew_values_clause?: (ctx: New_values_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mv_log_purge_clause`.
     * @param ctx the parse tree
     */
    enterMv_log_purge_clause?: (ctx: Mv_log_purge_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mv_log_purge_clause`.
     * @param ctx the parse tree
     */
    exitMv_log_purge_clause?: (ctx: Mv_log_purge_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_materialized_zonemap`.
     * @param ctx the parse tree
     */
    enterCreate_materialized_zonemap?: (ctx: Create_materialized_zonemapContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_materialized_zonemap`.
     * @param ctx the parse tree
     */
    exitCreate_materialized_zonemap?: (ctx: Create_materialized_zonemapContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_materialized_zonemap`.
     * @param ctx the parse tree
     */
    enterAlter_materialized_zonemap?: (ctx: Alter_materialized_zonemapContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_materialized_zonemap`.
     * @param ctx the parse tree
     */
    exitAlter_materialized_zonemap?: (ctx: Alter_materialized_zonemapContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_materialized_zonemap`.
     * @param ctx the parse tree
     */
    enterDrop_materialized_zonemap?: (ctx: Drop_materialized_zonemapContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_materialized_zonemap`.
     * @param ctx the parse tree
     */
    exitDrop_materialized_zonemap?: (ctx: Drop_materialized_zonemapContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.zonemap_refresh_clause`.
     * @param ctx the parse tree
     */
    enterZonemap_refresh_clause?: (ctx: Zonemap_refresh_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.zonemap_refresh_clause`.
     * @param ctx the parse tree
     */
    exitZonemap_refresh_clause?: (ctx: Zonemap_refresh_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.zonemap_attributes`.
     * @param ctx the parse tree
     */
    enterZonemap_attributes?: (ctx: Zonemap_attributesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.zonemap_attributes`.
     * @param ctx the parse tree
     */
    exitZonemap_attributes?: (ctx: Zonemap_attributesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.zonemap_name`.
     * @param ctx the parse tree
     */
    enterZonemap_name?: (ctx: Zonemap_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.zonemap_name`.
     * @param ctx the parse tree
     */
    exitZonemap_name?: (ctx: Zonemap_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.operator_name`.
     * @param ctx the parse tree
     */
    enterOperator_name?: (ctx: Operator_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.operator_name`.
     * @param ctx the parse tree
     */
    exitOperator_name?: (ctx: Operator_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.operator_function_name`.
     * @param ctx the parse tree
     */
    enterOperator_function_name?: (ctx: Operator_function_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.operator_function_name`.
     * @param ctx the parse tree
     */
    exitOperator_function_name?: (ctx: Operator_function_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_zonemap_on_table`.
     * @param ctx the parse tree
     */
    enterCreate_zonemap_on_table?: (ctx: Create_zonemap_on_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_zonemap_on_table`.
     * @param ctx the parse tree
     */
    exitCreate_zonemap_on_table?: (ctx: Create_zonemap_on_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_zonemap_as_subquery`.
     * @param ctx the parse tree
     */
    enterCreate_zonemap_as_subquery?: (ctx: Create_zonemap_as_subqueryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_zonemap_as_subquery`.
     * @param ctx the parse tree
     */
    exitCreate_zonemap_as_subquery?: (ctx: Create_zonemap_as_subqueryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_operator`.
     * @param ctx the parse tree
     */
    enterAlter_operator?: (ctx: Alter_operatorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_operator`.
     * @param ctx the parse tree
     */
    exitAlter_operator?: (ctx: Alter_operatorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_operator`.
     * @param ctx the parse tree
     */
    enterDrop_operator?: (ctx: Drop_operatorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_operator`.
     * @param ctx the parse tree
     */
    exitDrop_operator?: (ctx: Drop_operatorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_operator`.
     * @param ctx the parse tree
     */
    enterCreate_operator?: (ctx: Create_operatorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_operator`.
     * @param ctx the parse tree
     */
    exitCreate_operator?: (ctx: Create_operatorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.binding_clause`.
     * @param ctx the parse tree
     */
    enterBinding_clause?: (ctx: Binding_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.binding_clause`.
     * @param ctx the parse tree
     */
    exitBinding_clause?: (ctx: Binding_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_binding_clause`.
     * @param ctx the parse tree
     */
    enterAdd_binding_clause?: (ctx: Add_binding_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_binding_clause`.
     * @param ctx the parse tree
     */
    exitAdd_binding_clause?: (ctx: Add_binding_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.implementation_clause`.
     * @param ctx the parse tree
     */
    enterImplementation_clause?: (ctx: Implementation_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.implementation_clause`.
     * @param ctx the parse tree
     */
    exitImplementation_clause?: (ctx: Implementation_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.primary_operator_list`.
     * @param ctx the parse tree
     */
    enterPrimary_operator_list?: (ctx: Primary_operator_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.primary_operator_list`.
     * @param ctx the parse tree
     */
    exitPrimary_operator_list?: (ctx: Primary_operator_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.primary_operator_item`.
     * @param ctx the parse tree
     */
    enterPrimary_operator_item?: (ctx: Primary_operator_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.primary_operator_item`.
     * @param ctx the parse tree
     */
    exitPrimary_operator_item?: (ctx: Primary_operator_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.operator_context_clause`.
     * @param ctx the parse tree
     */
    enterOperator_context_clause?: (ctx: Operator_context_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.operator_context_clause`.
     * @param ctx the parse tree
     */
    exitOperator_context_clause?: (ctx: Operator_context_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_function_clause`.
     * @param ctx the parse tree
     */
    enterUsing_function_clause?: (ctx: Using_function_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_function_clause`.
     * @param ctx the parse tree
     */
    exitUsing_function_clause?: (ctx: Using_function_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_binding_clause`.
     * @param ctx the parse tree
     */
    enterDrop_binding_clause?: (ctx: Drop_binding_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_binding_clause`.
     * @param ctx the parse tree
     */
    exitDrop_binding_clause?: (ctx: Drop_binding_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_materialized_view`.
     * @param ctx the parse tree
     */
    enterCreate_materialized_view?: (ctx: Create_materialized_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_materialized_view`.
     * @param ctx the parse tree
     */
    exitCreate_materialized_view?: (ctx: Create_materialized_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.scoped_table_ref_constraint`.
     * @param ctx the parse tree
     */
    enterScoped_table_ref_constraint?: (ctx: Scoped_table_ref_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.scoped_table_ref_constraint`.
     * @param ctx the parse tree
     */
    exitScoped_table_ref_constraint?: (ctx: Scoped_table_ref_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mv_column_alias`.
     * @param ctx the parse tree
     */
    enterMv_column_alias?: (ctx: Mv_column_aliasContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mv_column_alias`.
     * @param ctx the parse tree
     */
    exitMv_column_alias?: (ctx: Mv_column_aliasContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_mv_refresh`.
     * @param ctx the parse tree
     */
    enterCreate_mv_refresh?: (ctx: Create_mv_refreshContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_mv_refresh`.
     * @param ctx the parse tree
     */
    exitCreate_mv_refresh?: (ctx: Create_mv_refreshContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.query_rewrite_clause`.
     * @param ctx the parse tree
     */
    enterQuery_rewrite_clause?: (ctx: Query_rewrite_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.query_rewrite_clause`.
     * @param ctx the parse tree
     */
    exitQuery_rewrite_clause?: (ctx: Query_rewrite_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unusable_editions_clause`.
     * @param ctx the parse tree
     */
    enterUnusable_editions_clause?: (ctx: Unusable_editions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unusable_editions_clause`.
     * @param ctx the parse tree
     */
    exitUnusable_editions_clause?: (ctx: Unusable_editions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_materialized_view`.
     * @param ctx the parse tree
     */
    enterDrop_materialized_view?: (ctx: Drop_materialized_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_materialized_view`.
     * @param ctx the parse tree
     */
    exitDrop_materialized_view?: (ctx: Drop_materialized_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_materialized_view_log`.
     * @param ctx the parse tree
     */
    enterDrop_materialized_view_log?: (ctx: Drop_materialized_view_logContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_materialized_view_log`.
     * @param ctx the parse tree
     */
    exitDrop_materialized_view_log?: (ctx: Drop_materialized_view_logContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_context`.
     * @param ctx the parse tree
     */
    enterCreate_context?: (ctx: Create_contextContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_context`.
     * @param ctx the parse tree
     */
    exitCreate_context?: (ctx: Create_contextContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.oracle_namespace`.
     * @param ctx the parse tree
     */
    enterOracle_namespace?: (ctx: Oracle_namespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.oracle_namespace`.
     * @param ctx the parse tree
     */
    exitOracle_namespace?: (ctx: Oracle_namespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_cluster`.
     * @param ctx the parse tree
     */
    enterCreate_cluster?: (ctx: Create_clusterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_cluster`.
     * @param ctx the parse tree
     */
    exitCreate_cluster?: (ctx: Create_clusterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_profile`.
     * @param ctx the parse tree
     */
    enterCreate_profile?: (ctx: Create_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_profile`.
     * @param ctx the parse tree
     */
    exitCreate_profile?: (ctx: Create_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.resource_parameters`.
     * @param ctx the parse tree
     */
    enterResource_parameters?: (ctx: Resource_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.resource_parameters`.
     * @param ctx the parse tree
     */
    exitResource_parameters?: (ctx: Resource_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.password_parameters`.
     * @param ctx the parse tree
     */
    enterPassword_parameters?: (ctx: Password_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.password_parameters`.
     * @param ctx the parse tree
     */
    exitPassword_parameters?: (ctx: Password_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_lockdown_profile`.
     * @param ctx the parse tree
     */
    enterCreate_lockdown_profile?: (ctx: Create_lockdown_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_lockdown_profile`.
     * @param ctx the parse tree
     */
    exitCreate_lockdown_profile?: (ctx: Create_lockdown_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.static_base_profile`.
     * @param ctx the parse tree
     */
    enterStatic_base_profile?: (ctx: Static_base_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.static_base_profile`.
     * @param ctx the parse tree
     */
    exitStatic_base_profile?: (ctx: Static_base_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dynamic_base_profile`.
     * @param ctx the parse tree
     */
    enterDynamic_base_profile?: (ctx: Dynamic_base_profileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dynamic_base_profile`.
     * @param ctx the parse tree
     */
    exitDynamic_base_profile?: (ctx: Dynamic_base_profileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_outline`.
     * @param ctx the parse tree
     */
    enterCreate_outline?: (ctx: Create_outlineContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_outline`.
     * @param ctx the parse tree
     */
    exitCreate_outline?: (ctx: Create_outlineContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_restore_point`.
     * @param ctx the parse tree
     */
    enterCreate_restore_point?: (ctx: Create_restore_pointContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_restore_point`.
     * @param ctx the parse tree
     */
    exitCreate_restore_point?: (ctx: Create_restore_pointContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_role`.
     * @param ctx the parse tree
     */
    enterCreate_role?: (ctx: Create_roleContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_role`.
     * @param ctx the parse tree
     */
    exitCreate_role?: (ctx: Create_roleContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_table`.
     * @param ctx the parse tree
     */
    enterCreate_table?: (ctx: Create_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_table`.
     * @param ctx the parse tree
     */
    exitCreate_table?: (ctx: Create_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltype_table`.
     * @param ctx the parse tree
     */
    enterXmltype_table?: (ctx: Xmltype_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltype_table`.
     * @param ctx the parse tree
     */
    exitXmltype_table?: (ctx: Xmltype_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltype_virtual_columns`.
     * @param ctx the parse tree
     */
    enterXmltype_virtual_columns?: (ctx: Xmltype_virtual_columnsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltype_virtual_columns`.
     * @param ctx the parse tree
     */
    exitXmltype_virtual_columns?: (ctx: Xmltype_virtual_columnsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltype_column_properties`.
     * @param ctx the parse tree
     */
    enterXmltype_column_properties?: (ctx: Xmltype_column_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltype_column_properties`.
     * @param ctx the parse tree
     */
    exitXmltype_column_properties?: (ctx: Xmltype_column_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltype_storage`.
     * @param ctx the parse tree
     */
    enterXmltype_storage?: (ctx: Xmltype_storageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltype_storage`.
     * @param ctx the parse tree
     */
    exitXmltype_storage?: (ctx: Xmltype_storageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlschema_spec`.
     * @param ctx the parse tree
     */
    enterXmlschema_spec?: (ctx: Xmlschema_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlschema_spec`.
     * @param ctx the parse tree
     */
    exitXmlschema_spec?: (ctx: Xmlschema_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_table`.
     * @param ctx the parse tree
     */
    enterObject_table?: (ctx: Object_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_table`.
     * @param ctx the parse tree
     */
    exitObject_table?: (ctx: Object_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_type`.
     * @param ctx the parse tree
     */
    enterObject_type?: (ctx: Object_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_type`.
     * @param ctx the parse tree
     */
    exitObject_type?: (ctx: Object_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.oid_index_clause`.
     * @param ctx the parse tree
     */
    enterOid_index_clause?: (ctx: Oid_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.oid_index_clause`.
     * @param ctx the parse tree
     */
    exitOid_index_clause?: (ctx: Oid_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.oid_clause`.
     * @param ctx the parse tree
     */
    enterOid_clause?: (ctx: Oid_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.oid_clause`.
     * @param ctx the parse tree
     */
    exitOid_clause?: (ctx: Oid_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_properties`.
     * @param ctx the parse tree
     */
    enterObject_properties?: (ctx: Object_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_properties`.
     * @param ctx the parse tree
     */
    exitObject_properties?: (ctx: Object_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_table_substitution`.
     * @param ctx the parse tree
     */
    enterObject_table_substitution?: (ctx: Object_table_substitutionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_table_substitution`.
     * @param ctx the parse tree
     */
    exitObject_table_substitution?: (ctx: Object_table_substitutionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_table`.
     * @param ctx the parse tree
     */
    enterRelational_table?: (ctx: Relational_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_table`.
     * @param ctx the parse tree
     */
    exitRelational_table?: (ctx: Relational_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_table_properties`.
     * @param ctx the parse tree
     */
    enterRelational_table_properties?: (ctx: Relational_table_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_table_properties`.
     * @param ctx the parse tree
     */
    exitRelational_table_properties?: (ctx: Relational_table_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_table_property`.
     * @param ctx the parse tree
     */
    enterRelational_table_property?: (ctx: Relational_table_propertyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_table_property`.
     * @param ctx the parse tree
     */
    exitRelational_table_property?: (ctx: Relational_table_propertyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.immutable_table_clauses`.
     * @param ctx the parse tree
     */
    enterImmutable_table_clauses?: (ctx: Immutable_table_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.immutable_table_clauses`.
     * @param ctx the parse tree
     */
    exitImmutable_table_clauses?: (ctx: Immutable_table_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.immutable_table_no_drop_clause`.
     * @param ctx the parse tree
     */
    enterImmutable_table_no_drop_clause?: (ctx: Immutable_table_no_drop_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.immutable_table_no_drop_clause`.
     * @param ctx the parse tree
     */
    exitImmutable_table_no_drop_clause?: (ctx: Immutable_table_no_drop_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.immutable_table_no_delete_clause`.
     * @param ctx the parse tree
     */
    enterImmutable_table_no_delete_clause?: (ctx: Immutable_table_no_delete_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.immutable_table_no_delete_clause`.
     * @param ctx the parse tree
     */
    exitImmutable_table_no_delete_clause?: (ctx: Immutable_table_no_delete_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.blockchain_table_clauses`.
     * @param ctx the parse tree
     */
    enterBlockchain_table_clauses?: (ctx: Blockchain_table_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.blockchain_table_clauses`.
     * @param ctx the parse tree
     */
    exitBlockchain_table_clauses?: (ctx: Blockchain_table_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.blockchain_drop_table_clause`.
     * @param ctx the parse tree
     */
    enterBlockchain_drop_table_clause?: (ctx: Blockchain_drop_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.blockchain_drop_table_clause`.
     * @param ctx the parse tree
     */
    exitBlockchain_drop_table_clause?: (ctx: Blockchain_drop_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.blockchain_row_retention_clause`.
     * @param ctx the parse tree
     */
    enterBlockchain_row_retention_clause?: (ctx: Blockchain_row_retention_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.blockchain_row_retention_clause`.
     * @param ctx the parse tree
     */
    exitBlockchain_row_retention_clause?: (ctx: Blockchain_row_retention_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.blockchain_hash_and_data_format_clause`.
     * @param ctx the parse tree
     */
    enterBlockchain_hash_and_data_format_clause?: (ctx: Blockchain_hash_and_data_format_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.blockchain_hash_and_data_format_clause`.
     * @param ctx the parse tree
     */
    exitBlockchain_hash_and_data_format_clause?: (ctx: Blockchain_hash_and_data_format_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.collation_name`.
     * @param ctx the parse tree
     */
    enterCollation_name?: (ctx: Collation_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.collation_name`.
     * @param ctx the parse tree
     */
    exitCollation_name?: (ctx: Collation_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_properties`.
     * @param ctx the parse tree
     */
    enterTable_properties?: (ctx: Table_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_properties`.
     * @param ctx the parse tree
     */
    exitTable_properties?: (ctx: Table_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.read_only_clause`.
     * @param ctx the parse tree
     */
    enterRead_only_clause?: (ctx: Read_only_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.read_only_clause`.
     * @param ctx the parse tree
     */
    exitRead_only_clause?: (ctx: Read_only_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.indexing_clause`.
     * @param ctx the parse tree
     */
    enterIndexing_clause?: (ctx: Indexing_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.indexing_clause`.
     * @param ctx the parse tree
     */
    exitIndexing_clause?: (ctx: Indexing_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.attribute_clustering_clause`.
     * @param ctx the parse tree
     */
    enterAttribute_clustering_clause?: (ctx: Attribute_clustering_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.attribute_clustering_clause`.
     * @param ctx the parse tree
     */
    exitAttribute_clustering_clause?: (ctx: Attribute_clustering_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clustering_join`.
     * @param ctx the parse tree
     */
    enterClustering_join?: (ctx: Clustering_joinContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clustering_join`.
     * @param ctx the parse tree
     */
    exitClustering_join?: (ctx: Clustering_joinContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clustering_join_item`.
     * @param ctx the parse tree
     */
    enterClustering_join_item?: (ctx: Clustering_join_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clustering_join_item`.
     * @param ctx the parse tree
     */
    exitClustering_join_item?: (ctx: Clustering_join_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.equijoin_condition`.
     * @param ctx the parse tree
     */
    enterEquijoin_condition?: (ctx: Equijoin_conditionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.equijoin_condition`.
     * @param ctx the parse tree
     */
    exitEquijoin_condition?: (ctx: Equijoin_conditionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cluster_clause`.
     * @param ctx the parse tree
     */
    enterCluster_clause?: (ctx: Cluster_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cluster_clause`.
     * @param ctx the parse tree
     */
    exitCluster_clause?: (ctx: Cluster_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clustering_columns`.
     * @param ctx the parse tree
     */
    enterClustering_columns?: (ctx: Clustering_columnsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clustering_columns`.
     * @param ctx the parse tree
     */
    exitClustering_columns?: (ctx: Clustering_columnsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clustering_column_group`.
     * @param ctx the parse tree
     */
    enterClustering_column_group?: (ctx: Clustering_column_groupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clustering_column_group`.
     * @param ctx the parse tree
     */
    exitClustering_column_group?: (ctx: Clustering_column_groupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.yes_no`.
     * @param ctx the parse tree
     */
    enterYes_no?: (ctx: Yes_noContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.yes_no`.
     * @param ctx the parse tree
     */
    exitYes_no?: (ctx: Yes_noContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.zonemap_clause`.
     * @param ctx the parse tree
     */
    enterZonemap_clause?: (ctx: Zonemap_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.zonemap_clause`.
     * @param ctx the parse tree
     */
    exitZonemap_clause?: (ctx: Zonemap_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logical_replication_clause`.
     * @param ctx the parse tree
     */
    enterLogical_replication_clause?: (ctx: Logical_replication_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logical_replication_clause`.
     * @param ctx the parse tree
     */
    exitLogical_replication_clause?: (ctx: Logical_replication_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_name`.
     * @param ctx the parse tree
     */
    enterTable_name?: (ctx: Table_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_name`.
     * @param ctx the parse tree
     */
    exitTable_name?: (ctx: Table_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_property`.
     * @param ctx the parse tree
     */
    enterRelational_property?: (ctx: Relational_propertyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_property`.
     * @param ctx the parse tree
     */
    exitRelational_property?: (ctx: Relational_propertyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_partitioning_clauses`.
     * @param ctx the parse tree
     */
    enterTable_partitioning_clauses?: (ctx: Table_partitioning_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_partitioning_clauses`.
     * @param ctx the parse tree
     */
    exitTable_partitioning_clauses?: (ctx: Table_partitioning_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.range_partitions`.
     * @param ctx the parse tree
     */
    enterRange_partitions?: (ctx: Range_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.range_partitions`.
     * @param ctx the parse tree
     */
    exitRange_partitions?: (ctx: Range_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.list_partitions`.
     * @param ctx the parse tree
     */
    enterList_partitions?: (ctx: List_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.list_partitions`.
     * @param ctx the parse tree
     */
    exitList_partitions?: (ctx: List_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hash_partitions`.
     * @param ctx the parse tree
     */
    enterHash_partitions?: (ctx: Hash_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hash_partitions`.
     * @param ctx the parse tree
     */
    exitHash_partitions?: (ctx: Hash_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.individual_hash_partitions`.
     * @param ctx the parse tree
     */
    enterIndividual_hash_partitions?: (ctx: Individual_hash_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.individual_hash_partitions`.
     * @param ctx the parse tree
     */
    exitIndividual_hash_partitions?: (ctx: Individual_hash_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hash_partitions_by_quantity`.
     * @param ctx the parse tree
     */
    enterHash_partitions_by_quantity?: (ctx: Hash_partitions_by_quantityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hash_partitions_by_quantity`.
     * @param ctx the parse tree
     */
    exitHash_partitions_by_quantity?: (ctx: Hash_partitions_by_quantityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hash_partition_quantity`.
     * @param ctx the parse tree
     */
    enterHash_partition_quantity?: (ctx: Hash_partition_quantityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hash_partition_quantity`.
     * @param ctx the parse tree
     */
    exitHash_partition_quantity?: (ctx: Hash_partition_quantityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.composite_range_partitions`.
     * @param ctx the parse tree
     */
    enterComposite_range_partitions?: (ctx: Composite_range_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.composite_range_partitions`.
     * @param ctx the parse tree
     */
    exitComposite_range_partitions?: (ctx: Composite_range_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.composite_list_partitions`.
     * @param ctx the parse tree
     */
    enterComposite_list_partitions?: (ctx: Composite_list_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.composite_list_partitions`.
     * @param ctx the parse tree
     */
    exitComposite_list_partitions?: (ctx: Composite_list_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.composite_hash_partitions`.
     * @param ctx the parse tree
     */
    enterComposite_hash_partitions?: (ctx: Composite_hash_partitionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.composite_hash_partitions`.
     * @param ctx the parse tree
     */
    exitComposite_hash_partitions?: (ctx: Composite_hash_partitionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.reference_partitioning`.
     * @param ctx the parse tree
     */
    enterReference_partitioning?: (ctx: Reference_partitioningContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.reference_partitioning`.
     * @param ctx the parse tree
     */
    exitReference_partitioning?: (ctx: Reference_partitioningContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.reference_partition_desc`.
     * @param ctx the parse tree
     */
    enterReference_partition_desc?: (ctx: Reference_partition_descContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.reference_partition_desc`.
     * @param ctx the parse tree
     */
    exitReference_partition_desc?: (ctx: Reference_partition_descContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.system_partitioning`.
     * @param ctx the parse tree
     */
    enterSystem_partitioning?: (ctx: System_partitioningContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.system_partitioning`.
     * @param ctx the parse tree
     */
    exitSystem_partitioning?: (ctx: System_partitioningContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.range_partition_desc`.
     * @param ctx the parse tree
     */
    enterRange_partition_desc?: (ctx: Range_partition_descContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.range_partition_desc`.
     * @param ctx the parse tree
     */
    exitRange_partition_desc?: (ctx: Range_partition_descContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.list_partition_desc`.
     * @param ctx the parse tree
     */
    enterList_partition_desc?: (ctx: List_partition_descContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.list_partition_desc`.
     * @param ctx the parse tree
     */
    exitList_partition_desc?: (ctx: List_partition_descContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_template`.
     * @param ctx the parse tree
     */
    enterSubpartition_template?: (ctx: Subpartition_templateContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_template`.
     * @param ctx the parse tree
     */
    exitSubpartition_template?: (ctx: Subpartition_templateContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hash_subpartition_quantity`.
     * @param ctx the parse tree
     */
    enterHash_subpartition_quantity?: (ctx: Hash_subpartition_quantityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hash_subpartition_quantity`.
     * @param ctx the parse tree
     */
    exitHash_subpartition_quantity?: (ctx: Hash_subpartition_quantityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_by_range`.
     * @param ctx the parse tree
     */
    enterSubpartition_by_range?: (ctx: Subpartition_by_rangeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_by_range`.
     * @param ctx the parse tree
     */
    exitSubpartition_by_range?: (ctx: Subpartition_by_rangeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_by_list`.
     * @param ctx the parse tree
     */
    enterSubpartition_by_list?: (ctx: Subpartition_by_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_by_list`.
     * @param ctx the parse tree
     */
    exitSubpartition_by_list?: (ctx: Subpartition_by_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_by_hash`.
     * @param ctx the parse tree
     */
    enterSubpartition_by_hash?: (ctx: Subpartition_by_hashContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_by_hash`.
     * @param ctx the parse tree
     */
    exitSubpartition_by_hash?: (ctx: Subpartition_by_hashContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_name`.
     * @param ctx the parse tree
     */
    enterSubpartition_name?: (ctx: Subpartition_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_name`.
     * @param ctx the parse tree
     */
    exitSubpartition_name?: (ctx: Subpartition_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.range_subpartition_desc`.
     * @param ctx the parse tree
     */
    enterRange_subpartition_desc?: (ctx: Range_subpartition_descContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.range_subpartition_desc`.
     * @param ctx the parse tree
     */
    exitRange_subpartition_desc?: (ctx: Range_subpartition_descContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.list_subpartition_desc`.
     * @param ctx the parse tree
     */
    enterList_subpartition_desc?: (ctx: List_subpartition_descContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.list_subpartition_desc`.
     * @param ctx the parse tree
     */
    exitList_subpartition_desc?: (ctx: List_subpartition_descContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.individual_hash_subparts`.
     * @param ctx the parse tree
     */
    enterIndividual_hash_subparts?: (ctx: Individual_hash_subpartsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.individual_hash_subparts`.
     * @param ctx the parse tree
     */
    exitIndividual_hash_subparts?: (ctx: Individual_hash_subpartsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hash_subparts_by_quantity`.
     * @param ctx the parse tree
     */
    enterHash_subparts_by_quantity?: (ctx: Hash_subparts_by_quantityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hash_subparts_by_quantity`.
     * @param ctx the parse tree
     */
    exitHash_subparts_by_quantity?: (ctx: Hash_subparts_by_quantityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.range_values_clause`.
     * @param ctx the parse tree
     */
    enterRange_values_clause?: (ctx: Range_values_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.range_values_clause`.
     * @param ctx the parse tree
     */
    exitRange_values_clause?: (ctx: Range_values_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.range_values_list`.
     * @param ctx the parse tree
     */
    enterRange_values_list?: (ctx: Range_values_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.range_values_list`.
     * @param ctx the parse tree
     */
    exitRange_values_list?: (ctx: Range_values_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.list_values_clause`.
     * @param ctx the parse tree
     */
    enterList_values_clause?: (ctx: List_values_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.list_values_clause`.
     * @param ctx the parse tree
     */
    exitList_values_clause?: (ctx: List_values_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_partition_description`.
     * @param ctx the parse tree
     */
    enterTable_partition_description?: (ctx: Table_partition_descriptionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_partition_description`.
     * @param ctx the parse tree
     */
    exitTable_partition_description?: (ctx: Table_partition_descriptionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partitioning_storage_clause`.
     * @param ctx the parse tree
     */
    enterPartitioning_storage_clause?: (ctx: Partitioning_storage_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partitioning_storage_clause`.
     * @param ctx the parse tree
     */
    exitPartitioning_storage_clause?: (ctx: Partitioning_storage_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_partitioning_storage`.
     * @param ctx the parse tree
     */
    enterLob_partitioning_storage?: (ctx: Lob_partitioning_storageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_partitioning_storage`.
     * @param ctx the parse tree
     */
    exitLob_partitioning_storage?: (ctx: Lob_partitioning_storageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.size_clause`.
     * @param ctx the parse tree
     */
    enterSize_clause?: (ctx: Size_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.size_clause`.
     * @param ctx the parse tree
     */
    exitSize_clause?: (ctx: Size_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_compression`.
     * @param ctx the parse tree
     */
    enterTable_compression?: (ctx: Table_compressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_compression`.
     * @param ctx the parse tree
     */
    exitTable_compression?: (ctx: Table_compressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_table_clause`.
     * @param ctx the parse tree
     */
    enterInmemory_table_clause?: (ctx: Inmemory_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_table_clause`.
     * @param ctx the parse tree
     */
    exitInmemory_table_clause?: (ctx: Inmemory_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_attributes`.
     * @param ctx the parse tree
     */
    enterInmemory_attributes?: (ctx: Inmemory_attributesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_attributes`.
     * @param ctx the parse tree
     */
    exitInmemory_attributes?: (ctx: Inmemory_attributesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_memcompress`.
     * @param ctx the parse tree
     */
    enterInmemory_memcompress?: (ctx: Inmemory_memcompressContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_memcompress`.
     * @param ctx the parse tree
     */
    exitInmemory_memcompress?: (ctx: Inmemory_memcompressContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_priority`.
     * @param ctx the parse tree
     */
    enterInmemory_priority?: (ctx: Inmemory_priorityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_priority`.
     * @param ctx the parse tree
     */
    exitInmemory_priority?: (ctx: Inmemory_priorityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_distribute`.
     * @param ctx the parse tree
     */
    enterInmemory_distribute?: (ctx: Inmemory_distributeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_distribute`.
     * @param ctx the parse tree
     */
    exitInmemory_distribute?: (ctx: Inmemory_distributeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_duplicate`.
     * @param ctx the parse tree
     */
    enterInmemory_duplicate?: (ctx: Inmemory_duplicateContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_duplicate`.
     * @param ctx the parse tree
     */
    exitInmemory_duplicate?: (ctx: Inmemory_duplicateContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inmemory_column_clause`.
     * @param ctx the parse tree
     */
    enterInmemory_column_clause?: (ctx: Inmemory_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inmemory_column_clause`.
     * @param ctx the parse tree
     */
    exitInmemory_column_clause?: (ctx: Inmemory_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.physical_attributes_clause`.
     * @param ctx the parse tree
     */
    enterPhysical_attributes_clause?: (ctx: Physical_attributes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.physical_attributes_clause`.
     * @param ctx the parse tree
     */
    exitPhysical_attributes_clause?: (ctx: Physical_attributes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.storage_clause`.
     * @param ctx the parse tree
     */
    enterStorage_clause?: (ctx: Storage_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.storage_clause`.
     * @param ctx the parse tree
     */
    exitStorage_clause?: (ctx: Storage_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.deferred_segment_creation`.
     * @param ctx the parse tree
     */
    enterDeferred_segment_creation?: (ctx: Deferred_segment_creationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.deferred_segment_creation`.
     * @param ctx the parse tree
     */
    exitDeferred_segment_creation?: (ctx: Deferred_segment_creationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.segment_attributes_clause`.
     * @param ctx the parse tree
     */
    enterSegment_attributes_clause?: (ctx: Segment_attributes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.segment_attributes_clause`.
     * @param ctx the parse tree
     */
    exitSegment_attributes_clause?: (ctx: Segment_attributes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.physical_properties`.
     * @param ctx the parse tree
     */
    enterPhysical_properties?: (ctx: Physical_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.physical_properties`.
     * @param ctx the parse tree
     */
    exitPhysical_properties?: (ctx: Physical_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_clause`.
     * @param ctx the parse tree
     */
    enterIlm_clause?: (ctx: Ilm_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_clause`.
     * @param ctx the parse tree
     */
    exitIlm_clause?: (ctx: Ilm_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_policy_clause`.
     * @param ctx the parse tree
     */
    enterIlm_policy_clause?: (ctx: Ilm_policy_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_policy_clause`.
     * @param ctx the parse tree
     */
    exitIlm_policy_clause?: (ctx: Ilm_policy_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_compression_policy`.
     * @param ctx the parse tree
     */
    enterIlm_compression_policy?: (ctx: Ilm_compression_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_compression_policy`.
     * @param ctx the parse tree
     */
    exitIlm_compression_policy?: (ctx: Ilm_compression_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_tiering_policy`.
     * @param ctx the parse tree
     */
    enterIlm_tiering_policy?: (ctx: Ilm_tiering_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_tiering_policy`.
     * @param ctx the parse tree
     */
    exitIlm_tiering_policy?: (ctx: Ilm_tiering_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_after_on`.
     * @param ctx the parse tree
     */
    enterIlm_after_on?: (ctx: Ilm_after_onContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_after_on`.
     * @param ctx the parse tree
     */
    exitIlm_after_on?: (ctx: Ilm_after_onContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.segment_group`.
     * @param ctx the parse tree
     */
    enterSegment_group?: (ctx: Segment_groupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.segment_group`.
     * @param ctx the parse tree
     */
    exitSegment_group?: (ctx: Segment_groupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_inmemory_policy`.
     * @param ctx the parse tree
     */
    enterIlm_inmemory_policy?: (ctx: Ilm_inmemory_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_inmemory_policy`.
     * @param ctx the parse tree
     */
    exitIlm_inmemory_policy?: (ctx: Ilm_inmemory_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ilm_time_period`.
     * @param ctx the parse tree
     */
    enterIlm_time_period?: (ctx: Ilm_time_periodContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ilm_time_period`.
     * @param ctx the parse tree
     */
    exitIlm_time_period?: (ctx: Ilm_time_periodContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.heap_org_table_clause`.
     * @param ctx the parse tree
     */
    enterHeap_org_table_clause?: (ctx: Heap_org_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.heap_org_table_clause`.
     * @param ctx the parse tree
     */
    exitHeap_org_table_clause?: (ctx: Heap_org_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_clause?: (ctx: External_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_clause?: (ctx: External_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.access_driver_type`.
     * @param ctx the parse tree
     */
    enterAccess_driver_type?: (ctx: Access_driver_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.access_driver_type`.
     * @param ctx the parse tree
     */
    exitAccess_driver_type?: (ctx: Access_driver_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_data_props`.
     * @param ctx the parse tree
     */
    enterExternal_table_data_props?: (ctx: External_table_data_propsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_data_props`.
     * @param ctx the parse tree
     */
    exitExternal_table_data_props?: (ctx: External_table_data_propsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_data_format`.
     * @param ctx the parse tree
     */
    enterExternal_table_data_format?: (ctx: External_table_data_formatContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_data_format`.
     * @param ctx the parse tree
     */
    exitExternal_table_data_format?: (ctx: External_table_data_formatContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_transform`.
     * @param ctx the parse tree
     */
    enterExternal_table_transform?: (ctx: External_table_transformContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_transform`.
     * @param ctx the parse tree
     */
    exitExternal_table_transform?: (ctx: External_table_transformContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_field`.
     * @param ctx the parse tree
     */
    enterExternal_table_field?: (ctx: External_table_fieldContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_field`.
     * @param ctx the parse tree
     */
    exitExternal_table_field?: (ctx: External_table_fieldContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_field_list`.
     * @param ctx the parse tree
     */
    enterExternal_table_field_list?: (ctx: External_table_field_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_field_list`.
     * @param ctx the parse tree
     */
    exitExternal_table_field_list?: (ctx: External_table_field_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_fields_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_fields_clause?: (ctx: External_table_fields_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_fields_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_fields_clause?: (ctx: External_table_fields_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_position_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_position_clause?: (ctx: External_table_position_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_position_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_position_clause?: (ctx: External_table_position_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_datatype_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_datatype_clause?: (ctx: External_table_datatype_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_datatype_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_datatype_clause?: (ctx: External_table_datatype_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_delimit_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_delimit_clause?: (ctx: External_table_delimit_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_delimit_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_delimit_clause?: (ctx: External_table_delimit_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_trim_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_trim_clause?: (ctx: External_table_trim_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_trim_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_trim_clause?: (ctx: External_table_trim_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_date_format_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_date_format_clause?: (ctx: External_table_date_format_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_date_format_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_date_format_clause?: (ctx: External_table_date_format_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_init_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_init_clause?: (ctx: External_table_init_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_init_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_init_clause?: (ctx: External_table_init_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_condition_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_condition_clause?: (ctx: External_table_condition_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_condition_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_condition_clause?: (ctx: External_table_condition_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_lls_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_lls_clause?: (ctx: External_table_lls_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_lls_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_lls_clause?: (ctx: External_table_lls_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_records`.
     * @param ctx the parse tree
     */
    enterExternal_table_records?: (ctx: External_table_recordsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_records`.
     * @param ctx the parse tree
     */
    exitExternal_table_records?: (ctx: External_table_recordsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_record_options_clause`.
     * @param ctx the parse tree
     */
    enterExternal_table_record_options_clause?: (ctx: External_table_record_options_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_record_options_clause`.
     * @param ctx the parse tree
     */
    exitExternal_table_record_options_clause?: (ctx: External_table_record_options_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_output_files`.
     * @param ctx the parse tree
     */
    enterExternal_table_output_files?: (ctx: External_table_output_filesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_output_files`.
     * @param ctx the parse tree
     */
    exitExternal_table_output_files?: (ctx: External_table_output_filesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_fields`.
     * @param ctx the parse tree
     */
    enterExternal_table_fields?: (ctx: External_table_fieldsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_fields`.
     * @param ctx the parse tree
     */
    exitExternal_table_fields?: (ctx: External_table_fieldsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_datapump`.
     * @param ctx the parse tree
     */
    enterExternal_table_datapump?: (ctx: External_table_datapumpContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_datapump`.
     * @param ctx the parse tree
     */
    exitExternal_table_datapump?: (ctx: External_table_datapumpContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_hive`.
     * @param ctx the parse tree
     */
    enterExternal_table_hive?: (ctx: External_table_hiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_hive`.
     * @param ctx the parse tree
     */
    exitExternal_table_hive?: (ctx: External_table_hiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_hive_parameter_map`.
     * @param ctx the parse tree
     */
    enterExternal_table_hive_parameter_map?: (ctx: External_table_hive_parameter_mapContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_hive_parameter_map`.
     * @param ctx the parse tree
     */
    exitExternal_table_hive_parameter_map?: (ctx: External_table_hive_parameter_mapContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_hive_parameter_map_entry`.
     * @param ctx the parse tree
     */
    enterExternal_table_hive_parameter_map_entry?: (ctx: External_table_hive_parameter_map_entryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_hive_parameter_map_entry`.
     * @param ctx the parse tree
     */
    exitExternal_table_hive_parameter_map_entry?: (ctx: External_table_hive_parameter_map_entryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.external_table_directory`.
     * @param ctx the parse tree
     */
    enterExternal_table_directory?: (ctx: External_table_directoryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.external_table_directory`.
     * @param ctx the parse tree
     */
    exitExternal_table_directory?: (ctx: External_table_directoryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.row_movement_clause`.
     * @param ctx the parse tree
     */
    enterRow_movement_clause?: (ctx: Row_movement_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.row_movement_clause`.
     * @param ctx the parse tree
     */
    exitRow_movement_clause?: (ctx: Row_movement_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_archive_clause`.
     * @param ctx the parse tree
     */
    enterFlashback_archive_clause?: (ctx: Flashback_archive_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_archive_clause`.
     * @param ctx the parse tree
     */
    exitFlashback_archive_clause?: (ctx: Flashback_archive_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.log_grp`.
     * @param ctx the parse tree
     */
    enterLog_grp?: (ctx: Log_grpContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.log_grp`.
     * @param ctx the parse tree
     */
    exitLog_grp?: (ctx: Log_grpContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_table_logging`.
     * @param ctx the parse tree
     */
    enterSupplemental_table_logging?: (ctx: Supplemental_table_loggingContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_table_logging`.
     * @param ctx the parse tree
     */
    exitSupplemental_table_logging?: (ctx: Supplemental_table_loggingContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_log_grp_clause`.
     * @param ctx the parse tree
     */
    enterSupplemental_log_grp_clause?: (ctx: Supplemental_log_grp_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_log_grp_clause`.
     * @param ctx the parse tree
     */
    exitSupplemental_log_grp_clause?: (ctx: Supplemental_log_grp_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_id_key_clause`.
     * @param ctx the parse tree
     */
    enterSupplemental_id_key_clause?: (ctx: Supplemental_id_key_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_id_key_clause`.
     * @param ctx the parse tree
     */
    exitSupplemental_id_key_clause?: (ctx: Supplemental_id_key_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.allocate_extent_clause`.
     * @param ctx the parse tree
     */
    enterAllocate_extent_clause?: (ctx: Allocate_extent_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.allocate_extent_clause`.
     * @param ctx the parse tree
     */
    exitAllocate_extent_clause?: (ctx: Allocate_extent_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.deallocate_unused_clause`.
     * @param ctx the parse tree
     */
    enterDeallocate_unused_clause?: (ctx: Deallocate_unused_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.deallocate_unused_clause`.
     * @param ctx the parse tree
     */
    exitDeallocate_unused_clause?: (ctx: Deallocate_unused_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.shrink_clause`.
     * @param ctx the parse tree
     */
    enterShrink_clause?: (ctx: Shrink_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.shrink_clause`.
     * @param ctx the parse tree
     */
    exitShrink_clause?: (ctx: Shrink_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.records_per_block_clause`.
     * @param ctx the parse tree
     */
    enterRecords_per_block_clause?: (ctx: Records_per_block_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.records_per_block_clause`.
     * @param ctx the parse tree
     */
    exitRecords_per_block_clause?: (ctx: Records_per_block_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.upgrade_table_clause`.
     * @param ctx the parse tree
     */
    enterUpgrade_table_clause?: (ctx: Upgrade_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.upgrade_table_clause`.
     * @param ctx the parse tree
     */
    exitUpgrade_table_clause?: (ctx: Upgrade_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.truncate_table`.
     * @param ctx the parse tree
     */
    enterTruncate_table?: (ctx: Truncate_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.truncate_table`.
     * @param ctx the parse tree
     */
    exitTruncate_table?: (ctx: Truncate_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_table`.
     * @param ctx the parse tree
     */
    enterDrop_table?: (ctx: Drop_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_table`.
     * @param ctx the parse tree
     */
    exitDrop_table?: (ctx: Drop_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_tablespace`.
     * @param ctx the parse tree
     */
    enterDrop_tablespace?: (ctx: Drop_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_tablespace`.
     * @param ctx the parse tree
     */
    exitDrop_tablespace?: (ctx: Drop_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_tablespace_set`.
     * @param ctx the parse tree
     */
    enterDrop_tablespace_set?: (ctx: Drop_tablespace_setContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_tablespace_set`.
     * @param ctx the parse tree
     */
    exitDrop_tablespace_set?: (ctx: Drop_tablespace_setContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.including_contents_clause`.
     * @param ctx the parse tree
     */
    enterIncluding_contents_clause?: (ctx: Including_contents_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.including_contents_clause`.
     * @param ctx the parse tree
     */
    exitIncluding_contents_clause?: (ctx: Including_contents_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_view`.
     * @param ctx the parse tree
     */
    enterDrop_view?: (ctx: Drop_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_view`.
     * @param ctx the parse tree
     */
    exitDrop_view?: (ctx: Drop_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.comment_on_column`.
     * @param ctx the parse tree
     */
    enterComment_on_column?: (ctx: Comment_on_columnContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.comment_on_column`.
     * @param ctx the parse tree
     */
    exitComment_on_column?: (ctx: Comment_on_columnContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.enable_or_disable`.
     * @param ctx the parse tree
     */
    enterEnable_or_disable?: (ctx: Enable_or_disableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.enable_or_disable`.
     * @param ctx the parse tree
     */
    exitEnable_or_disable?: (ctx: Enable_or_disableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.allow_or_disallow`.
     * @param ctx the parse tree
     */
    enterAllow_or_disallow?: (ctx: Allow_or_disallowContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.allow_or_disallow`.
     * @param ctx the parse tree
     */
    exitAllow_or_disallow?: (ctx: Allow_or_disallowContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_synonym`.
     * @param ctx the parse tree
     */
    enterAlter_synonym?: (ctx: Alter_synonymContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_synonym`.
     * @param ctx the parse tree
     */
    exitAlter_synonym?: (ctx: Alter_synonymContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_synonym`.
     * @param ctx the parse tree
     */
    enterCreate_synonym?: (ctx: Create_synonymContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_synonym`.
     * @param ctx the parse tree
     */
    exitCreate_synonym?: (ctx: Create_synonymContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_synonym`.
     * @param ctx the parse tree
     */
    enterDrop_synonym?: (ctx: Drop_synonymContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_synonym`.
     * @param ctx the parse tree
     */
    exitDrop_synonym?: (ctx: Drop_synonymContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_spfile`.
     * @param ctx the parse tree
     */
    enterCreate_spfile?: (ctx: Create_spfileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_spfile`.
     * @param ctx the parse tree
     */
    exitCreate_spfile?: (ctx: Create_spfileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.spfile_name`.
     * @param ctx the parse tree
     */
    enterSpfile_name?: (ctx: Spfile_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.spfile_name`.
     * @param ctx the parse tree
     */
    exitSpfile_name?: (ctx: Spfile_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pfile_name`.
     * @param ctx the parse tree
     */
    enterPfile_name?: (ctx: Pfile_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pfile_name`.
     * @param ctx the parse tree
     */
    exitPfile_name?: (ctx: Pfile_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.comment_on_table`.
     * @param ctx the parse tree
     */
    enterComment_on_table?: (ctx: Comment_on_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.comment_on_table`.
     * @param ctx the parse tree
     */
    exitComment_on_table?: (ctx: Comment_on_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.comment_on_materialized`.
     * @param ctx the parse tree
     */
    enterComment_on_materialized?: (ctx: Comment_on_materializedContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.comment_on_materialized`.
     * @param ctx the parse tree
     */
    exitComment_on_materialized?: (ctx: Comment_on_materializedContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_analytic_view`.
     * @param ctx the parse tree
     */
    enterAlter_analytic_view?: (ctx: Alter_analytic_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_analytic_view`.
     * @param ctx the parse tree
     */
    exitAlter_analytic_view?: (ctx: Alter_analytic_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_add_cache_clause`.
     * @param ctx the parse tree
     */
    enterAlter_add_cache_clause?: (ctx: Alter_add_cache_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_add_cache_clause`.
     * @param ctx the parse tree
     */
    exitAlter_add_cache_clause?: (ctx: Alter_add_cache_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.levels_item`.
     * @param ctx the parse tree
     */
    enterLevels_item?: (ctx: Levels_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.levels_item`.
     * @param ctx the parse tree
     */
    exitLevels_item?: (ctx: Levels_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.measure_list`.
     * @param ctx the parse tree
     */
    enterMeasure_list?: (ctx: Measure_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.measure_list`.
     * @param ctx the parse tree
     */
    exitMeasure_list?: (ctx: Measure_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_drop_cache_clause`.
     * @param ctx the parse tree
     */
    enterAlter_drop_cache_clause?: (ctx: Alter_drop_cache_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_drop_cache_clause`.
     * @param ctx the parse tree
     */
    exitAlter_drop_cache_clause?: (ctx: Alter_drop_cache_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_attribute_dimension`.
     * @param ctx the parse tree
     */
    enterAlter_attribute_dimension?: (ctx: Alter_attribute_dimensionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_attribute_dimension`.
     * @param ctx the parse tree
     */
    exitAlter_attribute_dimension?: (ctx: Alter_attribute_dimensionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_audit_policy`.
     * @param ctx the parse tree
     */
    enterAlter_audit_policy?: (ctx: Alter_audit_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_audit_policy`.
     * @param ctx the parse tree
     */
    exitAlter_audit_policy?: (ctx: Alter_audit_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_cluster`.
     * @param ctx the parse tree
     */
    enterAlter_cluster?: (ctx: Alter_clusterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_cluster`.
     * @param ctx the parse tree
     */
    exitAlter_cluster?: (ctx: Alter_clusterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_analytic_view`.
     * @param ctx the parse tree
     */
    enterDrop_analytic_view?: (ctx: Drop_analytic_viewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_analytic_view`.
     * @param ctx the parse tree
     */
    exitDrop_analytic_view?: (ctx: Drop_analytic_viewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_attribute_dimension`.
     * @param ctx the parse tree
     */
    enterDrop_attribute_dimension?: (ctx: Drop_attribute_dimensionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_attribute_dimension`.
     * @param ctx the parse tree
     */
    exitDrop_attribute_dimension?: (ctx: Drop_attribute_dimensionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_audit_policy`.
     * @param ctx the parse tree
     */
    enterDrop_audit_policy?: (ctx: Drop_audit_policyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_audit_policy`.
     * @param ctx the parse tree
     */
    exitDrop_audit_policy?: (ctx: Drop_audit_policyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_flashback_archive`.
     * @param ctx the parse tree
     */
    enterDrop_flashback_archive?: (ctx: Drop_flashback_archiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_flashback_archive`.
     * @param ctx the parse tree
     */
    exitDrop_flashback_archive?: (ctx: Drop_flashback_archiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_cluster`.
     * @param ctx the parse tree
     */
    enterDrop_cluster?: (ctx: Drop_clusterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_cluster`.
     * @param ctx the parse tree
     */
    exitDrop_cluster?: (ctx: Drop_clusterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_context`.
     * @param ctx the parse tree
     */
    enterDrop_context?: (ctx: Drop_contextContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_context`.
     * @param ctx the parse tree
     */
    exitDrop_context?: (ctx: Drop_contextContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_directory`.
     * @param ctx the parse tree
     */
    enterDrop_directory?: (ctx: Drop_directoryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_directory`.
     * @param ctx the parse tree
     */
    exitDrop_directory?: (ctx: Drop_directoryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_diskgroup`.
     * @param ctx the parse tree
     */
    enterDrop_diskgroup?: (ctx: Drop_diskgroupContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_diskgroup`.
     * @param ctx the parse tree
     */
    exitDrop_diskgroup?: (ctx: Drop_diskgroupContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_edition`.
     * @param ctx the parse tree
     */
    enterDrop_edition?: (ctx: Drop_editionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_edition`.
     * @param ctx the parse tree
     */
    exitDrop_edition?: (ctx: Drop_editionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.truncate_cluster`.
     * @param ctx the parse tree
     */
    enterTruncate_cluster?: (ctx: Truncate_clusterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.truncate_cluster`.
     * @param ctx the parse tree
     */
    exitTruncate_cluster?: (ctx: Truncate_clusterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cache_or_nocache`.
     * @param ctx the parse tree
     */
    enterCache_or_nocache?: (ctx: Cache_or_nocacheContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cache_or_nocache`.
     * @param ctx the parse tree
     */
    exitCache_or_nocache?: (ctx: Cache_or_nocacheContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database_name`.
     * @param ctx the parse tree
     */
    enterDatabase_name?: (ctx: Database_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database_name`.
     * @param ctx the parse tree
     */
    exitDatabase_name?: (ctx: Database_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_database`.
     * @param ctx the parse tree
     */
    enterAlter_database?: (ctx: Alter_databaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_database`.
     * @param ctx the parse tree
     */
    exitAlter_database?: (ctx: Alter_databaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database_clause`.
     * @param ctx the parse tree
     */
    enterDatabase_clause?: (ctx: Database_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database_clause`.
     * @param ctx the parse tree
     */
    exitDatabase_clause?: (ctx: Database_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.startup_clauses`.
     * @param ctx the parse tree
     */
    enterStartup_clauses?: (ctx: Startup_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.startup_clauses`.
     * @param ctx the parse tree
     */
    exitStartup_clauses?: (ctx: Startup_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.resetlogs_or_noresetlogs`.
     * @param ctx the parse tree
     */
    enterResetlogs_or_noresetlogs?: (ctx: Resetlogs_or_noresetlogsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.resetlogs_or_noresetlogs`.
     * @param ctx the parse tree
     */
    exitResetlogs_or_noresetlogs?: (ctx: Resetlogs_or_noresetlogsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.upgrade_or_downgrade`.
     * @param ctx the parse tree
     */
    enterUpgrade_or_downgrade?: (ctx: Upgrade_or_downgradeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.upgrade_or_downgrade`.
     * @param ctx the parse tree
     */
    exitUpgrade_or_downgrade?: (ctx: Upgrade_or_downgradeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.recovery_clauses`.
     * @param ctx the parse tree
     */
    enterRecovery_clauses?: (ctx: Recovery_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.recovery_clauses`.
     * @param ctx the parse tree
     */
    exitRecovery_clauses?: (ctx: Recovery_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.begin_or_end`.
     * @param ctx the parse tree
     */
    enterBegin_or_end?: (ctx: Begin_or_endContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.begin_or_end`.
     * @param ctx the parse tree
     */
    exitBegin_or_end?: (ctx: Begin_or_endContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.general_recovery`.
     * @param ctx the parse tree
     */
    enterGeneral_recovery?: (ctx: General_recoveryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.general_recovery`.
     * @param ctx the parse tree
     */
    exitGeneral_recovery?: (ctx: General_recoveryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.full_database_recovery`.
     * @param ctx the parse tree
     */
    enterFull_database_recovery?: (ctx: Full_database_recoveryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.full_database_recovery`.
     * @param ctx the parse tree
     */
    exitFull_database_recovery?: (ctx: Full_database_recoveryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partial_database_recovery`.
     * @param ctx the parse tree
     */
    enterPartial_database_recovery?: (ctx: Partial_database_recoveryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partial_database_recovery`.
     * @param ctx the parse tree
     */
    exitPartial_database_recovery?: (ctx: Partial_database_recoveryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partial_database_recovery_10g`.
     * @param ctx the parse tree
     */
    enterPartial_database_recovery_10g?: (ctx: Partial_database_recovery_10gContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partial_database_recovery_10g`.
     * @param ctx the parse tree
     */
    exitPartial_database_recovery_10g?: (ctx: Partial_database_recovery_10gContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.managed_standby_recovery`.
     * @param ctx the parse tree
     */
    enterManaged_standby_recovery?: (ctx: Managed_standby_recoveryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.managed_standby_recovery`.
     * @param ctx the parse tree
     */
    exitManaged_standby_recovery?: (ctx: Managed_standby_recoveryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.db_name`.
     * @param ctx the parse tree
     */
    enterDb_name?: (ctx: Db_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.db_name`.
     * @param ctx the parse tree
     */
    exitDb_name?: (ctx: Db_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database_file_clauses`.
     * @param ctx the parse tree
     */
    enterDatabase_file_clauses?: (ctx: Database_file_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database_file_clauses`.
     * @param ctx the parse tree
     */
    exitDatabase_file_clauses?: (ctx: Database_file_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_datafile_clause`.
     * @param ctx the parse tree
     */
    enterCreate_datafile_clause?: (ctx: Create_datafile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_datafile_clause`.
     * @param ctx the parse tree
     */
    exitCreate_datafile_clause?: (ctx: Create_datafile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_datafile_clause`.
     * @param ctx the parse tree
     */
    enterAlter_datafile_clause?: (ctx: Alter_datafile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_datafile_clause`.
     * @param ctx the parse tree
     */
    exitAlter_datafile_clause?: (ctx: Alter_datafile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_tempfile_clause`.
     * @param ctx the parse tree
     */
    enterAlter_tempfile_clause?: (ctx: Alter_tempfile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_tempfile_clause`.
     * @param ctx the parse tree
     */
    exitAlter_tempfile_clause?: (ctx: Alter_tempfile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_datafile_clause`.
     * @param ctx the parse tree
     */
    enterMove_datafile_clause?: (ctx: Move_datafile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_datafile_clause`.
     * @param ctx the parse tree
     */
    exitMove_datafile_clause?: (ctx: Move_datafile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logfile_clauses`.
     * @param ctx the parse tree
     */
    enterLogfile_clauses?: (ctx: Logfile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logfile_clauses`.
     * @param ctx the parse tree
     */
    exitLogfile_clauses?: (ctx: Logfile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_logfile_clauses`.
     * @param ctx the parse tree
     */
    enterAdd_logfile_clauses?: (ctx: Add_logfile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_logfile_clauses`.
     * @param ctx the parse tree
     */
    exitAdd_logfile_clauses?: (ctx: Add_logfile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.group_redo_logfile`.
     * @param ctx the parse tree
     */
    enterGroup_redo_logfile?: (ctx: Group_redo_logfileContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.group_redo_logfile`.
     * @param ctx the parse tree
     */
    exitGroup_redo_logfile?: (ctx: Group_redo_logfileContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_logfile_clauses`.
     * @param ctx the parse tree
     */
    enterDrop_logfile_clauses?: (ctx: Drop_logfile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_logfile_clauses`.
     * @param ctx the parse tree
     */
    exitDrop_logfile_clauses?: (ctx: Drop_logfile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.switch_logfile_clause`.
     * @param ctx the parse tree
     */
    enterSwitch_logfile_clause?: (ctx: Switch_logfile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.switch_logfile_clause`.
     * @param ctx the parse tree
     */
    exitSwitch_logfile_clause?: (ctx: Switch_logfile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_db_logging`.
     * @param ctx the parse tree
     */
    enterSupplemental_db_logging?: (ctx: Supplemental_db_loggingContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_db_logging`.
     * @param ctx the parse tree
     */
    exitSupplemental_db_logging?: (ctx: Supplemental_db_loggingContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_or_drop`.
     * @param ctx the parse tree
     */
    enterAdd_or_drop?: (ctx: Add_or_dropContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_or_drop`.
     * @param ctx the parse tree
     */
    exitAdd_or_drop?: (ctx: Add_or_dropContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_plsql_clause`.
     * @param ctx the parse tree
     */
    enterSupplemental_plsql_clause?: (ctx: Supplemental_plsql_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_plsql_clause`.
     * @param ctx the parse tree
     */
    exitSupplemental_plsql_clause?: (ctx: Supplemental_plsql_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logfile_descriptor`.
     * @param ctx the parse tree
     */
    enterLogfile_descriptor?: (ctx: Logfile_descriptorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logfile_descriptor`.
     * @param ctx the parse tree
     */
    exitLogfile_descriptor?: (ctx: Logfile_descriptorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.controlfile_clauses`.
     * @param ctx the parse tree
     */
    enterControlfile_clauses?: (ctx: Controlfile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.controlfile_clauses`.
     * @param ctx the parse tree
     */
    exitControlfile_clauses?: (ctx: Controlfile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trace_file_clause`.
     * @param ctx the parse tree
     */
    enterTrace_file_clause?: (ctx: Trace_file_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trace_file_clause`.
     * @param ctx the parse tree
     */
    exitTrace_file_clause?: (ctx: Trace_file_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.standby_database_clauses`.
     * @param ctx the parse tree
     */
    enterStandby_database_clauses?: (ctx: Standby_database_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.standby_database_clauses`.
     * @param ctx the parse tree
     */
    exitStandby_database_clauses?: (ctx: Standby_database_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.activate_standby_db_clause`.
     * @param ctx the parse tree
     */
    enterActivate_standby_db_clause?: (ctx: Activate_standby_db_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.activate_standby_db_clause`.
     * @param ctx the parse tree
     */
    exitActivate_standby_db_clause?: (ctx: Activate_standby_db_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.maximize_standby_db_clause`.
     * @param ctx the parse tree
     */
    enterMaximize_standby_db_clause?: (ctx: Maximize_standby_db_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.maximize_standby_db_clause`.
     * @param ctx the parse tree
     */
    exitMaximize_standby_db_clause?: (ctx: Maximize_standby_db_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.register_logfile_clause`.
     * @param ctx the parse tree
     */
    enterRegister_logfile_clause?: (ctx: Register_logfile_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.register_logfile_clause`.
     * @param ctx the parse tree
     */
    exitRegister_logfile_clause?: (ctx: Register_logfile_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.commit_switchover_clause`.
     * @param ctx the parse tree
     */
    enterCommit_switchover_clause?: (ctx: Commit_switchover_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.commit_switchover_clause`.
     * @param ctx the parse tree
     */
    exitCommit_switchover_clause?: (ctx: Commit_switchover_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.start_standby_clause`.
     * @param ctx the parse tree
     */
    enterStart_standby_clause?: (ctx: Start_standby_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.start_standby_clause`.
     * @param ctx the parse tree
     */
    exitStart_standby_clause?: (ctx: Start_standby_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.stop_standby_clause`.
     * @param ctx the parse tree
     */
    enterStop_standby_clause?: (ctx: Stop_standby_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.stop_standby_clause`.
     * @param ctx the parse tree
     */
    exitStop_standby_clause?: (ctx: Stop_standby_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.convert_database_clause`.
     * @param ctx the parse tree
     */
    enterConvert_database_clause?: (ctx: Convert_database_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.convert_database_clause`.
     * @param ctx the parse tree
     */
    exitConvert_database_clause?: (ctx: Convert_database_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_settings_clause`.
     * @param ctx the parse tree
     */
    enterDefault_settings_clause?: (ctx: Default_settings_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_settings_clause`.
     * @param ctx the parse tree
     */
    exitDefault_settings_clause?: (ctx: Default_settings_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_time_zone_clause`.
     * @param ctx the parse tree
     */
    enterSet_time_zone_clause?: (ctx: Set_time_zone_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_time_zone_clause`.
     * @param ctx the parse tree
     */
    exitSet_time_zone_clause?: (ctx: Set_time_zone_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.instance_clauses`.
     * @param ctx the parse tree
     */
    enterInstance_clauses?: (ctx: Instance_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.instance_clauses`.
     * @param ctx the parse tree
     */
    exitInstance_clauses?: (ctx: Instance_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.security_clause`.
     * @param ctx the parse tree
     */
    enterSecurity_clause?: (ctx: Security_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.security_clause`.
     * @param ctx the parse tree
     */
    exitSecurity_clause?: (ctx: Security_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.domain`.
     * @param ctx the parse tree
     */
    enterDomain?: (ctx: DomainContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.domain`.
     * @param ctx the parse tree
     */
    exitDomain?: (ctx: DomainContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database`.
     * @param ctx the parse tree
     */
    enterDatabase?: (ctx: DatabaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database`.
     * @param ctx the parse tree
     */
    exitDatabase?: (ctx: DatabaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.edition_name`.
     * @param ctx the parse tree
     */
    enterEdition_name?: (ctx: Edition_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.edition_name`.
     * @param ctx the parse tree
     */
    exitEdition_name?: (ctx: Edition_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filenumber`.
     * @param ctx the parse tree
     */
    enterFilenumber?: (ctx: FilenumberContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filenumber`.
     * @param ctx the parse tree
     */
    exitFilenumber?: (ctx: FilenumberContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filename`.
     * @param ctx the parse tree
     */
    enterFilename?: (ctx: FilenameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filename`.
     * @param ctx the parse tree
     */
    exitFilename?: (ctx: FilenameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.prepare_clause`.
     * @param ctx the parse tree
     */
    enterPrepare_clause?: (ctx: Prepare_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.prepare_clause`.
     * @param ctx the parse tree
     */
    exitPrepare_clause?: (ctx: Prepare_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_mirror_clause`.
     * @param ctx the parse tree
     */
    enterDrop_mirror_clause?: (ctx: Drop_mirror_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_mirror_clause`.
     * @param ctx the parse tree
     */
    exitDrop_mirror_clause?: (ctx: Drop_mirror_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lost_write_protection`.
     * @param ctx the parse tree
     */
    enterLost_write_protection?: (ctx: Lost_write_protectionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lost_write_protection`.
     * @param ctx the parse tree
     */
    exitLost_write_protection?: (ctx: Lost_write_protectionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cdb_fleet_clauses`.
     * @param ctx the parse tree
     */
    enterCdb_fleet_clauses?: (ctx: Cdb_fleet_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cdb_fleet_clauses`.
     * @param ctx the parse tree
     */
    exitCdb_fleet_clauses?: (ctx: Cdb_fleet_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lead_cdb_clause`.
     * @param ctx the parse tree
     */
    enterLead_cdb_clause?: (ctx: Lead_cdb_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lead_cdb_clause`.
     * @param ctx the parse tree
     */
    exitLead_cdb_clause?: (ctx: Lead_cdb_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lead_cdb_uri_clause`.
     * @param ctx the parse tree
     */
    enterLead_cdb_uri_clause?: (ctx: Lead_cdb_uri_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lead_cdb_uri_clause`.
     * @param ctx the parse tree
     */
    exitLead_cdb_uri_clause?: (ctx: Lead_cdb_uri_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.property_clauses`.
     * @param ctx the parse tree
     */
    enterProperty_clauses?: (ctx: Property_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.property_clauses`.
     * @param ctx the parse tree
     */
    exitProperty_clauses?: (ctx: Property_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.replay_upgrade_clauses`.
     * @param ctx the parse tree
     */
    enterReplay_upgrade_clauses?: (ctx: Replay_upgrade_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.replay_upgrade_clauses`.
     * @param ctx the parse tree
     */
    exitReplay_upgrade_clauses?: (ctx: Replay_upgrade_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_database_link`.
     * @param ctx the parse tree
     */
    enterAlter_database_link?: (ctx: Alter_database_linkContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_database_link`.
     * @param ctx the parse tree
     */
    exitAlter_database_link?: (ctx: Alter_database_linkContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.password_value`.
     * @param ctx the parse tree
     */
    enterPassword_value?: (ctx: Password_valueContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.password_value`.
     * @param ctx the parse tree
     */
    exitPassword_value?: (ctx: Password_valueContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.link_authentication`.
     * @param ctx the parse tree
     */
    enterLink_authentication?: (ctx: Link_authenticationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.link_authentication`.
     * @param ctx the parse tree
     */
    exitLink_authentication?: (ctx: Link_authenticationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_schema`.
     * @param ctx the parse tree
     */
    enterCreate_schema?: (ctx: Create_schemaContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_schema`.
     * @param ctx the parse tree
     */
    exitCreate_schema?: (ctx: Create_schemaContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_database`.
     * @param ctx the parse tree
     */
    enterCreate_database?: (ctx: Create_databaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_database`.
     * @param ctx the parse tree
     */
    exitCreate_database?: (ctx: Create_databaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database_logging_clauses`.
     * @param ctx the parse tree
     */
    enterDatabase_logging_clauses?: (ctx: Database_logging_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database_logging_clauses`.
     * @param ctx the parse tree
     */
    exitDatabase_logging_clauses?: (ctx: Database_logging_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.database_logging_sub_clause`.
     * @param ctx the parse tree
     */
    enterDatabase_logging_sub_clause?: (ctx: Database_logging_sub_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.database_logging_sub_clause`.
     * @param ctx the parse tree
     */
    exitDatabase_logging_sub_clause?: (ctx: Database_logging_sub_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_clauses`.
     * @param ctx the parse tree
     */
    enterTablespace_clauses?: (ctx: Tablespace_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_clauses`.
     * @param ctx the parse tree
     */
    exitTablespace_clauses?: (ctx: Tablespace_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.enable_pluggable_database`.
     * @param ctx the parse tree
     */
    enterEnable_pluggable_database?: (ctx: Enable_pluggable_databaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.enable_pluggable_database`.
     * @param ctx the parse tree
     */
    exitEnable_pluggable_database?: (ctx: Enable_pluggable_databaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.file_name_convert`.
     * @param ctx the parse tree
     */
    enterFile_name_convert?: (ctx: File_name_convertContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.file_name_convert`.
     * @param ctx the parse tree
     */
    exitFile_name_convert?: (ctx: File_name_convertContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filename_convert_sub_clause`.
     * @param ctx the parse tree
     */
    enterFilename_convert_sub_clause?: (ctx: Filename_convert_sub_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filename_convert_sub_clause`.
     * @param ctx the parse tree
     */
    exitFilename_convert_sub_clause?: (ctx: Filename_convert_sub_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace_datafile_clauses`.
     * @param ctx the parse tree
     */
    enterTablespace_datafile_clauses?: (ctx: Tablespace_datafile_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace_datafile_clauses`.
     * @param ctx the parse tree
     */
    exitTablespace_datafile_clauses?: (ctx: Tablespace_datafile_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.undo_mode_clause`.
     * @param ctx the parse tree
     */
    enterUndo_mode_clause?: (ctx: Undo_mode_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.undo_mode_clause`.
     * @param ctx the parse tree
     */
    exitUndo_mode_clause?: (ctx: Undo_mode_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_tablespace`.
     * @param ctx the parse tree
     */
    enterDefault_tablespace?: (ctx: Default_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_tablespace`.
     * @param ctx the parse tree
     */
    exitDefault_tablespace?: (ctx: Default_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_temp_tablespace`.
     * @param ctx the parse tree
     */
    enterDefault_temp_tablespace?: (ctx: Default_temp_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_temp_tablespace`.
     * @param ctx the parse tree
     */
    exitDefault_temp_tablespace?: (ctx: Default_temp_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.undo_tablespace`.
     * @param ctx the parse tree
     */
    enterUndo_tablespace?: (ctx: Undo_tablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.undo_tablespace`.
     * @param ctx the parse tree
     */
    exitUndo_tablespace?: (ctx: Undo_tablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_database`.
     * @param ctx the parse tree
     */
    enterDrop_database?: (ctx: Drop_databaseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_database`.
     * @param ctx the parse tree
     */
    exitDrop_database?: (ctx: Drop_databaseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.create_database_link`.
     * @param ctx the parse tree
     */
    enterCreate_database_link?: (ctx: Create_database_linkContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.create_database_link`.
     * @param ctx the parse tree
     */
    exitCreate_database_link?: (ctx: Create_database_linkContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_database_link`.
     * @param ctx the parse tree
     */
    enterDrop_database_link?: (ctx: Drop_database_linkContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_database_link`.
     * @param ctx the parse tree
     */
    exitDrop_database_link?: (ctx: Drop_database_linkContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_tablespace_set`.
     * @param ctx the parse tree
     */
    enterAlter_tablespace_set?: (ctx: Alter_tablespace_setContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_tablespace_set`.
     * @param ctx the parse tree
     */
    exitAlter_tablespace_set?: (ctx: Alter_tablespace_setContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_tablespace_attrs`.
     * @param ctx the parse tree
     */
    enterAlter_tablespace_attrs?: (ctx: Alter_tablespace_attrsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_tablespace_attrs`.
     * @param ctx the parse tree
     */
    exitAlter_tablespace_attrs?: (ctx: Alter_tablespace_attrsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_tablespace_encryption`.
     * @param ctx the parse tree
     */
    enterAlter_tablespace_encryption?: (ctx: Alter_tablespace_encryptionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_tablespace_encryption`.
     * @param ctx the parse tree
     */
    exitAlter_tablespace_encryption?: (ctx: Alter_tablespace_encryptionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ts_file_name_convert`.
     * @param ctx the parse tree
     */
    enterTs_file_name_convert?: (ctx: Ts_file_name_convertContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ts_file_name_convert`.
     * @param ctx the parse tree
     */
    exitTs_file_name_convert?: (ctx: Ts_file_name_convertContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_role`.
     * @param ctx the parse tree
     */
    enterAlter_role?: (ctx: Alter_roleContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_role`.
     * @param ctx the parse tree
     */
    exitAlter_role?: (ctx: Alter_roleContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.role_identified_clause`.
     * @param ctx the parse tree
     */
    enterRole_identified_clause?: (ctx: Role_identified_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.role_identified_clause`.
     * @param ctx the parse tree
     */
    exitRole_identified_clause?: (ctx: Role_identified_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table`.
     * @param ctx the parse tree
     */
    enterAlter_table?: (ctx: Alter_tableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table`.
     * @param ctx the parse tree
     */
    exitAlter_table?: (ctx: Alter_tableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table_body`.
     * @param ctx the parse tree
     */
    enterAlter_table_body?: (ctx: Alter_table_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table_body`.
     * @param ctx the parse tree
     */
    exitAlter_table_body?: (ctx: Alter_table_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table_action`.
     * @param ctx the parse tree
     */
    enterAlter_table_action?: (ctx: Alter_table_actionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table_action`.
     * @param ctx the parse tree
     */
    exitAlter_table_action?: (ctx: Alter_table_actionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.enable_disable_clauses`.
     * @param ctx the parse tree
     */
    enterEnable_disable_clauses?: (ctx: Enable_disable_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.enable_disable_clauses`.
     * @param ctx the parse tree
     */
    exitEnable_disable_clauses?: (ctx: Enable_disable_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.memoptimize_read_write_clause`.
     * @param ctx the parse tree
     */
    enterMemoptimize_read_write_clause?: (ctx: Memoptimize_read_write_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.memoptimize_read_write_clause`.
     * @param ctx the parse tree
     */
    exitMemoptimize_read_write_clause?: (ctx: Memoptimize_read_write_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table_properties`.
     * @param ctx the parse tree
     */
    enterAlter_table_properties?: (ctx: Alter_table_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table_properties`.
     * @param ctx the parse tree
     */
    exitAlter_table_properties?: (ctx: Alter_table_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table_partitioning`.
     * @param ctx the parse tree
     */
    enterAlter_table_partitioning?: (ctx: Alter_table_partitioningContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table_partitioning`.
     * @param ctx the parse tree
     */
    exitAlter_table_partitioning?: (ctx: Alter_table_partitioningContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_table_partition`.
     * @param ctx the parse tree
     */
    enterAdd_table_partition?: (ctx: Add_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_table_partition`.
     * @param ctx the parse tree
     */
    exitAdd_table_partition?: (ctx: Add_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_table_partition`.
     * @param ctx the parse tree
     */
    enterDrop_table_partition?: (ctx: Drop_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_table_partition`.
     * @param ctx the parse tree
     */
    exitDrop_table_partition?: (ctx: Drop_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_table_partition`.
     * @param ctx the parse tree
     */
    enterMerge_table_partition?: (ctx: Merge_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_table_partition`.
     * @param ctx the parse tree
     */
    exitMerge_table_partition?: (ctx: Merge_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_table_partition`.
     * @param ctx the parse tree
     */
    enterModify_table_partition?: (ctx: Modify_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_table_partition`.
     * @param ctx the parse tree
     */
    exitModify_table_partition?: (ctx: Modify_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.split_table_partition`.
     * @param ctx the parse tree
     */
    enterSplit_table_partition?: (ctx: Split_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.split_table_partition`.
     * @param ctx the parse tree
     */
    exitSplit_table_partition?: (ctx: Split_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.truncate_table_partition`.
     * @param ctx the parse tree
     */
    enterTruncate_table_partition?: (ctx: Truncate_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.truncate_table_partition`.
     * @param ctx the parse tree
     */
    exitTruncate_table_partition?: (ctx: Truncate_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exchange_table_partition`.
     * @param ctx the parse tree
     */
    enterExchange_table_partition?: (ctx: Exchange_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exchange_table_partition`.
     * @param ctx the parse tree
     */
    exitExchange_table_partition?: (ctx: Exchange_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.coalesce_table_partition`.
     * @param ctx the parse tree
     */
    enterCoalesce_table_partition?: (ctx: Coalesce_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.coalesce_table_partition`.
     * @param ctx the parse tree
     */
    exitCoalesce_table_partition?: (ctx: Coalesce_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_interval_partition`.
     * @param ctx the parse tree
     */
    enterAlter_interval_partition?: (ctx: Alter_interval_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_interval_partition`.
     * @param ctx the parse tree
     */
    exitAlter_interval_partition?: (ctx: Alter_interval_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_table_partition`.
     * @param ctx the parse tree
     */
    enterMove_table_partition?: (ctx: Move_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_table_partition`.
     * @param ctx the parse tree
     */
    exitMove_table_partition?: (ctx: Move_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filter_condition`.
     * @param ctx the parse tree
     */
    enterFilter_condition?: (ctx: Filter_conditionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filter_condition`.
     * @param ctx the parse tree
     */
    exitFilter_condition?: (ctx: Filter_conditionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rename_table_partition`.
     * @param ctx the parse tree
     */
    enterRename_table_partition?: (ctx: Rename_table_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rename_table_partition`.
     * @param ctx the parse tree
     */
    exitRename_table_partition?: (ctx: Rename_table_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_extended_names`.
     * @param ctx the parse tree
     */
    enterPartition_extended_names?: (ctx: Partition_extended_namesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_extended_names`.
     * @param ctx the parse tree
     */
    exitPartition_extended_names?: (ctx: Partition_extended_namesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subpartition_extended_names`.
     * @param ctx the parse tree
     */
    enterSubpartition_extended_names?: (ctx: Subpartition_extended_namesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subpartition_extended_names`.
     * @param ctx the parse tree
     */
    exitSubpartition_extended_names?: (ctx: Subpartition_extended_namesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_table_properties_1`.
     * @param ctx the parse tree
     */
    enterAlter_table_properties_1?: (ctx: Alter_table_properties_1Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_table_properties_1`.
     * @param ctx the parse tree
     */
    exitAlter_table_properties_1?: (ctx: Alter_table_properties_1Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_iot_clauses`.
     * @param ctx the parse tree
     */
    enterAlter_iot_clauses?: (ctx: Alter_iot_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_iot_clauses`.
     * @param ctx the parse tree
     */
    exitAlter_iot_clauses?: (ctx: Alter_iot_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_mapping_table_clause`.
     * @param ctx the parse tree
     */
    enterAlter_mapping_table_clause?: (ctx: Alter_mapping_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_mapping_table_clause`.
     * @param ctx the parse tree
     */
    exitAlter_mapping_table_clause?: (ctx: Alter_mapping_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.alter_overflow_clause`.
     * @param ctx the parse tree
     */
    enterAlter_overflow_clause?: (ctx: Alter_overflow_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.alter_overflow_clause`.
     * @param ctx the parse tree
     */
    exitAlter_overflow_clause?: (ctx: Alter_overflow_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_overflow_clause`.
     * @param ctx the parse tree
     */
    enterAdd_overflow_clause?: (ctx: Add_overflow_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_overflow_clause`.
     * @param ctx the parse tree
     */
    exitAdd_overflow_clause?: (ctx: Add_overflow_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_index_clauses`.
     * @param ctx the parse tree
     */
    enterUpdate_index_clauses?: (ctx: Update_index_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_index_clauses`.
     * @param ctx the parse tree
     */
    exitUpdate_index_clauses?: (ctx: Update_index_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_global_index_clause`.
     * @param ctx the parse tree
     */
    enterUpdate_global_index_clause?: (ctx: Update_global_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_global_index_clause`.
     * @param ctx the parse tree
     */
    exitUpdate_global_index_clause?: (ctx: Update_global_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_all_indexes_clause`.
     * @param ctx the parse tree
     */
    enterUpdate_all_indexes_clause?: (ctx: Update_all_indexes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_all_indexes_clause`.
     * @param ctx the parse tree
     */
    exitUpdate_all_indexes_clause?: (ctx: Update_all_indexes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_all_indexes_index_clause`.
     * @param ctx the parse tree
     */
    enterUpdate_all_indexes_index_clause?: (ctx: Update_all_indexes_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_all_indexes_index_clause`.
     * @param ctx the parse tree
     */
    exitUpdate_all_indexes_index_clause?: (ctx: Update_all_indexes_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_index_partition`.
     * @param ctx the parse tree
     */
    enterUpdate_index_partition?: (ctx: Update_index_partitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_index_partition`.
     * @param ctx the parse tree
     */
    exitUpdate_index_partition?: (ctx: Update_index_partitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_index_subpartition`.
     * @param ctx the parse tree
     */
    enterUpdate_index_subpartition?: (ctx: Update_index_subpartitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_index_subpartition`.
     * @param ctx the parse tree
     */
    exitUpdate_index_subpartition?: (ctx: Update_index_subpartitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.enable_disable_clause`.
     * @param ctx the parse tree
     */
    enterEnable_disable_clause?: (ctx: Enable_disable_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.enable_disable_clause`.
     * @param ctx the parse tree
     */
    exitEnable_disable_clause?: (ctx: Enable_disable_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_index_clause`.
     * @param ctx the parse tree
     */
    enterUsing_index_clause?: (ctx: Using_index_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_index_clause`.
     * @param ctx the parse tree
     */
    exitUsing_index_clause?: (ctx: Using_index_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_attributes`.
     * @param ctx the parse tree
     */
    enterIndex_attributes?: (ctx: Index_attributesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_attributes`.
     * @param ctx the parse tree
     */
    exitIndex_attributes?: (ctx: Index_attributesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sort_or_nosort`.
     * @param ctx the parse tree
     */
    enterSort_or_nosort?: (ctx: Sort_or_nosortContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sort_or_nosort`.
     * @param ctx the parse tree
     */
    exitSort_or_nosort?: (ctx: Sort_or_nosortContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exceptions_clause`.
     * @param ctx the parse tree
     */
    enterExceptions_clause?: (ctx: Exceptions_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exceptions_clause`.
     * @param ctx the parse tree
     */
    exitExceptions_clause?: (ctx: Exceptions_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.move_table_clause`.
     * @param ctx the parse tree
     */
    enterMove_table_clause?: (ctx: Move_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.move_table_clause`.
     * @param ctx the parse tree
     */
    exitMove_table_clause?: (ctx: Move_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_to_partitioned`.
     * @param ctx the parse tree
     */
    enterModify_to_partitioned?: (ctx: Modify_to_partitionedContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_to_partitioned`.
     * @param ctx the parse tree
     */
    exitModify_to_partitioned?: (ctx: Modify_to_partitionedContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_org_table_clause`.
     * @param ctx the parse tree
     */
    enterIndex_org_table_clause?: (ctx: Index_org_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_org_table_clause`.
     * @param ctx the parse tree
     */
    exitIndex_org_table_clause?: (ctx: Index_org_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.mapping_table_clause`.
     * @param ctx the parse tree
     */
    enterMapping_table_clause?: (ctx: Mapping_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.mapping_table_clause`.
     * @param ctx the parse tree
     */
    exitMapping_table_clause?: (ctx: Mapping_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.key_compression`.
     * @param ctx the parse tree
     */
    enterKey_compression?: (ctx: Key_compressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.key_compression`.
     * @param ctx the parse tree
     */
    exitKey_compression?: (ctx: Key_compressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_org_overflow_clause`.
     * @param ctx the parse tree
     */
    enterIndex_org_overflow_clause?: (ctx: Index_org_overflow_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_org_overflow_clause`.
     * @param ctx the parse tree
     */
    exitIndex_org_overflow_clause?: (ctx: Index_org_overflow_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_clauses`.
     * @param ctx the parse tree
     */
    enterColumn_clauses?: (ctx: Column_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_clauses`.
     * @param ctx the parse tree
     */
    exitColumn_clauses?: (ctx: Column_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_collection_retrieval`.
     * @param ctx the parse tree
     */
    enterModify_collection_retrieval?: (ctx: Modify_collection_retrievalContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_collection_retrieval`.
     * @param ctx the parse tree
     */
    exitModify_collection_retrieval?: (ctx: Modify_collection_retrievalContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.collection_item`.
     * @param ctx the parse tree
     */
    enterCollection_item?: (ctx: Collection_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.collection_item`.
     * @param ctx the parse tree
     */
    exitCollection_item?: (ctx: Collection_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rename_column_clause`.
     * @param ctx the parse tree
     */
    enterRename_column_clause?: (ctx: Rename_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rename_column_clause`.
     * @param ctx the parse tree
     */
    exitRename_column_clause?: (ctx: Rename_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.old_column_name`.
     * @param ctx the parse tree
     */
    enterOld_column_name?: (ctx: Old_column_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.old_column_name`.
     * @param ctx the parse tree
     */
    exitOld_column_name?: (ctx: Old_column_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_column_name`.
     * @param ctx the parse tree
     */
    enterNew_column_name?: (ctx: New_column_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_column_name`.
     * @param ctx the parse tree
     */
    exitNew_column_name?: (ctx: New_column_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_modify_drop_column_clauses`.
     * @param ctx the parse tree
     */
    enterAdd_modify_drop_column_clauses?: (ctx: Add_modify_drop_column_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_modify_drop_column_clauses`.
     * @param ctx the parse tree
     */
    exitAdd_modify_drop_column_clauses?: (ctx: Add_modify_drop_column_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_column_clause`.
     * @param ctx the parse tree
     */
    enterDrop_column_clause?: (ctx: Drop_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_column_clause`.
     * @param ctx the parse tree
     */
    exitDrop_column_clause?: (ctx: Drop_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_column_clauses`.
     * @param ctx the parse tree
     */
    enterModify_column_clauses?: (ctx: Modify_column_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_column_clauses`.
     * @param ctx the parse tree
     */
    exitModify_column_clauses?: (ctx: Modify_column_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_col_properties`.
     * @param ctx the parse tree
     */
    enterModify_col_properties?: (ctx: Modify_col_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_col_properties`.
     * @param ctx the parse tree
     */
    exitModify_col_properties?: (ctx: Modify_col_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_col_visibility`.
     * @param ctx the parse tree
     */
    enterModify_col_visibility?: (ctx: Modify_col_visibilityContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_col_visibility`.
     * @param ctx the parse tree
     */
    exitModify_col_visibility?: (ctx: Modify_col_visibilityContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_col_substitutable`.
     * @param ctx the parse tree
     */
    enterModify_col_substitutable?: (ctx: Modify_col_substitutableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_col_substitutable`.
     * @param ctx the parse tree
     */
    exitModify_col_substitutable?: (ctx: Modify_col_substitutableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_column_clause`.
     * @param ctx the parse tree
     */
    enterAdd_column_clause?: (ctx: Add_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_column_clause`.
     * @param ctx the parse tree
     */
    exitAdd_column_clause?: (ctx: Add_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.varray_col_properties`.
     * @param ctx the parse tree
     */
    enterVarray_col_properties?: (ctx: Varray_col_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.varray_col_properties`.
     * @param ctx the parse tree
     */
    exitVarray_col_properties?: (ctx: Varray_col_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.varray_storage_clause`.
     * @param ctx the parse tree
     */
    enterVarray_storage_clause?: (ctx: Varray_storage_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.varray_storage_clause`.
     * @param ctx the parse tree
     */
    exitVarray_storage_clause?: (ctx: Varray_storage_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_segname`.
     * @param ctx the parse tree
     */
    enterLob_segname?: (ctx: Lob_segnameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_segname`.
     * @param ctx the parse tree
     */
    exitLob_segname?: (ctx: Lob_segnameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_item`.
     * @param ctx the parse tree
     */
    enterLob_item?: (ctx: Lob_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_item`.
     * @param ctx the parse tree
     */
    exitLob_item?: (ctx: Lob_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_storage_parameters`.
     * @param ctx the parse tree
     */
    enterLob_storage_parameters?: (ctx: Lob_storage_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_storage_parameters`.
     * @param ctx the parse tree
     */
    exitLob_storage_parameters?: (ctx: Lob_storage_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_storage_clause`.
     * @param ctx the parse tree
     */
    enterLob_storage_clause?: (ctx: Lob_storage_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_storage_clause`.
     * @param ctx the parse tree
     */
    exitLob_storage_clause?: (ctx: Lob_storage_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_lob_storage_clause`.
     * @param ctx the parse tree
     */
    enterModify_lob_storage_clause?: (ctx: Modify_lob_storage_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_lob_storage_clause`.
     * @param ctx the parse tree
     */
    exitModify_lob_storage_clause?: (ctx: Modify_lob_storage_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.modify_lob_parameters`.
     * @param ctx the parse tree
     */
    enterModify_lob_parameters?: (ctx: Modify_lob_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.modify_lob_parameters`.
     * @param ctx the parse tree
     */
    exitModify_lob_parameters?: (ctx: Modify_lob_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_parameters`.
     * @param ctx the parse tree
     */
    enterLob_parameters?: (ctx: Lob_parametersContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_parameters`.
     * @param ctx the parse tree
     */
    exitLob_parameters?: (ctx: Lob_parametersContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_deduplicate_clause`.
     * @param ctx the parse tree
     */
    enterLob_deduplicate_clause?: (ctx: Lob_deduplicate_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_deduplicate_clause`.
     * @param ctx the parse tree
     */
    exitLob_deduplicate_clause?: (ctx: Lob_deduplicate_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_compression_clause`.
     * @param ctx the parse tree
     */
    enterLob_compression_clause?: (ctx: Lob_compression_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_compression_clause`.
     * @param ctx the parse tree
     */
    exitLob_compression_clause?: (ctx: Lob_compression_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_retention_clause`.
     * @param ctx the parse tree
     */
    enterLob_retention_clause?: (ctx: Lob_retention_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_retention_clause`.
     * @param ctx the parse tree
     */
    exitLob_retention_clause?: (ctx: Lob_retention_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.encryption_spec`.
     * @param ctx the parse tree
     */
    enterEncryption_spec?: (ctx: Encryption_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.encryption_spec`.
     * @param ctx the parse tree
     */
    exitEncryption_spec?: (ctx: Encryption_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tablespace`.
     * @param ctx the parse tree
     */
    enterTablespace?: (ctx: TablespaceContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tablespace`.
     * @param ctx the parse tree
     */
    exitTablespace?: (ctx: TablespaceContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.varray_item`.
     * @param ctx the parse tree
     */
    enterVarray_item?: (ctx: Varray_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.varray_item`.
     * @param ctx the parse tree
     */
    exitVarray_item?: (ctx: Varray_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_properties`.
     * @param ctx the parse tree
     */
    enterColumn_properties?: (ctx: Column_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_properties`.
     * @param ctx the parse tree
     */
    exitColumn_properties?: (ctx: Column_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lob_partition_storage`.
     * @param ctx the parse tree
     */
    enterLob_partition_storage?: (ctx: Lob_partition_storageContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lob_partition_storage`.
     * @param ctx the parse tree
     */
    exitLob_partition_storage?: (ctx: Lob_partition_storageContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.period_definition`.
     * @param ctx the parse tree
     */
    enterPeriod_definition?: (ctx: Period_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.period_definition`.
     * @param ctx the parse tree
     */
    exitPeriod_definition?: (ctx: Period_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.start_time_column`.
     * @param ctx the parse tree
     */
    enterStart_time_column?: (ctx: Start_time_columnContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.start_time_column`.
     * @param ctx the parse tree
     */
    exitStart_time_column?: (ctx: Start_time_columnContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.end_time_column`.
     * @param ctx the parse tree
     */
    enterEnd_time_column?: (ctx: End_time_columnContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.end_time_column`.
     * @param ctx the parse tree
     */
    exitEnd_time_column?: (ctx: End_time_columnContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_definition`.
     * @param ctx the parse tree
     */
    enterColumn_definition?: (ctx: Column_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_definition`.
     * @param ctx the parse tree
     */
    exitColumn_definition?: (ctx: Column_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_collation_name`.
     * @param ctx the parse tree
     */
    enterColumn_collation_name?: (ctx: Column_collation_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_collation_name`.
     * @param ctx the parse tree
     */
    exitColumn_collation_name?: (ctx: Column_collation_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identity_clause`.
     * @param ctx the parse tree
     */
    enterIdentity_clause?: (ctx: Identity_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identity_clause`.
     * @param ctx the parse tree
     */
    exitIdentity_clause?: (ctx: Identity_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identity_options_parentheses`.
     * @param ctx the parse tree
     */
    enterIdentity_options_parentheses?: (ctx: Identity_options_parenthesesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identity_options_parentheses`.
     * @param ctx the parse tree
     */
    exitIdentity_options_parentheses?: (ctx: Identity_options_parenthesesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identity_options`.
     * @param ctx the parse tree
     */
    enterIdentity_options?: (ctx: Identity_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identity_options`.
     * @param ctx the parse tree
     */
    exitIdentity_options?: (ctx: Identity_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.virtual_column_definition`.
     * @param ctx the parse tree
     */
    enterVirtual_column_definition?: (ctx: Virtual_column_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.virtual_column_definition`.
     * @param ctx the parse tree
     */
    exitVirtual_column_definition?: (ctx: Virtual_column_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.virtual_column_expression`.
     * @param ctx the parse tree
     */
    enterVirtual_column_expression?: (ctx: Virtual_column_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.virtual_column_expression`.
     * @param ctx the parse tree
     */
    exitVirtual_column_expression?: (ctx: Virtual_column_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.autogenerated_sequence_definition`.
     * @param ctx the parse tree
     */
    enterAutogenerated_sequence_definition?: (ctx: Autogenerated_sequence_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.autogenerated_sequence_definition`.
     * @param ctx the parse tree
     */
    exitAutogenerated_sequence_definition?: (ctx: Autogenerated_sequence_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.by_user_for_statistics_clause`.
     * @param ctx the parse tree
     */
    enterBy_user_for_statistics_clause?: (ctx: By_user_for_statistics_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.by_user_for_statistics_clause`.
     * @param ctx the parse tree
     */
    exitBy_user_for_statistics_clause?: (ctx: By_user_for_statistics_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.evaluation_edition_clause`.
     * @param ctx the parse tree
     */
    enterEvaluation_edition_clause?: (ctx: Evaluation_edition_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.evaluation_edition_clause`.
     * @param ctx the parse tree
     */
    exitEvaluation_edition_clause?: (ctx: Evaluation_edition_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.nested_table_col_properties`.
     * @param ctx the parse tree
     */
    enterNested_table_col_properties?: (ctx: Nested_table_col_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.nested_table_col_properties`.
     * @param ctx the parse tree
     */
    exitNested_table_col_properties?: (ctx: Nested_table_col_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.nested_item`.
     * @param ctx the parse tree
     */
    enterNested_item?: (ctx: Nested_itemContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.nested_item`.
     * @param ctx the parse tree
     */
    exitNested_item?: (ctx: Nested_itemContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.substitutable_column_clause`.
     * @param ctx the parse tree
     */
    enterSubstitutable_column_clause?: (ctx: Substitutable_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.substitutable_column_clause`.
     * @param ctx the parse tree
     */
    exitSubstitutable_column_clause?: (ctx: Substitutable_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_name`.
     * @param ctx the parse tree
     */
    enterPartition_name?: (ctx: Partition_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_name`.
     * @param ctx the parse tree
     */
    exitPartition_name?: (ctx: Partition_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.supplemental_logging_props`.
     * @param ctx the parse tree
     */
    enterSupplemental_logging_props?: (ctx: Supplemental_logging_propsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.supplemental_logging_props`.
     * @param ctx the parse tree
     */
    exitSupplemental_logging_props?: (ctx: Supplemental_logging_propsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_type_col_properties`.
     * @param ctx the parse tree
     */
    enterObject_type_col_properties?: (ctx: Object_type_col_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_type_col_properties`.
     * @param ctx the parse tree
     */
    exitObject_type_col_properties?: (ctx: Object_type_col_propertiesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constraint_clauses`.
     * @param ctx the parse tree
     */
    enterConstraint_clauses?: (ctx: Constraint_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constraint_clauses`.
     * @param ctx the parse tree
     */
    exitConstraint_clauses?: (ctx: Constraint_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.old_constraint_name`.
     * @param ctx the parse tree
     */
    enterOld_constraint_name?: (ctx: Old_constraint_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.old_constraint_name`.
     * @param ctx the parse tree
     */
    exitOld_constraint_name?: (ctx: Old_constraint_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.new_constraint_name`.
     * @param ctx the parse tree
     */
    enterNew_constraint_name?: (ctx: New_constraint_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.new_constraint_name`.
     * @param ctx the parse tree
     */
    exitNew_constraint_name?: (ctx: New_constraint_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.drop_constraint_clause`.
     * @param ctx the parse tree
     */
    enterDrop_constraint_clause?: (ctx: Drop_constraint_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.drop_constraint_clause`.
     * @param ctx the parse tree
     */
    exitDrop_constraint_clause?: (ctx: Drop_constraint_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.check_constraint`.
     * @param ctx the parse tree
     */
    enterCheck_constraint?: (ctx: Check_constraintContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.check_constraint`.
     * @param ctx the parse tree
     */
    exitCheck_constraint?: (ctx: Check_constraintContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.foreign_key_clause`.
     * @param ctx the parse tree
     */
    enterForeign_key_clause?: (ctx: Foreign_key_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.foreign_key_clause`.
     * @param ctx the parse tree
     */
    exitForeign_key_clause?: (ctx: Foreign_key_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.references_clause`.
     * @param ctx the parse tree
     */
    enterReferences_clause?: (ctx: References_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.references_clause`.
     * @param ctx the parse tree
     */
    exitReferences_clause?: (ctx: References_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.on_delete_clause`.
     * @param ctx the parse tree
     */
    enterOn_delete_clause?: (ctx: On_delete_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.on_delete_clause`.
     * @param ctx the parse tree
     */
    exitOn_delete_clause?: (ctx: On_delete_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.anonymous_block`.
     * @param ctx the parse tree
     */
    enterAnonymous_block?: (ctx: Anonymous_blockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.anonymous_block`.
     * @param ctx the parse tree
     */
    exitAnonymous_block?: (ctx: Anonymous_blockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.invoker_rights_clause`.
     * @param ctx the parse tree
     */
    enterInvoker_rights_clause?: (ctx: Invoker_rights_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.invoker_rights_clause`.
     * @param ctx the parse tree
     */
    exitInvoker_rights_clause?: (ctx: Invoker_rights_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.call_spec`.
     * @param ctx the parse tree
     */
    enterCall_spec?: (ctx: Call_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.call_spec`.
     * @param ctx the parse tree
     */
    exitCall_spec?: (ctx: Call_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.java_spec`.
     * @param ctx the parse tree
     */
    enterJava_spec?: (ctx: Java_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.java_spec`.
     * @param ctx the parse tree
     */
    exitJava_spec?: (ctx: Java_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.c_spec`.
     * @param ctx the parse tree
     */
    enterC_spec?: (ctx: C_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.c_spec`.
     * @param ctx the parse tree
     */
    exitC_spec?: (ctx: C_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.c_agent_in_clause`.
     * @param ctx the parse tree
     */
    enterC_agent_in_clause?: (ctx: C_agent_in_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.c_agent_in_clause`.
     * @param ctx the parse tree
     */
    exitC_agent_in_clause?: (ctx: C_agent_in_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.c_parameters_clause`.
     * @param ctx the parse tree
     */
    enterC_parameters_clause?: (ctx: C_parameters_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.c_parameters_clause`.
     * @param ctx the parse tree
     */
    exitC_parameters_clause?: (ctx: C_parameters_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.c_external_parameter`.
     * @param ctx the parse tree
     */
    enterC_external_parameter?: (ctx: C_external_parameterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.c_external_parameter`.
     * @param ctx the parse tree
     */
    exitC_external_parameter?: (ctx: C_external_parameterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.c_property`.
     * @param ctx the parse tree
     */
    enterC_property?: (ctx: C_propertyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.c_property`.
     * @param ctx the parse tree
     */
    exitC_property?: (ctx: C_propertyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parameter`.
     * @param ctx the parse tree
     */
    enterParameter?: (ctx: ParameterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parameter`.
     * @param ctx the parse tree
     */
    exitParameter?: (ctx: ParameterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.default_value_part`.
     * @param ctx the parse tree
     */
    enterDefault_value_part?: (ctx: Default_value_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.default_value_part`.
     * @param ctx the parse tree
     */
    exitDefault_value_part?: (ctx: Default_value_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.seq_of_declare_specs`.
     * @param ctx the parse tree
     */
    enterSeq_of_declare_specs?: (ctx: Seq_of_declare_specsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.seq_of_declare_specs`.
     * @param ctx the parse tree
     */
    exitSeq_of_declare_specs?: (ctx: Seq_of_declare_specsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.declare_spec`.
     * @param ctx the parse tree
     */
    enterDeclare_spec?: (ctx: Declare_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.declare_spec`.
     * @param ctx the parse tree
     */
    exitDeclare_spec?: (ctx: Declare_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.variable_declaration`.
     * @param ctx the parse tree
     */
    enterVariable_declaration?: (ctx: Variable_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.variable_declaration`.
     * @param ctx the parse tree
     */
    exitVariable_declaration?: (ctx: Variable_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subtype_declaration`.
     * @param ctx the parse tree
     */
    enterSubtype_declaration?: (ctx: Subtype_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subtype_declaration`.
     * @param ctx the parse tree
     */
    exitSubtype_declaration?: (ctx: Subtype_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cursor_declaration`.
     * @param ctx the parse tree
     */
    enterCursor_declaration?: (ctx: Cursor_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cursor_declaration`.
     * @param ctx the parse tree
     */
    exitCursor_declaration?: (ctx: Cursor_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parameter_spec`.
     * @param ctx the parse tree
     */
    enterParameter_spec?: (ctx: Parameter_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parameter_spec`.
     * @param ctx the parse tree
     */
    exitParameter_spec?: (ctx: Parameter_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exception_declaration`.
     * @param ctx the parse tree
     */
    enterException_declaration?: (ctx: Exception_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exception_declaration`.
     * @param ctx the parse tree
     */
    exitException_declaration?: (ctx: Exception_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pragma_declaration`.
     * @param ctx the parse tree
     */
    enterPragma_declaration?: (ctx: Pragma_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pragma_declaration`.
     * @param ctx the parse tree
     */
    exitPragma_declaration?: (ctx: Pragma_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.record_type_def`.
     * @param ctx the parse tree
     */
    enterRecord_type_def?: (ctx: Record_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.record_type_def`.
     * @param ctx the parse tree
     */
    exitRecord_type_def?: (ctx: Record_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.field_spec`.
     * @param ctx the parse tree
     */
    enterField_spec?: (ctx: Field_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.field_spec`.
     * @param ctx the parse tree
     */
    exitField_spec?: (ctx: Field_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.ref_cursor_type_def`.
     * @param ctx the parse tree
     */
    enterRef_cursor_type_def?: (ctx: Ref_cursor_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.ref_cursor_type_def`.
     * @param ctx the parse tree
     */
    exitRef_cursor_type_def?: (ctx: Ref_cursor_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_declaration`.
     * @param ctx the parse tree
     */
    enterType_declaration?: (ctx: Type_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_declaration`.
     * @param ctx the parse tree
     */
    exitType_declaration?: (ctx: Type_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_type_def`.
     * @param ctx the parse tree
     */
    enterTable_type_def?: (ctx: Table_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_type_def`.
     * @param ctx the parse tree
     */
    exitTable_type_def?: (ctx: Table_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_indexed_by_part`.
     * @param ctx the parse tree
     */
    enterTable_indexed_by_part?: (ctx: Table_indexed_by_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_indexed_by_part`.
     * @param ctx the parse tree
     */
    exitTable_indexed_by_part?: (ctx: Table_indexed_by_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.varray_type_def`.
     * @param ctx the parse tree
     */
    enterVarray_type_def?: (ctx: Varray_type_defContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.varray_type_def`.
     * @param ctx the parse tree
     */
    exitVarray_type_def?: (ctx: Varray_type_defContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.seq_of_statements`.
     * @param ctx the parse tree
     */
    enterSeq_of_statements?: (ctx: Seq_of_statementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.seq_of_statements`.
     * @param ctx the parse tree
     */
    exitSeq_of_statements?: (ctx: Seq_of_statementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.label_declaration`.
     * @param ctx the parse tree
     */
    enterLabel_declaration?: (ctx: Label_declarationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.label_declaration`.
     * @param ctx the parse tree
     */
    exitLabel_declaration?: (ctx: Label_declarationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.statement`.
     * @param ctx the parse tree
     */
    enterStatement?: (ctx: StatementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.statement`.
     * @param ctx the parse tree
     */
    exitStatement?: (ctx: StatementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.assignment_statement`.
     * @param ctx the parse tree
     */
    enterAssignment_statement?: (ctx: Assignment_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.assignment_statement`.
     * @param ctx the parse tree
     */
    exitAssignment_statement?: (ctx: Assignment_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.continue_statement`.
     * @param ctx the parse tree
     */
    enterContinue_statement?: (ctx: Continue_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.continue_statement`.
     * @param ctx the parse tree
     */
    exitContinue_statement?: (ctx: Continue_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exit_statement`.
     * @param ctx the parse tree
     */
    enterExit_statement?: (ctx: Exit_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exit_statement`.
     * @param ctx the parse tree
     */
    exitExit_statement?: (ctx: Exit_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.goto_statement`.
     * @param ctx the parse tree
     */
    enterGoto_statement?: (ctx: Goto_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.goto_statement`.
     * @param ctx the parse tree
     */
    exitGoto_statement?: (ctx: Goto_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.if_statement`.
     * @param ctx the parse tree
     */
    enterIf_statement?: (ctx: If_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.if_statement`.
     * @param ctx the parse tree
     */
    exitIf_statement?: (ctx: If_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.elsif_part`.
     * @param ctx the parse tree
     */
    enterElsif_part?: (ctx: Elsif_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.elsif_part`.
     * @param ctx the parse tree
     */
    exitElsif_part?: (ctx: Elsif_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.else_part`.
     * @param ctx the parse tree
     */
    enterElse_part?: (ctx: Else_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.else_part`.
     * @param ctx the parse tree
     */
    exitElse_part?: (ctx: Else_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.loop_statement`.
     * @param ctx the parse tree
     */
    enterLoop_statement?: (ctx: Loop_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.loop_statement`.
     * @param ctx the parse tree
     */
    exitLoop_statement?: (ctx: Loop_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cursor_loop_param`.
     * @param ctx the parse tree
     */
    enterCursor_loop_param?: (ctx: Cursor_loop_paramContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cursor_loop_param`.
     * @param ctx the parse tree
     */
    exitCursor_loop_param?: (ctx: Cursor_loop_paramContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.forall_statement`.
     * @param ctx the parse tree
     */
    enterForall_statement?: (ctx: Forall_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.forall_statement`.
     * @param ctx the parse tree
     */
    exitForall_statement?: (ctx: Forall_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.bounds_clause`.
     * @param ctx the parse tree
     */
    enterBounds_clause?: (ctx: Bounds_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.bounds_clause`.
     * @param ctx the parse tree
     */
    exitBounds_clause?: (ctx: Bounds_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.between_bound`.
     * @param ctx the parse tree
     */
    enterBetween_bound?: (ctx: Between_boundContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.between_bound`.
     * @param ctx the parse tree
     */
    exitBetween_bound?: (ctx: Between_boundContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lower_bound`.
     * @param ctx the parse tree
     */
    enterLower_bound?: (ctx: Lower_boundContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lower_bound`.
     * @param ctx the parse tree
     */
    exitLower_bound?: (ctx: Lower_boundContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.upper_bound`.
     * @param ctx the parse tree
     */
    enterUpper_bound?: (ctx: Upper_boundContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.upper_bound`.
     * @param ctx the parse tree
     */
    exitUpper_bound?: (ctx: Upper_boundContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.null_statement`.
     * @param ctx the parse tree
     */
    enterNull_statement?: (ctx: Null_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.null_statement`.
     * @param ctx the parse tree
     */
    exitNull_statement?: (ctx: Null_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.raise_statement`.
     * @param ctx the parse tree
     */
    enterRaise_statement?: (ctx: Raise_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.raise_statement`.
     * @param ctx the parse tree
     */
    exitRaise_statement?: (ctx: Raise_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.return_statement`.
     * @param ctx the parse tree
     */
    enterReturn_statement?: (ctx: Return_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.return_statement`.
     * @param ctx the parse tree
     */
    exitReturn_statement?: (ctx: Return_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.call_statement`.
     * @param ctx the parse tree
     */
    enterCall_statement?: (ctx: Call_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.call_statement`.
     * @param ctx the parse tree
     */
    exitCall_statement?: (ctx: Call_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pipe_row_statement`.
     * @param ctx the parse tree
     */
    enterPipe_row_statement?: (ctx: Pipe_row_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pipe_row_statement`.
     * @param ctx the parse tree
     */
    exitPipe_row_statement?: (ctx: Pipe_row_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.selection_directive`.
     * @param ctx the parse tree
     */
    enterSelection_directive?: (ctx: Selection_directiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.selection_directive`.
     * @param ctx the parse tree
     */
    exitSelection_directive?: (ctx: Selection_directiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.error_directive`.
     * @param ctx the parse tree
     */
    enterError_directive?: (ctx: Error_directiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.error_directive`.
     * @param ctx the parse tree
     */
    exitError_directive?: (ctx: Error_directiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.selection_directive_body`.
     * @param ctx the parse tree
     */
    enterSelection_directive_body?: (ctx: Selection_directive_bodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.selection_directive_body`.
     * @param ctx the parse tree
     */
    exitSelection_directive_body?: (ctx: Selection_directive_bodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.body`.
     * @param ctx the parse tree
     */
    enterBody?: (ctx: BodyContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.body`.
     * @param ctx the parse tree
     */
    exitBody?: (ctx: BodyContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exception_handler`.
     * @param ctx the parse tree
     */
    enterException_handler?: (ctx: Exception_handlerContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exception_handler`.
     * @param ctx the parse tree
     */
    exitException_handler?: (ctx: Exception_handlerContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trigger_block`.
     * @param ctx the parse tree
     */
    enterTrigger_block?: (ctx: Trigger_blockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trigger_block`.
     * @param ctx the parse tree
     */
    exitTrigger_block?: (ctx: Trigger_blockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tps_block`.
     * @param ctx the parse tree
     */
    enterTps_block?: (ctx: Tps_blockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tps_block`.
     * @param ctx the parse tree
     */
    exitTps_block?: (ctx: Tps_blockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.block`.
     * @param ctx the parse tree
     */
    enterBlock?: (ctx: BlockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.block`.
     * @param ctx the parse tree
     */
    exitBlock?: (ctx: BlockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_statement`.
     * @param ctx the parse tree
     */
    enterSql_statement?: (ctx: Sql_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_statement`.
     * @param ctx the parse tree
     */
    exitSql_statement?: (ctx: Sql_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.execute_immediate`.
     * @param ctx the parse tree
     */
    enterExecute_immediate?: (ctx: Execute_immediateContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.execute_immediate`.
     * @param ctx the parse tree
     */
    exitExecute_immediate?: (ctx: Execute_immediateContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dynamic_returning_clause`.
     * @param ctx the parse tree
     */
    enterDynamic_returning_clause?: (ctx: Dynamic_returning_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dynamic_returning_clause`.
     * @param ctx the parse tree
     */
    exitDynamic_returning_clause?: (ctx: Dynamic_returning_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.data_manipulation_language_statements`.
     * @param ctx the parse tree
     */
    enterData_manipulation_language_statements?: (ctx: Data_manipulation_language_statementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.data_manipulation_language_statements`.
     * @param ctx the parse tree
     */
    exitData_manipulation_language_statements?: (ctx: Data_manipulation_language_statementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cursor_manipulation_statements`.
     * @param ctx the parse tree
     */
    enterCursor_manipulation_statements?: (ctx: Cursor_manipulation_statementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cursor_manipulation_statements`.
     * @param ctx the parse tree
     */
    exitCursor_manipulation_statements?: (ctx: Cursor_manipulation_statementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.close_statement`.
     * @param ctx the parse tree
     */
    enterClose_statement?: (ctx: Close_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.close_statement`.
     * @param ctx the parse tree
     */
    exitClose_statement?: (ctx: Close_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.open_statement`.
     * @param ctx the parse tree
     */
    enterOpen_statement?: (ctx: Open_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.open_statement`.
     * @param ctx the parse tree
     */
    exitOpen_statement?: (ctx: Open_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.fetch_statement`.
     * @param ctx the parse tree
     */
    enterFetch_statement?: (ctx: Fetch_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.fetch_statement`.
     * @param ctx the parse tree
     */
    exitFetch_statement?: (ctx: Fetch_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.variable_or_collection`.
     * @param ctx the parse tree
     */
    enterVariable_or_collection?: (ctx: Variable_or_collectionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.variable_or_collection`.
     * @param ctx the parse tree
     */
    exitVariable_or_collection?: (ctx: Variable_or_collectionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.open_for_statement`.
     * @param ctx the parse tree
     */
    enterOpen_for_statement?: (ctx: Open_for_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.open_for_statement`.
     * @param ctx the parse tree
     */
    exitOpen_for_statement?: (ctx: Open_for_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.transaction_control_statements`.
     * @param ctx the parse tree
     */
    enterTransaction_control_statements?: (ctx: Transaction_control_statementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.transaction_control_statements`.
     * @param ctx the parse tree
     */
    exitTransaction_control_statements?: (ctx: Transaction_control_statementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_transaction_command`.
     * @param ctx the parse tree
     */
    enterSet_transaction_command?: (ctx: Set_transaction_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_transaction_command`.
     * @param ctx the parse tree
     */
    exitSet_transaction_command?: (ctx: Set_transaction_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_constraint_command`.
     * @param ctx the parse tree
     */
    enterSet_constraint_command?: (ctx: Set_constraint_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_constraint_command`.
     * @param ctx the parse tree
     */
    exitSet_constraint_command?: (ctx: Set_constraint_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.commit_statement`.
     * @param ctx the parse tree
     */
    enterCommit_statement?: (ctx: Commit_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.commit_statement`.
     * @param ctx the parse tree
     */
    exitCommit_statement?: (ctx: Commit_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.write_clause`.
     * @param ctx the parse tree
     */
    enterWrite_clause?: (ctx: Write_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.write_clause`.
     * @param ctx the parse tree
     */
    exitWrite_clause?: (ctx: Write_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rollback_statement`.
     * @param ctx the parse tree
     */
    enterRollback_statement?: (ctx: Rollback_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rollback_statement`.
     * @param ctx the parse tree
     */
    exitRollback_statement?: (ctx: Rollback_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.savepoint_statement`.
     * @param ctx the parse tree
     */
    enterSavepoint_statement?: (ctx: Savepoint_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.savepoint_statement`.
     * @param ctx the parse tree
     */
    exitSavepoint_statement?: (ctx: Savepoint_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.collection_method_call`.
     * @param ctx the parse tree
     */
    enterCollection_method_call?: (ctx: Collection_method_callContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.collection_method_call`.
     * @param ctx the parse tree
     */
    exitCollection_method_call?: (ctx: Collection_method_callContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.explain_statement`.
     * @param ctx the parse tree
     */
    enterExplain_statement?: (ctx: Explain_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.explain_statement`.
     * @param ctx the parse tree
     */
    exitExplain_statement?: (ctx: Explain_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.select_only_statement`.
     * @param ctx the parse tree
     */
    enterSelect_only_statement?: (ctx: Select_only_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.select_only_statement`.
     * @param ctx the parse tree
     */
    exitSelect_only_statement?: (ctx: Select_only_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.select_statement`.
     * @param ctx the parse tree
     */
    enterSelect_statement?: (ctx: Select_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.select_statement`.
     * @param ctx the parse tree
     */
    exitSelect_statement?: (ctx: Select_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.with_clause`.
     * @param ctx the parse tree
     */
    enterWith_clause?: (ctx: With_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.with_clause`.
     * @param ctx the parse tree
     */
    exitWith_clause?: (ctx: With_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.with_factoring_clause`.
     * @param ctx the parse tree
     */
    enterWith_factoring_clause?: (ctx: With_factoring_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.with_factoring_clause`.
     * @param ctx the parse tree
     */
    exitWith_factoring_clause?: (ctx: With_factoring_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery_factoring_clause`.
     * @param ctx the parse tree
     */
    enterSubquery_factoring_clause?: (ctx: Subquery_factoring_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery_factoring_clause`.
     * @param ctx the parse tree
     */
    exitSubquery_factoring_clause?: (ctx: Subquery_factoring_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.search_clause`.
     * @param ctx the parse tree
     */
    enterSearch_clause?: (ctx: Search_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.search_clause`.
     * @param ctx the parse tree
     */
    exitSearch_clause?: (ctx: Search_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cycle_clause`.
     * @param ctx the parse tree
     */
    enterCycle_clause?: (ctx: Cycle_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cycle_clause`.
     * @param ctx the parse tree
     */
    exitCycle_clause?: (ctx: Cycle_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subav_factoring_clause`.
     * @param ctx the parse tree
     */
    enterSubav_factoring_clause?: (ctx: Subav_factoring_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subav_factoring_clause`.
     * @param ctx the parse tree
     */
    exitSubav_factoring_clause?: (ctx: Subav_factoring_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subav_clause`.
     * @param ctx the parse tree
     */
    enterSubav_clause?: (ctx: Subav_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subav_clause`.
     * @param ctx the parse tree
     */
    exitSubav_clause?: (ctx: Subav_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hierarchies_clause`.
     * @param ctx the parse tree
     */
    enterHierarchies_clause?: (ctx: Hierarchies_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hierarchies_clause`.
     * @param ctx the parse tree
     */
    exitHierarchies_clause?: (ctx: Hierarchies_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filter_clauses`.
     * @param ctx the parse tree
     */
    enterFilter_clauses?: (ctx: Filter_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filter_clauses`.
     * @param ctx the parse tree
     */
    exitFilter_clauses?: (ctx: Filter_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.filter_clause`.
     * @param ctx the parse tree
     */
    enterFilter_clause?: (ctx: Filter_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.filter_clause`.
     * @param ctx the parse tree
     */
    exitFilter_clause?: (ctx: Filter_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_calcs_clause`.
     * @param ctx the parse tree
     */
    enterAdd_calcs_clause?: (ctx: Add_calcs_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_calcs_clause`.
     * @param ctx the parse tree
     */
    exitAdd_calcs_clause?: (ctx: Add_calcs_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.add_calc_meas_clause`.
     * @param ctx the parse tree
     */
    enterAdd_calc_meas_clause?: (ctx: Add_calc_meas_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.add_calc_meas_clause`.
     * @param ctx the parse tree
     */
    exitAdd_calc_meas_clause?: (ctx: Add_calc_meas_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery`.
     * @param ctx the parse tree
     */
    enterSubquery?: (ctx: SubqueryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery`.
     * @param ctx the parse tree
     */
    exitSubquery?: (ctx: SubqueryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery_no_with`.
     * @param ctx the parse tree
     */
    enterSubquery_no_with?: (ctx: Subquery_no_withContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery_no_with`.
     * @param ctx the parse tree
     */
    exitSubquery_no_with?: (ctx: Subquery_no_withContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery_basic_elements`.
     * @param ctx the parse tree
     */
    enterSubquery_basic_elements?: (ctx: Subquery_basic_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery_basic_elements`.
     * @param ctx the parse tree
     */
    exitSubquery_basic_elements?: (ctx: Subquery_basic_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery_operation_part`.
     * @param ctx the parse tree
     */
    enterSubquery_operation_part?: (ctx: Subquery_operation_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery_operation_part`.
     * @param ctx the parse tree
     */
    exitSubquery_operation_part?: (ctx: Subquery_operation_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.query_block`.
     * @param ctx the parse tree
     */
    enterQuery_block?: (ctx: Query_blockContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.query_block`.
     * @param ctx the parse tree
     */
    exitQuery_block?: (ctx: Query_blockContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.selected_list`.
     * @param ctx the parse tree
     */
    enterSelected_list?: (ctx: Selected_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.selected_list`.
     * @param ctx the parse tree
     */
    exitSelected_list?: (ctx: Selected_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.from_clause`.
     * @param ctx the parse tree
     */
    enterFrom_clause?: (ctx: From_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.from_clause`.
     * @param ctx the parse tree
     */
    exitFrom_clause?: (ctx: From_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.select_list_elements`.
     * @param ctx the parse tree
     */
    enterSelect_list_elements?: (ctx: Select_list_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.select_list_elements`.
     * @param ctx the parse tree
     */
    exitSelect_list_elements?: (ctx: Select_list_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_ref_list`.
     * @param ctx the parse tree
     */
    enterTable_ref_list?: (ctx: Table_ref_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_ref_list`.
     * @param ctx the parse tree
     */
    exitTable_ref_list?: (ctx: Table_ref_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_ref`.
     * @param ctx the parse tree
     */
    enterTable_ref?: (ctx: Table_refContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_ref`.
     * @param ctx the parse tree
     */
    exitTable_ref?: (ctx: Table_refContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_ref_aux`.
     * @param ctx the parse tree
     */
    enterTable_ref_aux?: (ctx: Table_ref_auxContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_ref_aux`.
     * @param ctx the parse tree
     */
    exitTable_ref_aux?: (ctx: Table_ref_auxContext) => void;
    /**
     * Enter a parse tree produced by the `table_ref_aux_internal_one`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    enterTable_ref_aux_internal_one?: (ctx: Table_ref_aux_internal_oneContext) => void;
    /**
     * Exit a parse tree produced by the `table_ref_aux_internal_one`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    exitTable_ref_aux_internal_one?: (ctx: Table_ref_aux_internal_oneContext) => void;
    /**
     * Enter a parse tree produced by the `table_ref_aux_internal_two`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    enterTable_ref_aux_internal_two?: (ctx: Table_ref_aux_internal_twoContext) => void;
    /**
     * Exit a parse tree produced by the `table_ref_aux_internal_two`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    exitTable_ref_aux_internal_two?: (ctx: Table_ref_aux_internal_twoContext) => void;
    /**
     * Enter a parse tree produced by the `table_ref_aux_internal_thre`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    enterTable_ref_aux_internal_thre?: (ctx: Table_ref_aux_internal_threContext) => void;
    /**
     * Exit a parse tree produced by the `table_ref_aux_internal_thre`
     * labeled alternative in `PlSqlParser.table_ref_aux_internal`.
     * @param ctx the parse tree
     */
    exitTable_ref_aux_internal_thre?: (ctx: Table_ref_aux_internal_threContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_clause`.
     * @param ctx the parse tree
     */
    enterJoin_clause?: (ctx: Join_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_clause`.
     * @param ctx the parse tree
     */
    exitJoin_clause?: (ctx: Join_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_on_part`.
     * @param ctx the parse tree
     */
    enterJoin_on_part?: (ctx: Join_on_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_on_part`.
     * @param ctx the parse tree
     */
    exitJoin_on_part?: (ctx: Join_on_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.join_using_part`.
     * @param ctx the parse tree
     */
    enterJoin_using_part?: (ctx: Join_using_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.join_using_part`.
     * @param ctx the parse tree
     */
    exitJoin_using_part?: (ctx: Join_using_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.outer_join_type`.
     * @param ctx the parse tree
     */
    enterOuter_join_type?: (ctx: Outer_join_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.outer_join_type`.
     * @param ctx the parse tree
     */
    exitOuter_join_type?: (ctx: Outer_join_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.query_partition_clause`.
     * @param ctx the parse tree
     */
    enterQuery_partition_clause?: (ctx: Query_partition_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.query_partition_clause`.
     * @param ctx the parse tree
     */
    exitQuery_partition_clause?: (ctx: Query_partition_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.flashback_query_clause`.
     * @param ctx the parse tree
     */
    enterFlashback_query_clause?: (ctx: Flashback_query_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.flashback_query_clause`.
     * @param ctx the parse tree
     */
    exitFlashback_query_clause?: (ctx: Flashback_query_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_clause`.
     * @param ctx the parse tree
     */
    enterPivot_clause?: (ctx: Pivot_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_clause`.
     * @param ctx the parse tree
     */
    exitPivot_clause?: (ctx: Pivot_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_element`.
     * @param ctx the parse tree
     */
    enterPivot_element?: (ctx: Pivot_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_element`.
     * @param ctx the parse tree
     */
    exitPivot_element?: (ctx: Pivot_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_for_clause`.
     * @param ctx the parse tree
     */
    enterPivot_for_clause?: (ctx: Pivot_for_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_for_clause`.
     * @param ctx the parse tree
     */
    exitPivot_for_clause?: (ctx: Pivot_for_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_in_clause`.
     * @param ctx the parse tree
     */
    enterPivot_in_clause?: (ctx: Pivot_in_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_in_clause`.
     * @param ctx the parse tree
     */
    exitPivot_in_clause?: (ctx: Pivot_in_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_in_clause_element`.
     * @param ctx the parse tree
     */
    enterPivot_in_clause_element?: (ctx: Pivot_in_clause_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_in_clause_element`.
     * @param ctx the parse tree
     */
    exitPivot_in_clause_element?: (ctx: Pivot_in_clause_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.pivot_in_clause_elements`.
     * @param ctx the parse tree
     */
    enterPivot_in_clause_elements?: (ctx: Pivot_in_clause_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.pivot_in_clause_elements`.
     * @param ctx the parse tree
     */
    exitPivot_in_clause_elements?: (ctx: Pivot_in_clause_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unpivot_clause`.
     * @param ctx the parse tree
     */
    enterUnpivot_clause?: (ctx: Unpivot_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unpivot_clause`.
     * @param ctx the parse tree
     */
    exitUnpivot_clause?: (ctx: Unpivot_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unpivot_in_clause`.
     * @param ctx the parse tree
     */
    enterUnpivot_in_clause?: (ctx: Unpivot_in_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unpivot_in_clause`.
     * @param ctx the parse tree
     */
    exitUnpivot_in_clause?: (ctx: Unpivot_in_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unpivot_in_elements`.
     * @param ctx the parse tree
     */
    enterUnpivot_in_elements?: (ctx: Unpivot_in_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unpivot_in_elements`.
     * @param ctx the parse tree
     */
    exitUnpivot_in_elements?: (ctx: Unpivot_in_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.hierarchical_query_clause`.
     * @param ctx the parse tree
     */
    enterHierarchical_query_clause?: (ctx: Hierarchical_query_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.hierarchical_query_clause`.
     * @param ctx the parse tree
     */
    exitHierarchical_query_clause?: (ctx: Hierarchical_query_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.start_part`.
     * @param ctx the parse tree
     */
    enterStart_part?: (ctx: Start_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.start_part`.
     * @param ctx the parse tree
     */
    exitStart_part?: (ctx: Start_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.group_by_clause`.
     * @param ctx the parse tree
     */
    enterGroup_by_clause?: (ctx: Group_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.group_by_clause`.
     * @param ctx the parse tree
     */
    exitGroup_by_clause?: (ctx: Group_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.group_by_elements`.
     * @param ctx the parse tree
     */
    enterGroup_by_elements?: (ctx: Group_by_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.group_by_elements`.
     * @param ctx the parse tree
     */
    exitGroup_by_elements?: (ctx: Group_by_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rollup_cube_clause`.
     * @param ctx the parse tree
     */
    enterRollup_cube_clause?: (ctx: Rollup_cube_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rollup_cube_clause`.
     * @param ctx the parse tree
     */
    exitRollup_cube_clause?: (ctx: Rollup_cube_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.grouping_sets_clause`.
     * @param ctx the parse tree
     */
    enterGrouping_sets_clause?: (ctx: Grouping_sets_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.grouping_sets_clause`.
     * @param ctx the parse tree
     */
    exitGrouping_sets_clause?: (ctx: Grouping_sets_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.grouping_sets_elements`.
     * @param ctx the parse tree
     */
    enterGrouping_sets_elements?: (ctx: Grouping_sets_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.grouping_sets_elements`.
     * @param ctx the parse tree
     */
    exitGrouping_sets_elements?: (ctx: Grouping_sets_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.having_clause`.
     * @param ctx the parse tree
     */
    enterHaving_clause?: (ctx: Having_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.having_clause`.
     * @param ctx the parse tree
     */
    exitHaving_clause?: (ctx: Having_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_clause`.
     * @param ctx the parse tree
     */
    enterModel_clause?: (ctx: Model_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_clause`.
     * @param ctx the parse tree
     */
    exitModel_clause?: (ctx: Model_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cell_reference_options`.
     * @param ctx the parse tree
     */
    enterCell_reference_options?: (ctx: Cell_reference_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cell_reference_options`.
     * @param ctx the parse tree
     */
    exitCell_reference_options?: (ctx: Cell_reference_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.return_rows_clause`.
     * @param ctx the parse tree
     */
    enterReturn_rows_clause?: (ctx: Return_rows_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.return_rows_clause`.
     * @param ctx the parse tree
     */
    exitReturn_rows_clause?: (ctx: Return_rows_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.reference_model`.
     * @param ctx the parse tree
     */
    enterReference_model?: (ctx: Reference_modelContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.reference_model`.
     * @param ctx the parse tree
     */
    exitReference_model?: (ctx: Reference_modelContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.main_model`.
     * @param ctx the parse tree
     */
    enterMain_model?: (ctx: Main_modelContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.main_model`.
     * @param ctx the parse tree
     */
    exitMain_model?: (ctx: Main_modelContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_column_clauses`.
     * @param ctx the parse tree
     */
    enterModel_column_clauses?: (ctx: Model_column_clausesContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_column_clauses`.
     * @param ctx the parse tree
     */
    exitModel_column_clauses?: (ctx: Model_column_clausesContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_column_partition_part`.
     * @param ctx the parse tree
     */
    enterModel_column_partition_part?: (ctx: Model_column_partition_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_column_partition_part`.
     * @param ctx the parse tree
     */
    exitModel_column_partition_part?: (ctx: Model_column_partition_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_column_list`.
     * @param ctx the parse tree
     */
    enterModel_column_list?: (ctx: Model_column_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_column_list`.
     * @param ctx the parse tree
     */
    exitModel_column_list?: (ctx: Model_column_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_column`.
     * @param ctx the parse tree
     */
    enterModel_column?: (ctx: Model_columnContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_column`.
     * @param ctx the parse tree
     */
    exitModel_column?: (ctx: Model_columnContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_rules_clause`.
     * @param ctx the parse tree
     */
    enterModel_rules_clause?: (ctx: Model_rules_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_rules_clause`.
     * @param ctx the parse tree
     */
    exitModel_rules_clause?: (ctx: Model_rules_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_rules_part`.
     * @param ctx the parse tree
     */
    enterModel_rules_part?: (ctx: Model_rules_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_rules_part`.
     * @param ctx the parse tree
     */
    exitModel_rules_part?: (ctx: Model_rules_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_rules_element`.
     * @param ctx the parse tree
     */
    enterModel_rules_element?: (ctx: Model_rules_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_rules_element`.
     * @param ctx the parse tree
     */
    exitModel_rules_element?: (ctx: Model_rules_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cell_assignment`.
     * @param ctx the parse tree
     */
    enterCell_assignment?: (ctx: Cell_assignmentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cell_assignment`.
     * @param ctx the parse tree
     */
    exitCell_assignment?: (ctx: Cell_assignmentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_iterate_clause`.
     * @param ctx the parse tree
     */
    enterModel_iterate_clause?: (ctx: Model_iterate_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_iterate_clause`.
     * @param ctx the parse tree
     */
    exitModel_iterate_clause?: (ctx: Model_iterate_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.until_part`.
     * @param ctx the parse tree
     */
    enterUntil_part?: (ctx: Until_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.until_part`.
     * @param ctx the parse tree
     */
    exitUntil_part?: (ctx: Until_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.order_by_clause`.
     * @param ctx the parse tree
     */
    enterOrder_by_clause?: (ctx: Order_by_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.order_by_clause`.
     * @param ctx the parse tree
     */
    exitOrder_by_clause?: (ctx: Order_by_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.order_by_elements`.
     * @param ctx the parse tree
     */
    enterOrder_by_elements?: (ctx: Order_by_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.order_by_elements`.
     * @param ctx the parse tree
     */
    exitOrder_by_elements?: (ctx: Order_by_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.offset_clause`.
     * @param ctx the parse tree
     */
    enterOffset_clause?: (ctx: Offset_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.offset_clause`.
     * @param ctx the parse tree
     */
    exitOffset_clause?: (ctx: Offset_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.fetch_clause`.
     * @param ctx the parse tree
     */
    enterFetch_clause?: (ctx: Fetch_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.fetch_clause`.
     * @param ctx the parse tree
     */
    exitFetch_clause?: (ctx: Fetch_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.for_update_clause`.
     * @param ctx the parse tree
     */
    enterFor_update_clause?: (ctx: For_update_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.for_update_clause`.
     * @param ctx the parse tree
     */
    exitFor_update_clause?: (ctx: For_update_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.for_update_of_part`.
     * @param ctx the parse tree
     */
    enterFor_update_of_part?: (ctx: For_update_of_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.for_update_of_part`.
     * @param ctx the parse tree
     */
    exitFor_update_of_part?: (ctx: For_update_of_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.for_update_options`.
     * @param ctx the parse tree
     */
    enterFor_update_options?: (ctx: For_update_optionsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.for_update_options`.
     * @param ctx the parse tree
     */
    exitFor_update_options?: (ctx: For_update_optionsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_statement`.
     * @param ctx the parse tree
     */
    enterUpdate_statement?: (ctx: Update_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_statement`.
     * @param ctx the parse tree
     */
    exitUpdate_statement?: (ctx: Update_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.update_set_clause`.
     * @param ctx the parse tree
     */
    enterUpdate_set_clause?: (ctx: Update_set_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.update_set_clause`.
     * @param ctx the parse tree
     */
    exitUpdate_set_clause?: (ctx: Update_set_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_based_update_set_clause`.
     * @param ctx the parse tree
     */
    enterColumn_based_update_set_clause?: (ctx: Column_based_update_set_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_based_update_set_clause`.
     * @param ctx the parse tree
     */
    exitColumn_based_update_set_clause?: (ctx: Column_based_update_set_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.delete_statement`.
     * @param ctx the parse tree
     */
    enterDelete_statement?: (ctx: Delete_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.delete_statement`.
     * @param ctx the parse tree
     */
    exitDelete_statement?: (ctx: Delete_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.insert_statement`.
     * @param ctx the parse tree
     */
    enterInsert_statement?: (ctx: Insert_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.insert_statement`.
     * @param ctx the parse tree
     */
    exitInsert_statement?: (ctx: Insert_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.single_table_insert`.
     * @param ctx the parse tree
     */
    enterSingle_table_insert?: (ctx: Single_table_insertContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.single_table_insert`.
     * @param ctx the parse tree
     */
    exitSingle_table_insert?: (ctx: Single_table_insertContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.multi_table_insert`.
     * @param ctx the parse tree
     */
    enterMulti_table_insert?: (ctx: Multi_table_insertContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.multi_table_insert`.
     * @param ctx the parse tree
     */
    exitMulti_table_insert?: (ctx: Multi_table_insertContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.multi_table_element`.
     * @param ctx the parse tree
     */
    enterMulti_table_element?: (ctx: Multi_table_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.multi_table_element`.
     * @param ctx the parse tree
     */
    exitMulti_table_element?: (ctx: Multi_table_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.conditional_insert_clause`.
     * @param ctx the parse tree
     */
    enterConditional_insert_clause?: (ctx: Conditional_insert_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.conditional_insert_clause`.
     * @param ctx the parse tree
     */
    exitConditional_insert_clause?: (ctx: Conditional_insert_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.conditional_insert_when_part`.
     * @param ctx the parse tree
     */
    enterConditional_insert_when_part?: (ctx: Conditional_insert_when_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.conditional_insert_when_part`.
     * @param ctx the parse tree
     */
    exitConditional_insert_when_part?: (ctx: Conditional_insert_when_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.conditional_insert_else_part`.
     * @param ctx the parse tree
     */
    enterConditional_insert_else_part?: (ctx: Conditional_insert_else_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.conditional_insert_else_part`.
     * @param ctx the parse tree
     */
    exitConditional_insert_else_part?: (ctx: Conditional_insert_else_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.insert_into_clause`.
     * @param ctx the parse tree
     */
    enterInsert_into_clause?: (ctx: Insert_into_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.insert_into_clause`.
     * @param ctx the parse tree
     */
    exitInsert_into_clause?: (ctx: Insert_into_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.values_clause`.
     * @param ctx the parse tree
     */
    enterValues_clause?: (ctx: Values_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.values_clause`.
     * @param ctx the parse tree
     */
    exitValues_clause?: (ctx: Values_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_statement`.
     * @param ctx the parse tree
     */
    enterMerge_statement?: (ctx: Merge_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_statement`.
     * @param ctx the parse tree
     */
    exitMerge_statement?: (ctx: Merge_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_update_clause`.
     * @param ctx the parse tree
     */
    enterMerge_update_clause?: (ctx: Merge_update_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_update_clause`.
     * @param ctx the parse tree
     */
    exitMerge_update_clause?: (ctx: Merge_update_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_element`.
     * @param ctx the parse tree
     */
    enterMerge_element?: (ctx: Merge_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_element`.
     * @param ctx the parse tree
     */
    exitMerge_element?: (ctx: Merge_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_update_delete_part`.
     * @param ctx the parse tree
     */
    enterMerge_update_delete_part?: (ctx: Merge_update_delete_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_update_delete_part`.
     * @param ctx the parse tree
     */
    exitMerge_update_delete_part?: (ctx: Merge_update_delete_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.merge_insert_clause`.
     * @param ctx the parse tree
     */
    enterMerge_insert_clause?: (ctx: Merge_insert_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.merge_insert_clause`.
     * @param ctx the parse tree
     */
    exitMerge_insert_clause?: (ctx: Merge_insert_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.selected_tableview`.
     * @param ctx the parse tree
     */
    enterSelected_tableview?: (ctx: Selected_tableviewContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.selected_tableview`.
     * @param ctx the parse tree
     */
    exitSelected_tableview?: (ctx: Selected_tableviewContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lock_table_statement`.
     * @param ctx the parse tree
     */
    enterLock_table_statement?: (ctx: Lock_table_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lock_table_statement`.
     * @param ctx the parse tree
     */
    exitLock_table_statement?: (ctx: Lock_table_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.wait_nowait_part`.
     * @param ctx the parse tree
     */
    enterWait_nowait_part?: (ctx: Wait_nowait_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.wait_nowait_part`.
     * @param ctx the parse tree
     */
    exitWait_nowait_part?: (ctx: Wait_nowait_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lock_table_element`.
     * @param ctx the parse tree
     */
    enterLock_table_element?: (ctx: Lock_table_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lock_table_element`.
     * @param ctx the parse tree
     */
    exitLock_table_element?: (ctx: Lock_table_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.lock_mode`.
     * @param ctx the parse tree
     */
    enterLock_mode?: (ctx: Lock_modeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.lock_mode`.
     * @param ctx the parse tree
     */
    exitLock_mode?: (ctx: Lock_modeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.general_table_ref`.
     * @param ctx the parse tree
     */
    enterGeneral_table_ref?: (ctx: General_table_refContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.general_table_ref`.
     * @param ctx the parse tree
     */
    exitGeneral_table_ref?: (ctx: General_table_refContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.static_returning_clause`.
     * @param ctx the parse tree
     */
    enterStatic_returning_clause?: (ctx: Static_returning_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.static_returning_clause`.
     * @param ctx the parse tree
     */
    exitStatic_returning_clause?: (ctx: Static_returning_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.error_logging_clause`.
     * @param ctx the parse tree
     */
    enterError_logging_clause?: (ctx: Error_logging_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.error_logging_clause`.
     * @param ctx the parse tree
     */
    exitError_logging_clause?: (ctx: Error_logging_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.error_logging_into_part`.
     * @param ctx the parse tree
     */
    enterError_logging_into_part?: (ctx: Error_logging_into_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.error_logging_into_part`.
     * @param ctx the parse tree
     */
    exitError_logging_into_part?: (ctx: Error_logging_into_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.error_logging_reject_part`.
     * @param ctx the parse tree
     */
    enterError_logging_reject_part?: (ctx: Error_logging_reject_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.error_logging_reject_part`.
     * @param ctx the parse tree
     */
    exitError_logging_reject_part?: (ctx: Error_logging_reject_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dml_table_expression_clause`.
     * @param ctx the parse tree
     */
    enterDml_table_expression_clause?: (ctx: Dml_table_expression_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dml_table_expression_clause`.
     * @param ctx the parse tree
     */
    exitDml_table_expression_clause?: (ctx: Dml_table_expression_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_collection_expression`.
     * @param ctx the parse tree
     */
    enterTable_collection_expression?: (ctx: Table_collection_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_collection_expression`.
     * @param ctx the parse tree
     */
    exitTable_collection_expression?: (ctx: Table_collection_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.subquery_restriction_clause`.
     * @param ctx the parse tree
     */
    enterSubquery_restriction_clause?: (ctx: Subquery_restriction_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.subquery_restriction_clause`.
     * @param ctx the parse tree
     */
    exitSubquery_restriction_clause?: (ctx: Subquery_restriction_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sample_clause`.
     * @param ctx the parse tree
     */
    enterSample_clause?: (ctx: Sample_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sample_clause`.
     * @param ctx the parse tree
     */
    exitSample_clause?: (ctx: Sample_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.seed_part`.
     * @param ctx the parse tree
     */
    enterSeed_part?: (ctx: Seed_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.seed_part`.
     * @param ctx the parse tree
     */
    exitSeed_part?: (ctx: Seed_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.condition`.
     * @param ctx the parse tree
     */
    enterCondition?: (ctx: ConditionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.condition`.
     * @param ctx the parse tree
     */
    exitCondition?: (ctx: ConditionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.expressions_`.
     * @param ctx the parse tree
     */
    enterExpressions_?: (ctx: Expressions_Context) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.expressions_`.
     * @param ctx the parse tree
     */
    exitExpressions_?: (ctx: Expressions_Context) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.expression`.
     * @param ctx the parse tree
     */
    enterExpression?: (ctx: ExpressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.expression`.
     * @param ctx the parse tree
     */
    exitExpression?: (ctx: ExpressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cursor_expression`.
     * @param ctx the parse tree
     */
    enterCursor_expression?: (ctx: Cursor_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cursor_expression`.
     * @param ctx the parse tree
     */
    exitCursor_expression?: (ctx: Cursor_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logical_expression`.
     * @param ctx the parse tree
     */
    enterLogical_expression?: (ctx: Logical_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logical_expression`.
     * @param ctx the parse tree
     */
    exitLogical_expression?: (ctx: Logical_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unary_logical_expression`.
     * @param ctx the parse tree
     */
    enterUnary_logical_expression?: (ctx: Unary_logical_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unary_logical_expression`.
     * @param ctx the parse tree
     */
    exitUnary_logical_expression?: (ctx: Unary_logical_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unary_logical_operation`.
     * @param ctx the parse tree
     */
    enterUnary_logical_operation?: (ctx: Unary_logical_operationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unary_logical_operation`.
     * @param ctx the parse tree
     */
    exitUnary_logical_operation?: (ctx: Unary_logical_operationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.logical_operation`.
     * @param ctx the parse tree
     */
    enterLogical_operation?: (ctx: Logical_operationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.logical_operation`.
     * @param ctx the parse tree
     */
    exitLogical_operation?: (ctx: Logical_operationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.multiset_expression`.
     * @param ctx the parse tree
     */
    enterMultiset_expression?: (ctx: Multiset_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.multiset_expression`.
     * @param ctx the parse tree
     */
    exitMultiset_expression?: (ctx: Multiset_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_expression`.
     * @param ctx the parse tree
     */
    enterRelational_expression?: (ctx: Relational_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_expression`.
     * @param ctx the parse tree
     */
    exitRelational_expression?: (ctx: Relational_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.compound_expression`.
     * @param ctx the parse tree
     */
    enterCompound_expression?: (ctx: Compound_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.compound_expression`.
     * @param ctx the parse tree
     */
    exitCompound_expression?: (ctx: Compound_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.relational_operator`.
     * @param ctx the parse tree
     */
    enterRelational_operator?: (ctx: Relational_operatorContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.relational_operator`.
     * @param ctx the parse tree
     */
    exitRelational_operator?: (ctx: Relational_operatorContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.in_elements`.
     * @param ctx the parse tree
     */
    enterIn_elements?: (ctx: In_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.in_elements`.
     * @param ctx the parse tree
     */
    exitIn_elements?: (ctx: In_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.between_elements`.
     * @param ctx the parse tree
     */
    enterBetween_elements?: (ctx: Between_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.between_elements`.
     * @param ctx the parse tree
     */
    exitBetween_elements?: (ctx: Between_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.concatenation`.
     * @param ctx the parse tree
     */
    enterConcatenation?: (ctx: ConcatenationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.concatenation`.
     * @param ctx the parse tree
     */
    exitConcatenation?: (ctx: ConcatenationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.interval_expression`.
     * @param ctx the parse tree
     */
    enterInterval_expression?: (ctx: Interval_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.interval_expression`.
     * @param ctx the parse tree
     */
    exitInterval_expression?: (ctx: Interval_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_expression`.
     * @param ctx the parse tree
     */
    enterModel_expression?: (ctx: Model_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_expression`.
     * @param ctx the parse tree
     */
    exitModel_expression?: (ctx: Model_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.model_expression_element`.
     * @param ctx the parse tree
     */
    enterModel_expression_element?: (ctx: Model_expression_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.model_expression_element`.
     * @param ctx the parse tree
     */
    exitModel_expression_element?: (ctx: Model_expression_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.single_column_for_loop`.
     * @param ctx the parse tree
     */
    enterSingle_column_for_loop?: (ctx: Single_column_for_loopContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.single_column_for_loop`.
     * @param ctx the parse tree
     */
    exitSingle_column_for_loop?: (ctx: Single_column_for_loopContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.multi_column_for_loop`.
     * @param ctx the parse tree
     */
    enterMulti_column_for_loop?: (ctx: Multi_column_for_loopContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.multi_column_for_loop`.
     * @param ctx the parse tree
     */
    exitMulti_column_for_loop?: (ctx: Multi_column_for_loopContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unary_expression`.
     * @param ctx the parse tree
     */
    enterUnary_expression?: (ctx: Unary_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unary_expression`.
     * @param ctx the parse tree
     */
    exitUnary_expression?: (ctx: Unary_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.unary_expression_core`.
     * @param ctx the parse tree
     */
    enterUnary_expression_core?: (ctx: Unary_expression_coreContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.unary_expression_core`.
     * @param ctx the parse tree
     */
    exitUnary_expression_core?: (ctx: Unary_expression_coreContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.selection_directive_expression`.
     * @param ctx the parse tree
     */
    enterSelection_directive_expression?: (ctx: Selection_directive_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.selection_directive_expression`.
     * @param ctx the parse tree
     */
    exitSelection_directive_expression?: (ctx: Selection_directive_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.implicit_cursor_expression`.
     * @param ctx the parse tree
     */
    enterImplicit_cursor_expression?: (ctx: Implicit_cursor_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.implicit_cursor_expression`.
     * @param ctx the parse tree
     */
    exitImplicit_cursor_expression?: (ctx: Implicit_cursor_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.collection_expression`.
     * @param ctx the parse tree
     */
    enterCollection_expression?: (ctx: Collection_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.collection_expression`.
     * @param ctx the parse tree
     */
    exitCollection_expression?: (ctx: Collection_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_statement`.
     * @param ctx the parse tree
     */
    enterCase_statement?: (ctx: Case_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_statement`.
     * @param ctx the parse tree
     */
    exitCase_statement?: (ctx: Case_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.simple_case_statement`.
     * @param ctx the parse tree
     */
    enterSimple_case_statement?: (ctx: Simple_case_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.simple_case_statement`.
     * @param ctx the parse tree
     */
    exitSimple_case_statement?: (ctx: Simple_case_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.searched_case_statement`.
     * @param ctx the parse tree
     */
    enterSearched_case_statement?: (ctx: Searched_case_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.searched_case_statement`.
     * @param ctx the parse tree
     */
    exitSearched_case_statement?: (ctx: Searched_case_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_when_part_statement`.
     * @param ctx the parse tree
     */
    enterCase_when_part_statement?: (ctx: Case_when_part_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_when_part_statement`.
     * @param ctx the parse tree
     */
    exitCase_when_part_statement?: (ctx: Case_when_part_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_else_part_statement`.
     * @param ctx the parse tree
     */
    enterCase_else_part_statement?: (ctx: Case_else_part_statementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_else_part_statement`.
     * @param ctx the parse tree
     */
    exitCase_else_part_statement?: (ctx: Case_else_part_statementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_expression`.
     * @param ctx the parse tree
     */
    enterCase_expression?: (ctx: Case_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_expression`.
     * @param ctx the parse tree
     */
    exitCase_expression?: (ctx: Case_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.simple_case_expression`.
     * @param ctx the parse tree
     */
    enterSimple_case_expression?: (ctx: Simple_case_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.simple_case_expression`.
     * @param ctx the parse tree
     */
    exitSimple_case_expression?: (ctx: Simple_case_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.searched_case_expression`.
     * @param ctx the parse tree
     */
    enterSearched_case_expression?: (ctx: Searched_case_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.searched_case_expression`.
     * @param ctx the parse tree
     */
    exitSearched_case_expression?: (ctx: Searched_case_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_when_part_expression`.
     * @param ctx the parse tree
     */
    enterCase_when_part_expression?: (ctx: Case_when_part_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_when_part_expression`.
     * @param ctx the parse tree
     */
    exitCase_when_part_expression?: (ctx: Case_when_part_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.case_else_part_expression`.
     * @param ctx the parse tree
     */
    enterCase_else_part_expression?: (ctx: Case_else_part_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.case_else_part_expression`.
     * @param ctx the parse tree
     */
    exitCase_else_part_expression?: (ctx: Case_else_part_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.atom`.
     * @param ctx the parse tree
     */
    enterAtom?: (ctx: AtomContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.atom`.
     * @param ctx the parse tree
     */
    exitAtom?: (ctx: AtomContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.quantified_expression`.
     * @param ctx the parse tree
     */
    enterQuantified_expression?: (ctx: Quantified_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.quantified_expression`.
     * @param ctx the parse tree
     */
    exitQuantified_expression?: (ctx: Quantified_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.string_function`.
     * @param ctx the parse tree
     */
    enterString_function?: (ctx: String_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.string_function`.
     * @param ctx the parse tree
     */
    exitString_function?: (ctx: String_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.standard_function`.
     * @param ctx the parse tree
     */
    enterStandard_function?: (ctx: Standard_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.standard_function`.
     * @param ctx the parse tree
     */
    exitStandard_function?: (ctx: Standard_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_function`.
     * @param ctx the parse tree
     */
    enterJson_function?: (ctx: Json_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_function`.
     * @param ctx the parse tree
     */
    exitJson_function?: (ctx: Json_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_object_content`.
     * @param ctx the parse tree
     */
    enterJson_object_content?: (ctx: Json_object_contentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_object_content`.
     * @param ctx the parse tree
     */
    exitJson_object_content?: (ctx: Json_object_contentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_object_entry`.
     * @param ctx the parse tree
     */
    enterJson_object_entry?: (ctx: Json_object_entryContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_object_entry`.
     * @param ctx the parse tree
     */
    exitJson_object_entry?: (ctx: Json_object_entryContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_table_clause`.
     * @param ctx the parse tree
     */
    enterJson_table_clause?: (ctx: Json_table_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_table_clause`.
     * @param ctx the parse tree
     */
    exitJson_table_clause?: (ctx: Json_table_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_array_element`.
     * @param ctx the parse tree
     */
    enterJson_array_element?: (ctx: Json_array_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_array_element`.
     * @param ctx the parse tree
     */
    exitJson_array_element?: (ctx: Json_array_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_on_null_clause`.
     * @param ctx the parse tree
     */
    enterJson_on_null_clause?: (ctx: Json_on_null_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_on_null_clause`.
     * @param ctx the parse tree
     */
    exitJson_on_null_clause?: (ctx: Json_on_null_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_return_clause`.
     * @param ctx the parse tree
     */
    enterJson_return_clause?: (ctx: Json_return_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_return_clause`.
     * @param ctx the parse tree
     */
    exitJson_return_clause?: (ctx: Json_return_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_transform_op`.
     * @param ctx the parse tree
     */
    enterJson_transform_op?: (ctx: Json_transform_opContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_transform_op`.
     * @param ctx the parse tree
     */
    exitJson_transform_op?: (ctx: Json_transform_opContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_column_clause`.
     * @param ctx the parse tree
     */
    enterJson_column_clause?: (ctx: Json_column_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_column_clause`.
     * @param ctx the parse tree
     */
    exitJson_column_clause?: (ctx: Json_column_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_column_definition`.
     * @param ctx the parse tree
     */
    enterJson_column_definition?: (ctx: Json_column_definitionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_column_definition`.
     * @param ctx the parse tree
     */
    exitJson_column_definition?: (ctx: Json_column_definitionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_query_returning_clause`.
     * @param ctx the parse tree
     */
    enterJson_query_returning_clause?: (ctx: Json_query_returning_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_query_returning_clause`.
     * @param ctx the parse tree
     */
    exitJson_query_returning_clause?: (ctx: Json_query_returning_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_query_return_type`.
     * @param ctx the parse tree
     */
    enterJson_query_return_type?: (ctx: Json_query_return_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_query_return_type`.
     * @param ctx the parse tree
     */
    exitJson_query_return_type?: (ctx: Json_query_return_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_query_wrapper_clause`.
     * @param ctx the parse tree
     */
    enterJson_query_wrapper_clause?: (ctx: Json_query_wrapper_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_query_wrapper_clause`.
     * @param ctx the parse tree
     */
    exitJson_query_wrapper_clause?: (ctx: Json_query_wrapper_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_query_on_error_clause`.
     * @param ctx the parse tree
     */
    enterJson_query_on_error_clause?: (ctx: Json_query_on_error_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_query_on_error_clause`.
     * @param ctx the parse tree
     */
    exitJson_query_on_error_clause?: (ctx: Json_query_on_error_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_query_on_empty_clause`.
     * @param ctx the parse tree
     */
    enterJson_query_on_empty_clause?: (ctx: Json_query_on_empty_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_query_on_empty_clause`.
     * @param ctx the parse tree
     */
    exitJson_query_on_empty_clause?: (ctx: Json_query_on_empty_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_value_return_clause`.
     * @param ctx the parse tree
     */
    enterJson_value_return_clause?: (ctx: Json_value_return_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_value_return_clause`.
     * @param ctx the parse tree
     */
    exitJson_value_return_clause?: (ctx: Json_value_return_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_value_return_type`.
     * @param ctx the parse tree
     */
    enterJson_value_return_type?: (ctx: Json_value_return_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_value_return_type`.
     * @param ctx the parse tree
     */
    exitJson_value_return_type?: (ctx: Json_value_return_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.json_value_on_mismatch_clause`.
     * @param ctx the parse tree
     */
    enterJson_value_on_mismatch_clause?: (ctx: Json_value_on_mismatch_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.json_value_on_mismatch_clause`.
     * @param ctx the parse tree
     */
    exitJson_value_on_mismatch_clause?: (ctx: Json_value_on_mismatch_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.literal`.
     * @param ctx the parse tree
     */
    enterLiteral?: (ctx: LiteralContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.literal`.
     * @param ctx the parse tree
     */
    exitLiteral?: (ctx: LiteralContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.numeric_function_wrapper`.
     * @param ctx the parse tree
     */
    enterNumeric_function_wrapper?: (ctx: Numeric_function_wrapperContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.numeric_function_wrapper`.
     * @param ctx the parse tree
     */
    exitNumeric_function_wrapper?: (ctx: Numeric_function_wrapperContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.numeric_function`.
     * @param ctx the parse tree
     */
    enterNumeric_function?: (ctx: Numeric_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.numeric_function`.
     * @param ctx the parse tree
     */
    exitNumeric_function?: (ctx: Numeric_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.listagg_overflow_clause`.
     * @param ctx the parse tree
     */
    enterListagg_overflow_clause?: (ctx: Listagg_overflow_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.listagg_overflow_clause`.
     * @param ctx the parse tree
     */
    exitListagg_overflow_clause?: (ctx: Listagg_overflow_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.other_function`.
     * @param ctx the parse tree
     */
    enterOther_function?: (ctx: Other_functionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.other_function`.
     * @param ctx the parse tree
     */
    exitOther_function?: (ctx: Other_functionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.over_clause_keyword`.
     * @param ctx the parse tree
     */
    enterOver_clause_keyword?: (ctx: Over_clause_keywordContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.over_clause_keyword`.
     * @param ctx the parse tree
     */
    exitOver_clause_keyword?: (ctx: Over_clause_keywordContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.within_or_over_clause_keyword`.
     * @param ctx the parse tree
     */
    enterWithin_or_over_clause_keyword?: (ctx: Within_or_over_clause_keywordContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.within_or_over_clause_keyword`.
     * @param ctx the parse tree
     */
    exitWithin_or_over_clause_keyword?: (ctx: Within_or_over_clause_keywordContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.standard_prediction_function_keyword`.
     * @param ctx the parse tree
     */
    enterStandard_prediction_function_keyword?: (ctx: Standard_prediction_function_keywordContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.standard_prediction_function_keyword`.
     * @param ctx the parse tree
     */
    exitStandard_prediction_function_keyword?: (ctx: Standard_prediction_function_keywordContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.over_clause`.
     * @param ctx the parse tree
     */
    enterOver_clause?: (ctx: Over_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.over_clause`.
     * @param ctx the parse tree
     */
    exitOver_clause?: (ctx: Over_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.windowing_clause`.
     * @param ctx the parse tree
     */
    enterWindowing_clause?: (ctx: Windowing_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.windowing_clause`.
     * @param ctx the parse tree
     */
    exitWindowing_clause?: (ctx: Windowing_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.windowing_type`.
     * @param ctx the parse tree
     */
    enterWindowing_type?: (ctx: Windowing_typeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.windowing_type`.
     * @param ctx the parse tree
     */
    exitWindowing_type?: (ctx: Windowing_typeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.windowing_elements`.
     * @param ctx the parse tree
     */
    enterWindowing_elements?: (ctx: Windowing_elementsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.windowing_elements`.
     * @param ctx the parse tree
     */
    exitWindowing_elements?: (ctx: Windowing_elementsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_clause`.
     * @param ctx the parse tree
     */
    enterUsing_clause?: (ctx: Using_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_clause`.
     * @param ctx the parse tree
     */
    exitUsing_clause?: (ctx: Using_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.using_element`.
     * @param ctx the parse tree
     */
    enterUsing_element?: (ctx: Using_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.using_element`.
     * @param ctx the parse tree
     */
    exitUsing_element?: (ctx: Using_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.assignable_element`.
     * @param ctx the parse tree
     */
    enterAssignable_element?: (ctx: Assignable_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.assignable_element`.
     * @param ctx the parse tree
     */
    exitAssignable_element?: (ctx: Assignable_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.collect_order_by_part`.
     * @param ctx the parse tree
     */
    enterCollect_order_by_part?: (ctx: Collect_order_by_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.collect_order_by_part`.
     * @param ctx the parse tree
     */
    exitCollect_order_by_part?: (ctx: Collect_order_by_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.within_or_over_part`.
     * @param ctx the parse tree
     */
    enterWithin_or_over_part?: (ctx: Within_or_over_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.within_or_over_part`.
     * @param ctx the parse tree
     */
    exitWithin_or_over_part?: (ctx: Within_or_over_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.string_delimiter`.
     * @param ctx the parse tree
     */
    enterString_delimiter?: (ctx: String_delimiterContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.string_delimiter`.
     * @param ctx the parse tree
     */
    exitString_delimiter?: (ctx: String_delimiterContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cost_matrix_clause`.
     * @param ctx the parse tree
     */
    enterCost_matrix_clause?: (ctx: Cost_matrix_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cost_matrix_clause`.
     * @param ctx the parse tree
     */
    exitCost_matrix_clause?: (ctx: Cost_matrix_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_passing_clause`.
     * @param ctx the parse tree
     */
    enterXml_passing_clause?: (ctx: Xml_passing_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_passing_clause`.
     * @param ctx the parse tree
     */
    exitXml_passing_clause?: (ctx: Xml_passing_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_attributes_clause`.
     * @param ctx the parse tree
     */
    enterXml_attributes_clause?: (ctx: Xml_attributes_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_attributes_clause`.
     * @param ctx the parse tree
     */
    exitXml_attributes_clause?: (ctx: Xml_attributes_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_namespaces_clause`.
     * @param ctx the parse tree
     */
    enterXml_namespaces_clause?: (ctx: Xml_namespaces_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_namespaces_clause`.
     * @param ctx the parse tree
     */
    exitXml_namespaces_clause?: (ctx: Xml_namespaces_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_table_column`.
     * @param ctx the parse tree
     */
    enterXml_table_column?: (ctx: Xml_table_columnContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_table_column`.
     * @param ctx the parse tree
     */
    exitXml_table_column?: (ctx: Xml_table_columnContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_general_default_part`.
     * @param ctx the parse tree
     */
    enterXml_general_default_part?: (ctx: Xml_general_default_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_general_default_part`.
     * @param ctx the parse tree
     */
    exitXml_general_default_part?: (ctx: Xml_general_default_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_multiuse_expression_element`.
     * @param ctx the parse tree
     */
    enterXml_multiuse_expression_element?: (ctx: Xml_multiuse_expression_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_multiuse_expression_element`.
     * @param ctx the parse tree
     */
    exitXml_multiuse_expression_element?: (ctx: Xml_multiuse_expression_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlroot_param_version_part`.
     * @param ctx the parse tree
     */
    enterXmlroot_param_version_part?: (ctx: Xmlroot_param_version_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlroot_param_version_part`.
     * @param ctx the parse tree
     */
    exitXmlroot_param_version_part?: (ctx: Xmlroot_param_version_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlroot_param_standalone_part`.
     * @param ctx the parse tree
     */
    enterXmlroot_param_standalone_part?: (ctx: Xmlroot_param_standalone_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlroot_param_standalone_part`.
     * @param ctx the parse tree
     */
    exitXmlroot_param_standalone_part?: (ctx: Xmlroot_param_standalone_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlserialize_param_enconding_part`.
     * @param ctx the parse tree
     */
    enterXmlserialize_param_enconding_part?: (ctx: Xmlserialize_param_enconding_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlserialize_param_enconding_part`.
     * @param ctx the parse tree
     */
    exitXmlserialize_param_enconding_part?: (ctx: Xmlserialize_param_enconding_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlserialize_param_version_part`.
     * @param ctx the parse tree
     */
    enterXmlserialize_param_version_part?: (ctx: Xmlserialize_param_version_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlserialize_param_version_part`.
     * @param ctx the parse tree
     */
    exitXmlserialize_param_version_part?: (ctx: Xmlserialize_param_version_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmlserialize_param_ident_part`.
     * @param ctx the parse tree
     */
    enterXmlserialize_param_ident_part?: (ctx: Xmlserialize_param_ident_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmlserialize_param_ident_part`.
     * @param ctx the parse tree
     */
    exitXmlserialize_param_ident_part?: (ctx: Xmlserialize_param_ident_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.annotations_clause`.
     * @param ctx the parse tree
     */
    enterAnnotations_clause?: (ctx: Annotations_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.annotations_clause`.
     * @param ctx the parse tree
     */
    exitAnnotations_clause?: (ctx: Annotations_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.annotations_list`.
     * @param ctx the parse tree
     */
    enterAnnotations_list?: (ctx: Annotations_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.annotations_list`.
     * @param ctx the parse tree
     */
    exitAnnotations_list?: (ctx: Annotations_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.annotation`.
     * @param ctx the parse tree
     */
    enterAnnotation?: (ctx: AnnotationContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.annotation`.
     * @param ctx the parse tree
     */
    exitAnnotation?: (ctx: AnnotationContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_plus_command`.
     * @param ctx the parse tree
     */
    enterSql_plus_command?: (ctx: Sql_plus_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_plus_command`.
     * @param ctx the parse tree
     */
    exitSql_plus_command?: (ctx: Sql_plus_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.execute_command`.
     * @param ctx the parse tree
     */
    enterExecute_command?: (ctx: Execute_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.execute_command`.
     * @param ctx the parse tree
     */
    exitExecute_command?: (ctx: Execute_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.start_command`.
     * @param ctx the parse tree
     */
    enterStart_command?: (ctx: Start_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.start_command`.
     * @param ctx the parse tree
     */
    exitStart_command?: (ctx: Start_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sql_plus_filepath`.
     * @param ctx the parse tree
     */
    enterSql_plus_filepath?: (ctx: Sql_plus_filepathContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sql_plus_filepath`.
     * @param ctx the parse tree
     */
    exitSql_plus_filepath?: (ctx: Sql_plus_filepathContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.whenever_command`.
     * @param ctx the parse tree
     */
    enterWhenever_command?: (ctx: Whenever_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.whenever_command`.
     * @param ctx the parse tree
     */
    exitWhenever_command?: (ctx: Whenever_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.set_command`.
     * @param ctx the parse tree
     */
    enterSet_command?: (ctx: Set_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.set_command`.
     * @param ctx the parse tree
     */
    exitSet_command?: (ctx: Set_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.timing_command`.
     * @param ctx the parse tree
     */
    enterTiming_command?: (ctx: Timing_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.timing_command`.
     * @param ctx the parse tree
     */
    exitTiming_command?: (ctx: Timing_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.clear_command`.
     * @param ctx the parse tree
     */
    enterClear_command?: (ctx: Clear_commandContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.clear_command`.
     * @param ctx the parse tree
     */
    exitClear_command?: (ctx: Clear_commandContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.partition_extension_clause`.
     * @param ctx the parse tree
     */
    enterPartition_extension_clause?: (ctx: Partition_extension_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.partition_extension_clause`.
     * @param ctx the parse tree
     */
    exitPartition_extension_clause?: (ctx: Partition_extension_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_alias`.
     * @param ctx the parse tree
     */
    enterColumn_alias?: (ctx: Column_aliasContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_alias`.
     * @param ctx the parse tree
     */
    exitColumn_alias?: (ctx: Column_aliasContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_alias`.
     * @param ctx the parse tree
     */
    enterTable_alias?: (ctx: Table_aliasContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_alias`.
     * @param ctx the parse tree
     */
    exitTable_alias?: (ctx: Table_aliasContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.where_clause`.
     * @param ctx the parse tree
     */
    enterWhere_clause?: (ctx: Where_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.where_clause`.
     * @param ctx the parse tree
     */
    exitWhere_clause?: (ctx: Where_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.into_clause`.
     * @param ctx the parse tree
     */
    enterInto_clause?: (ctx: Into_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.into_clause`.
     * @param ctx the parse tree
     */
    exitInto_clause?: (ctx: Into_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xml_column_name`.
     * @param ctx the parse tree
     */
    enterXml_column_name?: (ctx: Xml_column_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xml_column_name`.
     * @param ctx the parse tree
     */
    exitXml_column_name?: (ctx: Xml_column_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cost_class_name`.
     * @param ctx the parse tree
     */
    enterCost_class_name?: (ctx: Cost_class_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cost_class_name`.
     * @param ctx the parse tree
     */
    exitCost_class_name?: (ctx: Cost_class_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.attribute_name`.
     * @param ctx the parse tree
     */
    enterAttribute_name?: (ctx: Attribute_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.attribute_name`.
     * @param ctx the parse tree
     */
    exitAttribute_name?: (ctx: Attribute_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.savepoint_name`.
     * @param ctx the parse tree
     */
    enterSavepoint_name?: (ctx: Savepoint_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.savepoint_name`.
     * @param ctx the parse tree
     */
    exitSavepoint_name?: (ctx: Savepoint_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.rollback_segment_name`.
     * @param ctx the parse tree
     */
    enterRollback_segment_name?: (ctx: Rollback_segment_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.rollback_segment_name`.
     * @param ctx the parse tree
     */
    exitRollback_segment_name?: (ctx: Rollback_segment_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.schema_name`.
     * @param ctx the parse tree
     */
    enterSchema_name?: (ctx: Schema_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.schema_name`.
     * @param ctx the parse tree
     */
    exitSchema_name?: (ctx: Schema_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.routine_name`.
     * @param ctx the parse tree
     */
    enterRoutine_name?: (ctx: Routine_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.routine_name`.
     * @param ctx the parse tree
     */
    exitRoutine_name?: (ctx: Routine_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.package_name`.
     * @param ctx the parse tree
     */
    enterPackage_name?: (ctx: Package_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.package_name`.
     * @param ctx the parse tree
     */
    exitPackage_name?: (ctx: Package_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.implementation_type_name`.
     * @param ctx the parse tree
     */
    enterImplementation_type_name?: (ctx: Implementation_type_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.implementation_type_name`.
     * @param ctx the parse tree
     */
    exitImplementation_type_name?: (ctx: Implementation_type_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.parameter_name`.
     * @param ctx the parse tree
     */
    enterParameter_name?: (ctx: Parameter_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.parameter_name`.
     * @param ctx the parse tree
     */
    exitParameter_name?: (ctx: Parameter_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.reference_model_name`.
     * @param ctx the parse tree
     */
    enterReference_model_name?: (ctx: Reference_model_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.reference_model_name`.
     * @param ctx the parse tree
     */
    exitReference_model_name?: (ctx: Reference_model_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.main_model_name`.
     * @param ctx the parse tree
     */
    enterMain_model_name?: (ctx: Main_model_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.main_model_name`.
     * @param ctx the parse tree
     */
    exitMain_model_name?: (ctx: Main_model_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.container_tableview_name`.
     * @param ctx the parse tree
     */
    enterContainer_tableview_name?: (ctx: Container_tableview_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.container_tableview_name`.
     * @param ctx the parse tree
     */
    exitContainer_tableview_name?: (ctx: Container_tableview_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.aggregate_function_name`.
     * @param ctx the parse tree
     */
    enterAggregate_function_name?: (ctx: Aggregate_function_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.aggregate_function_name`.
     * @param ctx the parse tree
     */
    exitAggregate_function_name?: (ctx: Aggregate_function_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.query_name`.
     * @param ctx the parse tree
     */
    enterQuery_name?: (ctx: Query_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.query_name`.
     * @param ctx the parse tree
     */
    exitQuery_name?: (ctx: Query_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.grantee_name`.
     * @param ctx the parse tree
     */
    enterGrantee_name?: (ctx: Grantee_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.grantee_name`.
     * @param ctx the parse tree
     */
    exitGrantee_name?: (ctx: Grantee_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.role_name`.
     * @param ctx the parse tree
     */
    enterRole_name?: (ctx: Role_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.role_name`.
     * @param ctx the parse tree
     */
    exitRole_name?: (ctx: Role_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constraint_name`.
     * @param ctx the parse tree
     */
    enterConstraint_name?: (ctx: Constraint_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constraint_name`.
     * @param ctx the parse tree
     */
    exitConstraint_name?: (ctx: Constraint_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.label_name`.
     * @param ctx the parse tree
     */
    enterLabel_name?: (ctx: Label_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.label_name`.
     * @param ctx the parse tree
     */
    exitLabel_name?: (ctx: Label_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_name`.
     * @param ctx the parse tree
     */
    enterType_name?: (ctx: Type_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_name`.
     * @param ctx the parse tree
     */
    exitType_name?: (ctx: Type_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.sequence_name`.
     * @param ctx the parse tree
     */
    enterSequence_name?: (ctx: Sequence_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.sequence_name`.
     * @param ctx the parse tree
     */
    exitSequence_name?: (ctx: Sequence_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.exception_name`.
     * @param ctx the parse tree
     */
    enterException_name?: (ctx: Exception_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.exception_name`.
     * @param ctx the parse tree
     */
    exitException_name?: (ctx: Exception_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_name`.
     * @param ctx the parse tree
     */
    enterFunction_name?: (ctx: Function_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_name`.
     * @param ctx the parse tree
     */
    exitFunction_name?: (ctx: Function_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.procedure_name`.
     * @param ctx the parse tree
     */
    enterProcedure_name?: (ctx: Procedure_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.procedure_name`.
     * @param ctx the parse tree
     */
    exitProcedure_name?: (ctx: Procedure_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.trigger_name`.
     * @param ctx the parse tree
     */
    enterTrigger_name?: (ctx: Trigger_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.trigger_name`.
     * @param ctx the parse tree
     */
    exitTrigger_name?: (ctx: Trigger_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.variable_name`.
     * @param ctx the parse tree
     */
    enterVariable_name?: (ctx: Variable_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.variable_name`.
     * @param ctx the parse tree
     */
    exitVariable_name?: (ctx: Variable_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.index_name`.
     * @param ctx the parse tree
     */
    enterIndex_name?: (ctx: Index_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.index_name`.
     * @param ctx the parse tree
     */
    exitIndex_name?: (ctx: Index_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.cursor_name`.
     * @param ctx the parse tree
     */
    enterCursor_name?: (ctx: Cursor_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.cursor_name`.
     * @param ctx the parse tree
     */
    exitCursor_name?: (ctx: Cursor_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.record_name`.
     * @param ctx the parse tree
     */
    enterRecord_name?: (ctx: Record_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.record_name`.
     * @param ctx the parse tree
     */
    exitRecord_name?: (ctx: Record_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.link_name`.
     * @param ctx the parse tree
     */
    enterLink_name?: (ctx: Link_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.link_name`.
     * @param ctx the parse tree
     */
    exitLink_name?: (ctx: Link_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.local_link_name`.
     * @param ctx the parse tree
     */
    enterLocal_link_name?: (ctx: Local_link_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.local_link_name`.
     * @param ctx the parse tree
     */
    exitLocal_link_name?: (ctx: Local_link_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.connection_qualifier`.
     * @param ctx the parse tree
     */
    enterConnection_qualifier?: (ctx: Connection_qualifierContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.connection_qualifier`.
     * @param ctx the parse tree
     */
    exitConnection_qualifier?: (ctx: Connection_qualifierContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_name`.
     * @param ctx the parse tree
     */
    enterColumn_name?: (ctx: Column_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_name`.
     * @param ctx the parse tree
     */
    exitColumn_name?: (ctx: Column_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.tableview_name`.
     * @param ctx the parse tree
     */
    enterTableview_name?: (ctx: Tableview_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.tableview_name`.
     * @param ctx the parse tree
     */
    exitTableview_name?: (ctx: Tableview_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.xmltable`.
     * @param ctx the parse tree
     */
    enterXmltable?: (ctx: XmltableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.xmltable`.
     * @param ctx the parse tree
     */
    exitXmltable?: (ctx: XmltableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.char_set_name`.
     * @param ctx the parse tree
     */
    enterChar_set_name?: (ctx: Char_set_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.char_set_name`.
     * @param ctx the parse tree
     */
    exitChar_set_name?: (ctx: Char_set_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.synonym_name`.
     * @param ctx the parse tree
     */
    enterSynonym_name?: (ctx: Synonym_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.synonym_name`.
     * @param ctx the parse tree
     */
    exitSynonym_name?: (ctx: Synonym_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.schema_object_name`.
     * @param ctx the parse tree
     */
    enterSchema_object_name?: (ctx: Schema_object_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.schema_object_name`.
     * @param ctx the parse tree
     */
    exitSchema_object_name?: (ctx: Schema_object_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.dir_object_name`.
     * @param ctx the parse tree
     */
    enterDir_object_name?: (ctx: Dir_object_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.dir_object_name`.
     * @param ctx the parse tree
     */
    exitDir_object_name?: (ctx: Dir_object_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.user_object_name`.
     * @param ctx the parse tree
     */
    enterUser_object_name?: (ctx: User_object_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.user_object_name`.
     * @param ctx the parse tree
     */
    exitUser_object_name?: (ctx: User_object_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.grant_object_name`.
     * @param ctx the parse tree
     */
    enterGrant_object_name?: (ctx: Grant_object_nameContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.grant_object_name`.
     * @param ctx the parse tree
     */
    exitGrant_object_name?: (ctx: Grant_object_nameContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.column_list`.
     * @param ctx the parse tree
     */
    enterColumn_list?: (ctx: Column_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.column_list`.
     * @param ctx the parse tree
     */
    exitColumn_list?: (ctx: Column_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.paren_column_list`.
     * @param ctx the parse tree
     */
    enterParen_column_list?: (ctx: Paren_column_listContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.paren_column_list`.
     * @param ctx the parse tree
     */
    exitParen_column_list?: (ctx: Paren_column_listContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.keep_clause`.
     * @param ctx the parse tree
     */
    enterKeep_clause?: (ctx: Keep_clauseContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.keep_clause`.
     * @param ctx the parse tree
     */
    exitKeep_clause?: (ctx: Keep_clauseContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_argument`.
     * @param ctx the parse tree
     */
    enterFunction_argument?: (ctx: Function_argumentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_argument`.
     * @param ctx the parse tree
     */
    exitFunction_argument?: (ctx: Function_argumentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_argument_analytic`.
     * @param ctx the parse tree
     */
    enterFunction_argument_analytic?: (ctx: Function_argument_analyticContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_argument_analytic`.
     * @param ctx the parse tree
     */
    exitFunction_argument_analytic?: (ctx: Function_argument_analyticContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.function_argument_modeling`.
     * @param ctx the parse tree
     */
    enterFunction_argument_modeling?: (ctx: Function_argument_modelingContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.function_argument_modeling`.
     * @param ctx the parse tree
     */
    exitFunction_argument_modeling?: (ctx: Function_argument_modelingContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.respect_or_ignore_nulls`.
     * @param ctx the parse tree
     */
    enterRespect_or_ignore_nulls?: (ctx: Respect_or_ignore_nullsContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.respect_or_ignore_nulls`.
     * @param ctx the parse tree
     */
    exitRespect_or_ignore_nulls?: (ctx: Respect_or_ignore_nullsContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.argument`.
     * @param ctx the parse tree
     */
    enterArgument?: (ctx: ArgumentContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.argument`.
     * @param ctx the parse tree
     */
    exitArgument?: (ctx: ArgumentContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.type_spec`.
     * @param ctx the parse tree
     */
    enterType_spec?: (ctx: Type_specContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.type_spec`.
     * @param ctx the parse tree
     */
    exitType_spec?: (ctx: Type_specContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.datatype`.
     * @param ctx the parse tree
     */
    enterDatatype?: (ctx: DatatypeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.datatype`.
     * @param ctx the parse tree
     */
    exitDatatype?: (ctx: DatatypeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.precision_part`.
     * @param ctx the parse tree
     */
    enterPrecision_part?: (ctx: Precision_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.precision_part`.
     * @param ctx the parse tree
     */
    exitPrecision_part?: (ctx: Precision_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.native_datatype_element`.
     * @param ctx the parse tree
     */
    enterNative_datatype_element?: (ctx: Native_datatype_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.native_datatype_element`.
     * @param ctx the parse tree
     */
    exitNative_datatype_element?: (ctx: Native_datatype_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.bind_variable`.
     * @param ctx the parse tree
     */
    enterBind_variable?: (ctx: Bind_variableContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.bind_variable`.
     * @param ctx the parse tree
     */
    exitBind_variable?: (ctx: Bind_variableContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.general_element`.
     * @param ctx the parse tree
     */
    enterGeneral_element?: (ctx: General_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.general_element`.
     * @param ctx the parse tree
     */
    exitGeneral_element?: (ctx: General_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.general_element_part`.
     * @param ctx the parse tree
     */
    enterGeneral_element_part?: (ctx: General_element_partContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.general_element_part`.
     * @param ctx the parse tree
     */
    exitGeneral_element_part?: (ctx: General_element_partContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.table_element`.
     * @param ctx the parse tree
     */
    enterTable_element?: (ctx: Table_elementContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.table_element`.
     * @param ctx the parse tree
     */
    exitTable_element?: (ctx: Table_elementContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.object_privilege`.
     * @param ctx the parse tree
     */
    enterObject_privilege?: (ctx: Object_privilegeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.object_privilege`.
     * @param ctx the parse tree
     */
    exitObject_privilege?: (ctx: Object_privilegeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.system_privilege`.
     * @param ctx the parse tree
     */
    enterSystem_privilege?: (ctx: System_privilegeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.system_privilege`.
     * @param ctx the parse tree
     */
    exitSystem_privilege?: (ctx: System_privilegeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.constant`.
     * @param ctx the parse tree
     */
    enterConstant?: (ctx: ConstantContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.constant`.
     * @param ctx the parse tree
     */
    exitConstant?: (ctx: ConstantContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.numeric`.
     * @param ctx the parse tree
     */
    enterNumeric?: (ctx: NumericContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.numeric`.
     * @param ctx the parse tree
     */
    exitNumeric?: (ctx: NumericContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.numeric_negative`.
     * @param ctx the parse tree
     */
    enterNumeric_negative?: (ctx: Numeric_negativeContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.numeric_negative`.
     * @param ctx the parse tree
     */
    exitNumeric_negative?: (ctx: Numeric_negativeContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.quoted_string`.
     * @param ctx the parse tree
     */
    enterQuoted_string?: (ctx: Quoted_stringContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.quoted_string`.
     * @param ctx the parse tree
     */
    exitQuoted_string?: (ctx: Quoted_stringContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.identifier`.
     * @param ctx the parse tree
     */
    enterIdentifier?: (ctx: IdentifierContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.identifier`.
     * @param ctx the parse tree
     */
    exitIdentifier?: (ctx: IdentifierContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.id_expression`.
     * @param ctx the parse tree
     */
    enterId_expression?: (ctx: Id_expressionContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.id_expression`.
     * @param ctx the parse tree
     */
    exitId_expression?: (ctx: Id_expressionContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.inquiry_directive`.
     * @param ctx the parse tree
     */
    enterInquiry_directive?: (ctx: Inquiry_directiveContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.inquiry_directive`.
     * @param ctx the parse tree
     */
    exitInquiry_directive?: (ctx: Inquiry_directiveContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.outer_join_sign`.
     * @param ctx the parse tree
     */
    enterOuter_join_sign?: (ctx: Outer_join_signContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.outer_join_sign`.
     * @param ctx the parse tree
     */
    exitOuter_join_sign?: (ctx: Outer_join_signContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.regular_id`.
     * @param ctx the parse tree
     */
    enterRegular_id?: (ctx: Regular_idContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.regular_id`.
     * @param ctx the parse tree
     */
    exitRegular_id?: (ctx: Regular_idContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.non_reserved_keywords_in_18c`.
     * @param ctx the parse tree
     */
    enterNon_reserved_keywords_in_18c?: (ctx: Non_reserved_keywords_in_18cContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.non_reserved_keywords_in_18c`.
     * @param ctx the parse tree
     */
    exitNon_reserved_keywords_in_18c?: (ctx: Non_reserved_keywords_in_18cContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.non_reserved_keywords_in_12c`.
     * @param ctx the parse tree
     */
    enterNon_reserved_keywords_in_12c?: (ctx: Non_reserved_keywords_in_12cContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.non_reserved_keywords_in_12c`.
     * @param ctx the parse tree
     */
    exitNon_reserved_keywords_in_12c?: (ctx: Non_reserved_keywords_in_12cContext) => void;
    /**
     * Enter a parse tree produced by `PlSqlParser.non_reserved_keywords_pre12c`.
     * @param ctx the parse tree
     */
    enterNon_reserved_keywords_pre12c?: (ctx: Non_reserved_keywords_pre12cContext) => void;
    /**
     * Exit a parse tree produced by `PlSqlParser.non_reserved_keywords_pre12c`.
     * @param ctx the parse tree
     */
    exitNon_reserved_keywords_pre12c?: (ctx: Non_reserved_keywords_pre12cContext) => void;

    visitTerminal(node: TerminalNode): void {}
    visitErrorNode(node: ErrorNode): void {}
    enterEveryRule(node: ParserRuleContext): void {}
    exitEveryRule(node: ParserRuleContext): void {}
}

