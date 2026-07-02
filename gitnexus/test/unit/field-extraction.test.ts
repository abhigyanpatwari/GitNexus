import { describe, it, expect, beforeEach } from 'vitest';
import { TypeScriptFieldExtractor } from '../../src/core/ingestion/field-extractors/typescript.js';
import { createFieldExtractor } from '../../src/core/ingestion/field-extractors/generic.js';
import { typescriptConfig } from '../../src/core/ingestion/field-extractors/configs/typescript-javascript.js';
import { pythonConfig } from '../../src/core/ingestion/field-extractors/configs/python.js';
import { goConfig } from '../../src/core/ingestion/field-extractors/configs/go.js';
import { cppConfig } from '../../src/core/ingestion/field-extractors/configs/c-cpp.js';
import { rubyConfig } from '../../src/core/ingestion/field-extractors/configs/ruby.js';
import { dartConfig } from '../../src/core/ingestion/field-extractors/configs/dart.js';
import { javaConfig, kotlinConfig } from '../../src/core/ingestion/field-extractors/configs/jvm.js';
import { swiftConfig } from '../../src/core/ingestion/field-extractors/configs/swift.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';
import type { TypeEnvironment } from '../../src/core/ingestion/type-env.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Cpp from 'tree-sitter-cpp';
import Ruby from 'tree-sitter-ruby';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';

// Vendored grammars — loaded from vendor/ by absolute path, never node_modules (#2111).
const Dart = requireVendoredGrammar('tree-sitter-dart');

let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not have a prebuild for this platform
}

let Swift: unknown;
try {
  Swift = requireVendoredGrammar('tree-sitter-swift');
} catch {
  // Swift grammar may not have a prebuild for this platform
}
import { csharpConfig as csharpFieldConfig } from '../../src/core/ingestion/field-extractors/configs/csharp.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const parser = new Parser();

const parse = (code: string) => {
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
};

// Mock context for tests. symbolTable comes from createSemanticModel().symbols
// (the facade) rather than createSymbolTable() (the raw leaf) — this mirrors
// production, where FieldExtractorContext always receives the SemanticModel-
// wrapped facade so any .add() write dispatches through the owner-scoped
// registries. No current field extractor calls symbolTable.add(), but
// matching the production shape prevents silent drift if a future extractor
// starts registering dynamically-discovered properties.
const createMockContext = (): FieldExtractorContext => ({
  typeEnv: {
    lookup: () => undefined,
    constructorBindings: [],
    fileScope: () => new Map(),
    allScopes: () => new Map(),
    constructorTypeMap: new Map(),
  } as TypeEnvironment,
  symbolTable: createSemanticModel().symbols,
  filePath: 'test.ts',
  language: SupportedLanguages.TypeScript,
});

describe('TypeScriptFieldExtractor', () => {
  let extractor: TypeScriptFieldExtractor;
  let mockContext: FieldExtractorContext;

  beforeEach(() => {
    extractor = new TypeScriptFieldExtractor();
    mockContext = createMockContext();
  });

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parse('class User {}');
      const classNode = tree.rootNode.child(0);
      expect(classNode).toBeDefined();
      expect(extractor.isTypeDeclaration(classNode!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parse('interface IUser {}');
      const interfaceNode = tree.rootNode.child(0);
      expect(interfaceNode).toBeDefined();
      expect(extractor.isTypeDeclaration(interfaceNode!)).toBe(true);
    });

    it('recognizes abstract_class_declaration', () => {
      const tree = parse('abstract class BaseService {}');
      const abstractNode = tree.rootNode.child(0);
      expect(abstractNode).toBeDefined();
      expect(extractor.isTypeDeclaration(abstractNode!)).toBe(true);
    });

    it('rejects function_declaration', () => {
      const tree = parse('function getUser() {}');
      const functionNode = tree.rootNode.child(0);
      expect(functionNode).toBeDefined();
      expect(extractor.isTypeDeclaration(functionNode!)).toBe(false);
    });

    it('rejects variable declaration', () => {
      const tree = parse('const user = {};');
      const variableNode = tree.rootNode.child(0);
      expect(variableNode).toBeDefined();
      expect(extractor.isTypeDeclaration(variableNode!)).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts single field with type', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('User');
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('name');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].visibility).toBe('public');
    });

    it('extracts private field', () => {
      const tree = parse(`
        class User {
          private password: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('password');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].visibility).toBe('private');
    });

    it('extracts static readonly field', () => {
      const tree = parse(`
        class Config {
          static readonly VERSION: string = '1.0';
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('VERSION');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].isStatic).toBe(true);
      expect(result!.fields[0].isReadonly).toBe(true);
      expect(result!.fields[0].visibility).toBe('public');
    });

    it('extracts optional field (?:)', () => {
      const tree = parse(`
        interface User {
          email?: string;
        }
      `);
      const interfaceNode = tree.rootNode.child(0);
      const result = extractor.extract(interfaceNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('email');
      // Note: optional fields may have type modified to include undefined
      expect(result!.fields[0].type).toContain('string');
    });

    it('extracts multiple fields with different visibilities', () => {
      const tree = parse(`
        class User {
          public id: number;
          private secretKey: string;
          protected createdAt: Date;
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(4);

      const fields = result!.fields;

      const idField = fields.find((f) => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.visibility).toBe('public');
      expect(idField!.type).toBe('number');

      const secretKeyField = fields.find((f) => f.name === 'secretKey');
      expect(secretKeyField).toBeDefined();
      expect(secretKeyField!.visibility).toBe('private');

      const createdAtField = fields.find((f) => f.name === 'createdAt');
      expect(createdAtField).toBeDefined();
      expect(createdAtField!.visibility).toBe('protected');

      const nameField = fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.visibility).toBe('public'); // default
    });

    it('handles field without type annotation', () => {
      const tree = parse(`
        class User {
          name;
          age;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);

      const nameField = result!.fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBeNull();

      const ageField = result!.fields.find((f) => f.name === 'age');
      expect(ageField).toBeDefined();
      expect(ageField!.type).toBeNull();
    });

    it('extracts complex generic types (Map<string, User>, Array<number>)', () => {
      const tree = parse(`
        class Repository {
          users: Map<string, User>;
          ids: Array<number>;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);

      const usersField = result!.fields.find((f) => f.name === 'users');
      expect(usersField).toBeDefined();
      expect(usersField!.type).toBe('Map<string, User>');

      const idsField = result!.fields.find((f) => f.name === 'ids');
      expect(idsField).toBeDefined();
      expect(idsField!.type).toBe('Array<number>');
    });

    it('extracts nested types', () => {
      const tree = parse(`
        class Container {
          data: OuterType<InnerType<string>>;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('data');
      expect(result!.fields[0].type).toBe('OuterType<InnerType<string>>');
    });

    it('extracts fields from interface', () => {
      const tree = parse(`
        interface UserDTO {
          id: number;
          name: string;
          email?: string;
        }
      `);
      const interfaceNode = tree.rootNode.child(0);
      const result = extractor.extract(interfaceNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserDTO');
      expect(result!.fields).toHaveLength(3);

      const idField = result!.fields.find((f) => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.type).toBe('number');

      const nameField = result!.fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');

      const emailField = result!.fields.find((f) => f.name === 'email');
      expect(emailField).toBeDefined();
    });

    it('extracts fields from abstract class', () => {
      const tree = parse(`
        abstract class BaseEntity {
          protected id: number;
          createdAt: Date;
        }
      `);
      const abstractNode = tree.rootNode.child(0);
      const result = extractor.extract(abstractNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('BaseEntity');
      expect(result!.fields).toHaveLength(2);

      const idField = result!.fields.find((f) => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.visibility).toBe('protected');

      const createdAtField = result!.fields.find((f) => f.name === 'createdAt');
      expect(createdAtField).toBeDefined();
      expect(createdAtField!.visibility).toBe('public');
    });

    it('extracts array types', () => {
      const tree = parse(`
        class UserService {
          users: User[];
          ids: number[];
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);

      const usersField = result!.fields.find((f) => f.name === 'users');
      expect(usersField).toBeDefined();
      expect(usersField!.type).toBe('User[]');

      const idsField = result!.fields.find((f) => f.name === 'ids');
      expect(idsField).toBeDefined();
      expect(idsField!.type).toBe('number[]');
    });

    it('extracts union types', () => {
      const tree = parse(`
        class Field {
          value: string | number | null;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('value');
      expect(result!.fields[0].type).toBe('string | number | null');
    });

    it('returns null for non-type declaration nodes', () => {
      const tree = parse('function getUser() {}');
      const functionNode = tree.rootNode.child(0);
      const result = extractor.extract(functionNode!, mockContext);
      expect(result).toBeNull();
    });

    it('extracts fields from type alias with object type', () => {
      const tree = parse(`
        type UserDTO = {
          id: number;
          name: string;
        }
      `);
      const typeAliasNode = tree.rootNode.child(0);
      const result = extractor.extract(typeAliasNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserDTO');
      expect(result!.fields).toHaveLength(2);

      const idField = result!.fields.find((f) => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.type).toBe('number');

      const nameField = result!.fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');
    });

    it('includes source file path in field info', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].sourceFile).toBe('test.ts');
    });

    it('includes line number in field info', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].line).toBeGreaterThan(0);
    });

    it('detects nested interface declarations in methods', () => {
      const tree = parse(`
        class Container {
          data: string;
          
          process() {
            interface LocalInterface {
              value: number;
            }
          }
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('Container');
      // Note: Nested types within method bodies are detected
      expect(result!.nestedTypes).toContain('LocalInterface');
      // Should only extract fields from the outer class
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('data');
    });
  });
});

// ---------------------------------------------------------------------------
// Generic factory tests — TypeScript config
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — TypeScript config', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(typescriptConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.TypeScript;

  it('extracts public and private fields from a class', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(`
      class User {
        public name: string;
        private age: number;
      }
    `);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(extractor.isTypeDeclaration(classNode!)).toBe(true);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields).toHaveLength(2);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('public');
    expect(nameField!.type).toBe('string');

    const ageField = result!.fields.find((f) => f.name === 'age');
    expect(ageField).toBeDefined();
    expect(ageField!.visibility).toBe('private');
    expect(ageField!.type).toBe('number');
  });

  it('uses body-discovery fallback when body type does not match config', () => {
    parser.setLanguage(TypeScript.typescript);
    // interface_declaration has an interface_body — which IS in the config bodyNodeTypes
    // but type_alias_declaration has an object_type body which is also in bodyNodeTypes
    const tree = parser.parse(`
      interface Settings {
        theme: string;
        debug: boolean;
      }
    `);
    const ifaceNode = tree.rootNode.child(0);
    expect(ifaceNode).toBeDefined();
    expect(extractor.isTypeDeclaration(ifaceNode!)).toBe(true);

    const result = extractor.extract(ifaceNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('Settings');
    expect(result!.fields).toHaveLength(2);
    expect(result!.fields.map((f) => f.name)).toContain('theme');
    expect(result!.fields.map((f) => f.name)).toContain('debug');
  });

  it('returns null for non-type-declaration nodes', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('function hello() {}');
    const fnNode = tree.rootNode.child(0);
    expect(extractor.isTypeDeclaration(fnNode!)).toBe(false);
    expect(extractor.extract(fnNode!, mockContext)).toBeNull();
  });

  it('extracts static and readonly modifiers', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(`
      class Config {
        static readonly MAX: number;
        private count: number;
      }
    `);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);

    const maxField = result!.fields.find((f) => f.name === 'MAX');
    expect(maxField).toBeDefined();
    expect(maxField!.isStatic).toBe(true);
    expect(maxField!.isReadonly).toBe(true);

    const countField = result!.fields.find((f) => f.name === 'count');
    expect(countField).toBeDefined();
    expect(countField!.isStatic).toBe(false);
    expect(countField!.isReadonly).toBe(false);
  });

  it('does not false-positive visibility on fields named after visibility keywords', () => {
    parser.setLanguage(TypeScript.typescript);
    // A class field literally named 'private' with no accessibility modifier —
    // findVisibility must not confuse the name with a keyword
    const tree = parser.parse(`
      class Flags {
        private: boolean;
      }
    `);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].name).toBe('private');
    // Default visibility is public — the field NAME 'private' must not be treated as a keyword
    expect(result!.fields[0].visibility).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Python config
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Python', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(pythonConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Python;
  mockContext.filePath = 'test.py';

  it('extracts annotated class fields', () => {
    parser.setLanguage(Python);
    const tree = parser.parse(`class User:
    name: str
    email: str
`);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(extractor.isTypeDeclaration(classNode!)).toBe(true);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields).toHaveLength(2);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe('str');
    expect(nameField!.visibility).toBe('public');

    const emailField = result!.fields.find((f) => f.name === 'email');
    expect(emailField).toBeDefined();
    expect(emailField!.type).toBe('str');
  });

  it('detects underscore-based visibility: _protected and __private', () => {
    parser.setLanguage(Python);
    const tree = parser.parse(`class Settings:
    name: str
    _internal: int
    __secret: str
`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(3);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('public');

    const internalField = result!.fields.find((f) => f.name === '_internal');
    expect(internalField).toBeDefined();
    expect(internalField!.visibility).toBe('protected');

    const secretField = result!.fields.find((f) => f.name === '__secret');
    expect(secretField).toBeDefined();
    expect(secretField!.visibility).toBe('private');
  });

  it('does not mark dunder attributes as private', () => {
    parser.setLanguage(Python);
    // __slots__ starts with __ but also ends with __ so the private check
    // (startsWith('__') && !endsWith('__')) is skipped.
    // However it still starts with _ so the config classifies it as protected.
    const tree = parser.parse(`class Meta:
    __slots__: list
`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    // __slots__ ends with __ → not private, but still starts with _ → protected
    expect(result!.fields[0].visibility).toBe('protected');
  });

  it('reports isStatic and isReadonly as false', () => {
    parser.setLanguage(Python);
    const tree = parser.parse(`class A:
    x: int
`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields[0].isStatic).toBe(false);
    expect(result!.fields[0].isReadonly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Go config
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Go', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(goConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Go;
  mockContext.filePath = 'test.go';

  // Helper: Go AST nests name under type_spec, not type_declaration.
  // The generic factory's extract() requires a node with a 'name' field,
  // so we walk to type_spec which holds the name.
  function findTypeSpec(src: string) {
    parser.setLanguage(Go);
    const tree = parser.parse(src);
    const typeDecl = tree.rootNode.child(0)!;
    return { typeDecl, typeSpec: typeDecl.namedChild(0)! };
  }

  it('recognizes type_declaration via isTypeDeclaration', () => {
    const { typeDecl } = findTypeSpec(`type User struct {\n\tName string\n}`);
    expect(typeDecl.type).toBe('type_declaration');
    expect(extractor.isTypeDeclaration(typeDecl)).toBe(true);
  });

  it('rejects non-type-declaration nodes', () => {
    parser.setLanguage(Go);
    const tree = parser.parse(`func main() {}`);
    const fnNode = tree.rootNode.child(0);
    expect(extractor.isTypeDeclaration(fnNode!)).toBe(false);
    expect(extractor.extract(fnNode!, mockContext)).toBeNull();
  });

  it('detects uppercase-based visibility via extractVisibility on field nodes', () => {
    const { typeDecl } = findTypeSpec(
      `type Config struct {\n\tHost string\n\tport int\n\tTimeout int\n}`,
    );
    // Navigate to field_declaration nodes inside the struct
    // type_declaration > type_spec > struct_type > field_declaration_list > field_declaration
    const typeSpec = typeDecl.namedChild(0)!;
    const structType = typeSpec.namedChild(1)!;
    const fieldList = structType.namedChild(0)!;

    expect(fieldList.type).toBe('field_declaration_list');

    const hostNode = fieldList.namedChild(0)!;
    const portNode = fieldList.namedChild(1)!;
    const timeoutNode = fieldList.namedChild(2)!;

    expect(goConfig.extractName(hostNode)).toBe('Host');
    expect(goConfig.extractVisibility(hostNode)).toBe('public');

    expect(goConfig.extractName(portNode)).toBe('port');
    expect(goConfig.extractVisibility(portNode)).toBe('package');

    expect(goConfig.extractName(timeoutNode)).toBe('Timeout');
    expect(goConfig.extractVisibility(timeoutNode)).toBe('public');
  });

  it('extracts field types', () => {
    const { typeDecl } = findTypeSpec(`type Point struct {\n\tX float64\n\tY float64\n}`);
    const typeSpec = typeDecl.namedChild(0)!;
    const structType = typeSpec.namedChild(1)!;
    const fieldList = structType.namedChild(0)!;

    const xNode = fieldList.namedChild(0)!;
    expect(goConfig.extractName(xNode)).toBe('X');
    expect(goConfig.extractType(xNode)).toBe('float64');
  });

  it('extracts every name from Go multi-name struct fields', () => {
    const { typeDecl } = findTypeSpec(`type Point struct {\n\tX, y int\n}`);

    const result = extractor.extract(typeDecl, mockContext);
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);

    const xField = result!.fields.find((field) => field.name === 'X');
    expect(xField).toBeDefined();
    expect(xField!.type).toBe('int');
    expect(xField!.visibility).toBe('public');

    const yField = result!.fields.find((field) => field.name === 'y');
    expect(yField).toBeDefined();
    expect(yField!.type).toBe('int');
    expect(yField!.visibility).toBe('package');
  });

  it('extracts Go multi-name struct fields when called with the runtime struct_type owner', () => {
    const { typeDecl } = findTypeSpec(`type Point struct {\n\tX, y int\n}`);
    const typeSpec = typeDecl.namedChild(0)!;
    const structType = typeSpec.namedChild(1)!;

    expect(structType.type).toBe('struct_type');
    expect(extractor.isTypeDeclaration(structType)).toBe(true);

    const result = extractor.extract(structType, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('Point');
    expect(result!.fields).toHaveLength(2);

    const xField = result!.fields.find((field) => field.name === 'X');
    expect(xField).toBeDefined();
    expect(xField!.type).toBe('int');
    expect(xField!.visibility).toBe('public');

    const yField = result!.fields.find((field) => field.name === 'y');
    expect(yField).toBeDefined();
    expect(yField!.type).toBe('int');
    expect(yField!.visibility).toBe('package');
  });

  it('reports isStatic and isReadonly as false for all fields', () => {
    const { typeDecl } = findTypeSpec(`type S struct {\n\tX int\n}`);
    const typeSpec = typeDecl.namedChild(0)!;
    const structType = typeSpec.namedChild(1)!;
    const fieldList = structType.namedChild(0)!;
    const fieldNode = fieldList.namedChild(0)!;

    expect(goConfig.isStatic(fieldNode)).toBe(false);
    expect(goConfig.isReadonly(fieldNode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C++ config
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — C++', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(cppConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.CPlusPlus;
  mockContext.filePath = 'test.cpp';

  it('extracts fields from a class with access specifiers', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse(`class User {
public:
  int id;
  std::string name;
private:
  std::string password;
};`);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(extractor.isTypeDeclaration(classNode!)).toBe(true);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields).toHaveLength(3);

    const idField = result!.fields.find((f) => f.name === 'id');
    expect(idField).toBeDefined();
    expect(idField!.visibility).toBe('public');
    expect(idField!.type).toBe('int');

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('public');

    const pwField = result!.fields.find((f) => f.name === 'password');
    expect(pwField).toBeDefined();
    expect(pwField!.visibility).toBe('private');
  });

  it('uses backward-sibling walk to find access specifier', () => {
    parser.setLanguage(Cpp);
    // protected section followed by more fields
    const tree = parser.parse(`class Base {
protected:
  int x;
  int y;
public:
  int z;
};`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(3);

    const xField = result!.fields.find((f) => f.name === 'x');
    expect(xField).toBeDefined();
    expect(xField!.visibility).toBe('protected');

    const yField = result!.fields.find((f) => f.name === 'y');
    expect(yField).toBeDefined();
    expect(yField!.visibility).toBe('protected');

    const zField = result!.fields.find((f) => f.name === 'z');
    expect(zField).toBeDefined();
    expect(zField!.visibility).toBe('public');
  });

  it('defaults to private for class without access specifiers', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse(`class Secret {
  int value;
};`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].name).toBe('value');
    expect(result!.fields[0].visibility).toBe('private');
  });

  it('defaults to public for struct without access specifiers', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse(`struct Point {
  double x;
  double y;
};`);
    const structNode = tree.rootNode.child(0);
    expect(extractor.isTypeDeclaration(structNode!)).toBe(true);

    const result = extractor.extract(structNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);
    expect(result!.fields[0].visibility).toBe('public');
    expect(result!.fields[1].visibility).toBe('public');
  });

  it('detects static and const fields', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse(`class Config {
public:
  static int count;
  const int MAX_SIZE;
};`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);

    const countField = result!.fields.find((f) => f.name === 'count');
    expect(countField).toBeDefined();
    expect(countField!.isStatic).toBe(true);

    const maxField = result!.fields.find((f) => f.name === 'MAX_SIZE');
    expect(maxField).toBeDefined();
    expect(maxField!.isReadonly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ruby config
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Ruby', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(rubyConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Ruby;
  mockContext.filePath = 'test.rb';

  it('extracts multiple fields from attr_accessor', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class User
  attr_accessor :name, :email, :age
end`);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(extractor.isTypeDeclaration(classNode!)).toBe(true);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields).toHaveLength(3);

    const names = result!.fields.map((f) => f.name);
    expect(names).toContain('name');
    expect(names).toContain('email');
    expect(names).toContain('age');

    // All attr_accessor fields are public
    for (const field of result!.fields) {
      expect(field.visibility).toBe('public');
      expect(field.type).toBeNull();
    }
  });

  it('extracts fields from attr_reader as readonly', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class Config
  attr_reader :host, :port
end`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);
    expect(result!.fields[0].isReadonly).toBe(true);
    expect(result!.fields[1].isReadonly).toBe(true);
  });

  it('extracts fields from attr_writer as non-readonly', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class Settings
  attr_writer :theme
end`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].name).toBe('theme');
    expect(result!.fields[0].isReadonly).toBe(false);
  });

  it('handles multiple attr_* calls in the same class', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class Person
  attr_accessor :name
  attr_reader :id
  attr_writer :password
end`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(3);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.isReadonly).toBe(false);

    const idField = result!.fields.find((f) => f.name === 'id');
    expect(idField).toBeDefined();
    expect(idField!.isReadonly).toBe(true);

    const pwField = result!.fields.find((f) => f.name === 'password');
    expect(pwField).toBeDefined();
    expect(pwField!.isReadonly).toBe(false);
  });

  it('reports type as null (Ruby is dynamically typed)', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class Item
  attr_accessor :value
end`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].type).toBeNull();
  });

  it('reports isStatic as false', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse(`class Demo
  attr_accessor :data
end`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields[0].isStatic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C# config — primary constructor fields
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — C# primary constructor fields', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(csharpFieldConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.CSharp;
  mockContext.filePath = 'test.cs';

  it('extracts record positional parameters as public readonly fields', () => {
    parser.setLanguage(CSharp);
    const tree = parser.parse('public record Person(string Name, int Age);');
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('Person');
    expect(result!.fields).toHaveLength(2);

    const nameField = result!.fields.find((f) => f.name === 'Name');
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe('string');
    expect(nameField!.visibility).toBe('public');
    expect(nameField!.isReadonly).toBe(true);
    expect(nameField!.isStatic).toBe(false);

    const ageField = result!.fields.find((f) => f.name === 'Age');
    expect(ageField).toBeDefined();
    expect(ageField!.type).toBe('int');
    expect(ageField!.visibility).toBe('public');
    expect(ageField!.isReadonly).toBe(true);
  });

  it('extracts class primary constructor parameters as private fields', () => {
    parser.setLanguage(CSharp);
    const tree = parser.parse(`public class Point(int x, int y) {
      public int X => x;
    }`);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();

    const xField = result!.fields.find((f) => f.name === 'x');
    expect(xField).toBeDefined();
    expect(xField!.type).toBe('int');
    expect(xField!.visibility).toBe('private');
    expect(xField!.isReadonly).toBe(false);
  });

  it('combines body fields with primary constructor fields', () => {
    parser.setLanguage(CSharp);
    const tree = parser.parse(`public class Service(string name) {
      public int Count;
    }`);
    const classNode = tree.rootNode.child(0);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    // Body field + primary constructor field
    expect(result!.fields.length).toBeGreaterThanOrEqual(2);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('private');

    const countField = result!.fields.find((f) => f.name === 'Count');
    expect(countField).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dart config — F26: static const / static final class fields
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Dart', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(dartConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Dart;
  mockContext.filePath = 'test.dart';

  it('extracts a static const field as static + readonly (F26)', () => {
    parser.setLanguage(Dart);
    const tree = parser.parse(`class C {
  static const a = 1;
}`);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(extractor.isTypeDeclaration(classNode!)).toBe(true);

    const result = extractor.extract(classNode!, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('C');
    const a = result!.fields.find((f) => f.name === 'a');
    expect(a).toBeDefined();
    expect(a!.isStatic).toBe(true);
    expect(a!.isReadonly).toBe(true);
    expect(a!.visibility).toBe('public');
  });

  it('extracts multi-name static final fields, all static + readonly (F26)', () => {
    parser.setLanguage(Dart);
    const tree = parser.parse(`class C {
  static final String b = 'x', c = 'y';
}`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    // Exact-count guard (#1919 review CF4): `find()` below passes even on a
    // double-emit, so assert b/c surface exactly twice total — one field each,
    // no duplicate from the static_final_declaration_list multi-name path.
    expect(result!.fields.filter((f) => f.name === 'b' || f.name === 'c')).toHaveLength(2);
    const b = result!.fields.find((f) => f.name === 'b');
    const c = result!.fields.find((f) => f.name === 'c');
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    for (const f of [b!, c!]) {
      expect(f.isStatic).toBe(true);
      expect(f.isReadonly).toBe(true);
      expect(f.type).toBe('String');
    }
  });

  it('still extracts instance fields (regression)', () => {
    parser.setLanguage(Dart);
    const tree = parser.parse(`class C {
  int z = 0;
}`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    const z = result!.fields.find((f) => f.name === 'z');
    expect(z).toBeDefined();
    expect(z!.isStatic).toBe(false);
    expect(z!.isReadonly).toBe(false);
    expect(z!.type).toBe('int');
  });

  it('marks an underscore-prefixed static const as private (F26)', () => {
    parser.setLanguage(Dart);
    const tree = parser.parse(`class C {
  static const _p = 1;
}`);
    const classNode = tree.rootNode.child(0);
    const result = extractor.extract(classNode!, mockContext);

    expect(result).not.toBeNull();
    const p = result!.fields.find((f) => f.name === '_p');
    expect(p).toBeDefined();
    expect(p!.visibility).toBe('private');
    expect(p!.isStatic).toBe(true);
    expect(p!.isReadonly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Java config — rawDeclaredType: verbatim generic type text (PR #2200 U1)
// and annotations: '@Name' strings from the modifiers child (PR #2200 U2)
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Java (rawDeclaredType + annotations)', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(javaConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Java;
  mockContext.filePath = 'Test.java';

  /** Parse `src` and return the first class_declaration node. */
  function classNode(src: string) {
    parser.setLanguage(Java);
    const tree = parser.parse(src);
    const node = tree.rootNode.child(0);
    if (!node) throw new Error('no class node');
    return node;
  }

  it.each([
    {
      field: 'private List<Shape> shapes;',
      name: 'shapes',
      type: 'List',
      rawDeclaredType: 'List<Shape>',
    },
    {
      field: 'private Set<T> items;',
      name: 'items',
      type: 'Set',
      rawDeclaredType: 'Set<T>',
    },
    {
      field: 'private Map<String, Foo> byName;',
      name: 'byName',
      type: 'Map',
      rawDeclaredType: 'Map<String, Foo>',
    },
    {
      // Non-generic field: rawDeclaredType is PRESENT and equals the type text.
      field: 'private String name;',
      name: 'name',
      type: 'String',
      rawDeclaredType: 'String',
    },
    {
      // Qualified generic: raw text preserved verbatim; simple name still last segment.
      field: 'private java.util.List<Shape> shapes;',
      name: 'shapes',
      type: 'List',
      rawDeclaredType: 'java.util.List<Shape>',
    },
  ])(
    'extracts type "$type" and rawDeclaredType "$rawDeclaredType" from `$field`',
    ({ field, name, type, rawDeclaredType }) => {
      const result = extractor.extract(classNode(`class C { ${field} }`), mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0]).toMatchObject({ name, type, rawDeclaredType });
    },
  );

  it.each([
    {
      // marker_annotation node type (no arguments).
      field: '@Autowired private List<Shape> shapes;',
      annotations: ['@Autowired'],
    },
    {
      // `annotation` node type (with arguments), not `marker_annotation` —
      // the name comes from the annotation's `name` field.
      field: '@Autowired(required=false) private List<Shape> shapes;',
      annotations: ['@Autowired'],
    },
    {
      // Multiple annotations on one field — all are collected, in order.
      field: '@Nullable @Autowired @Qualifier("shapeBeans") private List<Shape> shapes;',
      annotations: ['@Nullable', '@Autowired', '@Qualifier'],
    },
  ])('extracts annotations $annotations from `$field`', ({ field, annotations }) => {
    const result = extractor.extract(classNode(`class C { ${field} }`), mockContext);

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0]).toMatchObject({ name: 'shapes', annotations });
  });

  it('omits annotations entirely for a non-annotated field', () => {
    const result = extractor.extract(
      classNode('class C { private List<Shape> shapes; }'),
      mockContext,
    );

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0]).not.toHaveProperty('annotations');
  });

  it('still extracts the field when extractRawType/extractAnnotations throw (per-hook isolation)', () => {
    // A throwing hook must degrade to a field WITHOUT raw/annotations — never
    // escape buildField: an escaped throw reaches the language-group catch
    // upstream (processFileGroup) and silently drops every remaining file in
    // the group (#2286-review guard pattern).
    const throwingExtractor = createFieldExtractor({
      ...javaConfig,
      extractRawType: () => {
        throw new Error('unexpected node shape');
      },
      extractAnnotations: () => {
        throw new Error('unexpected node shape');
      },
    });

    const result = throwingExtractor.extract(
      classNode('class C { @Autowired private List<Shape> shapes; }'),
      mockContext,
    );

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0]).toMatchObject({ name: 'shapes', type: 'List' });
    expect(result!.fields[0]).not.toHaveProperty('rawDeclaredType');
    expect(result!.fields[0]).not.toHaveProperty('annotations');
  });
});

// ---------------------------------------------------------------------------
// Kotlin config — F52: companion-object properties indexed as fields
// ---------------------------------------------------------------------------

const describeKotlin = Kotlin ? describe : describe.skip;

describeKotlin('GenericFieldExtractor — Kotlin (F52 companion)', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(kotlinConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Kotlin;
  mockContext.filePath = 'test.kt';

  /** The first companion_object node in `src`. */
  function companion(src: string): Parser.SyntaxNode {
    parser.setLanguage(Kotlin as Parser.Language);
    const tree = parser.parse(src);
    let found: Parser.SyntaxNode | undefined;
    const walk = (n: Parser.SyntaxNode) => {
      if (n.type === 'companion_object') found ??= n;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    walk(tree.rootNode);
    if (!found) throw new Error('no companion_object found');
    return found;
  }

  it('extracts a `const val` companion property as a static, readonly field', () => {
    const node = companion(`class C {
  companion object {
    const val TAG = "c"
  }
}`);
    expect(extractor.isTypeDeclaration(node)).toBe(true);
    const result = extractor.extract(node, mockContext);
    expect(result).not.toBeNull();
    const tag = result!.fields.find((f) => f.name === 'TAG');
    expect(tag).toBeDefined();
    expect(tag!.isStatic).toBe(true);
    expect(tag!.isReadonly).toBe(true);
  });

  it('extracts a property from a NAMED companion object', () => {
    const node = companion(`class C {
  companion object Factory {
    val x = 1
  }
}`);
    const result = extractor.extract(node, mockContext);
    const x = result!.fields.find((f) => f.name === 'x');
    expect(x).toBeDefined();
    expect(x!.isStatic).toBe(true);
    expect(x!.isReadonly).toBe(true);
  });

  it('indexes only the property, not the function, and emits it exactly once', () => {
    const node = companion(`class C {
  companion object {
    val onlyField = 1
    fun create() {}
  }
}`);
    const result = extractor.extract(node, mockContext);
    const fieldNames = result!.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['onlyField']); // function excluded, no duplication
  });

  // CF4 (#1919 review): guard the new `isInsideKotlinCompanion` walk against
  // false-positives — a plain (non-companion) class property must be isStatic=false.
  it('reports a plain non-companion class property as isStatic=false (CF4)', () => {
    const classNode = firstNodeOfType(
      `class C {
  val x: Int = 1
}`,
      'class_declaration',
    );
    expect(extractor.isTypeDeclaration(classNode)).toBe(true);
    const result = extractor.extract(classNode, mockContext);
    expect(result).not.toBeNull();
    const x = result!.fields.find((f) => f.name === 'x');
    expect(x).toBeDefined();
    expect(x!.isStatic).toBe(false);
  });

  /** Parse `src` and return the first node of the given type (depth-first). */
  function firstNodeOfType(src: string, type: string): Parser.SyntaxNode {
    parser.setLanguage(Kotlin as Parser.Language);
    const tree = parser.parse(src);
    let found: Parser.SyntaxNode | undefined;
    const walk = (n: Parser.SyntaxNode) => {
      if (found) return;
      if (n.type === type) {
        found = n;
        return;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    walk(tree.rootNode);
    if (!found) throw new Error(`no ${type} found`);
    return found;
  }
});

// ---------------------------------------------------------------------------
// Swift config — F75: protocol property requirements extracted as fields
// ---------------------------------------------------------------------------

const describeSwift = Swift ? describe : describe.skip;

describeSwift('GenericFieldExtractor — Swift (F75 protocol property requirements)', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(swiftConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Swift;
  mockContext.filePath = 'test.swift';

  /** Parse `src` and return the first class/protocol declaration node. */
  function declNode(src: string): Parser.SyntaxNode {
    parser.setLanguage(Swift as Parser.Language);
    const tree = parser.parse(src);
    const node = tree.rootNode.child(0);
    if (!node) throw new Error('no declaration node');
    return node;
  }

  it('extracts a `{ get }` protocol property requirement as a field (F75)', () => {
    const node = declNode(`protocol P {
  var title: String { get }
}`);
    expect(extractor.isTypeDeclaration(node)).toBe(true);
    const result = extractor.extract(node, mockContext);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('P');
    const title = result!.fields.find((f) => f.name === 'title');
    expect(title).toBeDefined();
    expect(title!.type).toBe('String');
    expect(title!.isStatic).toBe(false);
  });

  it('extracts a `{ get set }` protocol property requirement (F75)', () => {
    const node = declNode(`protocol P {
  var count: Int { get set }
}`);
    const result = extractor.extract(node, mockContext);
    const count = result!.fields.find((f) => f.name === 'count');
    expect(count).toBeDefined();
    expect(count!.type).toBe('Int');
  });

  it('extracts a static protocol property requirement as static (F75)', () => {
    const node = declNode(`protocol P {
  static var shared: P { get }
}`);
    const result = extractor.extract(node, mockContext);
    const shared = result!.fields.find((f) => f.name === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.type).toBe('P');
    expect(shared!.isStatic).toBe(true);
  });

  it('extracts all requirements from a multi-property protocol (F75)', () => {
    const node = declNode(`protocol P {
  var title: String { get }
  var count: Int { get set }
  static var shared: P { get }
}`);
    const result = extractor.extract(node, mockContext);
    const names = result!.fields.map((f) => f.name).sort();
    expect(names).toEqual(['count', 'shared', 'title']);
  });

  it('still extracts a class stored property exactly once (regression)', () => {
    const node = declNode(`class C {
  var name: String = ""
}`);
    expect(extractor.isTypeDeclaration(node)).toBe(true);
    const result = extractor.extract(node, mockContext);
    const matches = result!.fields.filter((f) => f.name === 'name');
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('String');
  });
});
