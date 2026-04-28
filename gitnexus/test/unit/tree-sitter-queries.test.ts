import { describe, it, expect } from 'vitest';
import {
  TYPESCRIPT_QUERIES,
  JAVASCRIPT_QUERIES,
  PYTHON_QUERIES,
  JAVA_QUERIES,
  C_QUERIES,
  GO_QUERIES,
  CPP_QUERIES,
  CSHARP_QUERIES,
  RUST_QUERIES,
  PHP_QUERIES,
  RUBY_QUERIES,
  SWIFT_QUERIES,
  DART_QUERIES,
} from '../../src/core/ingestion/tree-sitter-queries.js';

describe('tree-sitter queries', () => {
  describe('TypeScript queries', () => {
    it('captures class declarations', () => {
      expect(TYPESCRIPT_QUERIES).toContain('class_declaration');
      expect(TYPESCRIPT_QUERIES).toContain('@definition.class');
    });

    it('captures interface declarations', () => {
      expect(TYPESCRIPT_QUERIES).toContain('interface_declaration');
      expect(TYPESCRIPT_QUERIES).toContain('@definition.interface');
    });

    it('captures function declarations', () => {
      expect(TYPESCRIPT_QUERIES).toContain('function_declaration');
      expect(TYPESCRIPT_QUERIES).toContain('@definition.function');
    });

    it('captures method definitions', () => {
      expect(TYPESCRIPT_QUERIES).toContain('method_definition');
      expect(TYPESCRIPT_QUERIES).toContain('@definition.method');
    });

    it('captures arrow functions in variable declarations', () => {
      expect(TYPESCRIPT_QUERIES).toContain('arrow_function');
    });

    it('captures imports', () => {
      expect(TYPESCRIPT_QUERIES).toContain('import_statement');
      expect(TYPESCRIPT_QUERIES).toContain('@import');
    });

    it('captures call expressions', () => {
      expect(TYPESCRIPT_QUERIES).toContain('call_expression');
      expect(TYPESCRIPT_QUERIES).toContain('@call');
    });

    it('captures heritage (extends/implements)', () => {
      expect(TYPESCRIPT_QUERIES).toContain('@heritage.extends');
      expect(TYPESCRIPT_QUERIES).toContain('@heritage.implements');
    });
  });

  describe('JavaScript queries', () => {
    it('captures function and class definitions', () => {
      expect(JAVASCRIPT_QUERIES).toContain('@definition.class');
      expect(JAVASCRIPT_QUERIES).toContain('@definition.function');
      expect(JAVASCRIPT_QUERIES).toContain('@definition.method');
    });

    it('captures heritage (extends)', () => {
      expect(JAVASCRIPT_QUERIES).toContain('@heritage.extends');
    });

    it('does not have interface declarations', () => {
      expect(JAVASCRIPT_QUERIES).not.toContain('interface_declaration');
    });
  });

  describe('Python queries', () => {
    it('captures class and function definitions', () => {
      expect(PYTHON_QUERIES).toContain('class_definition');
      expect(PYTHON_QUERIES).toContain('function_definition');
    });

    it('captures imports including from-imports', () => {
      expect(PYTHON_QUERIES).toContain('import_statement');
      expect(PYTHON_QUERIES).toContain('import_from_statement');
    });

    it('captures heritage (class inheritance)', () => {
      expect(PYTHON_QUERIES).toContain('@heritage.extends');
    });
  });

  describe('Java queries', () => {
    it('captures all major declaration types', () => {
      expect(JAVA_QUERIES).toContain('@definition.class');
      expect(JAVA_QUERIES).toContain('@definition.interface');
      expect(JAVA_QUERIES).toContain('@definition.enum');
      expect(JAVA_QUERIES).toContain('@definition.method');
      expect(JAVA_QUERIES).toContain('@definition.constructor');
      expect(JAVA_QUERIES).toContain('@definition.annotation');
    });

    it('captures extends and implements heritage', () => {
      expect(JAVA_QUERIES).toContain('@heritage.extends');
      expect(JAVA_QUERIES).toContain('@heritage.implements');
    });

    it('captures method references as calls', () => {
      expect(JAVA_QUERIES).toContain('(method_reference) @call');
    });
  });

  describe('C queries', () => {
    it('captures function definitions', () => {
      expect(C_QUERIES).toContain('function_definition');
      expect(C_QUERIES).toContain('@definition.function');
    });

    it('captures struct, union, enum, typedef', () => {
      expect(C_QUERIES).toContain('@definition.struct');
      expect(C_QUERIES).toContain('@definition.union');
      expect(C_QUERIES).toContain('@definition.enum');
      expect(C_QUERIES).toContain('@definition.typedef');
    });

    it('captures macros', () => {
      expect(C_QUERIES).toContain('@definition.macro');
    });

    it('captures includes as imports', () => {
      expect(C_QUERIES).toContain('preproc_include');
    });
  });

  describe('Go queries', () => {
    it('captures function and method declarations', () => {
      expect(GO_QUERIES).toContain('function_declaration');
      expect(GO_QUERIES).toContain('method_declaration');
    });

    it('captures struct and interface types', () => {
      expect(GO_QUERIES).toContain('@definition.struct');
      expect(GO_QUERIES).toContain('@definition.interface');
    });

    it('captures import declarations', () => {
      expect(GO_QUERIES).toContain('import_declaration');
    });
  });

  describe('C++ queries', () => {
    it('captures class, struct, namespace', () => {
      expect(CPP_QUERIES).toContain('@definition.class');
      expect(CPP_QUERIES).toContain('@definition.struct');
      expect(CPP_QUERIES).toContain('@definition.namespace');
    });

    it('captures templates', () => {
      expect(CPP_QUERIES).toContain('@definition.template');
      expect(CPP_QUERIES).toContain('template_declaration');
    });

    it('captures heritage (base class)', () => {
      expect(CPP_QUERIES).toContain('@heritage.extends');
    });
  });

  describe('C# queries', () => {
    it('captures all major types', () => {
      expect(CSHARP_QUERIES).toContain('@definition.class');
      expect(CSHARP_QUERIES).toContain('@definition.interface');
      expect(CSHARP_QUERIES).toContain('@definition.struct');
      expect(CSHARP_QUERIES).toContain('@definition.enum');
      expect(CSHARP_QUERIES).toContain('@definition.record');
      expect(CSHARP_QUERIES).toContain('@definition.delegate');
    });

    it('captures namespace declarations', () => {
      expect(CSHARP_QUERIES).toContain('@definition.namespace');
    });

    it('captures constructor and property', () => {
      expect(CSHARP_QUERIES).toContain('@definition.constructor');
      expect(CSHARP_QUERIES).toContain('@definition.property');
    });
  });

  describe('Rust queries', () => {
    it('captures function items', () => {
      expect(RUST_QUERIES).toContain('function_item');
      expect(RUST_QUERIES).toContain('@definition.function');
    });

    it('captures struct, enum, trait, impl', () => {
      expect(RUST_QUERIES).toContain('@definition.struct');
      expect(RUST_QUERIES).toContain('@definition.enum');
      expect(RUST_QUERIES).toContain('@definition.trait');
      expect(RUST_QUERIES).toContain('@definition.impl');
    });

    it('captures module, const, static, macro', () => {
      expect(RUST_QUERIES).toContain('@definition.module');
      expect(RUST_QUERIES).toContain('@definition.const');
      expect(RUST_QUERIES).toContain('@definition.static');
      expect(RUST_QUERIES).toContain('@definition.macro');
    });

    it('captures trait implementation heritage', () => {
      expect(RUST_QUERIES).toContain('@heritage.trait');
      expect(RUST_QUERIES).toContain('@heritage.class');
    });
  });

  describe('PHP queries', () => {
    it('captures class, interface, trait, enum', () => {
      expect(PHP_QUERIES).toContain('@definition.class');
      expect(PHP_QUERIES).toContain('@definition.interface');
      expect(PHP_QUERIES).toContain('@definition.trait');
      expect(PHP_QUERIES).toContain('@definition.enum');
    });

    it('captures top-level function definitions', () => {
      expect(PHP_QUERIES).toContain('function_definition');
      expect(PHP_QUERIES).toContain('@definition.function');
    });

    it('captures method declarations', () => {
      expect(PHP_QUERIES).toContain('method_declaration');
      expect(PHP_QUERIES).toContain('@definition.method');
    });

    it('captures class properties', () => {
      expect(PHP_QUERIES).toContain('property_declaration');
      expect(PHP_QUERIES).toContain('@definition.property');
    });

    it('captures heritage (extends, implements, use trait)', () => {
      expect(PHP_QUERIES).toContain('@heritage.extends');
      expect(PHP_QUERIES).toContain('@heritage.implements');
      expect(PHP_QUERIES).toContain('@heritage.trait');
    });

    it('captures namespace definitions', () => {
      expect(PHP_QUERIES).toContain('namespace_definition');
      expect(PHP_QUERIES).toContain('@definition.namespace');
    });
  });

  describe('Swift queries', () => {
    it('captures class, struct, enum', () => {
      expect(SWIFT_QUERIES).toContain('@definition.class');
      expect(SWIFT_QUERIES).toContain('@definition.struct');
      expect(SWIFT_QUERIES).toContain('@definition.enum');
    });

    it('captures protocols as interfaces', () => {
      expect(SWIFT_QUERIES).toContain('protocol_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.interface');
    });

    it('captures init declarations as constructors', () => {
      expect(SWIFT_QUERIES).toContain('init_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.constructor');
    });

    it('captures function declarations', () => {
      expect(SWIFT_QUERIES).toContain('function_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.function');
    });

    it('captures protocol method declarations', () => {
      expect(SWIFT_QUERIES).toContain('protocol_function_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.method');
    });

    it('captures properties', () => {
      expect(SWIFT_QUERIES).toContain('property_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.property');
    });

    it('captures heritage (inheritance)', () => {
      expect(SWIFT_QUERIES).toContain('@heritage.extends');
    });

    it('captures type aliases', () => {
      expect(SWIFT_QUERIES).toContain('typealias_declaration');
      expect(SWIFT_QUERIES).toContain('@definition.type');
    });

    it('captures extensions as classes', () => {
      expect(SWIFT_QUERIES).toContain('"extension"');
    });

    it('captures actors as classes', () => {
      expect(SWIFT_QUERIES).toContain('"actor"');
    });
  });

  describe('Dart queries', () => {
    it('captures class, mixin, extension, enum declarations', () => {
      expect(DART_QUERIES).toContain('@definition.class');
      expect(DART_QUERIES).toContain('@definition.trait');
      expect(DART_QUERIES).toContain('@definition.enum');
    });

    it('captures top-level functions and methods', () => {
      expect(DART_QUERIES).toContain('@definition.function');
      expect(DART_QUERIES).toContain('@definition.method');
    });

    it('captures constructors including factory constructors', () => {
      expect(DART_QUERIES).toContain('@definition.constructor');
      expect(DART_QUERIES).toContain('factory_constructor_signature');
    });

    it('captures field declarations and getters/setters', () => {
      expect(DART_QUERIES).toContain('@definition.property');
      expect(DART_QUERIES).toContain('getter_signature');
      expect(DART_QUERIES).toContain('setter_signature');
    });

    it('captures import statements', () => {
      expect(DART_QUERIES).toContain('@import');
      expect(DART_QUERIES).toContain('library_import');
    });

    it('captures heritage (extends, implements, with)', () => {
      expect(DART_QUERIES).toContain('@heritage.extends');
    });

    it('captures direct calls and method chains', () => {
      expect(DART_QUERIES).toContain('expression_statement');
      expect(DART_QUERIES).toContain('unconditional_assignable_selector');
      expect(DART_QUERIES).toContain('@call');
    });

    it('captures await expressions as calls', () => {
      expect(DART_QUERIES).toContain('await_expression');
    });

    it('captures named argument calls (widget children)', () => {
      expect(DART_QUERIES).toContain('named_argument');
    });

    it('captures list literal calls (widget children lists)', () => {
      expect(DART_QUERIES).toContain('list_literal');
    });

    it('captures cascade calls (obj..method())', () => {
      expect(DART_QUERIES).toContain('cascade_section');
    });

    it('captures arrow function body calls (=> expr)', () => {
      expect(DART_QUERIES).toContain('function_body "=>"');
    });

    it('captures lambda body calls (() => expr)', () => {
      expect(DART_QUERIES).toContain('function_expression_body');
    });
  });

  // ---------------------------------------------------------------------------
  // Variable/constant declaration capture tests
  // ---------------------------------------------------------------------------

  describe('Variable/constant declaration captures', () => {
    it('TypeScript captures const/let as @definition.const', () => {
      expect(TYPESCRIPT_QUERIES).toContain('@definition.const');
      expect(TYPESCRIPT_QUERIES).toContain('lexical_declaration');
    });

    it('TypeScript captures var as @definition.variable', () => {
      expect(TYPESCRIPT_QUERIES).toContain('@definition.variable');
      expect(TYPESCRIPT_QUERIES).toContain('variable_declaration');
    });

    it('JavaScript captures const/let as @definition.const', () => {
      expect(JAVASCRIPT_QUERIES).toContain('@definition.const');
    });

    it('JavaScript captures var as @definition.variable', () => {
      expect(JAVASCRIPT_QUERIES).toContain('@definition.variable');
    });

    it('Python captures plain assignments as @definition.variable', () => {
      expect(PYTHON_QUERIES).toContain('@definition.variable');
    });

    it('Go captures const_declaration and var_declaration', () => {
      expect(GO_QUERIES).toContain('@definition.const');
      expect(GO_QUERIES).toContain('@definition.variable');
      expect(GO_QUERIES).toContain('short_var_declaration');
    });

    it('Java captures local_variable_declaration', () => {
      expect(JAVA_QUERIES).toContain('local_variable_declaration');
      expect(JAVA_QUERIES).toContain('@definition.variable');
    });

    it('C captures init_declarator as @definition.variable', () => {
      expect(C_QUERIES).toContain('init_declarator');
      expect(C_QUERIES).toContain('@definition.variable');
    });

    it('C++ captures init_declarator as @definition.variable', () => {
      expect(CPP_QUERIES).toContain('init_declarator');
      expect(CPP_QUERIES).toContain('@definition.variable');
    });

    it('C# captures local_declaration_statement', () => {
      expect(CSHARP_QUERIES).toContain('local_declaration_statement');
      expect(CSHARP_QUERIES).toContain('@definition.variable');
    });

    it('Rust retains const_item and static_item captures', () => {
      expect(RUST_QUERIES).toContain('@definition.const');
      expect(RUST_QUERIES).toContain('@definition.static');
    });

    it('PHP captures const_declaration', () => {
      expect(PHP_QUERIES).toContain('const_declaration');
      expect(PHP_QUERIES).toContain('@definition.const');
    });

    it('Ruby captures constant assignments', () => {
      expect(RUBY_QUERIES).toContain('@definition.const');
    });

    it('Dart captures declaration as @definition.variable', () => {
      expect(DART_QUERIES).toContain('(declaration');
      expect(DART_QUERIES).toContain('@definition.variable');
    });
  });
});
