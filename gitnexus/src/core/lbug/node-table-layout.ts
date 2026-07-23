import type { NodeTableName } from 'gitnexus-shared';

export type CsvColumnEncoding =
  | 'node-id'
  | 'string'
  | 'number'
  | 'boolean'
  | 'string-array'
  | 'content'
  | 'description';

export interface NodeTableColumnSpec {
  name: string;
  ddlType: string;
  csvEncoding: CsvColumnEncoding;
  defaultValue?: string | number | boolean;
}

export interface NodeTableLayout {
  table: NodeTableName;
  columns: readonly NodeTableColumnSpec[];
  quoteTableName?: boolean;
}

const column = (
  name: string,
  ddlType: string,
  csvEncoding: CsvColumnEncoding = 'string',
  defaultValue?: string | number | boolean,
): NodeTableColumnSpec => ({ name, ddlType, csvEncoding, defaultValue });

const CODE_ELEMENT_BASE = [
  column('id', 'STRING', 'node-id'),
  column('name', 'STRING'),
  column('filePath', 'STRING'),
  column('startLine', 'INT64', 'number', -1),
  column('endLine', 'INT64', 'number', -1),
  column('isExported', 'BOOLEAN', 'boolean', false),
  column('content', 'STRING', 'content'),
  column('description', 'STRING', 'description'),
] as const;

// Same base as code elements minus isExported (multi-language tables have none).
const MULTI_LANGUAGE_BASE = CODE_ELEMENT_BASE.filter(({ name }) => name !== 'isExported');

export const CODE_ELEMENT_COLUMNS = CODE_ELEMENT_BASE.map(({ name }) => name);
export const MULTI_LANG_BASE_COLUMNS = MULTI_LANGUAGE_BASE.map(({ name }) => name);

const FUNCTION_LAYOUT: NodeTableLayout = {
  table: 'Function',
  columns: [
    ...CODE_ELEMENT_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('moduleQualifiedName', 'STRING'),
    column('visibility', 'STRING'),
    column('visibilityModifier', 'STRING'),
    column('isEntry', 'BOOLEAN', 'boolean', false),
    column('isView', 'BOOLEAN', 'boolean', false),
    column('isInline', 'BOOLEAN', 'boolean', false),
    column('isNative', 'BOOLEAN', 'boolean', false),
    column('parameterCount', 'INT32', 'number', 0),
    column('returnType', 'STRING'),
    column('acquires', 'STRING[]', 'string-array'),
    column('usedTypes', 'STRING[]', 'string-array'),
    column('attributes', 'STRING[]', 'string-array'),
    column('attributesJson', 'STRING'),
    column('typeParamsJson', 'STRING'),
    column('locationFidelity', 'STRING'),
  ],
};

const structLikeLayout = (table: 'Struct' | 'Enum'): NodeTableLayout => ({
  table,
  quoteTableName: true,
  columns: [
    ...MULTI_LANGUAGE_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('moduleQualifiedName', 'STRING'),
    column('moduleAddress', 'STRING'),
    column('abilities', 'STRING[]', 'string-array'),
    column('isResource', 'BOOLEAN', 'boolean', false),
    column('isEvent', 'BOOLEAN', 'boolean', false),
    column('fieldList', 'STRING[]', 'string-array'),
    column('attributes', 'STRING[]', 'string-array'),
    column('attributesJson', 'STRING'),
    column('typeParamsJson', 'STRING'),
    column('moveDeclarationKind', 'STRING'),
    column('locationFidelity', 'STRING'),
  ],
});

const TYPE_LAYOUT: NodeTableLayout = {
  table: 'Type',
  quoteTableName: true,
  columns: [
    ...MULTI_LANGUAGE_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('moduleQualifiedName', 'STRING'),
    column('locationFidelity', 'STRING'),
  ],
};

const ENUM_VARIANT_LAYOUT: NodeTableLayout = {
  table: 'EnumVariant',
  quoteTableName: true,
  columns: [
    ...MULTI_LANGUAGE_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('parentEnum', 'STRING'),
    column('moduleQualifiedName', 'STRING'),
    column('variantKind', 'STRING'),
    column('fieldsJson', 'STRING'),
    column('attributes', 'STRING[]', 'string-array'),
    column('attributesJson', 'STRING'),
    column('locationFidelity', 'STRING'),
  ],
};

const CONST_LAYOUT: NodeTableLayout = {
  table: 'Const',
  quoteTableName: true,
  columns: [
    ...MULTI_LANGUAGE_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('moduleQualifiedName', 'STRING'),
    column('constType', 'STRING'),
    column('constValue', 'STRING'),
    column('isErrorCode', 'BOOLEAN', 'boolean', false),
    column('locationFidelity', 'STRING'),
  ],
};

const MODULE_LAYOUT: NodeTableLayout = {
  table: 'Module',
  quoteTableName: true,
  columns: [
    ...MULTI_LANGUAGE_BASE,
    column('language', 'STRING'),
    column('qualifiedName', 'STRING'),
    column('moduleAddress', 'STRING'),
    column('attributes', 'STRING[]', 'string-array'),
    column('attributesJson', 'STRING'),
    column('locationFidelity', 'STRING'),
  ],
};

export const NODE_TABLE_LAYOUTS = {
  Function: FUNCTION_LAYOUT,
  Struct: structLikeLayout('Struct'),
  Enum: structLikeLayout('Enum'),
  Type: TYPE_LAYOUT,
  EnumVariant: ENUM_VARIANT_LAYOUT,
  Const: CONST_LAYOUT,
  Module: MODULE_LAYOUT,
} as const satisfies Partial<Record<NodeTableName, NodeTableLayout>>;

export type LayoutTableName = keyof typeof NODE_TABLE_LAYOUTS;

export const hasNodeTableLayout = (table: string): table is LayoutTableName =>
  Object.hasOwn(NODE_TABLE_LAYOUTS, table);

export const getNodeTableLayout = (table: LayoutTableName): NodeTableLayout =>
  NODE_TABLE_LAYOUTS[table];

export const getNodeTableColumnNames = (table: NodeTableName): readonly string[] | undefined =>
  hasNodeTableLayout(table) ? getNodeTableLayout(table).columns.map(({ name }) => name) : undefined;

export const getNodeTableCsvHeader = (table: LayoutTableName): string =>
  NODE_TABLE_LAYOUTS[table].columns.map(({ name }) => name).join(',');

export const buildNodeTableSchema = (table: LayoutTableName): string => {
  const layout = NODE_TABLE_LAYOUTS[table];
  const tableName = layout.quoteTableName ? `\`${layout.table}\`` : layout.table;
  const columns = layout.columns.map(({ name, ddlType }) => `  ${name} ${ddlType},`).join('\n');
  return `\nCREATE NODE TABLE ${tableName} (\n${columns}\n  PRIMARY KEY (id)\n)`;
};
