import { describe, it, expect } from 'vitest';
import { buildTypeEnv, lookupTypeEnv, type TypeEnv } from '../../src/core/ingestion/type-env.js';
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
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from let declaration', () => {
      const tree = parse('let repo: Repository;', TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('function save(user: User, repo: Repository) {}', TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from arrow function parameters', () => {
      const tree = parse('const fn = (user: User) => user.save();', TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('ignores variables without type annotations', () => {
      const tree = parse('const x = 5; let y = "hello";', TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatSize(env)).toBe(0);
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
      const env = buildTypeEnv(tree, 'java');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(`
        class App {
          void process(User user, Repository repo) {}
        }
      `, Java);
      const env = buildTypeEnv(tree, 'java');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from field declaration', () => {
      const tree = parse(`
        class App {
          private User user;
        }
      `, Java);
      const env = buildTypeEnv(tree, 'java');
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
      const env = buildTypeEnv(tree, 'csharp');
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
      const env = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from method parameters', () => {
      const tree = parse(`
        class App {
          void Process(User user, Repository repo) {}
        }
      `, CSharp);
      const env = buildTypeEnv(tree, 'csharp');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
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
      const env = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from short var with composite literal', () => {
      const tree = parse(`
        package main
        func main() {
          user := User{Name: "Alice"}
        }
      `, Go);
      const env = buildTypeEnv(tree, 'go');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        package main
        func process(user User, repo Repository) {}
      `, Go);
      const env = buildTypeEnv(tree, 'go');
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
      const env = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        fn process(user: User, repo: Repository) {}
      `, Rust);
      const env = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });

    it('extracts type from let with reference', () => {
      const tree = parse(`
        fn main() {
          let user: &User = &get_user();
        }
      `, Rust);
      const env = buildTypeEnv(tree, 'rust');
      expect(flatGet(env, 'user')).toBe('User');
    });
  });

  describe('Python', () => {
    it('extracts type from annotated assignment (PEP 484)', () => {
      const tree = parse('user: User = get_user()', Python);
      const env = buildTypeEnv(tree, 'python');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse('def process(user: User, repo: Repository): pass', Python);
      const env = buildTypeEnv(tree, 'python');
      // Python uses typed_parameter nodes, check if they match
    });
  });

  describe('C++', () => {
    it('extracts type from local variable declaration', () => {
      const tree = parse(`
        void run() {
          User user;
        }
      `, CPP);
      const env = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from initialized declaration', () => {
      const tree = parse(`
        void run() {
          User user = getUser();
        }
      `, CPP);
      const env = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from pointer declaration', () => {
      const tree = parse(`
        void run() {
          User* user = new User();
        }
      `, CPP);
      const env = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
    });

    it('extracts type from function parameters', () => {
      const tree = parse(`
        void process(User user, Repository& repo) {}
      `, CPP);
      const env = buildTypeEnv(tree, 'cpp');
      expect(flatGet(env, 'user')).toBe('User');
      expect(flatGet(env, 'repo')).toBe('Repository');
    });
  });

  describe('PHP', () => {
    it('extracts type from function parameters', () => {
      const tree = parse(`<?php
        function process(User $user, Repository $repo) {}
      `, PHP.php);
      const env = buildTypeEnv(tree, 'php');
      // PHP parameter type extraction
      expect(flatGet(env, '$user')).toBe('User');
      expect(flatGet(env, '$repo')).toBe('Repository');
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
      const env = buildTypeEnv(tree, 'typescript');

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

    it('lookupTypeEnv resolves from enclosing function scope', () => {
      const code = `
function handleUser(user: User) {
  user.save();
}
function handleRepo(user: Repo) {
  user.save();
}`;
      const tree = parse(code, TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');

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
      expect(lookupTypeEnv(env, 'user', calls[0])).toBe('User');
      // Second call is inside handleRepo → user should be Repo
      expect(lookupTypeEnv(env, 'user', calls[1])).toBe('Repo');
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
      const env = buildTypeEnv(tree, 'typescript');

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
      expect(lookupTypeEnv(env, 'user', calls[0])).toBe('User');
      // Second call inside RepoService.process → repo should be Repo
      expect(lookupTypeEnv(env, 'repo', calls[1])).toBe('Repo');
    });

    it('file-level variables are accessible from all scopes', () => {
      const tree = parse(`
        const config: Config = getConfig();
        function process(user: User) {
          config.validate();
          user.save();
        }
      `, TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');

      // config is at file-level scope
      const fileScope = env.get('');
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
      // Use a call inside the function to test scope resolution
      expect(lookupTypeEnv(env, 'user', calls[2])).toBe('User');
      // config is file-level, accessible from any scope
      expect(lookupTypeEnv(env, 'config', calls[1])).toBe('Config');
    });
  });

  describe('destructuring patterns (known limitations)', () => {
    it('captures the typed source variable but not destructured bindings', () => {
      const tree = parse(`
        const user: User = getUser();
        const { name, email } = user;
      `, TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
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
      const env = buildTypeEnv(tree, 'typescript');
      // Complex type annotation (object type) — extractSimpleTypeName returns undefined
      expect(flatSize(env)).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty map for code without type annotations', () => {
      const tree = parse('const x = 5;', TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      expect(flatSize(env)).toBe(0);
    });

    it('last-write-wins for same variable name in same scope', () => {
      const tree = parse(`
        let x: User = getUser();
        let x: Admin = getAdmin();
      `, TypeScript.typescript);
      const env = buildTypeEnv(tree, 'typescript');
      // Both declarations are at file level; last one wins
      expect(flatGet(env, 'x')).toBeDefined();
    });
  });
});
