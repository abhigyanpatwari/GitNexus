/**
 * Unit test: Java Spring @RequestMapping / @GetMapping route extraction
 * via the dedicated `route-extractors/spring.ts` module.
 *
 * Tests the extractSpringRoutes function directly (no worker pool needed)
 * and validates per-class prefix resolution, multi-class handling, and
 * all HTTP method annotations.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../../../../src/core/ingestion/route-extractors/spring.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

it('compiles Spring queries on first use and reuses them across files', async (t) => {
  const compile = t.mock.method(Parser, 'Query');
  try {
    const spring = await import('../../../../../src/core/ingestion/route-extractors/spring.js');
    assert.equal(compile.mock.callCount(), 0);

    const source = '@RestController class C { @GetMapping("/x") String x() { return ""; } }';
    assert.equal(spring.extractSpringTypes(parse(source), 'C.java').length, 1);
    assert.equal(compile.mock.callCount(), 1);
    for (const file of ['app/C.java', 'test/C.java']) {
      assert.equal(spring.extractSpringRoutes(parse(source), file).length, 1);
      assert.equal(compile.mock.callCount(), 2);
    }
  } finally {
    compile.mock.restore();
  }
});

describe('extractSpringRoutes', () => {
  it('extracts method-level routes with class-level @RequestMapping prefix', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/list")
    public List<User> listUsers() { return null; }

    @PostMapping("/create")
    public User createUser() { return null; }

    @DeleteMapping(path = "/delete")
    public void deleteUser() {}

    @PutMapping(value = "/update")
    public void updateUser() {}

    @PatchMapping("/patch")
    public void patchUser() {}
}
`);

    const routes = extractSpringRoutes(tree, 'UserController.java');
    assert.equal(routes.length, 5);

    const byMethod = new Map(routes.map((r) => [r.httpMethod, r]));

    assert.equal(byMethod.get('GET')!.routePath, '/list');
    assert.equal(byMethod.get('GET')!.prefix, '/api/users');

    assert.equal(byMethod.get('POST')!.routePath, '/create');
    assert.equal(byMethod.get('POST')!.prefix, '/api/users');

    assert.equal(byMethod.get('DELETE')!.routePath, '/delete');
    assert.equal(byMethod.get('DELETE')!.prefix, '/api/users');

    assert.equal(byMethod.get('PUT')!.routePath, '/update');
    assert.equal(byMethod.get('PUT')!.prefix, '/api/users');

    assert.equal(byMethod.get('PATCH')!.routePath, '/patch');
    assert.equal(byMethod.get('PATCH')!.prefix, '/api/users');
  });

  it('emits bare routes when no class-level @RequestMapping exists', () => {
    const tree = parse(`
@RestController
public class HealthController {
    @GetMapping("/health")
    public String health() { return "OK"; }

    @GetMapping("/ready")
    public String ready() { return "OK"; }
}
`);

    const routes = extractSpringRoutes(tree, 'HealthController.java');
    assert.equal(routes.length, 2);
    for (const route of routes) {
      assert.equal(route.prefix, undefined);
    }
    const paths = routes.map((r) => r.routePath).sort();
    assert.deepEqual(paths, ['/health', '/ready']);
  });

  it('does NOT emit class-level @RequestMapping as a standalone Route', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/list")
    public List<User> listUsers() { return null; }
}
`);

    const routes = extractSpringRoutes(tree, 'UserController.java');
    // Only the method-level route, not the class-level prefix
    assert.equal(routes.length, 1);
    assert.equal(routes[0].decoratorName, 'GetMapping');
  });

  it('handles multiple classes in one file with independent prefixes', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/admin")
class AdminController {
    @GetMapping("/dashboard")
    public String dashboard() { return "admin"; }
}

@RestController
@RequestMapping("/api/public")
class PublicController {
    @GetMapping("/info")
    public String info() { return "public"; }
}
`);

    const routes = extractSpringRoutes(tree, 'MultiController.java');
    assert.equal(routes.length, 2);

    const adminRoute = routes.find((r) => r.routePath === '/dashboard');
    assert.notEqual(adminRoute, undefined);
    assert.equal(adminRoute!.prefix, '/api/admin');

    const publicRoute = routes.find((r) => r.routePath === '/info');
    assert.notEqual(publicRoute, undefined);
    assert.equal(publicRoute!.prefix, '/api/public');
  });

  it('supports @PatchMapping (previously missing)', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api")
public class PatchController {
    @PatchMapping("/update")
    public void patch() {}
}
`);

    const routes = extractSpringRoutes(tree, 'PatchController.java');
    assert.equal(routes.length, 1);
    assert.equal(routes[0].httpMethod, 'PATCH');
    assert.equal(routes[0].routePath, '/update');
    assert.equal(routes[0].prefix, '/api');
  });

  it('handles named annotation arguments with path= and value=', () => {
    const tree = parse(`
@RestController
@RequestMapping(value = "/api/v2")
public class V2Controller {
    @GetMapping(path = "/items")
    public String items() { return "[]"; }

    @PostMapping(value = "/items")
    public String createItem() { return "{}"; }
}
`);

    const routes = extractSpringRoutes(tree, 'V2Controller.java');
    assert.equal(routes.length, 2);
    for (const route of routes) {
      assert.equal(route.prefix, '/api/v2');
      assert.equal(route.routePath, '/items');
    }
  });

  it('ignores non-route named args like produces/consumes', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api")
public class MediaController {
    @GetMapping(value = "/json", produces = "application/json")
    public String json() { return "{}"; }
}
`);

    const routes = extractSpringRoutes(tree, 'MediaController.java');
    // Should only extract the route path, not the produces value
    assert.equal(routes.length, 1);
    assert.equal(routes[0].routePath, '/json');
    assert.equal(routes[0].prefix, '/api');
  });

  it('does not bleed prefix across unrelated classes', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/v1")
class V1Controller {
    @GetMapping("/old")
    public String old() { return "v1"; }
}

@RestController
class NoPrefix {
    @GetMapping("/bare")
    public String bare() { return "no prefix"; }
}

@RestController
@RequestMapping("/api/v3")
class V3Controller {
    @GetMapping("/new")
    public String newer() { return "v3"; }
}
`);

    const routes = extractSpringRoutes(tree, 'Multi.java');
    assert.equal(routes.length, 3);

    const v1 = routes.find((r) => r.routePath === '/old');
    assert.equal(v1!.prefix, '/api/v1');

    const bare = routes.find((r) => r.routePath === '/bare');
    assert.equal(bare!.prefix, undefined);

    const v3 = routes.find((r) => r.routePath === '/new');
    assert.equal(v3!.prefix, '/api/v3');
  });

  it('reports correct line numbers', () => {
    const tree = parse(`@RestController
@RequestMapping("/api")
public class LineTest {
    @GetMapping("/first")
    public String first() { return "1"; }

    @PostMapping("/second")
    public String second() { return "2"; }
}
`);

    const routes = extractSpringRoutes(tree, 'LineTest.java');
    assert.equal(routes.length, 2);
    // @GetMapping is on line index 3 (0-based)
    const first = routes.find((r) => r.routePath === '/first');
    assert.equal(first!.lineNumber, 3);
    // @PostMapping is on line index 6
    const second = routes.find((r) => r.routePath === '/second');
    assert.equal(second!.lineNumber, 6);
  });
});
