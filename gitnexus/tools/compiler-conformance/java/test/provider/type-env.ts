import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTypeEnv, type TypeEnvironment } from '../../../../../src/core/ingestion/type-env.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { extractSimpleTypeName } from '../../../../../src/core/ingestion/type-extractors/shared.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { requireVendoredGrammar } from '../../../../../src/core/tree-sitter/vendored-grammars.js';

let Dart: Parser.Language | null = null;
try {
  Dart = requireVendoredGrammar('tree-sitter-dart');
  const testParser = new Parser();
  testParser.setLanguage(Dart);
} catch {
  Dart = null;
}

let Swift: Parser.Language | null = null;
try {
  Swift = requireVendoredGrammar('tree-sitter-swift');
  const testParser = new Parser();
  testParser.setLanguage(Swift);
} catch {
  Swift = null;
}

const parser = new Parser();

const parse = (code: string, lang: Parser.Language) => {
  parser.setLanguage(lang);
  return parser.parse(code);
};

/** Flatten a scoped TypeEnvironment into a simple name→type map (for simple test assertions). */
function flatGet(typeEnv: TypeEnvironment, varName: string): string | undefined {
  for (const [, scopeMap] of typeEnv.allScopes()) {
    const val = scopeMap.get(varName);
    if (val) return val;
  }
  return undefined;
}

describe('buildTypeEnv', () => {
  describe('Java', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(
        `
        class App {
          void run() {
            User user = new User();
            Repository repo = getRepo();
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
      assert.equal(flatGet(typeEnv, 'repo'), 'Repository');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(
        `
        class App {
          void process(User user, Repository repo) {}
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
      assert.equal(flatGet(typeEnv, 'repo'), 'Repository');
    });

    it('extracts type from field declaration', () => {
      const tree = parse(
        `
        class App {
          private User user;
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });
  });

  describe('super/base/parent resolution', () => {
    it('resolves super to parent class name (Java)', () => {
      const code = `
class BaseModel {
  boolean save() { return true; }
}
class User extends BaseModel {
  boolean save() {
    super.save();
    return true;
  }
}`;
      const tree = parse(code, Java);
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'method_invocation') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      assert.notEqual(superCall, undefined);
      assert.equal(typeEnv.lookup('super', superCall), 'BaseModel');
    });
  });

  describe('constructor inference (Tier 1 fallback)', () => {
    describe('Java', () => {
      it('infers type from var with new expression (Java 10+)', () => {
        const tree = parse(
          `
          class App {
            void run() {
              var user = new User();
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        assert.equal(flatGet(typeEnv, 'user'), 'User');
      });

      it('prefers explicit type over constructor inference', () => {
        const tree = parse(
          `
          class App {
            void run() {
              User user = new User();
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        assert.equal(flatGet(typeEnv, 'user'), 'User');
      });

      it('does not infer from var without new expression', () => {
        const tree = parse(
          `
          class App {
            void run() {
              var x = getUser();
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        assert.equal(flatGet(typeEnv, 'x'), undefined);
      });
    });

    describe('Java instanceof pattern variable (Phase 5.2)', () => {
      it('extracts binding from x instanceof User user', () => {
        const tree = parse(
          `
          class App {
            void process(Object obj) {
              if (obj instanceof User user) {
                user.save();
              }
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        assert.equal(flatGet(typeEnv, 'user'), 'User');
      });

      it('extracts boolean type from plain instanceof (no pattern variable)', () => {
        const tree = parse(
          `
          class App {
            void process(Object obj) {
              boolean b = obj instanceof User;
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        // No pattern variable — b gets its declared type 'boolean', not 'User'
        assert.equal(flatGet(typeEnv, 'b'), 'boolean');
      });

      it('extracts correct type when multiple instanceof patterns exist', () => {
        const tree = parse(
          `
          class App {
            void process(Object obj) {
              if (obj instanceof User user) {
                user.save();
              }
              if (obj instanceof Repo repo) {
                repo.save();
              }
            }
          }
        `,
          Java,
        );
        const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
        assert.equal(flatGet(typeEnv, 'user'), 'User');
        assert.equal(flatGet(typeEnv, 'repo'), 'Repo');
      });
    });
  });

  describe('generic parent class resolution', () => {
    it('resolves super through generic parent (Java)', () => {
      const code = `
class BaseModel<T> {
  T save() { return null; }
}
class User extends BaseModel<String> {
  String save() {
    super.save();
    return "ok";
  }
}`;
      const tree = parse(code, Java);
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'method_invocation') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      assert.notEqual(superCall, undefined);
      // Should resolve to "BaseModel", not "BaseModel<String>"
      assert.equal(typeEnv.lookup('super', superCall), 'BaseModel');
    });
  });

  describe('assignment chain — Java variable_declarator', () => {
    it('propagates var alias = u when u has an explicit type', () => {
      const tree = parse(
        `
        class App {
          void process() {
            User u = new User();
            var alias = u;
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'u'), 'User');
      assert.equal(flatGet(typeEnv, 'alias'), 'User');
    });
  });

  // ── extractSimpleTypeName: nullable wrapper unwrapping ────────────────

  describe('extractSimpleTypeName — nullable wrapper unwrapping', () => {
    it('unwraps Java Optional<User> → User', () => {
      const tree = parse(
        `
        class App {
          void process() {
            Optional<User> user = findUser();
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });

    it('does NOT unwrap List<User> — containers stay as List', () => {
      const tree = parse(
        `
        class App {
          void process() {
            List<User> users = getUsers();
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'users'), 'List');
    });

    it('does NOT unwrap Map<String, User> — containers stay as Map', () => {
      const tree = parse(
        `
        class App {
          void process() {
            Map<String, User> lookup = getLookup();
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'lookup'), 'Map');
    });

    it('does NOT unwrap CompletableFuture<User> — async wrappers stay', () => {
      const tree = parse(
        `
        class App {
          void process() {
            CompletableFuture<User> future = fetchUser();
          }
        }
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'future'), 'CompletableFuture');
    });

    it('unwraps TypeScript extractSimpleTypeName directly for generic_type', () => {
      // Parse a Java Optional<User> and grab the type node to test extractSimpleTypeName
      parser.setLanguage(Java);
      const tree = parser.parse(`class A { void f() { Optional<User> x = null; } }`);
      // Navigate to the type node: class > body > method > body > local_variable_declaration > type
      const method = tree.rootNode.firstNamedChild?.lastNamedChild?.firstNamedChild;
      const decl = method?.lastNamedChild?.firstNamedChild;
      const typeNode = decl?.childForFieldName('type');
      if (typeNode) {
        assert.equal(extractSimpleTypeName(typeNode), 'User');
      }
    });
  });

  describe('for-loop element type inference (Tier 1c) — Java', () => {
    it('still resolves explicit type enhanced-for (regression)', () => {
      const tree = parse(
        `
class Foo {
  void process(List<User> users) {
    for (User user : users) {
      user.save();
    }
  }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });

    it('does not infer type when iterable has no annotation', () => {
      const tree = parse(
        `
class Foo {
  void process() {
    var users = getUsers();
    for (var user : users) {
      user.save();
    }
  }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), undefined);
    });
  });

  describe('Java switch pattern variable (Phase 6)', () => {
    it('switch (obj) { case User u -> } binds u to User', () => {
      const tree = parse(
        `
class App {
    void process(Object obj) {
        switch (obj) {
            case User u -> u.save();
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'u'), 'User');
    });

    it('switch (obj) { case User u -> ...; case Admin a -> ... } — both bind', () => {
      const tree = parse(
        `
class App {
    void process(Object obj) {
        switch (obj) {
            case User u -> u.save();
            case Admin a -> a.manage();
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'u'), 'User');
      assert.equal(flatGet(typeEnv, 'a'), 'Admin');
    });

    it('switch (x) { case 42 -> ... } — no pattern variable, no binding', () => {
      const tree = parse(
        `
class App {
    void process(Object x) {
        switch (x) {
            case 42 -> System.out.println("answer");
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      // Only the parameter x:Object should exist, no extra bindings from case 42
      assert.equal(flatGet(typeEnv, 'x'), 'Object');
    });

    it('obj instanceof User user — regression: still works after type_pattern addition', () => {
      const tree = parse(
        `
class App {
    void process(Object obj) {
        if (obj instanceof User user) {
            user.save();
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });
  });

  describe('new container descriptors (Phase 6.1)', () => {
    it('Stream<User> resolves element type via descriptor (Java)', () => {
      const tree = parse(
        `
class App {
    void process(Stream<User> users) {
        for (User user : users.toList()) {
            user.save();
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });
  });

  describe('multi-declarator type association (sizeBefore optimization)', () => {
    it('Java: multi-declarator captures all variable names with shared type', () => {
      const tree = parse(
        `
class App {
    void run() {
        User a = getA(), b = getB();
        a.save();
        b.save();
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'a'), 'User');
      assert.equal(flatGet(typeEnv, 'b'), 'User');
    });

    it('Java: untyped declaration before typed does not get false type association', () => {
      // `x` has no type annotation → must NOT be associated with the User type
      // from the later declaration. This guards the sizeBefore skip logic.
      const tree = parse(
        `
class App {
    void run() {
        var x = getX();
        User user = getUser();
        user.save();
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
      // x should NOT have a type binding (it's untyped via var)
      assert.equal(flatGet(typeEnv, 'x'), undefined);
    });

    it('Java: single declarator with type still works after optimization', () => {
      const tree = parse(
        `
class App {
    void run() {
        User user = getUser();
        user.save();
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'user'), 'User');
    });

    it('Java: for-loop resolves element type from multi-declarator typed iterable', () => {
      // Tests that declarationTypeNodes is correctly populated for multi-declarator
      // variables, enabling for-loop element type resolution (Strategy 1).
      const tree = parse(
        `
class App {
    void run() {
        List<User> users = getUsers(), admins = getAdmins();
        for (User u : users) {
            u.save();
        }
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      assert.equal(flatGet(typeEnv, 'users'), 'List');
      assert.equal(flatGet(typeEnv, 'admins'), 'List');
      assert.equal(flatGet(typeEnv, 'u'), 'User');
    });
  });

  describe('constructorTypeMap (virtual dispatch detection)', () => {
    it('Java: Animal a = new Dog() populates constructorTypeMap with Dog', () => {
      const tree = parse(
        `
class Animal {}
class Dog extends Animal {}
class App {
    void run() {
        Animal a = new Dog();
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      // Find the entry for variable 'a'
      let ctorType: string | undefined;
      for (const [key, value] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0a')) {
          ctorType = value;
          break;
        }
      }
      assert.equal(ctorType, 'Dog');
    });

    it('Java: same-type constructor does NOT populate constructorTypeMap', () => {
      const tree = parse(
        `
class User {}
class App {
    void run() {
        User u = new User();
    }
}
      `,
        Java,
      );
      const typeEnv = buildTypeEnv(tree, SupportedLanguages.Java);
      let found = false;
      for (const [key] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0u')) {
          found = true;
          break;
        }
      }
      assert.equal(found, false);
    });
  });
});
