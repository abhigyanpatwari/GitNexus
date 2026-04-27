; ----- Namespaces -----
(namespace_definition
  name: (namespace_name) @scope.name.namespace) @scope.def.namespace

; ----- Imports -----
(namespace_use_declaration) @import.statement

; ----- Classes, Interfaces, Traits -----
(class_declaration
  name: (name) @scope.name.class) @scope.def.class

(interface_declaration
  name: (name) @scope.name.class) @scope.def.class

(trait_declaration
  name: (name) @scope.name.class) @scope.def.class

; ----- Methods and Functions -----
(method_declaration
  name: (name) @scope.name.method) @scope.def.method

(function_definition
  name: (name) @scope.name.function) @scope.def.function
