
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
  decorators: `
    (decorator) @decorator
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
