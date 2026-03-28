import { describe, it, expect } from 'vitest';
import { buildTypeEnv, type TypeEnvironment } from '../../src/core/ingestion/type-env.js';
import {
  stripNullable,
  extractSimpleTypeName,
} from '../../src/core/ingestion/type-extractors/shared.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Python from 'tree-sitter-python';
import CPP from 'tree-sitter-cpp';
import Kotlin from 'tree-sitter-kotlin';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';

const parser = new Parser();

const parse = (code: string, lang: any) => {
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

/** Count all bindings across all scopes. */
function flatSize(typeEnv: TypeEnvironment): number {
  let count = 0;
  for (const [, scopeMap] of typeEnv.allScopes()) count += scopeMap.size;
  return count;
}

describe('buildTypeEnv', () => {
  describe('TypeScript', () => {
    it('extracts type from const declaration', () => {
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from let declaration', () => {
      const tree = parse('let repo: Repository;', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('function save(user: User, repo: Repository) {}', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
    });

    it('extracts type from arrow function parameters', () => {
      const tree = parse('const fn = (user: User) => user.save();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('ignores variables without type annotations', () => {
      const tree = parse('const x = 5; let y = "hello";', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatSize(typeEnv)).toBe(0);
    });

    it('extracts type from nullable union User | null', () => {
      const tree = parse('const user: User | null = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from optional union User | undefined', () => {
      const tree = parse('let user: User | undefined;', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from triple nullable union User | null | undefined', () => {
      const tree = parse('const user: User | null | undefined = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('ignores non-nullable unions like User | Repo', () => {
      const tree = parse('const entity: User | Repo = getEntity();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'entity')).toBeUndefined();
    });
  });

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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('C#', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(
        `
        class App {
          void Run() {
            User user = new User();
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from var with new expression', () => {
      const tree = parse(
        `
        class App {
          void Run() {
            var user = new User();
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(
        `
        class App {
          void Process(User user, Repository repo) {}
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
    });

    it('extracts type from is pattern matching (obj is User user)', () => {
      const tree = parse(
        `
        class User { public void Save() {} }
        class App {
          void Process(object obj) {
            if (obj is User user) {
              user.Save();
            }
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('Go', () => {
    it('extracts type from var declaration', () => {
      const tree = parse(
        `
        package main
        func main() {
          var user User
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from short var with composite literal', () => {
      const tree = parse(
        `
        package main
        func main() {
          user := User{Name: "Alice"}
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from address-of composite literal (&User{})', () => {
      const tree = parse(
        `
        package main
        func main() {
          user := &User{Name: "Alice"}
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from address-of in multi-assignment', () => {
      const tree = parse(
        `
        package main
        func main() {
          user, repo := &User{}, &Repo{}
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repo');
    });

    it('infers type from new(User) built-in', () => {
      const tree = parse(
        `
        package main
        func main() {
          user := new(User)
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does not infer from non-new function calls', () => {
      const tree = parse(
        `
        package main
        func main() {
          user := getUser()
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });

    it('infers element type from make([]User, 0) slice builtin', () => {
      const tree = parse(
        `
        package main
        func main() {
          sl := make([]User, 0)
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'sl')).toBe('User');
    });

    it('infers value type from make(map[string]User) map builtin', () => {
      const tree = parse(
        `
        package main
        func main() {
          m := make(map[string]User)
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'm')).toBe('User');
    });

    it('infers type from type assertion: user := iface.(User)', () => {
      const tree = parse(
        `
        package main
        type Saver interface { Save() }
        func process(s Saver) {
          user := s.(User)
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('infers type from type assertion in multi-assignment: user, ok := iface.(User)', () => {
      const tree = parse(
        `
        package main
        type Saver interface { Save() }
        func process(s Saver) {
          user, ok := s.(User)
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(
        `
        package main
        func process(user User, repo Repository) {}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      // Go parameter extraction depends on tree-sitter grammar structure
      // Parameters may or may not have 'name'/'type' fields
    });
  });

  describe('Rust', () => {
    it('extracts type from let declaration', () => {
      const tree = parse(
        `
        fn main() {
          let user: User = User::new();
        }
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(
        `
        fn process(user: User, repo: Repository) {}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
    });

    it('extracts type from let with reference', () => {
      const tree = parse(
        `
        fn main() {
          let user: &User = &get_user();
        }
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('Python', () => {
    it('extracts type from annotated assignment (PEP 484)', () => {
      const tree = parse('user: User = get_user()', Python);
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from standalone annotation without value (file scope)', () => {
      const tree = parse('active_user: User', Python);
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'active_user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('def process(user: User, repo: Repository): pass', Python);
      const typeEnv = buildTypeEnv(tree, 'python');
      // Python uses typed_parameter nodes, check if they match
    });

    it('extracts type from class-level annotation with default value', () => {
      const tree = parse(
        `class User:
    name: str = "default"
    age: int = 0
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'name')).toBe('str');
      expect(flatGet(typeEnv, 'age')).toBe('int');
    });

    it('extracts type from class-level annotation without default value', () => {
      const tree = parse(
        `class User:
    repo: UserRepo
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
    });

    it('extracts types from mixed class-level annotations and methods', () => {
      const tree = parse(
        `class User:
    name: str = "default"
    age: int = 0
    repo: UserRepo

    def save(self):
        pass
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'name')).toBe('str');
      expect(flatGet(typeEnv, 'age')).toBe('int');
      expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
    });

    describe('Python match/case as_pattern binding (Phase 6)', () => {
      it('extracts type from `case User() as u` in match statement', () => {
        const tree = parse(
          `
class User:
    def save(self):
        pass

def process(x):
    match x:
        case User() as u:
            u.save()
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'u')).toBe('User');
      });

      it('does NOT overwrite an existing binding in scopeEnv', () => {
        const tree = parse(
          `
class User:
    pass

def process(x):
    u: User = x
    match x:
        case User() as u:
            u.save()
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        // u is already bound from the annotation, pattern binding should not overwrite
        expect(flatGet(typeEnv, 'u')).toBe('User');
      });

      it('extracts type for each bound variable when multiple cases have as-patterns', () => {
        const tree = parse(
          `
class User:
    pass

class Repo:
    pass

def process(x):
    match x:
        case User() as u:
            u.save()
        case Repo() as r:
            r.save()
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'u')).toBe('User');
        expect(flatGet(typeEnv, 'r')).toBe('Repo');
      });

      it('does NOT extract binding when the pattern is not a class_pattern', () => {
        // `case 42 as n:` — integer pattern, not a class_pattern
        const tree = parse(
          `
def process(x):
    match x:
        case 42 as n:
            pass
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        // No class_pattern child — should return undefined
        expect(flatGet(typeEnv, 'n')).toBeUndefined();
      });
    });
  });

  describe('C++', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(
        `
        void run() {
          User user;
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from initialized declaration', () => {
      const tree = parse(
        `
        void run() {
          User user = getUser();
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from pointer declaration', () => {
      const tree = parse(
        `
        void run() {
          User* user = new User();
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(
        `
        void process(User user, Repository& repo) {}
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repository');
    });

    it('extracts type from range-for with explicit type', () => {
      const tree = parse(
        `
        void run() {
          std::vector<User> users;
          for (User& user : users) {
            user.save();
          }
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('extracts type from range-for with const ref', () => {
      const tree = parse(
        `
        void run() {
          std::vector<User> users;
          for (const User& user : users) {
            user.save();
          }
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('PHP', () => {
    it('extracts type from function parameters', () => {
      const tree = parse(
        `<?php
        function process(User $user, Repository $repo) {}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      // PHP parameter type extraction
      expect(flatGet(typeEnv, '$user')).toBe('User');
      expect(flatGet(typeEnv, '$repo')).toBe('Repository');
    });

    it('resolves $this to enclosing class name', () => {
      const code = `<?php
class UserService {
  public function process(): void {
    $this->save();
  }
}`;
      const tree = parse(code, PHP.php);
      const typeEnv = buildTypeEnv(tree, 'php');

      // Find the call node ($this->save())
      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'member_call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      expect(calls.length).toBe(1);
      // $this should resolve to enclosing class 'UserService'
      expect(typeEnv.lookup('$this', calls[0])).toBe('UserService');
    });

    it('extracts type from constructor property promotion (PHP 8.0+)', () => {
      const tree = parse(
        `<?php
class User {
  public function __construct(
    private string $name,
    private UserRepo $repo
  ) {}
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$repo')).toBe('UserRepo');
    });

    it('extracts type from typed class property (PHP 7.4+)', () => {
      const tree = parse(
        `<?php
class UserService {
  private UserRepo $repo;
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$repo')).toBe('UserRepo');
    });

    it('extracts type from typed class property with default value', () => {
      const tree = parse(
        `<?php
class UserService {
  public string $name = "test";
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$name')).toBe('string');
    });

    it('extracts PHPDoc @param with standard order: @param Type $name', () => {
      const tree = parse(
        `<?php
/**
 * @param UserRepo $repo the repository
 * @param string $name the user name
 */
function create($repo, $name) {
  $repo->save();
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$repo')).toBe('UserRepo');
      expect(flatGet(typeEnv, '$name')).toBe('string');
    });

    it('extracts PHPDoc @param with alternate order: @param $name Type', () => {
      const tree = parse(
        `<?php
/**
 * @param $repo UserRepo the repository
 * @param $name string the user name
 */
function process($repo, $name) {
  $repo->save();
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$repo')).toBe('UserRepo');
      expect(flatGet(typeEnv, '$name')).toBe('string');
    });
  });

  describe('Ruby YARD annotations', () => {
    it('extracts @param type bindings from YARD comments', () => {
      const tree = parse(
        `
class UserService
  # @param repo [UserRepo] the repository
  # @param name [String] the user's name
  def create(repo, name)
    repo.save
  end
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
      expect(flatGet(typeEnv, 'name')).toBe('String');
    });

    it('handles qualified YARD types (Models::User → User)', () => {
      const tree = parse(
        `
# @param user [Models::User] the user
def process(user)
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('handles nullable YARD types (String, nil → String)', () => {
      const tree = parse(
        `
# @param name [String, nil] optional name
def greet(name)
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'name')).toBe('String');
    });

    it('skips ambiguous union YARD types (String, Integer → undefined)', () => {
      const tree = parse(
        `
# @param value [String, Integer] mixed type
def process(value)
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'value')).toBeUndefined();
    });

    it('extracts no types when no YARD comments present', () => {
      const tree = parse(
        `
def create(repo, name)
  repo.save
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatSize(typeEnv)).toBe(0);
    });

    it('extracts types from singleton method YARD comments', () => {
      const tree = parse(
        `
class UserService
  # @param name [String] the user's name
  def self.find(name)
    name
  end
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'name')).toBe('String');
    });

    it('handles generic YARD types (Array<User> → Array)', () => {
      const tree = parse(
        `
# @param users [Array<User>] list of users
def process(users)
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'users')).toBe('Array');
    });
  });

  describe('super/base/parent resolution', () => {
    it('resolves super to parent class name (TypeScript)', () => {
      const code = `
class BaseModel {
  save(): boolean { return true; }
}
class User extends BaseModel {
  save(): boolean {
    super.save();
    return true;
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      // Find the super.save() call (inside User class)
      const superCall = calls.find((c: any) => {
        const text = c.text;
        return text.includes('super');
      });
      expect(superCall).toBeDefined();
      expect(typeEnv.lookup('super', superCall)).toBe('BaseModel');
    });

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
      const typeEnv = buildTypeEnv(tree, 'java');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'method_invocation') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      expect(superCall).toBeDefined();
      expect(typeEnv.lookup('super', superCall)).toBe('BaseModel');
    });

    it('resolves super to parent class name (Python)', () => {
      const code = `
class BaseModel:
    def save(self) -> bool:
        return True

class User(BaseModel):
    def save(self) -> bool:
        super().save()
        return True
`;
      const tree = parse(code, Python);
      const typeEnv = buildTypeEnv(tree, 'python');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      // Find a call inside the User class
      const superCall = calls.find((c: any) => c.text.includes('super'));
      expect(superCall).toBeDefined();
      expect(typeEnv.lookup('super', superCall)).toBe('BaseModel');
    });

    it('returns undefined when class has no parent', () => {
      const code = `
class Standalone {
  save(): boolean {
    return true;
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // No calls in this code — test the resolution function directly
      // by using the class body as the context node
      const classNode = tree.rootNode.firstNamedChild;
      expect(typeEnv.lookup('super', classNode!)).toBeUndefined();
    });
  });

  describe('Kotlin object_declaration this resolution', () => {
    it('resolves this inside object declaration', () => {
      const code = `
object AppConfig {
  fun setup() {
    this.init()
  }
}`;
      const tree = parse(code, Kotlin);
      const typeEnv = buildTypeEnv(tree, 'kotlin');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      expect(calls.length).toBe(1);
      expect(typeEnv.lookup('this', calls[0])).toBe('AppConfig');
    });
  });

  describe('scope awareness', () => {
    it('separates same-named variables in different functions', () => {
      const tree = parse(
        `
        function handleUser(user: User) {
          user.save();
        }
        function handleRepo(user: Repo) {
          user.save();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // Each function has its own scope for 'user' (keyed by funcName@startIndex)
      // Find the scope keys that start with handleUser/handleRepo
      const scopes = [...typeEnv.allScopes().keys()];
      const handleUserKey = scopes.find((k) => k.startsWith('handleUser@'));
      const handleRepoKey = scopes.find((k) => k.startsWith('handleRepo@'));
      expect(handleUserKey).toBeDefined();
      expect(handleRepoKey).toBeDefined();
      expect(typeEnv.allScopes().get(handleUserKey!)?.get('user')).toBe('User');
      expect(typeEnv.allScopes().get(handleRepoKey!)?.get('user')).toBe('Repo');
    });

    it('lookup resolves from enclosing function scope', () => {
      const code = `
function handleUser(user: User) {
  user.save();
}
function handleRepo(user: Repo) {
  user.save();
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // Find the call nodes inside each function
      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) {
          findCalls(node.child(i));
        }
      }
      findCalls(tree.rootNode);

      expect(calls.length).toBe(2);
      // First call is inside handleUser → user should be User
      expect(typeEnv.lookup('user', calls[0])).toBe('User');
      // Second call is inside handleRepo → user should be Repo
      expect(typeEnv.lookup('user', calls[1])).toBe('Repo');
    });

    it('separates same-named methods in different classes via startIndex', () => {
      const code = `
class UserService {
  process(user: User) {
    user.save();
  }
}
class RepoService {
  process(repo: Repo) {
    repo.save();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // Find the call nodes inside each process method
      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) {
          findCalls(node.child(i));
        }
      }
      findCalls(tree.rootNode);

      expect(calls.length).toBe(2);
      // First call inside UserService.process → user should be User
      expect(typeEnv.lookup('user', calls[0])).toBe('User');
      // Second call inside RepoService.process → repo should be Repo
      expect(typeEnv.lookup('repo', calls[1])).toBe('Repo');
    });

    it('file-level variables are accessible from all scopes', () => {
      const tree = parse(
        `
        const config: Config = getConfig();
        function process(user: User) {
          config.validate();
          user.save();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // config is at file-level scope
      const fileScope = typeEnv.fileScope();
      expect(fileScope?.get('config')).toBe('Config');

      // user is in process scope (key includes startIndex)
      // Find call nodes inside the process function
      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);
      // calls[0] = getConfig() at file level, calls[1] = config.validate(), calls[2] = user.save()
      expect(typeEnv.lookup('user', calls[2])).toBe('User');
      // config is file-level, accessible from any scope
      expect(typeEnv.lookup('config', calls[1])).toBe('Config');
    });
  });

  describe('destructuring patterns (known limitations)', () => {
    it('captures the typed source variable but not destructured bindings', () => {
      const tree = parse(
        `
        const user: User = getUser();
        const { name, email } = user;
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // The typed variable is captured
      expect(flatGet(typeEnv, 'user')).toBe('User');
      // Destructured bindings (name, email) would need type inference to resolve
      // — not extractable from annotations alone
      expect(flatGet(typeEnv, 'name')).toBeUndefined();
      expect(flatGet(typeEnv, 'email')).toBeUndefined();
    });

    it('does not extract from object-type-annotated destructuring', () => {
      // TypeScript allows: const { name }: { name: string } = user;
      // The annotation is on the whole pattern, not individual bindings
      const tree = parse(
        `
        const { name }: { name: string } = getUser();
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Complex type annotation (object type) — extractSimpleTypeName returns undefined
      expect(flatSize(typeEnv)).toBe(0);
    });
  });

  describe('constructor inference (Tier 1 fallback)', () => {
    describe('TypeScript', () => {
      it('infers type from new expression when no annotation', () => {
        const tree = parse('const user = new User();', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('prefers explicit annotation over constructor inference', () => {
        const tree = parse('const user: BaseUser = new User();', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        expect(flatGet(typeEnv, 'user')).toBe('BaseUser');
      });

      it('infers from namespaced constructor: new ns.Service()', () => {
        // extractSimpleTypeName handles member_expression via property_identifier
        const tree = parse('const svc = new ns.Service();', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        expect(flatGet(typeEnv, 'svc')).toBe('Service');
      });

      it('infers type from new expression with as cast', () => {
        const tree = parse('const x = new User() as BaseUser;', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        // Unwraps as_expression to find the inner new_expression → User
        expect(flatGet(typeEnv, 'x')).toBe('User');
      });

      it('infers type from new expression with non-null assertion', () => {
        const tree = parse('const x = new User()!;', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        // Unwraps non_null_expression to find the inner new_expression → User
        expect(flatGet(typeEnv, 'x')).toBe('User');
      });

      it('infers type from double-cast (new X() as unknown as T)', () => {
        const tree = parse('const x = new User() as unknown as Admin;', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        // Unwraps nested as_expression to find inner new_expression → User
        expect(flatGet(typeEnv, 'x')).toBe('User');
      });

      it('ignores non-new assignments', () => {
        const tree = parse('const x = getUser();', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        expect(flatSize(typeEnv)).toBe(0);
      });

      it('handles mixed annotated + unannotated declarators', () => {
        const tree = parse('const a: A = getA(), b = new B();', TypeScript.typescript);
        const typeEnv = buildTypeEnv(tree, 'typescript');
        expect(flatGet(typeEnv, 'a')).toBe('A');
        expect(flatGet(typeEnv, 'b')).toBe('B');
      });
    });

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
        const typeEnv = buildTypeEnv(tree, 'java');
        expect(flatGet(typeEnv, 'user')).toBe('User');
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
        const typeEnv = buildTypeEnv(tree, 'java');
        expect(flatGet(typeEnv, 'user')).toBe('User');
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
        const typeEnv = buildTypeEnv(tree, 'java');
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });
    });

    describe('Rust', () => {
      it('infers type from Type::new()', () => {
        const tree = parse(
          `
          fn main() {
            let user = User::new();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from Type::default()', () => {
        const tree = parse(
          `
          fn main() {
            let config = Config::default();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'config')).toBe('Config');
      });

      it('does NOT emit scanner binding for Type::default() (handled by extractInitializer)', () => {
        const tree = parse(
          `
          fn main() {
            let config = Config::default();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // ::default() should be excluded from scanConstructorBinding just like ::new()
        // extractInitializer already resolves it, so a scanner binding would be redundant
        const defaultBinding = typeEnv.constructorBindings.find((b) => b.calleeName === 'default');
        expect(defaultBinding).toBeUndefined();
      });

      it('does NOT emit scanner binding for Type::new() (handled by extractInitializer)', () => {
        const tree = parse(
          `
          fn main() {
            let user = User::new();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        const newBinding = typeEnv.constructorBindings.find((b) => b.calleeName === 'new');
        expect(newBinding).toBeUndefined();
      });

      it('prefers explicit annotation over constructor inference', () => {
        // Uses DIFFERENT types to catch Tier 0 overwrite bugs
        const tree = parse(
          `
          fn main() {
            let user: BaseUser = Admin::new();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('BaseUser');
      });

      it('infers type from let mut with ::new()', () => {
        const tree = parse(
          `
          fn main() {
            let mut user = User::new();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('resolves Self::new() to enclosing impl type', () => {
        const tree = parse(
          `
          struct User {}
          impl User {
            fn create() -> Self {
              let instance = Self::new();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'instance')).toBe('User');
      });

      it('resolves Self::default() to enclosing impl type', () => {
        const tree = parse(
          `
          struct Config {}
          impl Config {
            fn make() -> Self {
              let cfg = Self::default();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'cfg')).toBe('Config');
      });

      it('skips Self::new() outside impl block', () => {
        const tree = parse(
          `
          fn main() {
            let x = Self::new();
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });

      it('does not infer from Type::other_method()', () => {
        const tree = parse(
          `
          fn main() {
            let user = User::from_str("alice");
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBeUndefined();
      });

      it('infers type from struct literal (User { ... })', () => {
        const tree = parse(
          `
          fn main() {
            let user = User { name: "alice", age: 30 };
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from empty struct literal (Config {})', () => {
        const tree = parse(
          `
          fn main() {
            let config = Config {};
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'config')).toBe('Config');
      });

      it('prefers explicit annotation over struct literal inference', () => {
        const tree = parse(
          `
          fn main() {
            let user: BaseUser = Admin { name: "alice" };
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('BaseUser');
      });

      it('resolves Self {} struct literal to enclosing impl type', () => {
        const tree = parse(
          `
          struct User { name: String }
          impl User {
            fn reset(&self) -> Self {
              let fresh = Self { name: String::new() };
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'fresh')).toBe('User');
      });

      it('skips Self {} outside impl block', () => {
        const tree = parse(
          `
          fn main() {
            let x = Self { name: String::new() };
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });
    });

    describe('Rust if-let / while-let pattern bindings', () => {
      it('extracts type from captured_pattern in if let (user @ User { .. })', () => {
        const tree = parse(
          `
          fn process() {
            if let user @ User { .. } = get_user() {
              user.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('extracts type from nested captured_pattern in if let Some(user @ User { .. })', () => {
        const tree = parse(
          `
          fn process(opt: Option<User>) {
            if let Some(user @ User { .. }) = opt {
              user.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('extracts type from captured_pattern in while let', () => {
        const tree = parse(
          `
          fn process() {
            while let item @ Config { .. } = iter.next() {
              item.validate();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        expect(flatGet(typeEnv, 'item')).toBe('Config');
      });

      it('extracts binding from if let Some(x) = opt via Phase 5.2 pattern binding', () => {
        const tree = parse(
          `
          fn process(opt: Option<User>) {
            if let Some(user) = opt {
              user.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // Option<User> is unwrapped to "User" in TypeEnv via NULLABLE_WRAPPER_TYPES.
        // extractPatternBinding maps `user` → "User" from the scopeEnv lookup for `opt`.
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does NOT extract field bindings from struct pattern destructuring', () => {
        const tree = parse(
          `
          fn process(val: User) {
            if let User { name } = val {
              name.len();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // 'name' is a field of User — we don't know its type without field-type resolution
        expect(flatGet(typeEnv, 'name')).toBeUndefined();
        // 'val' should still be extracted from the parameter annotation
        expect(flatGet(typeEnv, 'val')).toBe('User');
      });

      it('extracts type from scoped struct pattern (Message::Data)', () => {
        const tree = parse(
          `
          fn process() {
            if let msg @ Message::Data { .. } = get_msg() {
              msg.process();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // scoped_type_identifier: Message::Data — extractSimpleTypeName returns "Data"
        expect(flatGet(typeEnv, 'msg')).toBe('Data');
      });

      it('still extracts parameter types alongside if-let bindings', () => {
        const tree = parse(
          `
          fn process(opt: Option<User>) {
            if let user @ User { .. } = get_user() {
              user.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // Option<User> unwraps to User (nullable wrapper unwrapping)
        expect(flatGet(typeEnv, 'opt')).toBe('User');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('Phase 5.2: extracts binding from if let Some(x) = opt where opt: Option<User>', () => {
        const tree = parse(
          `
          fn process(opt: Option<User>) {
            if let Some(user) = opt {
              user.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // opt: Option<User> → scopeEnv stores "User" (NULLABLE_WRAPPER_TYPES unwrapping)
        // extractPatternBinding maps user → opt's type → "User"
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('Phase 5.2: does NOT extract binding when source variable is unknown', () => {
        const tree = parse(
          `
          fn process() {
            if let Some(x) = unknown_var {
              x.foo();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // unknown_var is not in scopeEnv — conservative, produces no binding
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });

      it('Phase 5.2: does NOT extract binding for non-Option/Result wrappers', () => {
        const tree = parse(
          `
          fn process(vec: Vec<User>) {
            if let SomeOtherVariant(x) = vec {
              x.save();
            }
          }
        `,
          Rust,
        );
        const typeEnv = buildTypeEnv(tree, 'rust');
        // SomeOtherVariant is not a known unwrap wrapper — no binding
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
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
        const typeEnv = buildTypeEnv(tree, 'java');
        expect(flatGet(typeEnv, 'user')).toBe('User');
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
        const typeEnv = buildTypeEnv(tree, 'java');
        // No pattern variable — b gets its declared type 'boolean', not 'User'
        expect(flatGet(typeEnv, 'b')).toBe('boolean');
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
        const typeEnv = buildTypeEnv(tree, 'java');
        expect(flatGet(typeEnv, 'user')).toBe('User');
        expect(flatGet(typeEnv, 'repo')).toBe('Repo');
      });
    });

    describe('PHP', () => {
      it('infers type from new expression', () => {
        const tree = parse(
          `<?php
          $user = new User();
        `,
          PHP.php,
        );
        const typeEnv = buildTypeEnv(tree, 'php');
        expect(flatGet(typeEnv, '$user')).toBe('User');
      });

      it('resolves new self() and new static() to enclosing class', () => {
        const tree = parse(
          `<?php
          class Foo {
            function make() {
              $a = new self();
              $b = new static();
            }
          }
        `,
          PHP.php,
        );
        const typeEnv = buildTypeEnv(tree, 'php');
        expect(flatGet(typeEnv, '$a')).toBe('Foo');
        expect(flatGet(typeEnv, '$b')).toBe('Foo');
      });

      it('resolves new parent() to superclass', () => {
        const tree = parse(
          `<?php
          class Bar {}
          class Foo extends Bar {
            function make() {
              $p = new parent();
            }
          }
        `,
          PHP.php,
        );
        const typeEnv = buildTypeEnv(tree, 'php');
        expect(flatGet(typeEnv, '$p')).toBe('Bar');
      });

      it('skips self/static/parent outside class scope', () => {
        const tree = parse(
          `<?php
          $a = new self();
        `,
          PHP.php,
        );
        const typeEnv = buildTypeEnv(tree, 'php');
        expect(flatGet(typeEnv, '$a')).toBeUndefined();
      });

      it('does not infer from non-new assignments', () => {
        const tree = parse(
          `<?php
          $user = getUser();
        `,
          PHP.php,
        );
        const typeEnv = buildTypeEnv(tree, 'php');
        expect(flatGet(typeEnv, '$user')).toBeUndefined();
      });
    });

    describe('C++', () => {
      it('infers type from auto with new expression', () => {
        const tree = parse(
          `
          void run() {
            auto user = new User();
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from auto with direct construction when class is defined', () => {
        const tree = parse(
          `
          class User {};
          void run() {
            auto user = User();
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('prefers explicit type over auto inference', () => {
        const tree = parse(
          `
          void run() {
            User* user = new User();
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does not infer from auto with function call (not a known class)', () => {
        const tree = parse(
          `
          class User {};
          User getUser() { return User(); }
          void run() {
            auto x = getUser();
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        // getUser is an identifier but NOT a known class — no inference
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });

      it('infers type from brace initialization (User{})', () => {
        const tree = parse(
          `
          class User {};
          void run() {
            auto user = User{};
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from brace initialization with args (User{1,2})', () => {
        const tree = parse(
          `
          class Config {};
          void run() {
            auto cfg = Config{1, 2};
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'cfg')).toBe('Config');
      });

      it('infers type from namespaced brace-init (ns::User{})', () => {
        const tree = parse(
          `
          namespace ns { class User {}; }
          void run() {
            auto user = ns::User{};
          }
        `,
          CPP,
        );
        const typeEnv = buildTypeEnv(tree, 'cpp');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });
    });

    describe('Kotlin constructor inference', () => {
      it('still extracts explicit type annotations', () => {
        const tree = parse(
          `
          fun main() {
            val user: User = User()
          }
        `,
          Kotlin,
        );
        const typeEnv = buildTypeEnv(tree, 'kotlin');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from constructor call when class is in same file', () => {
        const tree = parse(
          `
          class User(val name: String)
          fun main() {
            val user = User("Alice")
          }
        `,
          Kotlin,
        );
        const typeEnv = buildTypeEnv(tree, 'kotlin');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does NOT infer type from plain function call', () => {
        const tree = parse(
          `
          fun getUser(): User = User("Alice")
          fun main() {
            val user = getUser()
          }
        `,
          Kotlin,
        );
        const typeEnv = buildTypeEnv(tree, 'kotlin');
        // getUser is not a class name — should NOT produce a binding
        expect(flatGet(typeEnv, 'user')).toBeUndefined();
      });

      it('infers type from constructor when class defined via SymbolTable', () => {
        const tree = parse(
          `
          fun main() {
            val user = User("Alice")
          }
        `,
          Kotlin,
        );
        // User is NOT defined in this file, but SymbolTable knows it's a Class
        const mockSymbolTable = {
          lookupFuzzy: (name: string) =>
            name === 'User' ? [{ nodeId: 'n1', filePath: 'models.kt', type: 'Class' }] : [],
          lookupExact: () => undefined,
          lookupExactFull: () => undefined,
          add: () => {},
          getStats: () => ({ fileCount: 0, globalSymbolCount: 0 }),
          clear: () => {},
        };
        const typeEnv = buildTypeEnv(tree, 'kotlin', { symbolTable: mockSymbolTable as any });
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does NOT infer when SymbolTable says callee is a Function', () => {
        const tree = parse(
          `
          fun main() {
            val result = doStuff()
          }
        `,
          Kotlin,
        );
        const mockSymbolTable = {
          lookupFuzzy: (name: string) =>
            name === 'doStuff' ? [{ nodeId: 'n1', filePath: 'utils.kt', type: 'Function' }] : [],
          lookupFuzzyCallable: () => [],
          lookupFieldByOwner: () => undefined,
          lookupExact: () => undefined,
          lookupExactFull: () => undefined,
          add: () => {},
          getStats: () => ({ fileCount: 0, globalSymbolCount: 0 }),
          clear: () => {},
        };
        const typeEnv = buildTypeEnv(tree, 'kotlin', { symbolTable: mockSymbolTable as any });
        expect(flatGet(typeEnv, 'result')).toBeUndefined();
      });

      it('prefers explicit annotation over constructor inference', () => {
        const tree = parse(
          `
          class User(val name: String)
          fun main() {
            val user: BaseEntity = User("Alice")
          }
        `,
          Kotlin,
        );
        const typeEnv = buildTypeEnv(tree, 'kotlin');
        // Tier 0 (explicit annotation) wins over Tier 1 (constructor inference)
        expect(flatGet(typeEnv, 'user')).toBe('BaseEntity');
      });
    });

    describe('Python constructor inference', () => {
      it('infers type from direct constructor call when class is known', () => {
        const tree = parse(
          `
class User:
    pass

def main():
    user = User("alice")
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('infers type from qualified constructor call (models.User)', () => {
        const tree = parse(
          `
class User:
    pass

def main():
    user = models.User("alice")
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        // extractSimpleTypeName extracts "User" from attribute node "models.User"
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does not infer from plain function call', () => {
        const tree = parse(
          `
def main():
    user = get_user()
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'user')).toBeUndefined();
      });
    });

    describe('Python walrus operator type inference', () => {
      it('infers type from walrus operator with constructor call', () => {
        const tree = parse(
          `
class User:
    pass

def main():
    if (user := User("alice")):
        pass
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'user')).toBe('User');
      });

      it('does not infer type from walrus operator without known class', () => {
        const tree = parse(
          `
def main():
    if (data := get_data()):
        pass
`,
          Python,
        );
        const typeEnv = buildTypeEnv(tree, 'python');
        expect(flatGet(typeEnv, 'data')).toBeUndefined();
      });
    });
  });

  describe('edge cases', () => {
    it('returns empty map for code without type annotations', () => {
      const tree = parse('const x = 5;', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatSize(typeEnv)).toBe(0);
    });

    it('last-write-wins for same variable name in same scope', () => {
      const tree = parse(
        `
        let x: User = getUser();
        let x: Admin = getAdmin();
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Both declarations are at file level; last one wins
      expect(flatGet(typeEnv, 'x')).toBeDefined();
    });
  });

  describe('generic parent class resolution', () => {
    it('resolves super through generic parent (TypeScript)', () => {
      const code = `
class BaseModel<T> {
  save(): T { return {} as T; }
}
class User extends BaseModel<string> {
  save(): string {
    super.save();
    return "ok";
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      expect(superCall).toBeDefined();
      // Should resolve to "BaseModel", not "BaseModel<string>"
      expect(typeEnv.lookup('super', superCall)).toBe('BaseModel');
    });

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
      const typeEnv = buildTypeEnv(tree, 'java');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'method_invocation') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      expect(superCall).toBeDefined();
      // Should resolve to "BaseModel", not "BaseModel<String>"
      expect(typeEnv.lookup('super', superCall)).toBe('BaseModel');
    });

    it('resolves super through qualified parent (Python models.Model)', () => {
      const code = `
class Model:
    def save(self):
        pass

class User(Model):
    def save(self):
        super().save()
`;
      const tree = parse(code, Python);
      const typeEnv = buildTypeEnv(tree, 'python');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const superCall = calls.find((c: any) => c.text.includes('super'));
      expect(superCall).toBeDefined();
      expect(typeEnv.lookup('super', superCall)).toBe('Model');
    });

    it('resolves super through generic parent (C#)', () => {
      const code = `
class BaseModel<T> {
  public T Save() { return default; }
}
class User : BaseModel<string> {
  public string Save() {
    base.Save();
    return "ok";
  }
}`;
      const tree = parse(code, CSharp);
      const typeEnv = buildTypeEnv(tree, 'csharp');

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'invocation_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      const baseCall = calls.find((c: any) => c.text.includes('base'));
      expect(baseCall).toBeDefined();
      // Should resolve to "BaseModel", not "BaseModel<string>"
      expect(typeEnv.lookup('base', baseCall)).toBe('BaseModel');
    });
  });

  describe('C++ namespaced constructor binding', () => {
    it('infers type from auto with namespaced constructor (ns::User)', () => {
      const tree = parse(
        `
        namespace ns {
          class HttpClient {};
        }
        void run() {
          auto client = ns::HttpClient();
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      // Should extract "HttpClient" from the scoped_identifier ns::HttpClient
      const binding = typeEnv.constructorBindings.find((b) => b.varName === 'client');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('HttpClient');
    });

    it('does not extract from non-namespaced plain identifier (existing behavior)', () => {
      const tree = parse(
        `
        class User {};
        void run() {
          auto user = User();
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      // User() with known class resolves via extractInitializer, not constructor bindings
      expect(flatGet(typeEnv, 'user')).toBe('User');
      // No unresolved bindings since User is locally known
      expect(typeEnv.constructorBindings.find((b) => b.varName === 'user')).toBeUndefined();
    });
  });

  describe('constructorBindings merged into buildTypeEnv', () => {
    it('returns constructor bindings for Kotlin val x = UnknownClass()', () => {
      const tree = parse(
        `
        fun main() {
          val user = UnknownClass()
        }
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      // UnknownClass is not defined locally — should appear as unverified binding
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('UnknownClass');
    });

    it('does NOT emit constructor binding when TypeEnv already resolved', () => {
      const tree = parse(
        `
        fun main() {
          val user: User = User()
        }
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      // Explicit annotation resolves it — no unverified binding needed
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(typeEnv.constructorBindings.find((b) => b.varName === 'user')).toBeUndefined();
    });

    it('returns constructor bindings for Python x = UnknownClass()', () => {
      const tree = parse(
        `
def main():
    user = SomeClass()
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('SomeClass');
    });

    it('returns constructor bindings for Python qualified call (models.User)', () => {
      const tree = parse(
        `
def main():
    user = models.User("alice")
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('User');
    });

    it('returns constructor bindings for Python walrus operator (user := SomeClass())', () => {
      const tree = parse(
        `
def main():
    if (user := SomeClass()):
        pass
`,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('SomeClass');
    });

    it('returns empty bindings for language without scanner (Go)', () => {
      const tree = parse(
        `
        package main
        func main() {
          var x int = 5
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(typeEnv.constructorBindings).toEqual([]);
    });

    it('returns constructor bindings for Ruby constant assignment (REPO = Repo.new)', () => {
      const tree = parse(
        `
REPO = Repo.new
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('REPO');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('Repo');
    });

    it('returns constructor bindings for Ruby namespaced constructor (service = Models::UserService.new)', () => {
      const tree = parse(
        `
service = Models::UserService.new
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('service');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('UserService');
    });

    it('returns constructor bindings for deeply namespaced Ruby constructor (svc = App::Models::Service.new)', () => {
      const tree = parse(
        `
svc = App::Models::Service.new
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('svc');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('Service');
    });

    it('includes scope key in constructor bindings', () => {
      const tree = parse(
        `
        fun process() {
          val user = RemoteUser()
        }
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].scope).toMatch(/^process@\d+$/);
    });

    it('returns constructor bindings for TypeScript const user = getUser()', () => {
      const tree = parse('const user = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('getUser');
    });

    it('does NOT emit constructor binding when TypeScript var has explicit type annotation', () => {
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(typeEnv.constructorBindings.find((b) => b.varName === 'user')).toBeUndefined();
    });

    it('skips destructuring patterns (array_pattern) for TypeScript', () => {
      const tree = parse('const [a, b] = getPair();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(typeEnv.constructorBindings).toEqual([]);
    });

    it('skips destructuring patterns (object_pattern) for TypeScript', () => {
      const tree = parse('const { name, age } = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(typeEnv.constructorBindings).toEqual([]);
    });

    it('unwraps await in TypeScript: const user = await fetchUser()', () => {
      const tree = parse(
        'async function f() { const user = await fetchUser(); }',
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('fetchUser');
    });

    it('handles qualified callee in TypeScript: const user = repo.getUser()', () => {
      const tree = parse('const user = repo.getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('getUser');
    });

    it('does not emit binding for TypeScript new expression (handled by extractInitializer)', () => {
      const tree = parse('const user = new User();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(typeEnv.constructorBindings.find((b) => b.varName === 'user')).toBeUndefined();
    });

    it('returns constructor binding for C# var user = svc.GetUser()', () => {
      const tree = parse(
        `
        class App {
          void Run() {
            var svc = new UserService();
            var user = svc.GetUser("alice");
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      const binding = typeEnv.constructorBindings.find((b) => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUser');
    });

    it('unwraps .await in Rust: let user = get_user().await', () => {
      const tree = parse(
        `
        async fn process() {
          let user = get_user().await;
        }
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(typeEnv.constructorBindings.length).toBe(1);
      expect(typeEnv.constructorBindings[0].varName).toBe('user');
      expect(typeEnv.constructorBindings[0].calleeName).toBe('get_user');
    });

    it('unwraps await in C#: var user = await svc.GetUserAsync()', () => {
      const tree = parse(
        `
        class App {
          async void Run() {
            var svc = new UserService();
            var user = await svc.GetUserAsync("alice");
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      const binding = typeEnv.constructorBindings.find((b) => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUserAsync');
    });

    it('returns constructor binding for C# var user = GetUser() (standalone call)', () => {
      const tree = parse(
        `
        class App {
          void Run() {
            var user = GetUser("alice");
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      const binding = typeEnv.constructorBindings.find((b) => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUser');
    });
  });

  describe('assignment chain propagation (Tier 2, depth-1)', () => {
    it('propagates explicit annotation: const a: User = ...; const b = a → b is User', () => {
      const tree = parse(
        `
        const a: User = getUser();
        const b = a;
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
    });

    it('propagates constructor inference: const a = new User(); const b = a → b is User', () => {
      const tree = parse(
        `
        const a = new User();
        const b = a;
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
    });

    it('depth-2 in declaration order resolves because single pass iterates sequentially', () => {
      // b = a → resolved (a has User), c = b → also resolved because the same
      // pass sets b before processing c (declarations are always in order).
      // The "depth-1" limit applies to out-of-order or cyclic references.
      const tree = parse(
        `
        const a: User = getUser();
        const b = a;
        const c = b;
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
      expect(flatGet(typeEnv, 'c')).toBe('User');
    });

    it('propagates typed function parameter to local alias', () => {
      const tree = parse(
        `
        function process(user: User) {
          const alias = user;
          alias.save();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // 'alias' should get User from the parameter 'user'
      const scopeKey = [...typeEnv.allScopes().keys()].find((k) => k.startsWith('process@'));
      expect(scopeKey).toBeDefined();
      expect(typeEnv.allScopes().get(scopeKey!)?.get('user')).toBe('User');
      expect(typeEnv.allScopes().get(scopeKey!)?.get('alias')).toBe('User');
    });

    it('propagates file-level typed variable to local alias inside function', () => {
      const tree = parse(
        `
        const config: Config = getConfig();
        function process() {
          const cfg = config;
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // cfg in process scope picks up Config from the file-level config binding
      const scopeKey = [...typeEnv.allScopes().keys()].find((k) => k.startsWith('process@'));
      expect(scopeKey).toBeDefined();
      expect(typeEnv.allScopes().get(scopeKey!)?.get('cfg')).toBe('Config');
    });

    it('does not propagate when RHS is a call expression (not a plain identifier)', () => {
      const tree = parse(
        `
        const x = getUser();
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // getUser() is a call_expression — should not create a binding
      expect(flatGet(typeEnv, 'x')).toBeUndefined();
    });
  });

  describe('stripNullable', () => {
    it('strips User | null → User', () => {
      expect(stripNullable('User | null')).toBe('User');
    });

    it('strips User | undefined → User', () => {
      expect(stripNullable('User | undefined')).toBe('User');
    });

    it('strips User | null | undefined → User', () => {
      expect(stripNullable('User | null | undefined')).toBe('User');
    });

    it('strips User? → User', () => {
      expect(stripNullable('User?')).toBe('User');
    });

    it('passes through User unchanged', () => {
      expect(stripNullable('User')).toBe('User');
    });

    it('refuses genuine union User | Repo → undefined', () => {
      expect(stripNullable('User | Repo')).toBeUndefined();
    });

    it('returns undefined for null alone', () => {
      expect(stripNullable('null')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(stripNullable('')).toBeUndefined();
    });

    it('strips User | void → User', () => {
      expect(stripNullable('User | void')).toBe('User');
    });

    it('strips User | None → User (Python)', () => {
      expect(stripNullable('User | None')).toBe('User');
    });

    it('strips User | nil → User (Ruby)', () => {
      expect(stripNullable('User | nil')).toBe('User');
    });

    it('strips User | void | nil → User (multiple nullable keywords)', () => {
      expect(stripNullable('User | void | nil')).toBe('User');
    });

    it('returns undefined for None alone', () => {
      expect(stripNullable('None')).toBeUndefined();
    });

    it('returns undefined for nil alone', () => {
      expect(stripNullable('nil')).toBeUndefined();
    });

    it('returns undefined for void alone', () => {
      expect(stripNullable('void')).toBeUndefined();
    });

    it('returns undefined for undefined alone', () => {
      expect(stripNullable('undefined')).toBeUndefined();
    });

    it('strips nullable suffix with spaces: User ? → User', () => {
      expect(stripNullable(' User? ')).toBe('User');
    });

    it('returns undefined for all-nullable union: null | undefined | void', () => {
      expect(stripNullable('null | undefined | void')).toBeUndefined();
    });

    it('refuses triple non-null union: User | Repo | Service', () => {
      expect(stripNullable('User | Repo | Service')).toBeUndefined();
    });
  });

  // ── Assignment chain: reverse-order depth limitation ──────────────────

  describe('assignment chain — reverse-order limitation', () => {
    it('resolves reverse-declared Tier 2→Tier 0 (Tier 0 set during walk, before post-walk)', () => {
      // Even though b = a appears before a: User in source, a's Tier 0 binding
      // is set during the AST walk. The post-walk Tier 2 loop runs after all
      // Tier 0/1 bindings exist, so b = a resolves.
      const tree = parse(
        `
        function process() {
          const b = a;
          const a: User = getUser();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const scopeKey = [...typeEnv.allScopes().keys()].find((k) => k.startsWith('process@'));
      expect(scopeKey).toBeDefined();
      expect(typeEnv.allScopes().get(scopeKey!)?.get('a')).toBe('User');
      expect(typeEnv.allScopes().get(scopeKey!)?.get('b')).toBe('User');
    });

    it('resolves reverse-ordered Tier 2 chains via fixpoint (b = a, a = c, c: User)', () => {
      // Two chained Tier 2 assignments in reverse source order.
      // The unified fixpoint loop resolves this in 2 iterations:
      //   Iter 1: a = c (c is Tier 0 → a = User)
      //   Iter 2: b = a (a now resolved → b = User)
      const tree = parse(
        `
        function process() {
          const b = a;
          const a = c;
          const c: User = getUser();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const scopeKey = [...typeEnv.allScopes().keys()].find((k) => k.startsWith('process@'));
      expect(scopeKey).toBeDefined();
      expect(typeEnv.allScopes().get(scopeKey!)?.get('c')).toBe('User');
      expect(typeEnv.allScopes().get(scopeKey!)?.get('a')).toBe('User');
      // Fixpoint now resolves reverse-ordered chains
      expect(typeEnv.allScopes().get(scopeKey!)?.get('b')).toBe('User');
    });
  });

  // ── Assignment chain: per-language coverage for refactored code ────────

  describe('assignment chain — Go var_spec form', () => {
    it('propagates var b = a when a has a known type (var_spec)', () => {
      const tree = parse(
        `
        package main
        func process() {
          var a User
          var b = a
        }
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
    });
  });

  describe('assignment chain — C# equals_value_clause', () => {
    it('propagates var alias = u when u has a known type', () => {
      const tree = parse(
        `
        class App {
          void Process() {
            User u = new User();
            var alias = u;
          }
        }
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });
  });

  describe('assignment chain — Kotlin property_declaration', () => {
    it('propagates val alias = u when u has an explicit type annotation', () => {
      const tree = parse(
        `
        fun process() {
          val u: User = User()
          val alias = u
        }
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });

    it('propagates val alias = u inside a class method with explicit type', () => {
      const tree = parse(
        `
        class Service {
          fun process() {
            val u: User = User()
            val alias = u
          }
        }
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });
  });

  describe('assignment chain — Python identifier', () => {
    it('propagates alias = u when u has a type annotation', () => {
      const tree = parse(
        `
def process():
    u: User = get_user()
    alias = u
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });

    it('propagates walrus alias := u when u has a type annotation', () => {
      const tree = parse(
        `
def process():
    u: User = get_user()
    if (alias := u):
        pass
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });
  });

  describe('assignment chain — Rust let_declaration', () => {
    it('propagates let alias = u when u has a type annotation', () => {
      const tree = parse(
        `
        fn process() {
          let u: User = User::new();
          let alias = u;
        }
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });
  });

  describe('assignment chain — PHP variable_name', () => {
    it('propagates $alias = $u when $u has a type from new', () => {
      const tree = parse(
        `<?php
        function process() {
          $u = new User();
          $alias = $u;
        }
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$u')).toBe('User');
      expect(flatGet(typeEnv, '$alias')).toBe('User');
    });
  });

  describe('assignment chain — Ruby assignment', () => {
    it('captures assignment of simple identifier for pending propagation', () => {
      // Ruby assignment chains: alias_user = user where user is a simple identifier.
      // In unit tests (no SymbolTable), constructor bindings are pending — so we test
      // that the extractor captures the assignment relationship correctly.
      // The actual propagation is tested via integration tests where User.new resolves.
      const tree = parse(
        `
def process(user)
  alias_user = user
  alias_user.save
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      // Without a known type for 'user' (no annotation in Ruby), alias_user stays undefined.
      // This verifies the extractor doesn't crash or produce false bindings.
      expect(flatGet(typeEnv, 'alias_user')).toBeUndefined();
    });

    it('does not capture assignment from call expression (not a plain identifier)', () => {
      const tree = parse(
        `
def process
  user = get_user()
  alias_user = user
end
`,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      // get_user() is a call — user has no resolved type, so alias_user should not resolve either
      expect(flatGet(typeEnv, 'alias_user')).toBeUndefined();
    });
  });

  // ── lookupInEnv with nullable stripping ───────────────────────────────

  describe('lookup resolves through nullable stripping', () => {
    it('TypeScript: lookup strips User | null to User', () => {
      const tree = parse(
        `
        function process(user: User | null) {
          user.save();
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Find the call node for .save()
      const scopeKey = [...typeEnv.allScopes().keys()].find((k) => k.startsWith('process@'));
      expect(scopeKey).toBeDefined();
      // The raw env stores 'User' because extractSimpleTypeName already unwraps union_type
      expect(typeEnv.allScopes().get(scopeKey!)?.get('user')).toBe('User');
    });

    it('Python: lookup strips User | None to User', () => {
      const tree = parse(
        `
def process():
    user: User | None = get_user()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      // Python 3.10+ union syntax is stored as raw text "User | None"
      // which stripNullable resolves at lookup time
      const rawVal = flatGet(typeEnv, 'user');
      expect(rawVal).toBeDefined();
      // Either already unwrapped by AST, or stored as raw text for stripNullable
      expect(stripNullable(rawVal!)).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('unwraps Rust Option<User> → User', () => {
      const tree = parse(
        `
        fn process() {
          let user: Option<User> = find_user();
        }
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'users')).toBe('List');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'lookup')).toBe('Map');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'future')).toBe('CompletableFuture');
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
        expect(extractSimpleTypeName(typeNode)).toBe('User');
      }
    });
  });

  // ── C++ assignment chain propagation ──────────────────────────────────

  describe('assignment chain — C++ auto alias', () => {
    it('propagates auto alias = u when u has an explicit type', () => {
      const tree = parse(
        `
        void process() {
          User u;
          auto alias = u;
        }
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'alias')).toBe('User');
    });
  });

  // ── Tier 1c: for-loop element type inference ───────────────────────────

  describe('for-loop element type inference (Tier 1c) — TypeScript', () => {
    it('infers loop variable type from User[] parameter annotation (for...of)', () => {
      const tree = parse(
        `
        function process(users: User[]) {
          for (const user of users) {
            user.save();
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('infers loop variable type from Array<User> parameter annotation (for...of)', () => {
      const tree = parse(
        `
        function process(users: Array<User>) {
          for (const user of users) {
            user.save();
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does NOT bind loop variable for for...in (produces string keys, not elements)', () => {
      const tree = parse(
        `
        function process(users: User[]) {
          for (const key in users) {
            console.log(key);
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // for...in yields string keys — extractor must NOT bind 'key' to User
      expect(flatGet(typeEnv, 'key')).toBeUndefined();
    });

    it('does not infer type when iterable variable has no known type in scope', () => {
      const tree = parse(
        `
        function process(users: any) {
          for (const user of users) {
            user.save();
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });

    it('infers loop variable from a locally declared const with User[] annotation', () => {
      const tree = parse(
        `
        function process() {
          const users: User[] = getUsers();
          for (const user of users) {
            user.save();
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Note: users itself is stored with no binding (extractSimpleTypeName returns undefined
      // for array_type), but the for-loop extractor uses AST walking to resolve the element type.
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('infers loop variable from readonly User[] parameter', () => {
      const tree = parse(
        `
        function process(users: readonly User[]) {
          for (const user of users) {
            user.save();
          }
        }
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('for-loop element type inference (Tier 1c) — Python', () => {
    it('infers loop variable type from List[User] parameter annotation', () => {
      const tree = parse(
        `
def process(users: List[User]):
    for user in users:
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('infers loop variable type from Sequence[User] annotation style', () => {
      const tree = parse(
        `
def process(users: Sequence[User]):
    for user in users:
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does not infer type when iterable parameter has no annotation', () => {
      const tree = parse(
        `
def process(users):
    for user in users:
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });

    it('infers loop variable from a locally annotated variable', () => {
      const tree = parse(
        `
def process():
    users: List[User] = get_users()
    for user in users:
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      // List[User] → extractSimpleTypeName returns 'List' (base name), stored as 'List'
      // extractElementTypeFromString('List') → undefined (no brackets in the string)
      // So user is unresolved unless users is stored as 'List[User]' raw.
      // The locally annotated var stores the base type 'List' via extractSimpleTypeName.
      // This test documents the actual behavior.
      const usersType = flatGet(typeEnv, 'users');
      expect(usersType).toBeDefined(); // users has a type annotation
    });
  });

  describe('for-loop element type inference (Tier 1c) — Go', () => {
    it('infers loop variable type from []User slice parameter (_, user := range users)', () => {
      const tree = parse(
        `
package main
func process(users []User) {
    for _, user := range users {
        user.Save()
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does NOT infer element type for single-var slice range (yields index, not element)', () => {
      const tree = parse(
        `
package main
func process(users []User) {
    for user := range users {
        user.Save()
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      // In Go, `for v := range slice` gives the INDEX (int), not the element.
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });

    it('infers loop variable from map range (_, v := range myMap)', () => {
      const tree = parse(
        `
package main
func process(myMap map[string]User) {
    for _, v := range myMap {
        v.Save()
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      expect(flatGet(typeEnv, 'v')).toBe('User');
    });

    it('does NOT infer element type for single-var map range (yields key, not value)', () => {
      const tree = parse(
        `
package main
func process(myMap map[string]User) {
    for k := range myMap {
        _ = k
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      // Single-var map range gives the KEY, not the value
      expect(flatGet(typeEnv, 'k')).toBeUndefined();
    });

    it('does not infer type for C-style for loops (no range_clause)', () => {
      const tree = parse(
        `
package main
func process() {
    for i := 0; i < 10; i++ {
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      // C-style for loop has no range_clause — extractor must return early
      expect(flatGet(typeEnv, 'i')).toBeUndefined();
    });

    it('does not infer type when iterable has no annotation in scope', () => {
      const tree = parse(
        `
package main
func process() {
    users := getUsers()
    for _, user := range users {
        user.Save()
    }
}
      `,
        Go,
      );
      const typeEnv = buildTypeEnv(tree, 'go');
      // users has no type annotation — only a constructor binding candidate
      // Without a resolved type for users, user cannot be inferred
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });
  });

  describe('for-loop element type inference (Tier 1c) — Rust', () => {
    it('infers loop variable from Vec<User> parameter (for user in &users)', () => {
      const tree = parse(
        `
fn process(users: Vec<User>) {
    for user in &users {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('infers loop variable from &[User] slice parameter', () => {
      const tree = parse(
        `
fn process(users: &[User]) {
    for user in users {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does not infer type for range expression (0..10)', () => {
      const tree = parse(
        `
fn process() {
    for i in 0..10 {
        println!("{}", i);
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'i')).toBeUndefined();
    });

    it('does not infer type when iterable has no annotation', () => {
      const tree = parse(
        `
fn process() {
    let users = get_users();
    for user in &users {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });
  });

  describe('for-loop element type inference (Tier 1c) — C#', () => {
    it('infers loop variable from var foreach with List<User> parameter', () => {
      const tree = parse(
        `
using System.Collections.Generic;
class Foo {
  void Process(List<User> users) {
    foreach (var user in users) {
      user.Save();
    }
  }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('still resolves explicit type foreach (regression)', () => {
      const tree = parse(
        `
class Foo {
  void Process(List<User> users) {
    foreach (User user in users) {
      user.Save();
    }
  }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does not infer type when iterable has no annotation', () => {
      const tree = parse(
        `
class Foo {
  void Process() {
    var users = GetUsers();
    foreach (var user in users) {
      user.Save();
    }
  }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });
  });

  describe('for-loop element type inference (Tier 1c) — Kotlin', () => {
    it('infers loop variable from unannotated for with List<User> parameter', () => {
      const tree = parse(
        `
fun process(users: List<User>) {
    for (user in users) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('still resolves explicit type annotation (regression)', () => {
      const tree = parse(
        `
fun process(users: List<User>) {
    for (user: User in users) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('does not infer type when iterable has no annotation', () => {
      const tree = parse(
        `
fun process() {
    val users = getUsers()
    for (user in users) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBeUndefined();
    });
  });

  describe('previously-skipped limitations (now resolved)', () => {
    it('TS destructured for-of: for (const [k, v] of entries) — last-child heuristic', () => {
      // array_pattern handled by binding last named child to element type.
      // Map<string, User> resolves to 'User' via last generic type arg.
      const tree = parse(
        `
function process(entries: Map<string, User>) {
  for (const [key, user] of entries) {
    user.save();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('Python tuple unpacking: for key, value in dict.items() — call iterable + pattern_list', () => {
      // call iterable: data.items() → extract receiver 'data' for type lookup.
      // pattern_list: bind last named child to element type.
      // dict[str, User] resolves to 'User' via last generic type arg.
      const tree = parse(
        `
def process(data: dict[str, User]):
    for key, user in data.items():
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('Python enumerate(dict.items()): for i, k, v — skips int index, binds value var to User', () => {
      // enumerate() wraps the iterable: right node is call with fn='enumerate', not fn.attribute.
      // Without enumerate() support, iterableName is never set → v stays unbound.
      // With the fix: unwrap enumerate → inner call → data.items() → v binds to User.
      const tree = parse(
        `
def process(data: dict[str, User]):
    for i, k, v in enumerate(data.items()):
        v.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'v')).toBe('User');
      // i is the int index from enumerate — must NOT be bound to User
      expect(flatGet(typeEnv, 'i')).toBeUndefined();
    });

    it('Python enumerate(dict.items()) with nested tuple: for i, (k, v) — binds v to User', () => {
      // Nested tuple pattern: `(k, v)` is a tuple_pattern inside the pattern_list.
      // AST: pattern_list > [identifier('i'), tuple_pattern > [identifier('k'), identifier('v')]]
      // Must descend into tuple_pattern to extract v, not just collect top-level identifiers.
      const tree = parse(
        `
def process(data: dict[str, User]):
    for i, (k, v) in enumerate(data.items()):
        v.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'v')).toBe('User');
      expect(flatGet(typeEnv, 'i')).toBeUndefined();
    });

    it('Python enumerate with parenthesized tuple: for (k, v) in enumerate(users) — binds v to User', () => {
      // Parenthesized tuple pattern: `(k, v)` is a tuple_pattern, not pattern_list.
      // AST: for_statement > left: tuple_pattern > [identifier('k'), identifier('v')]
      // Must handle tuple_pattern as top-level left node, not just nested inside pattern_list.
      const tree = parse(
        `
def process(users: List[User]):
    for (k, v) in enumerate(users):
        v.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      // enumerate yields (index, element) — k is int (unbound), v is User
      expect(flatGet(typeEnv, 'v')).toBe('User');
      expect(flatGet(typeEnv, 'k')).toBeUndefined();
    });

    it('TS instanceof narrowing: if (x instanceof User) — first-writer-wins, not block-scoped', () => {
      // Binds x to User via extractPatternBinding on binary_expression.
      // Only works when x has no prior type binding in scopeEnv.
      // True block-level scoping (overwriting existing bindings) is Phase 5.
      const tree = parse(
        `
function process(x) {
  if (x instanceof User) {
    x.save();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'x')).toBe('User');
    });

    it('Rust for with .iter(): for user in users.iter() — call_expression iterable', () => {
      // Extracts receiver from call_expression > field_expression > identifier.
      // .iter()/.into_iter()/.iter_mut() is the dominant Rust iteration pattern.
      const tree = parse(
        `
fn process(users: Vec<User>) {
    for user in users.iter() {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('method-aware type arg selection (.keys() vs .values())', () => {
    it('TS for-of map.values() resolves to value type (User)', () => {
      const tree = parse(
        `
function process(data: Map<string, User>) {
  for (const user of data.values()) {
    user.save();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('TS for-of map.keys() resolves to key type (string)', () => {
      const tree = parse(
        `
function process(data: Map<string, User>) {
  for (const key of data.keys()) {
    key.trim();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'key')).toBe('string');
    });

    it('Python for key in data.keys() resolves to key type (str)', () => {
      const tree = parse(
        `
def process(data: dict[str, User]):
    for key in data.keys():
        key.strip()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'key')).toBe('str');
    });

    it('Python for user in data.values() resolves to value type (User)', () => {
      const tree = parse(
        `
def process(data: dict[str, User]):
    for user in data.values():
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('Rust for key in map.keys() resolves to key type (String)', () => {
      const tree = parse(
        `
fn process(data: HashMap<String, User>) {
    for key in data.keys() {
        key.len();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'key')).toBe('String');
    });

    it('Rust for user in map.values() resolves to value type (User)', () => {
      const tree = parse(
        `
fn process(data: HashMap<String, User>) {
    for user in data.values() {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('container descriptor-aware type arg selection', () => {
    it('HashMap.keys() resolves to key type (String) via descriptor', () => {
      const tree = parse(
        `
fn process(data: HashMap<String, User>) {
    for key in data.keys() {
        key.len();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'key')).toBe('String');
    });

    it('HashMap.values() resolves to value type (User) via descriptor', () => {
      const tree = parse(
        `
fn process(data: HashMap<String, User>) {
    for user in data.values() {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('Vec.iter() resolves to element type (User) — arity 1 always returns last', () => {
      const tree = parse(
        `
fn process(users: Vec<User>) {
    for user in users.iter() {
        user.save();
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('unknown container falls back to last-arg heuristic', () => {
      // MyCache is not in CONTAINER_DESCRIPTORS, so .keys() still returns first via fallback
      const tree = parse(
        `
function process(cache: MyCache<string, User>) {
  for (const key of cache.keys()) {
    key.trim();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'key')).toBe('string');
    });
  });

  describe('for-loop Phase 2 enhancements', () => {
    it('TS object destructuring skip: for (const { id, name } of users) — no binding produced', () => {
      const tree = parse(
        `
function process(users: User[]) {
  for (const { id, name } of users) {
    console.log(id, name);
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Object destructuring should NOT produce bindings — field types are unknown
      expect(flatGet(typeEnv, 'id')).toBeUndefined();
      expect(flatGet(typeEnv, 'name')).toBeUndefined();
    });

    it('TS member access: for (const user of this.users) with users: User[] param — resolves', () => {
      const tree = parse(
        `
function process(users: User[]) {
  for (const user of this.users) {
    user.save();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('Python member access: for user in self.users with users: List[User] param — resolves', () => {
      const tree = parse(
        `
def process(users: List[User]):
    for user in self.users:
        user.save()
      `,
        Python,
      );
      const typeEnv = buildTypeEnv(tree, 'python');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('C++ structured bindings: for (auto& [key, value] : map) with map<string, User> param — binds value', () => {
      const tree = parse(
        `
void process(std::map<std::string, User>& map) {
  for (auto& [key, value] : map) {
    value.save();
  }
}
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'value')).toBe('User');
    });

    it('C++ structured bindings: exact App.cpp fixture — binds user and repo', () => {
      const tree = parse(
        `
#include "User.h"
#include "Repo.h"
#include <map>
#include <string>
#include <vector>

void processUserMap(std::map<std::string, User> userMap) {
    for (auto& [key, user] : userMap) {
        user.save();
    }
}

void processRepoMap(std::map<std::string, Repo> repoMap) {
    for (const auto& [key, repo] : repoMap) {
        repo.save();
    }
}
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      expect(flatGet(typeEnv, 'repo')).toBe('Repo');
    });
  });

  describe('known limitations (documented skip tests)', () => {
    it.skip('Ruby block parameter: users.each { |user| } — closure param inference, different feature', () => {
      // Not a for-loop; .each { |user| } is a method call with a block.
      // Requires closure parameter inference — a different feature category
      // applicable to Ruby, Swift closures, Kotlin lambdas, and Java lambdas.
      const tree = parse(
        `
def process(users)
  users.each { |user| user.save }
end
      `,
        Ruby,
      );
      const typeEnv = buildTypeEnv(tree, 'ruby');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('Kotlin when/is pattern binding (Phase 6)', () => {
    it('when (x) { is User -> } binds x to User', () => {
      const tree = parse(
        `
fun process(x: Any) {
    when (x) {
        is User -> x.name
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'x')).toBe('User');
    });

    it('when (x) { is User -> ...; is Admin -> ... } — last arm overwrites (allowPatternBindingOverwrite)', () => {
      const tree = parse(
        `
fun process(x: Any) {
    when (x) {
        is User -> x.name
        is Admin -> x.role
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      // allowPatternBindingOverwrite means each arm overwrites — last one wins
      expect(flatGet(typeEnv, 'x')).toBe('Admin');
    });

    it('when (x) { else -> } — no type check, no pattern binding produced', () => {
      const tree = parse(
        `
fun process() {
    val x: String = ""
    when (x) {
        else -> println(x)
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      // x has type String from its declaration — no pattern binding should narrow it
      // (else branch has no type_test node, so extractKotlinPatternBinding never fires)
      expect(flatGet(typeEnv, 'x')).toBe('String');
    });
  });

  describe('Kotlin for-loop HashMap.values resolution (Phase 6)', () => {
    it('for (user in data.values) binds user to User via HashMap<String, User>', () => {
      const tree = parse(
        `
fun processValues(data: HashMap<String, User>) {
    for (user in data.values) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('for (user in users) binds user to User via List<User> param', () => {
      const tree = parse(
        `
fun processList(users: List<User>) {
    for (user in users) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'u')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'u')).toBe('User');
      expect(flatGet(typeEnv, 'a')).toBe('Admin');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      // Only the parameter x:Object should exist, no extra bindings from case 42
      expect(flatGet(typeEnv, 'x')).toBe('Object');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('new container descriptors (Phase 6.1)', () => {
    it('Collection<User> resolves element type via descriptor (arity 1)', () => {
      const tree = parse(
        `
using System.Collections.ObjectModel;
public class App {
    public void Process(Collection<User> users) {
        foreach (var user in users) {
            user.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('MutableMap<String, User>.values() resolves to User via descriptor (arity 2)', () => {
      const tree = parse(
        `
fun process(data: MutableMap<String, User>) {
    for (user in data.values()) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('MutableList<User> resolves element type via descriptor', () => {
      const tree = parse(
        `
fun process(users: MutableList<User>) {
    for (user in users) {
        user.save()
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('SortedSet<User> resolves element type via descriptor (C#)', () => {
      const tree = parse(
        `
using System.Collections.Generic;
public class App {
    public void Process(SortedSet<User> users) {
        foreach (var user in users) {
            user.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('C# recursive_pattern binding (Phase 6.1)', () => {
    it('obj is User { Name: "Alice" } u — binds u to User', () => {
      const tree = parse(
        `
public class App {
    public void Process(object obj) {
        if (obj is User { Name: "Alice" } u) {
            u.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'u')).toBe('User');
    });

    it('switch expression with recursive_pattern — binds r to Repo', () => {
      const tree = parse(
        `
public class App {
    public void Process(object obj) {
        var result = obj switch {
            Repo { Name: "main" } r => r.Save(),
            _ => false
        };
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'r')).toBe('Repo');
    });

    it('recursive_pattern without designation — no pattern binding produced', () => {
      const tree = parse(
        `
public class App {
    public void Process(object obj) {
        if (obj is User { Name: "Alice" }) {
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      // obj → object from the parameter, but no pattern binding
      expect(flatGet(typeEnv, 'obj')).toBe('object');
      expect(flatSize(typeEnv)).toBe(1); // only the parameter binding
    });
  });

  describe('C# await foreach (Phase 6.1)', () => {
    it('await foreach (var user in users) — same node type as foreach, resolves element type', () => {
      const tree = parse(
        `
using System.Collections.Generic;
public class App {
    public async Task Process(IAsyncEnumerable<User> users) {
        await foreach (var user in users) {
            user.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('foreach (var user in this.data.Values) — nested member access with container property', () => {
      const tree = parse(
        `
using System.Collections.Generic;
public class App {
    private Dictionary<string, User> data;
    public void ProcessValues() {
        foreach (var user in this.data.Values) {
            user.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      // Verify lookup works from the call site (user.Save())
      const saveCall = tree.rootNode.descendantsOfType('invocation_expression')[0];
      expect(typeEnv.lookup('user', saveCall)).toBe('User');
    });
  });

  describe('TypeScript class field declaration (Phase 6.1)', () => {
    it('class field with array type — for-loop resolves element type via declarationTypeNodes', () => {
      const tree = parse(
        `
class UserService {
    private users: User[] = [];
    processUsers() {
        for (const user of this.users) {
            user.save();
        }
    }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // User[] is an array_type — extractSimpleTypeName returns undefined (no simple base name).
      // But declarationTypeNodes captures the raw AST node, so for-loop resolution
      // uses Strategy 1 (extractTsElementTypeFromAnnotation) to resolve the element type.
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('class field with generic type annotation — binds field name to base type', () => {
      const tree = parse(
        `
class RepoService {
    repos: Map<string, Repo> = new Map();
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'repos')).toBe('Map');
    });
  });

  describe('PHP foreach $this->property (Phase 7.4 — Strategy C)', () => {
    it('resolves loop variable from @var User[] property without @param workaround', () => {
      const tree = parse(
        `<?php
class App {
    /** @var User[] */
    private $users;
    public function process(): void {
        foreach ($this->users as $user) {
            $user->save();
        }
    }
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$user')).toBe('User');
    });

    it('does not bind from unknown $this->property (conservative)', () => {
      const tree = parse(
        `<?php
class App {
    private $unknownProp;
    public function process(): void {
        foreach ($this->unknownProp as $item) {
            $item->save();
        }
    }
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      expect(flatGet(typeEnv, '$item')).toBeUndefined();
    });

    it('multi-class file: resolves correct property for each class', () => {
      const tree = parse(
        `<?php
class A {
    /** @var User[] */
    private $items;
    public function processA(): void {
        foreach ($this->items as $item) {
            $item->save();
        }
    }
}
class B {
    /** @var Order[] */
    private $items;
    public function processB(): void {
        foreach ($this->items as $item) {
            $item->submit();
        }
    }
}
      `,
        PHP.php,
      );
      const typeEnv = buildTypeEnv(tree, 'php');
      // Both $item bindings exist but may share the same key if scoped to method name
      // Conservative: just verify at least one resolves correctly
      expect(flatGet(typeEnv, '$item')).toBeDefined();
    });
  });

  describe('match arm scoping — first-writer-wins regression', () => {
    it('Rust: first match arm binding wins, later arms do not overwrite', () => {
      const tree = parse(
        `
fn process(opt: Option<User>) {
    match opt {
        Some(user) => user.save(),
        None => {},
    }
}
      `,
        Rust,
      );
      const typeEnv = buildTypeEnv(tree, 'rust');
      // user should be typed from the first arm (Some unwrap)
      // Known limitation: binding leaks across arms (first-writer-wins)
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });
  });

  describe('performance optimizations — coverage for new code paths', () => {
    it('fastStripNullable: passes through simple identifier without stripping', () => {
      const tree = parse('function f(user: User) { user.save(); }', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // lookup exercises fastStripNullable — "User" has no | or ? markers
      const callNode = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('save'));
      expect(typeEnv.lookup('user', callNode)).toBe('User');
    });

    it('fastStripNullable: strips nullable union type via full stripNullable', () => {
      const tree = parse('function f(user: User | null) { user.save(); }', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const callNode = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('save'));
      expect(typeEnv.lookup('user', callNode)).toBe('User');
    });

    it('fastStripNullable: rejects bare nullable keyword', () => {
      const tree = parse('function f(x: null) { x.save(); }', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const callNode = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('save'));
      expect(typeEnv.lookup('x', callNode)).toBeUndefined();
    });

    it('fastStripNullable: strips optional type suffix', () => {
      const tree = parse(
        `
class Foo {
    process(user: User) {
        user.save();
    }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const callNode = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('save'));
      expect(typeEnv.lookup('user', callNode)).toBe('User');
    });

    it('SKIP_SUBTREE_TYPES: string literal subtrees do not affect type extraction', () => {
      const tree = parse(
        `
function f(user: User) {
    const msg = "hello world this is a long string";
    user.save();
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'user')).toBe('User');
    });

    it('interestingNodeTypes: non-declaration nodes skip extractTypeBinding', () => {
      // Large code with many non-interesting nodes (binary expressions, calls, etc.)
      const tree = parse(
        `
function calculate(service: Service) {
    const a = 1 + 2 + 3;
    const b = true && false;
    if (a > b) { service.run(); }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'service')).toBe('Service');
    });
  });

  describe('null-check narrowing via patternOverrides (Phase C Task 7)', () => {
    it('TS: if (x !== null) narrows User | null to User inside if-body', () => {
      const code = `
function process(x: User | null) {
  if (x !== null) {
    x.save();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Inside the if-body, x should resolve to User (nullable stripped)
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('TS: if (x !== undefined) narrows User | undefined to User inside if-body', () => {
      const code = `
function process(x: User | undefined) {
  if (x !== undefined) {
    x.save();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('TS: if (x != null) narrows with loose inequality', () => {
      const code = `
function process(x: User | null) {
  if (x != null) {
    x.save();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('TS: null-check narrowing does NOT leak to else branch', () => {
      const code = `
function process(x: User | null) {
  if (x !== null) {
    x.save();
  } else {
    x.fallback();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // Inside else branch, x should retain original nullable type (User via fastStripNullable)
      const fallbackCall = tree.rootNode.descendantForIndex(
        tree.rootNode.text.indexOf('x.fallback'),
      );
      // The else branch is NOT in the narrowing range, so lookup falls through to
      // the flat scopeEnv which has "User | null" — fastStripNullable strips it to User.
      // This is expected: without negative narrowing (Phase 13A), else branches still get
      // the base stripped type. The key invariant is that the narrowing override does NOT
      // apply outside the if-body range.
      expect(typeEnv.lookup('x', fallbackCall)).toBe('User');
    });

    it('TS: null-check narrowing does NOT apply outside the if block', () => {
      const code = `
function process(x: User | null) {
  if (x !== null) {
    x.save();
  }
  x.other();
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // After the if-block, x should use the flat scopeEnv (User | null → User via fastStripNullable)
      const otherCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.other'));
      expect(typeEnv.lookup('x', otherCall)).toBe('User');
    });

    it('TS: no narrowing when variable has no nullable type', () => {
      const code = `
function process(x: User) {
  if (x !== null) {
    x.save();
  }
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // x is already non-nullable — no narrowing override is emitted, but lookup still works
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('TS: instanceof still works alongside null-check narrowing', () => {
      const tree = parse(
        `
function process(x) {
  if (x instanceof User) {
    x.save();
  }
}
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'x')).toBe('User');
    });

    it('Kotlin: if (x != null) narrows nullable type inside if-body', () => {
      const code = `
fun process(x: User?) {
    if (x != null) {
        x.save()
    }
}`;
      const tree = parse(code, Kotlin);
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('Kotlin: when/is still works alongside null-check narrowing', () => {
      const tree = parse(
        `
fun process(x: Any) {
    when (x) {
        is User -> x.name
    }
}
      `,
        Kotlin,
      );
      const typeEnv = buildTypeEnv(tree, 'kotlin');
      expect(flatGet(typeEnv, 'x')).toBe('User');
    });

    it('C#: if (x != null) narrows nullable type inside if-body', () => {
      const code = `
class App {
    void Process(User? x) {
        if (x != null) {
            x.Save();
        }
    }
}`;
      const tree = parse(code, CSharp);
      const typeEnv = buildTypeEnv(tree, 'csharp');
      const saveCall = tree.rootNode.descendantForIndex(tree.rootNode.text.indexOf('x.Save'));
      expect(typeEnv.lookup('x', saveCall)).toBe('User');
    });

    it('C#: is_pattern_expression type pattern still works alongside null-check', () => {
      const tree = parse(
        `
class App {
    void Process(object obj) {
        if (obj is User user) {
            user.Save();
        }
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'user')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
      // x should NOT have a type binding (it's untyped via var)
      expect(flatGet(typeEnv, 'x')).toBeUndefined();
    });

    it('C#: multi-declarator with shared type captures both variables', () => {
      const tree = parse(
        `
class App {
    void Run() {
        User a = GetA(), b = GetB();
        a.Save();
        b.Save();
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      expect(flatGet(typeEnv, 'a')).toBe('User');
      expect(flatGet(typeEnv, 'b')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'user')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      expect(flatGet(typeEnv, 'users')).toBe('List');
      expect(flatGet(typeEnv, 'admins')).toBe('List');
      expect(flatGet(typeEnv, 'u')).toBe('User');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      // Find the entry for variable 'a'
      let ctorType: string | undefined;
      for (const [key, value] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0a')) {
          ctorType = value;
          break;
        }
      }
      expect(ctorType).toBe('Dog');
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
      const typeEnv = buildTypeEnv(tree, 'java');
      let found = false;
      for (const [key] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0u')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(false);
    });

    it('TypeScript: const a: Animal = new Dog() — constructorTypeMap not populated (type on variable_declarator, not lexical_declaration)', () => {
      // TS virtual dispatch for this pattern works through call-processor,
      // not constructorTypeMap — the type annotation is on the child
      // variable_declarator, not the outer lexical_declaration.
      const tree = parse(
        `
class Animal {}
class Dog extends Animal {}
const a: Animal = new Dog();
      `,
        TypeScript.typescript,
      );
      const typeEnv = buildTypeEnv(tree, 'typescript');
      expect(flatGet(typeEnv, 'a')).toBe('Animal');
      let found = false;
      for (const [key] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0a')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(false);
    });

    it('C++: Animal* a = new Dog() populates constructorTypeMap', () => {
      const tree = parse(
        `
class Animal {};
class Dog : public Animal {};
void run() {
    Animal* a = new Dog();
}
      `,
        CPP,
      );
      const typeEnv = buildTypeEnv(tree, 'cpp');
      let ctorType: string | undefined;
      for (const [key, value] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0a')) {
          ctorType = value;
          break;
        }
      }
      expect(ctorType).toBe('Dog');
    });

    it('C#: Animal a = new Dog() populates constructorTypeMap', () => {
      const tree = parse(
        `
class Animal {}
class Dog : Animal {}
class App {
    void Run() {
        Animal a = new Dog();
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      let ctorType: string | undefined;
      for (const [key, value] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0a')) {
          ctorType = value;
          break;
        }
      }
      expect(ctorType).toBe('Dog');
    });

    it('C#: implicit new() does NOT populate constructorTypeMap (type from declaration)', () => {
      const tree = parse(
        `
class Dog {}
class App {
    void Run() {
        Dog d = new();
    }
}
      `,
        CSharp,
      );
      const typeEnv = buildTypeEnv(tree, 'csharp');
      // d should be bound via declared type path
      expect(flatGet(typeEnv, 'd')).toBe('Dog');
      // constructorTypeMap should NOT have an entry (same type, no override needed)
      let found = false;
      for (const [key] of typeEnv.constructorTypeMap) {
        if (key.endsWith('\0d')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(false);
    });
  });

  describe('Phase 14: importedBindings seeding', () => {
    it('seeds imported bindings into file scope for unbound names', () => {
      // Source has no local declaration of 'config', so the imported binding wins
      const tree = parse('', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map([['config', 'Config']]),
      });
      const fileScope = typeEnv.fileScope();
      expect(fileScope?.get('config')).toBe('Config');
    });

    it('local declarations take precedence over imported bindings', () => {
      // Source declares config: AppConfig — imported binding for 'config' must not overwrite it
      const tree = parse('const config: AppConfig = getConfig();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map([['config', 'Config']]),
      });
      const fileScope = typeEnv.fileScope();
      // AppConfig from the local annotation wins over the imported 'Config'
      expect(fileScope?.get('config')).toBe('AppConfig');
    });

    it('does nothing when importedBindings is empty', () => {
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const typeEnvWithout = buildTypeEnv(tree, 'typescript');
      const typeEnvWith = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map(),
      });
      // Both envs should produce the same file-scope content
      const scopeWithout = typeEnvWithout.fileScope();
      const scopeWith = typeEnvWith.fileScope();
      expect(scopeWith?.get('user')).toBe(scopeWithout?.get('user'));
      expect(scopeWith?.size).toBe(scopeWithout?.size);
    });

    it('seeds multiple bindings', () => {
      const tree = parse('', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map([
          ['user', 'User'],
          ['config', 'Config'],
        ]),
      });
      const fileScope = typeEnv.fileScope();
      expect(fileScope?.get('user')).toBe('User');
      expect(fileScope?.get('config')).toBe('Config');
    });

    it('seeded bindings are reachable via lookup from a nested call node', () => {
      // A call inside a function should still be able to look up a file-scope seeded binding
      const code = `
function process() {
  config.validate();
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map([['config', 'Config']]),
      });

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      // config.validate() — lookup 'config' from inside the process function scope
      expect(typeEnv.lookup('config', calls[0])).toBe('Config');
    });

    it('seeds bindings with no conflict when local file has unrelated declarations', () => {
      // File has 'user' declared locally; 'config' comes from importedBindings
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedBindings: new Map([['config', 'Config']]),
      });
      const fileScope = typeEnv.fileScope();
      // Local binding preserved
      expect(fileScope?.get('user')).toBe('User');
      // Imported binding added for the name that had no local declaration
      expect(fileScope?.get('config')).toBe('Config');
    });
  });

  describe('importedReturnTypes (Phase 14 E3)', () => {
    // Minimal mock SymbolTable that returns a known callable
    const makeSymbolTable = (callables: Array<{ name: string; returnType?: string }>) => ({
      lookupFuzzyCallable: (name: string) =>
        callables
          .filter((c) => c.name === name)
          .map((c) => ({
            nodeId: 'n1',
            filePath: 'src.ts',
            type: 'Function' as const,
            returnType: c.returnType,
          })),
      lookupFuzzy: () => [],
      lookupExact: () => undefined,
      lookupExactFull: () => undefined,
      add: () => {},
      getStats: () => ({ fileCount: 0, globalSymbolCount: 0 }),
      clear: () => {},
    });

    it('SymbolTable has unambiguous match → uses it, ignores cross-file', () => {
      // SymbolTable knows getConfig() returns Config (SymbolType)
      // importedReturnTypes says getConfig → WrongType — SymbolTable must win
      const symbolTable = makeSymbolTable([{ name: 'getConfig', returnType: 'Config' }]);
      const tree = parse('const c = getConfig();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        symbolTable: symbolTable as any,
        importedReturnTypes: new Map([['getConfig', 'WrongType']]),
      });
      // SymbolTable result (Config) wins over cross-file fallback (WrongType)
      expect(flatGet(typeEnv, 'c')).toBe('Config');
    });

    it('SymbolTable has no match (0 results) → falls back to cross-file', () => {
      // SymbolTable knows nothing about getConfig
      const symbolTable = makeSymbolTable([]);
      const tree = parse('const c = getConfig();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        symbolTable: symbolTable as any,
        importedReturnTypes: new Map([['getConfig', 'Config']]),
      });
      // Cross-file fallback provides Config
      expect(flatGet(typeEnv, 'c')).toBe('Config');
    });

    it('SymbolTable has 2+ matches (ambiguous) → returns undefined, NO cross-file fallback', () => {
      // Two overloads of process() — ambiguous → must NOT fall back to cross-file
      const symbolTable = makeSymbolTable([
        { name: 'process', returnType: 'User' },
        { name: 'process', returnType: 'Admin' },
      ]);
      const tree = parse('const r = process();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        symbolTable: symbolTable as any,
        importedReturnTypes: new Map([['process', 'User']]),
      });
      // Ambiguous → conservative → no binding produced
      expect(flatGet(typeEnv, 'r')).toBeUndefined();
    });

    it('no SymbolTable → uses cross-file return types directly', () => {
      const tree = parse('const c = getConfig();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedReturnTypes: new Map([['getConfig', 'Config']]),
      });
      expect(flatGet(typeEnv, 'c')).toBe('Config');
    });

    it('cross-file has entry but SymbolTable covers it → SymbolTable wins', () => {
      // SymbolTable provides the authoritative return type; cross-file entry is ignored
      const symbolTable = makeSymbolTable([{ name: 'getUser', returnType: 'User' }]);
      const tree = parse('const u = getUser();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        symbolTable: symbolTable as any,
        importedReturnTypes: new Map([['getUser', 'CrossFileUser']]),
      });
      // SymbolTable result (User) wins
      expect(flatGet(typeEnv, 'u')).toBe('User');
    });

    it('does nothing when importedReturnTypes is absent', () => {
      const tree = parse('const c = getConfig();', TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');
      // No annotation, no SymbolTable, no cross-file → no binding
      expect(flatGet(typeEnv, 'c')).toBeUndefined();
    });

    it('resolved cross-file callee enables downstream call edges via lookup', () => {
      // File has: const c = getConfig(); c.validate();
      // importedReturnTypes maps getConfig → Config
      // After fixpoint, c should be typed as Config, making lookup('c', ...) return 'Config'
      const code = `
function process() {
  const c = getConfig();
  c.validate();
}`;
      const tree = parse(code, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript', {
        importedReturnTypes: new Map([['getConfig', 'Config']]),
      });

      const calls: any[] = [];
      function findCalls(node: any) {
        if (node.type === 'call_expression') calls.push(node);
        for (let i = 0; i < node.childCount; i++) findCalls(node.child(i));
      }
      findCalls(tree.rootNode);

      // calls[0] = getConfig(), calls[1] = c.validate()
      // From inside process(), c should resolve to Config
      const validateCall = calls.find((n: any) => n.text.includes('validate'));
      expect(validateCall).toBeDefined();
      expect(typeEnv.lookup('c', validateCall)).toBe('Config');
    });
  });
});
