;; Method and Function declarations
(contract_declaration (_
    (function_definition
        function_name: (identifier) @name) @definition.method))

(source_file
    (function_definition
        function_name: (identifier) @name) @definition.function)

;; Contract and Interface declarations
(contract_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface


;; Function calls
(call_expression (identifier) @name ) @reference.call

(call_expression 
    (member_expression 
        property: (property_identifier) @name )) @reference.call


;; Inheritance

(inheritance_specifier
    ancestor: (user_defined_type (identifier) @name . )) @reference.class
    