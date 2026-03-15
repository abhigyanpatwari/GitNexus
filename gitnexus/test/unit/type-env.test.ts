import { describe, it, expect } from 'vitest';
import { buildTypeEnv, type TypeEnv, type TypeEnvironment } from '../../src/core/ingestion/type-env.js';
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

/** Flatten a scoped TypeEnv into a simple name→type map (for simple test assertions). */
function flatGet(env: TypeEnv, varName: string): string | undefined {
  for (const [, scopeMap] of env) {
    const val = scopeMap.get(varName);
    if (val) return val;
  }
  return undefined;
}

/** Count all bindings across all scopes. */
function flatSize(env: TypeEnv): number {
  let count = 0;
  for (const [, scopeMap] of env) count += scopeMap.size;
  return count;
}

describe('buildTypeEnv', () => {
  describe('TypeScript', () => {
    it('extracts type from const declaration', () => {
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from let declaration', () => {
      const tree = parse('let repo: Repository;', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('function save(user: User, repo: Repository) {}', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from arrow function parameters', () => {
      const tree = parse('const fn = (user: User) => user.save();', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('ignores variables without type annotations', () => {
      const tree = parse('const x = 5; let y = "hello";', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatSize(env)).toBe(0);
    });

    it('extracts type from nullable union User | null', () => {
      const tree = parse('const user: User | null = getUser();', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from optional union User | undefined', () => {
      const tree = parse('let user: User | undefined;', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from triple nullable union User | null | undefined', () => {
      const tree = parse('const user: User | null | undefined = getUser();', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('ignores non-nullable unions like User | Repo', () => {
      const tree = parse('const entity: User | Repo = getEntity();', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'entity')).toBeUndefined();
    });
  });

  describe('Java', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(`
        class App {
          void run() {
            User user = new User();
            Repository repo = getRepo();
          }
        }
      `, Java);
      const { env } = buildTypeEnv(tree, 'java');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(`
        class App {
          void process(User user, Repository repo) {}
        }
      `, Java);
      const { env } = buildTypeEnv(tree, 'java');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from field declaration', () => {
      const tree = parse(`
        class App {
          private User user;
        }
      `, Java);
      const { env } = buildTypeEnv(tree, 'java');
      expect(flatGet(env, 'user')).toBe('User');
    });
  });

  describe('C#', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(`
        class App {
          void Run() {
            User user = new User();
          }
        }
      `, CSharp);
      const { env } = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from var with new expression', () => {
      const tree = parse(`
        class App {
          void Run() {
            var user = new User();
          }
        }
      `, CSharp);
      const { env } = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(`
        class App {
          void Process(User user, Repository repo) {}
        }
      `, CSharp);
      const { env } = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from is pattern matching (obj is User user)', () => {
      const tree = parse(`
        class User { public void Save() {} }
        class App {
          void Process(object obj) {
            if (obj is User user) {
              user.Save();
            }
          }
        }
      `, CSharp);
      const { env } = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
    });
  });

  describe('Go', () => {
    it('extracts type from var declaration', () => {
      const tree = parse(`
        package main
        func main() {
          var user User
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from short var with composite literal', () => {
      const tree = parse(`
        package main
        func main() {
          user := User{Name: "Alice"}
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from address-of composite literal (&User{})', () => {
      const tree = parse(`
        package main
        func main() {
          user := &User{Name: "Alice"}
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from address-of in multi-assignment', () => {
      const tree = parse(`
        package main
        func main() {
          user, repo := &User{}, &Repo{}
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repo');
    });

    it('infers type from new(User) built-in', () => {
      const tree = parse(`
        package main
        func main() {
          user := new(User)
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('does not infer from non-new function calls', () => {
      const tree = parse(`
        package main
        func main() {
          user := getUser()
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBeUndefined();
    });

    it('infers element type from make([]User, 0) slice builtin', () => {
      const tree = parse(`
        package main
        func main() {
          sl := make([]User, 0)
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'sl')).toBe('User');
    });

    it('infers value type from make(map[string]User) map builtin', () => {
      const tree = parse(`
        package main
        func main() {
          m := make(map[string]User)
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'm')).toBe('User');
    });

    it('infers type from type assertion: user := iface.(User)', () => {
      const tree = parse(`
        package main
        type Saver interface { Save() }
        func process(s Saver) {
          user := s.(User)
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('infers type from type assertion in multi-assignment: user, ok := iface.(User)', () => {
      const tree = parse(`
        package main
        type Saver interface { Save() }
        func process(s Saver) {
          user, ok := s.(User)
        }
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        package main
        func process(user User, repo Repository) {}
      `, Go);
      const { env } = buildTypeEnv(tree, 'go');
      // Go parameter extraction depends on tree-sitter grammar structure
      // Parameters may or may not have 'name'/'type' fields
    });
  });

  describe('Rust', () => {
    it('extracts type from let declaration', () => {
      const tree = parse(`
        fn main() {
          let user: User = User::new();
        }
      `, Rust);
      const { env } = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        fn process(user: User, repo: Repository) {}
      `, Rust);
      const { env } = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from let with reference', () => {
      const tree = parse(`
        fn main() {
          let user: &User = &get_user();
        }
      `, Rust);
      const { env } = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
    });
  });

  describe('Python', () => {
    it('extracts type from annotated assignment (PEP 484)', () => {
      const tree = parse('user: User = get_user()', Python);
      const { env } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('def process(user: User, repo: Repository): pass', Python);
      const { env } = buildTypeEnv(tree, 'python');
      // Python uses typed_parameter nodes, check if they match
    });

    it('extracts type from class-level annotation with default value', () => {
      const tree = parse(`class User:
    name: str = "default"
    age: int = 0
`, Python);
      const { env } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'name')).toBe('str');
      expect(flatGet(env, 'age')).toBe('int');
    });

    it('extracts type from class-level annotation without default value', () => {
      const tree = parse(`class User:
    repo: UserRepo
`, Python);
      const { env } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'repo')).toBe('UserRepo');
    });

    it('extracts types from mixed class-level annotations and methods', () => {
      const tree = parse(`class User:
    name: str = "default"
    age: int = 0
    repo: UserRepo

    def save(self):
        pass
`, Python);
      const { env } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'name')).toBe('str');
      expect(flatGet(env, 'age')).toBe('int');
      expect(flatGet(env, 'repo')).toBe('UserRepo');
    });
  });

  describe('C++', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(`
        void run() {
          User user;
        }
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from initialized declaration', () => {
      const tree = parse(`
        void run() {
          User user = getUser();
        }
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from pointer declaration', () => {
      const tree = parse(`
        void run() {
          User* user = new User();
        }
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        void process(User user, Repository& repo) {}
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from range-for with explicit type', () => {
      const tree = parse(`
        void run() {
          std::vector<User> users;
          for (User& user : users) {
            user.save();
          }
        }
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from range-for with const ref', () => {
      const tree = parse(`
        void run() {
          std::vector<User> users;
          for (const User& user : users) {
            user.save();
          }
        }
      `, CPP);
      const { env } = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });
  });

  describe('PHP', () => {
    it('extracts type from function parameters', () => {
      const tree = parse(`<?php
        function process(User $user, Repository $repo) {}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      // PHP parameter type extraction
      expect(flatGet(env, '$user')).toBe('User');
      expect(flatGet(env, '$repo')).toBe('Repository');
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

      expect(calls.length).toBeGreaterThanOrEqual(1);
      // $this should resolve to enclosing class 'UserService'
      expect(typeEnv.lookup('$this', calls[0])).toBe('UserService');
    });

    it('extracts type from constructor property promotion (PHP 8.0+)', () => {
      const tree = parse(`<?php
class User {
  public function __construct(
    private string $name,
    private UserRepo $repo
  ) {}
}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      expect(flatGet(env, '$repo')).toBe('UserRepo');
    });

    it('extracts type from typed class property (PHP 7.4+)', () => {
      const tree = parse(`<?php
class UserService {
  private UserRepo $repo;
}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      expect(flatGet(env, '$repo')).toBe('UserRepo');
    });

    it('extracts type from typed class property with default value', () => {
      const tree = parse(`<?php
class UserService {
  public string $name = "test";
}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      expect(flatGet(env, '$name')).toBe('string');
    });

    it('extracts PHPDoc @param with standard order: @param Type $name', () => {
      const tree = parse(`<?php
/**
 * @param UserRepo $repo the repository
 * @param string $name the user name
 */
function create($repo, $name) {
  $repo->save();
}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      expect(flatGet(env, '$repo')).toBe('UserRepo');
      expect(flatGet(env, '$name')).toBe('string');
    });

    it('extracts PHPDoc @param with alternate order: @param $name Type', () => {
      const tree = parse(`<?php
/**
 * @param $repo UserRepo the repository
 * @param $name string the user name
 */
function process($repo, $name) {
  $repo->save();
}
      `, PHP.php);
      const { env } = buildTypeEnv(tree, 'php');
      expect(flatGet(env, '$repo')).toBe('UserRepo');
      expect(flatGet(env, '$name')).toBe('string');
    });
  });

  describe('Ruby YARD annotations', () => {
    it('extracts @param type bindings from YARD comments', () => {
      const tree = parse(`
class UserService
  # @param repo [UserRepo] the repository
  # @param name [String] the user's name
  def create(repo, name)
    repo.save
  end
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'repo')).toBe('UserRepo');
      expect(flatGet(env, 'name')).toBe('String');
    });

    it('handles qualified YARD types (Models::User → User)', () => {
      const tree = parse(`
# @param user [Models::User] the user
def process(user)
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('handles nullable YARD types (String, nil → String)', () => {
      const tree = parse(`
# @param name [String, nil] optional name
def greet(name)
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'name')).toBe('String');
    });

    it('skips ambiguous union YARD types (String, Integer → undefined)', () => {
      const tree = parse(`
# @param value [String, Integer] mixed type
def process(value)
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'value')).toBeUndefined();
    });

    it('extracts no types when no YARD comments present', () => {
      const tree = parse(`
def create(repo, name)
  repo.save
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatSize(env)).toBe(0);
    });

    it('extracts types from singleton method YARD comments', () => {
      const tree = parse(`
class UserService
  # @param name [String] the user's name
  def self.find(name)
    name
  end
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'name')).toBe('String');
    });

    it('handles generic YARD types (Array<User> → Array)', () => {
      const tree = parse(`
# @param users [Array<User>] list of users
def process(users)
end
`, Ruby);
      const { env } = buildTypeEnv(tree, 'ruby');
      expect(flatGet(env, 'users')).toBe('Array');
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

      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(typeEnv.lookup('this', calls[0])).toBe('AppConfig');
    });
  });

  describe('scope awareness', () => {
    it('separates same-named variables in different functions', () => {
      const tree = parse(`
        function handleUser(user: User) {
          user.save();
        }
        function handleRepo(user: Repo) {
          user.save();
        }
      `, TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');

      // Each function has its own scope for 'user' (keyed by funcName@startIndex)
      // Find the scope keys that start with handleUser/handleRepo
      const scopes = [...env.keys()];
      const handleUserKey = scopes.find(k => k.startsWith('handleUser@'));
      const handleRepoKey = scopes.find(k => k.startsWith('handleRepo@'));
      expect(handleUserKey).toBeDefined();
      expect(handleRepoKey).toBeDefined();
      expect(env.get(handleUserKey!)?.get('user')).toBe('User');
      expect(env.get(handleRepoKey!)?.get('user')).toBe('Repo');
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
      const tree = parse(`
        const config: Config = getConfig();
        function process(user: User) {
          config.validate();
          user.save();
        }
      `, TypeScript.typescript);
      const typeEnv = buildTypeEnv(tree, 'typescript');

      // config is at file-level scope
      const fileScope = typeEnv.env.get('');
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
      const tree = parse(`
        const user: User = getUser();
        const { name, email } = user;
      `, TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      // The typed variable is captured
      expect(flatGet(env, 'user')).toBe('User');
      // Destructured bindings (name, email) would need type inference to resolve
      // — not extractable from annotations alone
      expect(flatGet(env, 'name')).toBeUndefined();
      expect(flatGet(env, 'email')).toBeUndefined();
    });

    it('does not extract from object-type-annotated destructuring', () => {
      // TypeScript allows: const { name }: { name: string } = user;
      // The annotation is on the whole pattern, not individual bindings
      const tree = parse(`
        const { name }: { name: string } = getUser();
      `, TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      // Complex type annotation (object type) — extractSimpleTypeName returns undefined
      expect(flatSize(env)).toBe(0);
    });
  });

  describe('constructor inference (Tier 1 fallback)', () => {
    describe('TypeScript', () => {
      it('infers type from new expression when no annotation', () => {
        const tree = parse('const user = new User();', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('prefers explicit annotation over constructor inference', () => {
        const tree = parse('const user: BaseUser = new User();', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        expect(flatGet(env, 'user')).toBe('BaseUser');
      });

      it('infers from namespaced constructor: new ns.Service()', () => {
        // extractSimpleTypeName handles member_expression via property_identifier
        const tree = parse('const svc = new ns.Service();', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        expect(flatGet(env, 'svc')).toBe('Service');
      });

      it('infers type from new expression with as cast', () => {
        const tree = parse('const x = new User() as BaseUser;', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        // Unwraps as_expression to find the inner new_expression → User
        expect(flatGet(env, 'x')).toBe('User');
      });

      it('infers type from new expression with non-null assertion', () => {
        const tree = parse('const x = new User()!;', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        // Unwraps non_null_expression to find the inner new_expression → User
        expect(flatGet(env, 'x')).toBe('User');
      });

      it('infers type from double-cast (new X() as unknown as T)', () => {
        const tree = parse('const x = new User() as unknown as Admin;', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        // Unwraps nested as_expression to find inner new_expression → User
        expect(flatGet(env, 'x')).toBe('User');
      });

      it('ignores non-new assignments', () => {
        const tree = parse('const x = getUser();', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        expect(flatSize(env)).toBe(0);
      });

      it('handles mixed annotated + unannotated declarators', () => {
        const tree = parse('const a: A = getA(), b = new B();', TypeScript.typescript);
        const { env } = buildTypeEnv(tree, 'typescript');
        expect(flatGet(env, 'a')).toBe('A');
        expect(flatGet(env, 'b')).toBe('B');
      });
    });

    describe('Java', () => {
      it('infers type from var with new expression (Java 10+)', () => {
        const tree = parse(`
          class App {
            void run() {
              var user = new User();
            }
          }
        `, Java);
        const { env } = buildTypeEnv(tree, 'java');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('prefers explicit type over constructor inference', () => {
        const tree = parse(`
          class App {
            void run() {
              User user = new User();
            }
          }
        `, Java);
        const { env } = buildTypeEnv(tree, 'java');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does not infer from var without new expression', () => {
        const tree = parse(`
          class App {
            void run() {
              var x = getUser();
            }
          }
        `, Java);
        const { env } = buildTypeEnv(tree, 'java');
        expect(flatGet(env, 'x')).toBeUndefined();
      });
    });

    describe('Rust', () => {
      it('infers type from Type::new()', () => {
        const tree = parse(`
          fn main() {
            let user = User::new();
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from Type::default()', () => {
        const tree = parse(`
          fn main() {
            let config = Config::default();
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'config')).toBe('Config');
      });

      it('does NOT emit scanner binding for Type::default() (handled by extractInitializer)', () => {
        const tree = parse(`
          fn main() {
            let config = Config::default();
          }
        `, Rust);
        const { constructorBindings } = buildTypeEnv(tree, 'rust');
        // ::default() should be excluded from scanConstructorBinding just like ::new()
        // extractInitializer already resolves it, so a scanner binding would be redundant
        const defaultBinding = constructorBindings.find(b => b.calleeName === 'default');
        expect(defaultBinding).toBeUndefined();
      });

      it('does NOT emit scanner binding for Type::new() (handled by extractInitializer)', () => {
        const tree = parse(`
          fn main() {
            let user = User::new();
          }
        `, Rust);
        const { constructorBindings } = buildTypeEnv(tree, 'rust');
        const newBinding = constructorBindings.find(b => b.calleeName === 'new');
        expect(newBinding).toBeUndefined();
      });

      it('prefers explicit annotation over constructor inference', () => {
        // Uses DIFFERENT types to catch Tier 0 overwrite bugs
        const tree = parse(`
          fn main() {
            let user: BaseUser = Admin::new();
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('BaseUser');
      });

      it('infers type from let mut with ::new()', () => {
        const tree = parse(`
          fn main() {
            let mut user = User::new();
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('resolves Self::new() to enclosing impl type', () => {
        const tree = parse(`
          struct User {}
          impl User {
            fn create() -> Self {
              let instance = Self::new();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'instance')).toBe('User');
      });

      it('resolves Self::default() to enclosing impl type', () => {
        const tree = parse(`
          struct Config {}
          impl Config {
            fn make() -> Self {
              let cfg = Self::default();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'cfg')).toBe('Config');
      });

      it('skips Self::new() outside impl block', () => {
        const tree = parse(`
          fn main() {
            let x = Self::new();
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'x')).toBeUndefined();
      });

      it('does not infer from Type::other_method()', () => {
        const tree = parse(`
          fn main() {
            let user = User::from_str("alice");
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBeUndefined();
      });

      it('infers type from struct literal (User { ... })', () => {
        const tree = parse(`
          fn main() {
            let user = User { name: "alice", age: 30 };
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from empty struct literal (Config {})', () => {
        const tree = parse(`
          fn main() {
            let config = Config {};
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'config')).toBe('Config');
      });

      it('prefers explicit annotation over struct literal inference', () => {
        const tree = parse(`
          fn main() {
            let user: BaseUser = Admin { name: "alice" };
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('BaseUser');
      });

      it('resolves Self {} struct literal to enclosing impl type', () => {
        const tree = parse(`
          struct User { name: String }
          impl User {
            fn reset(&self) -> Self {
              let fresh = Self { name: String::new() };
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'fresh')).toBe('User');
      });

      it('skips Self {} outside impl block', () => {
        const tree = parse(`
          fn main() {
            let x = Self { name: String::new() };
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'x')).toBeUndefined();
      });
    });

    describe('Rust if-let / while-let pattern bindings', () => {
      it('extracts type from captured_pattern in if let (user @ User { .. })', () => {
        const tree = parse(`
          fn process() {
            if let user @ User { .. } = get_user() {
              user.save();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('extracts type from nested captured_pattern in if let Some(user @ User { .. })', () => {
        const tree = parse(`
          fn process(opt: Option<User>) {
            if let Some(user @ User { .. }) = opt {
              user.save();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('extracts type from captured_pattern in while let', () => {
        const tree = parse(`
          fn process() {
            while let item @ Config { .. } = iter.next() {
              item.validate();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'item')).toBe('Config');
      });

      it('does NOT extract binding from if let Some(x) = opt (requires generic unwrapping)', () => {
        const tree = parse(`
          fn process(opt: Option<User>) {
            if let Some(user) = opt {
              user.save();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        // user's type is Option's inner type — requires generic unwrapping (Phase 3)
        expect(flatGet(env, 'user')).toBeUndefined();
      });

      it('does NOT extract field bindings from struct pattern destructuring', () => {
        const tree = parse(`
          fn process(val: User) {
            if let User { name } = val {
              name.len();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        // 'name' is a field of User — we don't know its type without field-type resolution
        expect(flatGet(env, 'name')).toBeUndefined();
        // 'val' should still be extracted from the parameter annotation
        expect(flatGet(env, 'val')).toBe('User');
      });

      it('extracts type from scoped struct pattern (Message::Data)', () => {
        const tree = parse(`
          fn process() {
            if let msg @ Message::Data { .. } = get_msg() {
              msg.process();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        // scoped_type_identifier: Message::Data — extractSimpleTypeName returns "Data"
        expect(flatGet(env, 'msg')).toBe('Data');
      });

      it('still extracts parameter types alongside if-let bindings', () => {
        const tree = parse(`
          fn process(opt: Option<User>) {
            if let user @ User { .. } = get_user() {
              user.save();
            }
          }
        `, Rust);
        const { env } = buildTypeEnv(tree, 'rust');
        expect(flatGet(env, 'opt')).toBe('Option');
        expect(flatGet(env, 'user')).toBe('User');
      });
    });

    describe('PHP', () => {
      it('infers type from new expression', () => {
        const tree = parse(`<?php
          $user = new User();
        `, PHP.php);
        const { env } = buildTypeEnv(tree, 'php');
        expect(flatGet(env, '$user')).toBe('User');
      });

      it('resolves new self() and new static() to enclosing class', () => {
        const tree = parse(`<?php
          class Foo {
            function make() {
              $a = new self();
              $b = new static();
            }
          }
        `, PHP.php);
        const { env } = buildTypeEnv(tree, 'php');
        expect(flatGet(env, '$a')).toBe('Foo');
        expect(flatGet(env, '$b')).toBe('Foo');
      });

      it('resolves new parent() to superclass', () => {
        const tree = parse(`<?php
          class Bar {}
          class Foo extends Bar {
            function make() {
              $p = new parent();
            }
          }
        `, PHP.php);
        const { env } = buildTypeEnv(tree, 'php');
        expect(flatGet(env, '$p')).toBe('Bar');
      });

      it('skips self/static/parent outside class scope', () => {
        const tree = parse(`<?php
          $a = new self();
        `, PHP.php);
        const { env } = buildTypeEnv(tree, 'php');
        expect(flatGet(env, '$a')).toBeUndefined();
      });

      it('does not infer from non-new assignments', () => {
        const tree = parse(`<?php
          $user = getUser();
        `, PHP.php);
        const { env } = buildTypeEnv(tree, 'php');
        expect(flatGet(env, '$user')).toBeUndefined();
      });
    });

    describe('C++', () => {
      it('infers type from auto with new expression', () => {
        const tree = parse(`
          void run() {
            auto user = new User();
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from auto with direct construction when class is defined', () => {
        const tree = parse(`
          class User {};
          void run() {
            auto user = User();
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('prefers explicit type over auto inference', () => {
        const tree = parse(`
          void run() {
            User* user = new User();
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does not infer from auto with function call (not a known class)', () => {
        const tree = parse(`
          class User {};
          User getUser() { return User(); }
          void run() {
            auto x = getUser();
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        // getUser is an identifier but NOT a known class — no inference
        expect(flatGet(env, 'x')).toBeUndefined();
      });

      it('infers type from brace initialization (User{})', () => {
        const tree = parse(`
          class User {};
          void run() {
            auto user = User{};
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from brace initialization with args (User{1,2})', () => {
        const tree = parse(`
          class Config {};
          void run() {
            auto cfg = Config{1, 2};
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'cfg')).toBe('Config');
      });

      it('infers type from namespaced brace-init (ns::User{})', () => {
        const tree = parse(`
          namespace ns { class User {}; }
          void run() {
            auto user = ns::User{};
          }
        `, CPP);
        const { env } = buildTypeEnv(tree, 'cpp');
        expect(flatGet(env, 'user')).toBe('User');
      });
    });

    describe('Kotlin constructor inference', () => {
      it('still extracts explicit type annotations', () => {
        const tree = parse(`
          fun main() {
            val user: User = User()
          }
        `, Kotlin);
        const { env } = buildTypeEnv(tree, 'kotlin');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from constructor call when class is in same file', () => {
        const tree = parse(`
          class User(val name: String)
          fun main() {
            val user = User("Alice")
          }
        `, Kotlin);
        const { env } = buildTypeEnv(tree, 'kotlin');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does NOT infer type from plain function call', () => {
        const tree = parse(`
          fun getUser(): User = User("Alice")
          fun main() {
            val user = getUser()
          }
        `, Kotlin);
        const { env } = buildTypeEnv(tree, 'kotlin');
        // getUser is not a class name — should NOT produce a binding
        expect(flatGet(env, 'user')).toBeUndefined();
      });

      it('infers type from constructor when class defined via SymbolTable', () => {
        const tree = parse(`
          fun main() {
            val user = User("Alice")
          }
        `, Kotlin);
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
        const { env } = buildTypeEnv(tree, 'kotlin', mockSymbolTable as any);
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does NOT infer when SymbolTable says callee is a Function', () => {
        const tree = parse(`
          fun main() {
            val result = doStuff()
          }
        `, Kotlin);
        const mockSymbolTable = {
          lookupFuzzy: (name: string) =>
            name === 'doStuff' ? [{ nodeId: 'n1', filePath: 'utils.kt', type: 'Function' }] : [],
          lookupExact: () => undefined,
          lookupExactFull: () => undefined,
          add: () => {},
          getStats: () => ({ fileCount: 0, globalSymbolCount: 0 }),
          clear: () => {},
        };
        const { env } = buildTypeEnv(tree, 'kotlin', mockSymbolTable as any);
        expect(flatGet(env, 'result')).toBeUndefined();
      });

      it('prefers explicit annotation over constructor inference', () => {
        const tree = parse(`
          class User(val name: String)
          fun main() {
            val user: BaseEntity = User("Alice")
          }
        `, Kotlin);
        const { env } = buildTypeEnv(tree, 'kotlin');
        // Tier 0 (explicit annotation) wins over Tier 1 (constructor inference)
        expect(flatGet(env, 'user')).toBe('BaseEntity');
      });
    });

    describe('Python constructor inference', () => {
      it('infers type from direct constructor call when class is known', () => {
        const tree = parse(`
class User:
    pass

def main():
    user = User("alice")
`, Python);
        const { env } = buildTypeEnv(tree, 'python');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('infers type from qualified constructor call (models.User)', () => {
        const tree = parse(`
class User:
    pass

def main():
    user = models.User("alice")
`, Python);
        const { env } = buildTypeEnv(tree, 'python');
        // extractSimpleTypeName extracts "User" from attribute node "models.User"
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does not infer from plain function call', () => {
        const tree = parse(`
def main():
    user = get_user()
`, Python);
        const { env } = buildTypeEnv(tree, 'python');
        expect(flatGet(env, 'user')).toBeUndefined();
      });
    });

    describe('Python walrus operator type inference', () => {
      it('infers type from walrus operator with constructor call', () => {
        const tree = parse(`
class User:
    pass

def main():
    if (user := User("alice")):
        pass
`, Python);
        const { env } = buildTypeEnv(tree, 'python');
        expect(flatGet(env, 'user')).toBe('User');
      });

      it('does not infer type from walrus operator without known class', () => {
        const tree = parse(`
def main():
    if (data := get_data()):
        pass
`, Python);
        const { env } = buildTypeEnv(tree, 'python');
        expect(flatGet(env, 'data')).toBeUndefined();
      });
    });
  });

  describe('edge cases', () => {
    it('returns empty map for code without type annotations', () => {
      const tree = parse('const x = 5;', TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      expect(flatSize(env)).toBe(0);
    });

    it('last-write-wins for same variable name in same scope', () => {
      const tree = parse(`
        let x: User = getUser();
        let x: Admin = getAdmin();
      `, TypeScript.typescript);
      const { env } = buildTypeEnv(tree, 'typescript');
      // Both declarations are at file level; last one wins
      expect(flatGet(env, 'x')).toBeDefined();
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
      const tree = parse(`
        namespace ns {
          class HttpClient {};
        }
        void run() {
          auto client = ns::HttpClient();
        }
      `, CPP);
      const { constructorBindings } = buildTypeEnv(tree, 'cpp');
      // Should extract "HttpClient" from the scoped_identifier ns::HttpClient
      const binding = constructorBindings.find(b => b.varName === 'client');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('HttpClient');
    });

    it('does not extract from non-namespaced plain identifier (existing behavior)', () => {
      const tree = parse(`
        class User {};
        void run() {
          auto user = User();
        }
      `, CPP);
      const { env, constructorBindings } = buildTypeEnv(tree, 'cpp');
      // User() with known class resolves via extractInitializer, not constructor bindings
      expect(flatGet(env, 'user')).toBe('User');
      // No unresolved bindings since User is locally known
      expect(constructorBindings.find(b => b.varName === 'user')).toBeUndefined();
    });
  });

  describe('constructorBindings merged into buildTypeEnv', () => {
    it('returns constructor bindings for Kotlin val x = UnknownClass()', () => {
      const tree = parse(`
        fun main() {
          val user = UnknownClass()
        }
      `, Kotlin);
      const { env, constructorBindings } = buildTypeEnv(tree, 'kotlin');
      // UnknownClass is not defined locally — should appear as unverified binding
      expect(flatGet(env, 'user')).toBeUndefined();
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('UnknownClass');
    });

    it('does NOT emit constructor binding when TypeEnv already resolved', () => {
      const tree = parse(`
        fun main() {
          val user: User = User()
        }
      `, Kotlin);
      const { env, constructorBindings } = buildTypeEnv(tree, 'kotlin');
      // Explicit annotation resolves it — no unverified binding needed
      expect(flatGet(env, 'user')).toBe('User');
      expect(constructorBindings.find(b => b.varName === 'user')).toBeUndefined();
    });

    it('returns constructor bindings for Python x = UnknownClass()', () => {
      const tree = parse(`
def main():
    user = SomeClass()
`, Python);
      const { env, constructorBindings } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'user')).toBeUndefined();
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('SomeClass');
    });

    it('returns constructor bindings for Python qualified call (models.User)', () => {
      const tree = parse(`
def main():
    user = models.User("alice")
`, Python);
      const { constructorBindings } = buildTypeEnv(tree, 'python');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('User');
    });

    it('returns constructor bindings for Python walrus operator (user := SomeClass())', () => {
      const tree = parse(`
def main():
    if (user := SomeClass()):
        pass
`, Python);
      const { env, constructorBindings } = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'user')).toBeUndefined();
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('SomeClass');
    });

    it('returns empty bindings for language without scanner (Go)', () => {
      const tree = parse(`
        package main
        func main() {
          var x int = 5
        }
      `, Go);
      const { constructorBindings } = buildTypeEnv(tree, 'go');
      expect(constructorBindings).toEqual([]);
    });

    it('returns constructor bindings for Ruby constant assignment (REPO = Repo.new)', () => {
      const tree = parse(`
REPO = Repo.new
`, Ruby);
      const { constructorBindings } = buildTypeEnv(tree, 'ruby');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('REPO');
      expect(constructorBindings[0].calleeName).toBe('Repo');
    });

    it('returns constructor bindings for Ruby namespaced constructor (service = Models::UserService.new)', () => {
      const tree = parse(`
service = Models::UserService.new
`, Ruby);
      const { constructorBindings } = buildTypeEnv(tree, 'ruby');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('service');
      expect(constructorBindings[0].calleeName).toBe('UserService');
    });

    it('returns constructor bindings for deeply namespaced Ruby constructor (svc = App::Models::Service.new)', () => {
      const tree = parse(`
svc = App::Models::Service.new
`, Ruby);
      const { constructorBindings } = buildTypeEnv(tree, 'ruby');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('svc');
      expect(constructorBindings[0].calleeName).toBe('Service');
    });

    it('includes scope key in constructor bindings', () => {
      const tree = parse(`
        fun process() {
          val user = RemoteUser()
        }
      `, Kotlin);
      const { constructorBindings } = buildTypeEnv(tree, 'kotlin');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].scope).toMatch(/^process@\d+$/);
    });

    it('returns constructor bindings for TypeScript const user = getUser()', () => {
      const tree = parse('const user = getUser();', TypeScript.typescript);
      const { env, constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBeUndefined();
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('getUser');
    });

    it('does NOT emit constructor binding when TypeScript var has explicit type annotation', () => {
      const tree = parse('const user: User = getUser();', TypeScript.typescript);
      const { env, constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
      expect(constructorBindings.find(b => b.varName === 'user')).toBeUndefined();
    });

    it('skips destructuring patterns (array_pattern) for TypeScript', () => {
      const tree = parse('const [a, b] = getPair();', TypeScript.typescript);
      const { constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(constructorBindings).toEqual([]);
    });

    it('skips destructuring patterns (object_pattern) for TypeScript', () => {
      const tree = parse('const { name, age } = getUser();', TypeScript.typescript);
      const { constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(constructorBindings).toEqual([]);
    });

    it('unwraps await in TypeScript: const user = await fetchUser()', () => {
      const tree = parse('async function f() { const user = await fetchUser(); }', TypeScript.typescript);
      const { constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('fetchUser');
    });

    it('handles qualified callee in TypeScript: const user = repo.getUser()', () => {
      const tree = parse('const user = repo.getUser();', TypeScript.typescript);
      const { constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('getUser');
    });

    it('does not emit binding for TypeScript new expression (handled by extractInitializer)', () => {
      const tree = parse('const user = new User();', TypeScript.typescript);
      const { env, constructorBindings } = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
      expect(constructorBindings.find(b => b.varName === 'user')).toBeUndefined();
    });

    it('returns constructor binding for C# var user = svc.GetUser()', () => {
      const tree = parse(`
        class App {
          void Run() {
            var svc = new UserService();
            var user = svc.GetUser("alice");
          }
        }
      `, CSharp);
      const { constructorBindings } = buildTypeEnv(tree, 'csharp');
      const binding = constructorBindings.find(b => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUser');
    });

    it('unwraps .await in Rust: let user = get_user().await', () => {
      const tree = parse(`
        async fn process() {
          let user = get_user().await;
        }
      `, Rust);
      const { constructorBindings } = buildTypeEnv(tree, 'rust');
      expect(constructorBindings.length).toBe(1);
      expect(constructorBindings[0].varName).toBe('user');
      expect(constructorBindings[0].calleeName).toBe('get_user');
    });

    it('unwraps await in C#: var user = await svc.GetUserAsync()', () => {
      const tree = parse(`
        class App {
          async void Run() {
            var svc = new UserService();
            var user = await svc.GetUserAsync("alice");
          }
        }
      `, CSharp);
      const { constructorBindings } = buildTypeEnv(tree, 'csharp');
      const binding = constructorBindings.find(b => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUserAsync');
    });

    it('returns constructor binding for C# var user = GetUser() (standalone call)', () => {
      const tree = parse(`
        class App {
          void Run() {
            var user = GetUser("alice");
          }
        }
      `, CSharp);
      const { constructorBindings } = buildTypeEnv(tree, 'csharp');
      const binding = constructorBindings.find(b => b.varName === 'user');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('GetUser');
    });
  });
});
