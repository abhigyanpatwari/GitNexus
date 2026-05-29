import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { parseSourceSafeSpy } = vi.hoisted(() => ({ parseSourceSafeSpy: vi.fn() }));

vi.mock('../../../src/core/tree-sitter/safe-parse.js', async () => {
  const { buildSafeParseMock } = await import('../../helpers/parse-source-safe-mock.js');
  return buildSafeParseMock(parseSourceSafeSpy);
});

import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('HttpRouteExtractor', () => {
  let tmpDir: string;
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-http-extract-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/backend',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  describe('plugin selection', () => {
    it('does not route Blade templates through the PHP source-scan plugin', () => {
      expect(getPluginForFile('resources/views/welcome.blade.php')).toBeUndefined();
      expect(getPluginForFile('routes/web.php')).toBeDefined();
    });
  });

  describe('provider extraction — graph-first (Strategy A)', () => {
    it('extracts routes from Route/HANDLES_ROUTE graph + source scan for method', async () => {
      const dir = path.join(tmpDir, 'graph-first');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'file-uid-ctrl',
              filePath: 'src/controller/UserController.java',
              routePath: '/api/v2/users',
              routeId: 'route-uid-users',
              responseKeys: null,
              routeSource: 'decorator-GetMapping',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-ctrl-list',
              name: 'list',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
            {
              uid: 'uid-ctrl-create',
              name: 'create',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const getRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(getRoute).toBeDefined();
      expect(getRoute!.confidence).toBe(0.9);
      expect(getRoute!.symbolUid).not.toBe('file-uid-ctrl');
    });

    it('supplements graph providers with source-scan providers from other files', async () => {
      const dir = path.join(tmpDir, 'graph-source-provider-union');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `
package main

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'file-uid-ctrl',
              filePath: 'src/controller/UserController.java',
              routePath: '/api/v2/users',
              routeId: 'route-uid-users',
              responseKeys: null,
              routeSource: 'decorator-GetMapping',
            },
          ];
        }
        if (query.includes('FETCHES')) return [];
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-ctrl-list',
              name: 'list',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const graphRouteMatches = providers.filter(
        (c) => c.contractId === 'http::GET::/api/v2/users',
      );
      expect(graphRouteMatches).toHaveLength(1);
      expect(graphRouteMatches[0].symbolUid).toBe('uid-ctrl-list');
      expect(graphRouteMatches[0].meta.extractionStrategy).toBe('graph_assisted');

      const sourceRoute = providers.find((c) => c.contractId === 'http::GET::/api/health');
      expect(sourceRoute).toBeDefined();
      expect(sourceRoute?.symbolName).toBe('healthHandler');
      expect(sourceRoute?.meta.extractionStrategy).toBe('source_scan');
    });
  });

  describe('provider extraction — source-scan fallback (Strategy B)', () => {
    it('extracts Spring @GetMapping annotation', async () => {
      const dir = path.join(tmpDir, 'spring');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }

    @GetMapping("/users/{id}")
    public User getById(@PathVariable Long id) { return service.findById(id); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);

      const listRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(listRoute).toBeDefined();
      expect(listRoute!.meta.method).toBe('GET');
      expect(listRoute!.meta.path).toBe('/api/v2/users');

      const createRoute = providers.find((c) => c.contractId === 'http::POST::/api/v2/users');
      expect(createRoute).toBeDefined();

      const getByIdRoute = providers.find(
        (c) => c.contractId === 'http::GET::/api/v2/users/{param}',
      );
      expect(getByIdRoute).toBeDefined();
    });

    // ─── #1834 — Spring named annotation arguments ──────────────────
    // Spring annotations accept both positional shorthand
    // (`@GetMapping("/users")`) and named arguments
    // (`@GetMapping(value = "/users")` or `@GetMapping(path = "/users")`).
    // The two AST shapes produced by tree-sitter-java differ:
    //   @GetMapping("/users")          → annotation_argument_list > string_literal
    //   @GetMapping(value = "/users")  → annotation_argument_list > element_value_pair
    // The named-arg pattern in `http-patterns/java.ts` MUST constrain
    // the `key` field to `path`/`value`; without that constraint the
    // query also captures other string-valued attributes such as
    // `produces`, `consumes`, `headers`, `name`, `params` (see PR #1834
    // review). The tests below pin both the positive cases and the
    // negative anti-regression cases.
    it('extracts Spring class-level @RequestMapping(path = "/api")', async () => {
      const dir = path.join(tmpDir, 'spring-class-named-path');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api/v3")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v3/users');
      expect(route).toBeDefined();
      expect(route!.meta.path).toBe('/api/v3/users');
    });

    it('extracts Spring class-level @RequestMapping(value = "/api")', async () => {
      const dir = path.join(tmpDir, 'spring-class-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/OrderController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(value = "/orders")
public class OrderController {
    @GetMapping("/list")
    public List<Order> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/orders/list');
      expect(route).toBeDefined();
    });

    it('extracts Spring method-level @GetMapping(value = "/users") (named value)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    it('extracts Spring method-level @GetMapping(path = "/users") (named path)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-path-get');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(path = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    it('extracts Spring method-level @PostMapping(path = "/users") (named path)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-path-post');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @PostMapping(path = "/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::POST::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('create');
    });

    it('combines class named-arg prefix with method positional path', async () => {
      const dir = path.join(tmpDir, 'spring-mixed-class-named-method-pos');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();
    });

    it('combines class positional prefix with method named-arg path', async () => {
      const dir = path.join(tmpDir, 'spring-mixed-class-pos-method-named');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping(value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();
    });

    it('does NOT emit a provider for @GetMapping(produces = ...) without path/value', async () => {
      // Anti-regression: without the `key:` constraint, the named-arg
      // query would capture `produces = "application/json"` and emit
      // a bogus `http::GET::/application/json` contract.
      const dir = path.join(tmpDir, 'spring-produces-only');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/MisleadingController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class MisleadingController {
    @GetMapping(produces = "application/json")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      // No GET provider should be emitted for this method — the only
      // string literal in the annotation is a non-route attribute.
      expect(
        providers.find((c) => c.contractId === 'http::GET::/application/json'),
      ).toBeUndefined();
      // And the controller has no other route, so providers list for
      // this file should be empty.
      const fromThisFile = providers.filter((c) =>
        c.symbolRef.filePath.endsWith('MisleadingController.java'),
      );
      expect(fromThisFile).toHaveLength(0);
    });

    it('emits exactly one provider for @GetMapping(name = "...", value = "/users")', async () => {
      // Anti-regression: without the `key:` constraint, the named-arg
      // query would capture both string literals and emit two
      // contracts (`/listUsers` + `/users`). With the constraint, only
      // `/users` is emitted.
      const dir = path.join(tmpDir, 'spring-name-and-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(name = "listUsers", value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const usersRoute = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(usersRoute).toBeDefined();
      expect(usersRoute!.symbolName).toBe('list');

      // The non-route `name` attribute must NOT produce a route.
      expect(providers.find((c) => c.contractId === 'http::GET::/listUsers')).toBeUndefined();

      const fromThisFile = providers.filter((c) =>
        c.symbolRef.filePath.endsWith('UserController.java'),
      );
      expect(fromThisFile).toHaveLength(1);
    });

    it('uses `path` (not non-route key) as class prefix when both appear', async () => {
      // Anti-regression: without the `key:` constraint, the LAST
      // element_value_pair in the annotation wins because
      // prefixByClassId.set is called per match, in document order. So
      // `@RequestMapping(path = "/api", name = "myApi")` would mistakenly
      // set the prefix to `myApi`. With the constraint, only the
      // `path`/`value` pair is captured and the prefix stays `/api`.
      const dir = path.join(tmpDir, 'spring-class-prefix-last-wins');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api", name = "myApi")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();

      // Must NOT have used `myApi` as the class prefix.
      expect(providers.find((c) => c.contractId === 'http::GET::/myApi/users')).toBeUndefined();
    });

    // ─── #1834 follow-up — Spring on Kotlin ──────────────────────────
    // The same positional / named-argument distinction applies to
    // Kotlin Spring Boot controllers. The Kotlin tree-sitter grammar
    // (fwcd/tree-sitter-kotlin) produces a different AST shape than
    // tree-sitter-java — both forms share `value_argument`, with the
    // optional leading `simple_identifier "="` distinguishing named
    // from positional. The plugin in `http-patterns/kotlin.ts` mirrors
    // the safety bar from java.ts: positional uses `.` to anchor the
    // string_literal as the first named child of `value_argument`,
    // and the named pattern restricts the `simple_identifier` key to
    // `^(path|value)$` to avoid capturing `produces`, `consumes`,
    // `headers`, `name`, `params`, etc.
    //
    // tree-sitter-kotlin is an optionalDependency. If the binding is
    // unavailable in the current test environment, `getPluginForFile`
    // returns undefined for `.kt` files and we skip the suite.
    const kotlinAvailable = getPluginForFile('Probe.kt') !== undefined;
    const itKotlin = kotlinAvailable ? it : it.skip;

    itKotlin('extracts Kotlin @RequestMapping("/api/v1") (positional class prefix)', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-class-positional');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v1/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
      expect(route!.meta.framework).toBe('spring');
    });

    itKotlin('extracts Kotlin @RequestMapping(path = "/api/v2") (named class prefix)', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-class-named-path');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api/v2")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(route).toBeDefined();
    });

    itKotlin(
      'extracts Kotlin @RequestMapping(value = "/orders") (named class prefix)',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-spring-class-named-value');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/OrderController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(value = "/orders")
class OrderController {
  @GetMapping("/list") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(providers.find((c) => c.contractId === 'http::GET::/orders/list')).toBeDefined();
      },
    );

    itKotlin('extracts Kotlin method-level @GetMapping(value = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(value = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    itKotlin('extracts Kotlin method-level @GetMapping(path = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-path-get');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(path = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
    });

    itKotlin('extracts Kotlin method-level @PostMapping(path = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-path-post');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @PostMapping(path = "/users") fun create() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::POST::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('create');
    });

    itKotlin('combines Kotlin class named-arg prefix with method positional path', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-mixed-class-named-method-pos');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
    });

    itKotlin('combines Kotlin class positional prefix with method named-arg path', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-mixed-class-pos-method-named');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class UserController {
  @GetMapping(value = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
    });

    itKotlin(
      'does NOT emit a Kotlin provider for @GetMapping(produces = ...) without path/value',
      async () => {
        // Anti-regression: without the `simple_identifier` key
        // constraint, the named-arg query would capture
        // `produces = "application/json"` and emit a bogus
        // `http::GET::/application/json` contract.
        const dir = path.join(tmpDir, 'kotlin-spring-produces-only');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/MisleadingController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class MisleadingController {
  @GetMapping(produces = "application/json") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          providers.find((c) => c.contractId === 'http::GET::/application/json'),
        ).toBeUndefined();
        const fromThisFile = providers.filter((c) =>
          c.symbolRef.filePath.endsWith('MisleadingController.kt'),
        );
        expect(fromThisFile).toHaveLength(0);
      },
    );

    itKotlin(
      'emits exactly one Kotlin provider for @GetMapping(name = "...", value = "/users")',
      async () => {
        // Anti-regression: without the key constraint, both string
        // literals would be captured as method paths, emitting two
        // contracts (`/listUsers` + `/users`).
        const dir = path.join(tmpDir, 'kotlin-spring-name-and-value');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/UserController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(name = "listUsers", value = "/users") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        const usersRoute = providers.find((c) => c.contractId === 'http::GET::/users');
        expect(usersRoute).toBeDefined();
        expect(usersRoute!.symbolName).toBe('list');

        expect(providers.find((c) => c.contractId === 'http::GET::/listUsers')).toBeUndefined();

        const fromThisFile = providers.filter((c) =>
          c.symbolRef.filePath.endsWith('UserController.kt'),
        );
        expect(fromThisFile).toHaveLength(1);
      },
    );

    itKotlin(
      'uses Kotlin `path` (not non-route key) as class prefix when both appear',
      async () => {
        // Anti-regression: without the key constraint, the LAST captured
        // value_argument would win in the prefix map. Here `name = "myApi"`
        // appears after `path = "/api"` — the prefix must remain `/api`.
        const dir = path.join(tmpDir, 'kotlin-spring-class-prefix-key-wins');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/UserController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api", name = "myApi")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/myApi/users')).toBeUndefined();
      },
    );

    it('extracts Express router.get patterns', async () => {
      const dir = path.join(tmpDir, 'express');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `
import { Router } from 'express';
const router = Router();

router.get('/api/users', async (req, res) => { res.json([]); });
router.post('/api/users', async (req, res) => { res.json({}); });
router.delete('/api/users/:id', async (req, res) => { res.sendStatus(204); });

export default router;
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
      expect(
        providers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('dedupes source-only providers by contract id', async () => {
      const dir = path.join(tmpDir, 'source-only-same-contract-id');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/health-a.ts'),
        `
router.get('/api/health', healthA);
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/routes/health-b.ts'),
        `
router.get('/api/health', healthB);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.contractId === 'http::GET::/api/health');

      expect(providers).toHaveLength(1);
      expect(providers[0].role).toBe('provider');
      expect(providers[0].meta.extractionStrategy).toBe('source_scan');
    });

    it('extracts Go Gin and Echo route registrations', async () => {
      const dir = path.join(tmpDir, 'go-frameworks');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'server.go'),
        `
package main

func createOrder(c *gin.Context) {}
func listOrders(c echo.Context) error { return nil }

func main() {
  r := gin.Default()
  r.POST("/api/orders/:id", createOrder)

  e := echo.New()
  e.GET("/api/orders", listOrders)
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const ginRoute = providers.find((c) => c.contractId === 'http::POST::/api/orders/{param}');
      expect(ginRoute).toBeDefined();
      expect(ginRoute?.symbolName).toBe('createOrder');

      const echoRoute = providers.find((c) => c.contractId === 'http::GET::/api/orders');
      expect(echoRoute).toBeDefined();
      expect(echoRoute?.symbolName).toBe('listOrders');
    });

    it('extracts stdlib HandleFunc providers', async () => {
      const dir = path.join(tmpDir, 'go-stdlib-provider');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'server.go'),
        `
package main

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const healthRoute = providers.find((c) => c.contractId === 'http::GET::/api/health');
      expect(healthRoute).toBeDefined();
      expect(healthRoute?.symbolName).toBe('healthHandler');
    });

    it('extracts NestJS controller decorators', async () => {
      const dir = path.join(tmpDir, 'nestjs');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'orders.controller.ts'),
        `
import { Controller, Patch } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Patch(':id')
  updateOrder() {
    return {};
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const patchRoute = providers.find((c) => c.contractId === 'http::PATCH::/orders/{param}');
      expect(patchRoute).toBeDefined();
      expect(patchRoute?.symbolName).toBe('updateOrder');
    });
  });

  describe('consumer extraction — fetch patterns', () => {
    it('extracts fetch() calls', async () => {
      const dir = path.join(tmpDir, 'frontend');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api/users.ts'),
        `
export async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function createUser(data: any) {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  return res.json();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(2);
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
    });

    it('extracts axios calls', async () => {
      const dir = path.join(tmpDir, 'axios-fe');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api.ts'),
        `
import axios from 'axios';
export const getUsers = () => axios.get('/api/users');
export const deleteUser = (id: string) => axios.delete(\`/api/users/\${id}\`);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('extracts jQuery $.get and $.post shorthand', async () => {
      const dir = path.join(tmpDir, 'jquery-shorthand');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/users.js'),
        `
function loadUsers() {
  $.get('/api/users', function (data) { console.log(data); });
}

function createUser(payload) {
  $.post('/api/users', payload);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const getRoute = consumers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(getRoute).toBeDefined();
      expect(getRoute?.meta.framework).toBe('jquery');

      const postRoute = consumers.find((c) => c.contractId === 'http::POST::/api/users');
      expect(postRoute).toBeDefined();
      expect(postRoute?.meta.framework).toBe('jquery');
    });

    it('extracts jQuery $.ajax with method: and type: keys and default GET', async () => {
      const dir = path.join(tmpDir, 'jquery-ajax');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/orders.js'),
        `
$.ajax({ url: '/api/orders', method: 'PUT', data: {} });
$.ajax({ url: '/api/items',  type:   'DELETE' });
$.ajax({ url: '/api/default' });

function reloadOrder(id) {
  return $.ajax({ url: \`/api/orders/\${id}\`, method: 'GET' });
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::DELETE::/api/items')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/default')).toBeDefined();
      // Template-literal URL inside $.ajax is normalized to {param} the same
      // way the fetch/axios paths do — confirms readStringProp accepts
      // template_string values for jQuery ajax, not just for axios object form.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('extracts axios({ method, url }) object form regardless of key order', async () => {
      const dir = path.join(tmpDir, 'axios-object');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/orders.ts'),
        `
import axios from 'axios';

export function createOrder(data: unknown) {
  return axios({ method: 'POST', url: '/api/orders', data });
}

export function updateUser(id: string, data: unknown) {
  return axios({ url: \`/api/users/\${id}\`, method: 'PUT', data });
}

export function listDefaults() {
  return axios({ url: '/api/defaults' });
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/users/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/defaults')).toBeDefined();
    });

    it('does not emit consumers for unrelated object-literal calls (negative control)', async () => {
      const dir = path.join(tmpDir, 'jquery-axios-negative');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/misc.js'),
        `
// jQuery but not an ajax/get/post call
$.fn.extend({ url: '/nope', method: 'POST' });
$.each([1, 2, 3], function (i, v) { return v; });

// Not axios and not $ — unrelated helper that happens to take { url, method }
function myHelper(opts) { return opts; }
myHelper({ url: '/nope', method: 'POST' });

// Bare object literal, not a call argument at all
const cfg = { url: '/nope', method: 'POST' };
console.log(cfg);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // None of the above should have produced any HTTP consumer contracts.
      const nopeConsumers = consumers.filter(
        (c) => typeof c.meta.path === 'string' && c.meta.path.includes('/nope'),
      );
      expect(nopeConsumers).toHaveLength(0);
    });

    it('extracts Python requests calls', async () => {
      const dir = path.join(tmpDir, 'python-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'client.py'),
        `
import requests

def create_order():
    return requests.post("https://svc.local/api/orders/42", json={"id": 42})
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
    });
    it('extracts Python httpx.AsyncClient calls assigned to attributes or aliases', async () => {
      const dir = path.join(tmpDir, 'python-httpx-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'client.py'),
        `
import httpx
import httpx as hx
from httpx import AsyncClient
from httpx import AsyncClient as HttpxAsyncClient

# Dotted-package look-alikes — must NOT be detected as httpx.
import my_pkg.httpx as evil_mod
from my_pkg.httpx import AsyncClient as evil_async
# Longer dotted path — must also NOT be detected.
import a.b.c.httpx as deep_evil
from a.b.c.httpx import AsyncClient as deep_evil_async
# Relative import — module_name is a relative_import node, not dotted_name, so
# it must not produce a contract either.
from .httpx import AsyncClient as rel_evil_async

module_client = httpx.AsyncClient(base_url="https://svc.local")
module_alias_client = hx.AsyncClient(base_url="https://svc.local")
module_direct_client = AsyncClient(base_url="https://svc.local")
module_renamed_client = HttpxAsyncClient(base_url="https://svc.local")
evil_mod_client = evil_mod.AsyncClient(base_url="https://svc.local")
evil_direct_client = evil_async(base_url="https://svc.local")
deep_evil_mod_client = deep_evil.AsyncClient(base_url="https://svc.local")
deep_evil_direct_client = deep_evil_async(base_url="https://svc.local")
rel_evil_direct_client = rel_evil_async(base_url="https://svc.local")

class TopicClient:
    def __init__(self):
        self._client = httpx.AsyncClient(base_url="https://svc.local")

    async def list_topics(self):
        return await self._client.get("/topic")

    async def publish(self):
        return await self._client.request("POST", "/questions/import")

    async def delete_topic(self):
        return await self._client.delete("/topic")

async def check_duplicate():
    async with httpx.AsyncClient() as client:
        data = {}
        data.get("/nope")
        service.request("POST", "/nope")
        return await client.post("https://svc.local/questions/duplicate-check")

async def import_aliases():
    local_alias_client = hx.AsyncClient(base_url="https://svc.local")
    local_direct_client = AsyncClient(base_url="https://svc.local")
    local_renamed_client = HttpxAsyncClient(base_url="https://svc.local")
    await local_alias_client.get("/alias-topic")
    await local_direct_client.patch("/direct-topic")
    await local_renamed_client.request("PUT", "/renamed-topic")
    async with hx.AsyncClient() as alias_context:
        await alias_context.delete("/alias-context")
    async with AsyncClient() as direct_context:
        return await direct_context.post("/direct-context")

def unrelated_scope_collision():
    client = acquire_cache_client()
    return client.get("/ignored-same-name")

def module_scope_shadow_collision():
    client = acquire_cache_client()
    return client.get("/ignored-module-same-name")

def shadow_direct_alias():
    AsyncClient = lambda: FakeClient()
    client = AsyncClient()
    return client.get("/shadow-direct-fp")

def shadow_module_alias():
    hx = FakeMod()
    client = hx.AsyncClient()
    return client.get("/shadow-module-fp")

async def shadow_direct_context():
    AsyncClient = lambda: FakeClient()
    async with AsyncClient() as client:
        return await client.get("/shadow-direct-context-fp")

def shadow_tuple_destructure():
    AsyncClient, _other = (lambda: FakeClient()), 42
    client = AsyncClient()
    return client.get("/shadow-tuple-fp")

# Class-body assignment of an imported alias is a class attribute under Python
# LEGB rules — methods inside still see the module binding. The detector must
# NOT poison the methods, so the legitimate httpx call below should still emit.
class ClassBodyRebindHolder:
    AsyncClient = lambda: FakeClient()

    def __init__(self):
        self._client = httpx.AsyncClient(base_url="https://svc.local")

    async def fetch(self):
        return await self._client.get("/class-body-rebind-ok")

module_client.get("/module-topic")
module_alias_client.get("/module-alias-topic")
module_direct_client.get("/module-direct-topic")
module_renamed_client.get("/module-renamed-topic")
evil_mod_client.get("/evil-module-dotted-fp")
evil_direct_client.get("/evil-direct-dotted-fp")
deep_evil_mod_client.get("/deep-evil-module-dotted-fp")
deep_evil_direct_client.get("/deep-evil-direct-dotted-fp")
rel_evil_direct_client.get("/rel-evil-direct-fp")
`,
      );

      // Isolated file for module-level rebind: shadowing applies file-wide, so
      // it must not affect the assertions in client.py above.
      fs.writeFileSync(
        path.join(dir, 'src', 'module_rebind.py'),
        `
from httpx import AsyncClient

# Module-level rebind: the rest of this file's bare AsyncClient calls must NOT
# emit httpx consumer contracts.
AsyncClient = lambda: FakeClient()

shadowed_module_client = AsyncClient(base_url="https://svc.local")
shadowed_module_client.get("/module-level-rebind-fp")
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const expected = [
        'http::GET::/topic',
        'http::POST::/questions/import',
        'http::DELETE::/topic',
        'http::POST::/questions/duplicate-check',
        'http::GET::/alias-topic',
        'http::PATCH::/direct-topic',
        'http::PUT::/renamed-topic',
        'http::DELETE::/alias-context',
        'http::POST::/direct-context',
        'http::GET::/module-topic',
        'http::GET::/module-alias-topic',
        'http::GET::/module-direct-topic',
        'http::GET::/module-renamed-topic',
        // Class-body rebind of `AsyncClient` is a class attribute, not a
        // method-scope shadow — the legitimate httpx.AsyncClient call inside
        // the class must still emit.
        'http::GET::/class-body-rebind-ok',
      ];

      for (const contractId of expected) {
        const consumer = consumers.find((c) => c.contractId === contractId);
        expect(consumer).toBeDefined();
        expect(consumer?.meta.framework).toBe('python-httpx');
      }

      // Positive control: the legitimate `module_direct_client = AsyncClient(...)`
      // path was actually exercised, so the negative dotted-package assertions
      // below are not passing vacuously.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/module-direct-topic'),
      ).toBeDefined();

      expect(consumers.find((c) => c.contractId === 'http::GET::/nope')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/nope')).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/ignored-same-name'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/ignored-module-same-name'),
      ).toBeUndefined();
      // Finding 1: dotted-package look-alikes (`my_pkg.httpx`, three-segment
      // `a.b.c.httpx`, and relative `.httpx`) must not be detected.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/evil-module-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/evil-direct-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/deep-evil-module-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/deep-evil-direct-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/rel-evil-direct-fp'),
      ).toBeUndefined();
      // Finding 2: locally rebound imported aliases must not be detected.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-direct-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-module-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-direct-context-fp'),
      ).toBeUndefined();
      // Tuple/list destructuring rebinds must also shadow the alias.
      expect(consumers.find((c) => c.contractId === 'http::GET::/shadow-tuple-fp')).toBeUndefined();
      // Module-level rebind in a separate file must shadow the whole file.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/module-level-rebind-fp'),
      ).toBeUndefined();
    });

    it('extracts Java Spring RestTemplate, WebClient and OkHttp literal calls', async () => {
      const dir = path.join(tmpDir, 'java-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ApiClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import okhttp3.Request;

class ApiClient {
  void run(RestTemplate restTemplate, WebClient webClient) {
    restTemplate.getForObject("/api/users/{id}", String.class, 42);
    restTemplate.exchange("/api/users/{id}/details", HttpMethod.GET, null, String.class);
    webClient.post().uri("/api/users");
    new Request.Builder().url("/api/orders/42").build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}/details'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/users/{param}/details' &&
            c.meta.framework === 'spring-rest-template' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/users' &&
            c.meta.framework === 'spring-web-client' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
    });

    it('does NOT match Java WebClient long-form method(HttpMethod).uri(...) yet', async () => {
      const dir = path.join(tmpDir, 'java-web-client-long-form');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'LongFormClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class LongFormClient {
  void run(WebClient webClient) {
    webClient.method(HttpMethod.PATCH).uri("/api/users/42").retrieve();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/users/{param}'),
      ).toBeUndefined();
    });

    it('extracts OpenFeign clients as consumers, not providers', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OrderClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "order-service", url = "\${order.service.url}", path = "/api")
interface OrderClient {
  @GetMapping("/orders/{id}")
  OrderDto getOrder(@PathVariable("id") String id);

  @PostMapping(path = "/orders")
  OrderDto createOrder(OrderDto body);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/orders' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        providers.find((c) => c.symbolRef.filePath.endsWith('OrderClient.java')),
      ).toBeUndefined();
    });

    it('extracts OpenFeign clients without an interface path prefix', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-no-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HealthClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "health-service")
interface HealthClient {
  @GetMapping("/health")
  String health();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/health' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        providers.find((c) => c.symbolRef.filePath.endsWith('HealthClient.java')),
      ).toBeUndefined();
    });

    it('does not treat @FeignClient text in an interface body as a Feign annotation', async () => {
      const dir = path.join(tmpDir, 'java-non-feign-interface-text');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'NotFeignClient.java'),
        `
import org.springframework.web.bind.annotation.GetMapping;

interface NotFeignClient {
  String MARKER = "@FeignClient";

  @GetMapping("/not-feign")
  String call();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(consumers.find((c) => c.contractId === 'http::GET::/not-feign')).toBeUndefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/not-feign')).toBeDefined();
    });

    it('extracts OpenFeign clients with @RequestMapping interface prefixes', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-request-mapping-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'InventoryClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "inventory-service")
@RequestMapping(path = "/api")
interface InventoryClient {
  @GetMapping("/inventory/{id}")
  InventoryDto getInventory(String id);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/inventory/{param}' &&
            c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
    });

    it('prefers @FeignClient(path=...) over @RequestMapping prefixes on OpenFeign clients', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-prefix-precedence');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'PrecedenceClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "order-service", path = "/feign-path")
@RequestMapping("/rm-path")
interface PrecedenceClient {
  @GetMapping("/orders")
  OrderDto getOrders();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders')).toBeUndefined();
    });

    it('extracts Java and Apache HttpClient literal request construction', async () => {
      const dir = path.join(tmpDir, 'java-http-client-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HttpClients.java'),
        `
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.methods.HttpPut;
import org.apache.http.client.methods.HttpDelete;
import org.apache.http.client.methods.HttpPatch;

class HttpClients {
  void run(HttpClient client) throws Exception {
    HttpRequest get = HttpRequest.newBuilder()
        .uri(URI.create("/api/users/1"))
        .GET()
        .build();
    HttpRequest post = HttpRequest.newBuilder()
        .uri(URI.create("/api/users"))
        .POST(HttpRequest.BodyPublishers.ofString("{}"))
        .build();

    new HttpGet("/api/orders/2");
    new HttpPost("/api/orders");
    new HttpPut("/api/orders/3");
    new HttpDelete("/api/orders/4");
    new HttpPatch("/api/orders/5");
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/users' &&
            c.meta.framework === 'java-http-client' &&
            c.confidence === 0.65,
        ),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/orders' &&
            c.meta.framework === 'apache-http-client' &&
            c.confidence === 0.65,
        ),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/orders/{param}'),
      ).toBeDefined();
    });

    // ─── Kotlin consumers (RestTemplate / WebClient short / OkHttp) ──
    // Same shape as the Java consumer test above, but parsed by the
    // tree-sitter-kotlin grammar via `KOTLIN_HTTP_PLUGIN`. Three
    // consumer flavors covered here (long-form WebClient
    // `webClient.method(HttpMethod.X).uri(...)` is intentionally
    // deferred to a follow-up — see kotlin.ts file header).
    //
    // tree-sitter-kotlin is an optionalDependency. If the binding is
    // unavailable, `getPluginForFile` returns undefined for `.kt` and
    // we skip the suite (matches the gating on the Provider tests).
    const kotlinConsumerAvailable = getPluginForFile('Probe.kt') !== undefined;
    const itKotlinConsumer = kotlinConsumerAvailable ? it : it.skip;

    itKotlinConsumer('extracts Kotlin RestTemplate verbs', async () => {
      const dir = path.join(tmpDir, 'kotlin-rest-template');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ApiClient.kt'),
        `package com.example
import org.springframework.web.client.RestTemplate

class ApiClient(private val restTemplate: RestTemplate) {
  fun run() {
    restTemplate.getForObject("/api/users/1", User::class.java)
    restTemplate.getForEntity("/api/users/2", User::class.java)
    restTemplate.postForObject("/api/users", body, User::class.java)
    restTemplate.postForEntity("/api/users", body, User::class.java)
    restTemplate.put("/api/users/3", body)
    restTemplate.delete("/api/users/4")
    restTemplate.patchForObject("/api/users/5", body, User::class.java)
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/users/{param}'),
      ).toBeDefined();

      // Framework label must be the same `spring-rest-template` used
      // by the Java plugin so polyglot repos coalesce on a single key.
      const restConsumers = consumers.filter((c) => c.meta.framework === 'spring-rest-template');
      expect(restConsumers.length).toBeGreaterThanOrEqual(5);
    });

    itKotlinConsumer('extracts Kotlin WebClient short-form verbs', async () => {
      const dir = path.join(tmpDir, 'kotlin-web-client-short');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OrderClient.kt'),
        `package com.example
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import org.springframework.web.reactive.function.client.awaitBodilessEntity

class OrderClient(private val webClient: WebClient) {
  suspend fun run() {
    val r1 = webClient.get().uri("/api/orders/1").retrieve().awaitBody<Order>()
    val r2 = webClient.post().uri("/api/orders").retrieve().awaitBody<Order>()
    val r3 = webClient.put().uri("/api/orders/2").retrieve().awaitBody<Order>()
    val r4 = webClient.delete().uri("/api/orders/3").retrieve().awaitBodilessEntity()
    val r5 = webClient.patch().uri("/api/orders/4").retrieve().awaitBody<Order>()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/orders/{param}'),
      ).toBeDefined();

      const wcConsumers = consumers.filter((c) => c.meta.framework === 'spring-web-client');
      expect(wcConsumers.length).toBeGreaterThanOrEqual(5);
    });

    itKotlinConsumer('extracts Kotlin OkHttp Request.Builder().url(...)', async () => {
      const dir = path.join(tmpDir, 'kotlin-okhttp');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OkClient.kt'),
        `package com.example
import okhttp3.OkHttpClient
import okhttp3.Request

class OkClient(private val client: OkHttpClient) {
  fun fetch() {
    val req = Request.Builder().url("/api/items").build()
    val resp = client.newCall(req).execute()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const okConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/items');
      expect(okConsumer).toBeDefined();
      expect(okConsumer!.meta.framework).toBe('okhttp');
    });

    itKotlinConsumer(
      'OkHttp Request.Builder().url("/x").post(body) — verb defaults to GET (Java parity)',
      async () => {
        // Anti-overreach / known-limitation pin: OkHttp encodes the
        // HTTP verb on a sibling call (`.post(body)` / `.delete()` /
        // ...), not on `.url(...)`. The query at `kotlin.ts:OK_HTTP_PATTERNS`
        // intentionally does not walk the chain to recover the verb —
        // it emits `method: 'GET'` for every match, mirroring the Java
        // plugin's `OK_HTTP_PATTERNS` (java.ts).
        //
        // This test pins the accepted behavior so a future verb-walk
        // implementation must update kotlin.ts's known-limitation
        // comment in lockstep. Concretely:
        //   - `Request.Builder().url("/api/users").post(body).build()`
        //     → ONE consumer: `http::GET::/api/users` (heuristic-default)
        //     → NO `http::POST::/api/users` consumer
        //
        // Test signal:
        //   - if this becomes correct (POST detected) without updating
        //     the kotlin.ts comment + java.ts behavior together, this
        //     test goes red and the reviewer must reconcile both sides.
        const dir = path.join(tmpDir, 'kotlin-okhttp-post-chain');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OkPostClient.kt'),
          `package com.example
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody

class OkPostClient(private val client: OkHttpClient, private val body: RequestBody) {
  fun create() {
    val req = Request.Builder().url("/api/users").post(body).build()
    client.newCall(req).execute()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        const fromThisFile = consumers.filter((c) =>
          c.symbolRef.filePath.endsWith('OkPostClient.kt'),
        );

        // Heuristic-default GET: exactly one consumer is emitted for
        // the .url("/x") capture, with method=GET regardless of the
        // sibling .post(body) call.
        expect(fromThisFile).toHaveLength(1);
        expect(fromThisFile[0].contractId).toBe('http::GET::/api/users');
        expect(fromThisFile[0].meta.method).toBe('GET');

        // Anti-overreach: no second contract with POST should appear.
        // If a future verb-walk lands and this assertion needs to flip
        // (i.e. POST is now detected), bump kotlin.ts's known-limitation
        // comment and java.ts in the same PR.
        expect(fromThisFile.find((c) => c.contractId === 'http::POST::/api/users')).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'does NOT match Kotlin WebClient long form (deferred to follow-up)',
      async () => {
        // Anti-overreach: confirm the short-form query does NOT
        // accidentally fire on the long-form chain
        // `webClient.method(HttpMethod.GET).uri(...)`. The long form
        // is intentionally unsupported in this PR; if a future change
        // to the short-form query starts capturing it we want a loud
        // signal here. Long-form support will arrive in a follow-up
        // with a dedicated query + verb walk-up helper.
        const dir = path.join(tmpDir, 'kotlin-web-client-long');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'LegacyClient.kt'),
          `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

class LegacyClient(private val webClient: WebClient) {
  suspend fun run() {
    val r = webClient.method(HttpMethod.GET).uri("/api/legacy").retrieve().awaitBody<String>()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // No consumer should be emitted from this file by the
        // current short-form query. Documented as a known limitation.
        const fromLegacy = consumers.filter((c) =>
          c.symbolRef.filePath.endsWith('LegacyClient.kt'),
        );
        expect(fromLegacy).toHaveLength(0);
      },
    );

    itKotlinConsumer(
      'does NOT pick up unrelated string-literal calls on a non-restTemplate receiver',
      async () => {
        // Anti-regression: the RestTemplate receiver constraint
        // (#eq? @obj "restTemplate") must hold. A field with a
        // different conventional name (e.g. `cacheClient`) calling
        // `.getForObject("/x", ...)` should NOT produce a route.
        const dir = path.join(tmpDir, 'kotlin-rest-template-other-receiver');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'CacheClient.kt'),
          `package com.example

class CacheClient(private val cacheClient: SomeCache) {
  fun run() {
    cacheClient.getForObject("/cache/key", String::class.java)
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(consumers.find((c) => c.contractId === 'http::GET::/cache/key')).toBeUndefined();
        const fromCache = consumers.filter((c) => c.symbolRef.filePath.endsWith('CacheClient.kt'));
        expect(fromCache).toHaveLength(0);
      },
    );

    it('extracts Go stdlib and resty calls', async () => {
      const dir = path.join(tmpDir, 'go-consumer');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'client.go'),
        `
package main

import (
  "net/http"

  "github.com/go-resty/resty/v2"
)

func main() {
  http.Get("/api/health")
  client := resty.New()
  client.R().Delete("/api/orders/42")
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/health')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
    });
  });

  describe('provider extraction — Laravel', () => {
    it('extracts Laravel Route::get patterns', async () => {
      const dir = path.join(tmpDir, 'laravel');
      fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routes/api.php'),
        `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::DELETE::/users/{param}')).toBeDefined();
    });
  });

  describe('consumer extraction — PHP', () => {
    it('extracts Laravel Http facade calls', async () => {
      const dir = path.join(tmpDir, 'php-http-facade');
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/Client.php'),
        `<?php
use Illuminate\\Support\\Facades\\Http;

class Client {
    public function run() {
        Http::get('/api/users');
        Http::post('/api/orders/42');
        Http::delete('/api/users/7');
    }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('extracts Guzzle $client->method() calls', async () => {
      const dir = path.join(tmpDir, 'php-guzzle');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/ApiClient.php'),
        `<?php
use GuzzleHttp\\Client;

class ApiClient {
    public function run(Client $client) {
        $client->get('/api/health');
        $client->post('/api/orders/42');
    }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/health')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('extracts file_get_contents HTTP calls', async () => {
      const dir = path.join(tmpDir, 'php-fgc');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/fetch.php'),
        `<?php
function fetchRemote() {
    $data = file_get_contents('https://example.test/api/items/1');
    $local = file_get_contents('/tmp/local-file.txt');
    return $data;
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/items/{param}')).toBeDefined();
      // file paths and stream wrappers must not emit consumer contracts
      expect(consumers.find((c) => c.meta.path === '/tmp/local-file.txt')).toBeUndefined();
    });
  });

  describe('provider extraction — FastAPI', () => {
    it('extracts FastAPI @app.get decorator patterns', async () => {
      const dir = path.join(tmpDir, 'fastapi');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users():
    return []

@app.post("/users")
async def create_user(user: UserCreate):
    return user
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(2);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
    });

    it('joins FastAPI @router.<verb> path with include_router(prefix=...) from main.py (attribute shape)', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-attr');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
from api import assistant
app = FastAPI()
app.include_router(assistant.router, prefix='/ai', tags=['ai'])
`,
      );
      fs.writeFileSync(
        path.join(dir, 'api/assistant.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.post("/assistant")
async def assistant(req):
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::POST::/ai/assistant')).toBeDefined();
      // bare unprefixed form should not be emitted when a prefix mapping exists
      expect(providers.find((c) => c.contractId === 'http::POST::/assistant')).toBeUndefined();
    });

    it('joins FastAPI @router.<verb> path with include_router(prefix=...) (named-import shape)', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-named');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
from api.predict import router as predict_router
app = FastAPI()
app.include_router(predict_router, prefix='/ai')
`,
      );
      fs.writeFileSync(
        path.join(dir, 'api/predict.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/concurrent")
async def concurrent():
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/ai/concurrent')).toBeDefined();
    });

    it('emits @router.<verb> path unmodified when no include_router prefix is configured', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-no-prefix');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.py'), `app = None\n`);
      fs.writeFileSync(
        path.join(dir, 'api/loose.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/standalone")
async def standalone():
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.find((c) => c.contractId === 'http::GET::/standalone')).toBeDefined();
    });
  });

  describe('consumer extraction — graph-first (Strategy A)', () => {
    it('extracts consumers from FETCHES graph edges', async () => {
      const dir = path.join(tmpDir, 'graph-consumers');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/api.ts'), 'export const api = {};');

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) return [];
        if (query.includes('FETCHES')) {
          return [
            {
              fileId: 'file-uid-api',
              filePath: 'src/api.ts',
              routePath: '/api/users',
              routeId: 'route-uid-users',
              fetchReason: 'fetch-url-match',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-fn-fetch',
              name: 'fetchUsers',
              filePath: 'src/api.ts',
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].confidence).toBe(0.9);
      expect(consumers[0].symbolName).toBe('fetchUsers');
    });

    it('supplements graph consumers with source-scan consumers from other files', async () => {
      const dir = path.join(tmpDir, 'graph-source-consumer-union');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/api/graph.ts'), 'export const api = {};');
      fs.writeFileSync(
        path.join(dir, 'src/api/health.ts'),
        `
export async function fetchHealth() {
  const res = await fetch('/api/health');
  return res.json();
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) return [];
        if (query.includes('FETCHES')) {
          return [
            {
              fileId: 'file-uid-api',
              filePath: 'src/api/graph.ts',
              routePath: '/api/users',
              routeId: 'route-uid-users',
              fetchReason: 'fetch-url-match',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-fn-fetch',
              name: 'fetchUsers',
              filePath: 'src/api/graph.ts',
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const graphConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(graphConsumer).toBeDefined();
      expect(graphConsumer?.symbolUid).toBe('uid-fn-fetch');
      expect(graphConsumer?.meta.extractionStrategy).toBe('graph_assisted');

      const sourceConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/health');
      expect(sourceConsumer).toBeDefined();
      expect(sourceConsumer?.meta.extractionStrategy).toBe('source_scan');
    });
  });

  describe('edge cases', () => {
    it('returns empty for repo with no matching files', async () => {
      const dir = path.join(tmpDir, 'empty-repo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# Hello');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts).toHaveLength(0);
    });

    it('handles graph queries that throw gracefully', async () => {
      const dir = path.join(tmpDir, 'graph-error');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/routes.ts'), `router.get('/api/health', handler);`);

      const throwingExecutor = async () => {
        throw new Error('DB unavailable');
      };

      const contracts = await extractor.extract(throwingExecutor, dir, makeRepo(dir));
      // Should fall back to source scan
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('path normalization', () => {
    it('strips trailing slash', async () => {
      const dir = path.join(tmpDir, 'trailing');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
router.get('/api/users/', handler);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const provider = contracts.find((c) => c.role === 'provider');
      expect(provider?.meta.path).toBe('/api/users');
    });

    it('normalizes path params from multiple syntaxes', async () => {
      const dir = path.join(tmpDir, 'params');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
router.get('/api/users/:id', handler1);
router.get('/api/posts/{postId}', handler2);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      contracts.forEach((c) => {
        expect(c.meta.path).not.toContain(':id');
        expect(c.meta.path).not.toContain('{postId}');
        if (typeof c.meta.path === 'string' && c.meta.path.includes('users/')) {
          expect(c.meta.path).toContain('{param}');
        }
      });
    });
  });

  // ─── #1185: contract extractors must honour .gitnexusignore ─────────
  //
  // Pre-#1185 the source-scan path used a hardcoded
  // `[node_modules, .git, dist, build, vendor]` glob ignore array, so a
  // user's `.gitnexusignore` pattern (e.g. a Python venv `mentor_env/`,
  // a generated stubs dir, a noisy fixture tree) was silently scanned
  // anyway. Since #1185 the source-scan path consumes the shared
  // `IgnoreService` (mirrors `filesystem-walker.ts`), so any pattern in
  // `.gitnexusignore` (or `.gitignore`) prunes the glob.
  describe('respects .gitnexusignore (#1185)', () => {
    it('source-scan glob skips files matched by .gitnexusignore', async () => {
      const dir = path.join(tmpDir, 'gitnexusignore-honoured');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'mentor_env/lib'), { recursive: true });
      // Control: a normal route file that SHOULD be discovered.
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `import { Router } from 'express';
const router = Router();
router.get('/api/users', (req, res) => res.json([]));
export default router;
`,
      );
      // Vendored source under a venv-style dir: the same Express
      // pattern, but inside a directory the user wants excluded.
      fs.writeFileSync(
        path.join(dir, 'mentor_env/lib/leaked.ts'),
        `import { Router } from 'express';
const r = Router();
r.get('/api/leaked', (req, res) => res.json([]));
export default r;
`,
      );
      fs.writeFileSync(path.join(dir, '.gitnexusignore'), 'mentor_env/\n');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      // Control survives.
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      // Excluded path is pruned at the glob level — nothing emitted.
      expect(providers.find((c) => c.contractId === 'http::GET::/api/leaked')).toBeUndefined();
      // Defence-in-depth: no contract whose symbolRef is under mentor_env/.
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
    });

    // Pinned by the @claude review on PR #1247: above, only `.gitnexusignore`
    // is exercised. `createIgnoreFilter` reads `.gitignore` too via
    // `loadIgnoreRules`, but that integration is only proven at the
    // `IgnoreService` level — no extractor-level test for the
    // `.gitignore`-only code path. Adding one minimal extractor-level
    // assertion here closes the gap (one shared test is sufficient
    // because all three extractors consume the same filter object).
    it('source-scan glob also skips files matched by `.gitignore` (no `.gitnexusignore`)', async () => {
      const dir = path.join(tmpDir, 'gitignore-honoured');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'mentor_env/lib'), { recursive: true });
      // Same Express pattern as above so detection logic is identical.
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `import { Router } from 'express';
const router = Router();
router.get('/api/users', (req, res) => res.json([]));
export default router;
`,
      );
      fs.writeFileSync(
        path.join(dir, 'mentor_env/lib/leaked.ts'),
        `import { Router } from 'express';
const r = Router();
r.get('/api/leaked', (req, res) => res.json([]));
export default r;
`,
      );
      // Note: NO .gitnexusignore — only `.gitignore`. This proves the
      // `.gitignore` code path inside `createIgnoreFilter` is wired to
      // the extractors' globs.
      fs.writeFileSync(path.join(dir, '.gitignore'), 'mentor_env/\n');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/api/leaked')).toBeUndefined();
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
    });
  });

  describe('Windows SIGSEGV regression — large input must route through parseSourceSafe', () => {
    it('routes >32 767-char source file through parseSourceSafe (not direct parser.parse)', async () => {
      parseSourceSafeSpy.mockClear();

      // >40 000-char Java controller file. Direct parser.parse(content) on
      // an input this size SIGSEGVs the process on Windows. The spy assertion
      // is what catches the regression — a "no throw" assertion alone is
      // satisfied by the bypass on Linux/macOS where parser.parse(40 000 chars)
      // succeeds.
      const padding = Array.from(
        { length: 600 },
        (_, i) => `    public String helper${i}() { return "padding-${i}-aaaaaaaaaaaaaaaaaaa"; }\n`,
      ).join('');
      const largeJava = `package com.example;\n\n@RestController\npublic class BigController {\n${padding}}\n`;
      expect(largeJava.length).toBeGreaterThan(40_000);

      // Use mkdtempSync rather than a fixed subdir name: satisfies CodeQL's
      // js/insecure-temporary-file rule by generating a unique random suffix
      // instead of relying on the parent tmpDir's predictable Date.now() name.
      const dir = fs.mkdtempSync(path.join(tmpDir, 'large-input-'));
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/controller/BigController.java'), largeJava);

      const mockDbExecutor = async (_query: string) => [];
      await extractor.extract(mockDbExecutor, dir, makeRepo(dir));

      expect(parseSourceSafeSpy).toHaveBeenCalled();
    });
  });
});
