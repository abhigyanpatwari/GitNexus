
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
  // React functional components with type annotations (simplified)
  reactComponents: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function
          (type_annotation)))) @react_component
  `,
  // React functional components as const declarations (simplified)
  reactConstComponents: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (as_expression
          (arrow_function)))) @react_const_component
  `,
  // Default export arrow functions (common React pattern)
  defaultExportArrows: `
    (export_statement
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: (arrow_function)))) @default_export_arrow
  `,
  // React hooks (useState, useEffect, etc.)
  hookCalls: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @hook_name
        value: (call_expression
          function: (identifier) @hook_function
          (#match? @hook_function "^use[A-Z].*")))) @hook_call
  `,
  // Hook calls with array destructuring (useState pattern)
  hookDestructuring: `
    (lexical_declaration
      (variable_declarator
        name: (array_pattern) @hook_pattern
        value: (call_expression
          function: (identifier) @hook_function
          (#match? @hook_function "^use[A-Z].*")))) @hook_destructuring
  `,
  variables: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @variable)) @var_declaration
  `,
  constDeclarations: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @const
        value: _)) @const_declaration
  `,
  // Function expressions assigned to variables
  functionExpressions: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (function_expression))) @function_expression
  `,
  exports: `
    (export_statement) @export
  `,
  exportFunctions: `
    (export_statement
      (function_declaration) @export_function)
  `,
  exportClasses: `
    (export_statement
      (class_declaration) @export_class)
  `,
  // Default exports
  defaultExports: `
    (export_statement
      (identifier) @default_export)
  `,
  // Default export functions
  defaultExportFunctions: `
    (export_statement
      (function_declaration) @default_export_function)
  `,
  interfaces: `
    (interface_declaration) @interface
  `,
  types: `
    (type_alias_declaration) @type
  `,
  enums: `
    (enum_declaration) @enum
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
  variables: `
    (variable_declaration
      (variable_declarator
        name: (identifier) @variable)) @var_declaration
  `,
  constDeclarations: `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @const
        value: _)) @const_declaration
  `,
  exports: `
    (export_statement) @export
  `,
  defaultExports: `
    (export_statement
      (identifier) @default_export)
  `,
  exportFunctions: `
    (export_statement
      (function_declaration) @export_function)
  `,
  exportClasses: `
    (export_statement
      (class_declaration) @export_class)
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
  moduleExports: `
    (assignment_expression
      left: (member_expression
        object: (identifier) @module
        property: (property_identifier) @export_name)
      right: _) @module_export
  `,
  functionExpressions: `
    (assignment_expression
      left: (identifier) @name
      right: (function_expression)) @func_expr
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
  methods: `
    (class_definition
      body: (block
        (function_definition) @method))
  `,
  variables: `
    (assignment
      left: (identifier) @variable
      right: _) @var_assignment
  `,
  global_variables: `
    (module
      (assignment
        left: (identifier) @global_var
        right: _)) @global_assignment
  `,
  decorators: `
    (decorated_definition
      (decorator) @decorator)
  `,
  properties: `
    (class_definition
      body: (block
        (decorated_definition
          (decorator
            (identifier) @property_decorator
            (#eq? @property_decorator "property"))
          (function_definition) @property)))
  `,
  staticmethods: `
    (class_definition
      body: (block
        (decorated_definition
          (decorator
            (identifier) @static_decorator
            (#eq? @static_decorator "staticmethod"))
          (function_definition) @static_method)))
  `,
  classmethods: `
    (class_definition
      body: (block
        (decorated_definition
          (decorator
            (identifier) @class_decorator
            (#eq? @class_decorator "classmethod"))
          (function_definition) @class_method)))
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
