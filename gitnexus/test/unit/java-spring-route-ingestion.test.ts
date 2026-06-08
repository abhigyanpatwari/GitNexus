/**
 * Unit test: Java Spring @RequestMapping / @GetMapping route extraction
 * via the dedicated `route-extractors/spring.ts` module.
 *
 * Tests the extractSpringRoutes function directly (no worker pool needed)
 * and validates per-class prefix resolution, multi-class handling, and
 * all HTTP method annotations.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

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
    expect(routes).toHaveLength(5);

    const byMethod = new Map(routes.map((r) => [r.httpMethod, r]));

    expect(byMethod.get('GET')!.routePath).toBe('/list');
    expect(byMethod.get('GET')!.prefix).toBe('/api/users');

    expect(byMethod.get('POST')!.routePath).toBe('/create');
    expect(byMethod.get('POST')!.prefix).toBe('/api/users');

    expect(byMethod.get('DELETE')!.routePath).toBe('/delete');
    expect(byMethod.get('DELETE')!.prefix).toBe('/api/users');

    expect(byMethod.get('PUT')!.routePath).toBe('/update');
    expect(byMethod.get('PUT')!.prefix).toBe('/api/users');

    expect(byMethod.get('PATCH')!.routePath).toBe('/patch');
    expect(byMethod.get('PATCH')!.prefix).toBe('/api/users');
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
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.prefix).toBeUndefined();
    }
    const paths = routes.map((r) => r.routePath).sort();
    expect(paths).toEqual(['/health', '/ready']);
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
    expect(routes).toHaveLength(1);
    expect(routes[0].decoratorName).toBe('GetMapping');
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
    expect(routes).toHaveLength(2);

    const adminRoute = routes.find((r) => r.routePath === '/dashboard');
    expect(adminRoute).toBeDefined();
    expect(adminRoute!.prefix).toBe('/api/admin');

    const publicRoute = routes.find((r) => r.routePath === '/info');
    expect(publicRoute).toBeDefined();
    expect(publicRoute!.prefix).toBe('/api/public');
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
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe('PATCH');
    expect(routes[0].routePath).toBe('/update');
    expect(routes[0].prefix).toBe('/api');
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
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.prefix).toBe('/api/v2');
      expect(route.routePath).toBe('/items');
    }
  });
});
