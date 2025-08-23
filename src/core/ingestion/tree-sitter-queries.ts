
export const TYPESCRIPT_QUERIES = {
  imports: `
    (import_statement) @import
  `,
  classes: `
    (class_declaration) @class
  `,
  methods: `
    (method_definition) @method
  `,
  functions: `
    (function_declaration) @function
  `,
  arrowFunctions: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function))) @arrow_function
  `,
  interfaces: `
    (interface_declaration) @interface
  `,
  types: `
    (type_alias_declaration) @type
  `,
};

// JavaScript queries - similar to TypeScript but without TS-specific syntax
export const JAVASCRIPT_QUERIES = {
  imports: `
    (import_statement) @import
  `,
  classes: `
    (class_declaration) @class
  `,
  methods: `
    (method_definition) @method
  `,
  functions: `
    (function_declaration) @function
  `,
  arrowFunctions: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function))) @arrow_function
  `,
  exports: `
    (export_statement) @export
  `,
  defaultExports: `
    (export_statement
      (identifier) @default_export)
  `,
  variableAssignments: `
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: (function_expression))) @var_function
  `,
  objectMethods: `
    (assignment_expression
      left: (member_expression
        property: (property_identifier) @name)
      right: (function_expression)) @obj_method
  `,
  // Note: No interfaces or types for pure JavaScript
};

export const PYTHON_QUERIES = {
  imports: `
    (import_statement) @import
  `,
  from_imports: `
    (import_from_statement) @from_import
  `,
  classes: `
    (class_definition) @class
  `,
  functions: `
    (function_definition) @function
  `,
  methods: `
    (class_definition
      body: (block
        (function_definition) @method))
  `,
  decorators: `
    (decorated_definition
      (decorator) @decorator)
  `,
};

export const JAVA_QUERIES = {
  classes: `
    (class_declaration) @class
  `,
  methods: `
    (method_declaration) @method
  `,
  interfaces: `
    (interface_declaration) @interface
  `,
};
