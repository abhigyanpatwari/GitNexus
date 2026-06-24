/**
 * Unit coverage for the ingestion-side Spring interface-inheritance resolution
 * (#2288): a concrete `@RestController` inherits the `@*Mapping`s declared on
 * the interface it implements. This pins the two pieces the cross-file pipeline
 * pass wires together:
 *   1. `extractSpringTypes` — the per-file `SharedSpringType` collector.
 *   2. `resolveInheritedSpringRoutes` — the shared, language-agnostic algorithm
 *      (also used by the group Java/Kotlin plugins) that attributes inherited
 *      routes to the implementing controller.
 *
 * It also pins the suppression half: `extractSpringRoutes` must NOT emit an
 * interface method's own `@*Mapping` as a standalone route (that route is
 * resolved onto the controller by the inheritance pass instead).
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  extractSpringRoutes,
  extractSpringTypes,
} from '../../src/core/ingestion/route-extractors/spring.js';
import { resolveInheritedSpringRoutes } from '../../src/core/ingestion/route-extractors/spring-shared.js';

function parse(src: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(Java);
  return p.parse(src);
}

/** Run extractSpringTypes over several files and resolve inherited routes. */
function inherited(files: Array<{ path: string; src: string }>) {
  const types = files.flatMap((f) => extractSpringTypes(parse(f.src), f.path));
  return resolveInheritedSpringRoutes(types).map((r) => ({
    filePath: r.filePath,
    methodName: r.methodName,
    key: `${r.method} ${r.path}`,
  }));
}

describe('Spring interface-inheritance resolution (ingestion, #2288)', () => {
  it('attributes an interface-declared route to the implementing controller', () => {
    const iface = {
      path: 'OrderApi.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface OrderApi {
  @GetMapping("/orders") Object list();
}
`,
    };
    const controller = {
      path: 'OrderController.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController implements OrderApi {
  public Object list() { return null; }
}
`,
    };

    const routes = inherited([iface, controller]);
    expect(routes).toEqual([
      { filePath: 'OrderController.java', methodName: 'list', key: 'GET /orders' },
    ]);
  });

  it('joins both the interface and controller class prefixes (no doubling)', () => {
    const iface = {
      path: 'Api.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api")
public interface Api {
  @GetMapping("/list") Object list();
  @PostMapping({"/a", "/b"}) Object multi();
}
`,
    };
    const controller = {
      path: 'C.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/v1")
public class C implements Api {
  public Object list() { return null; }
  public Object multi() { return null; }
}
`,
    };

    const keys = new Set(inherited([iface, controller]).map((r) => r.key));
    expect(keys).toEqual(new Set(['GET /v1/api/list', 'POST /v1/api/a', 'POST /v1/api/b']));
  });

  it('does NOT inherit a route the controller overrides with its own @*Mapping', () => {
    const iface = {
      path: 'Api.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface Api {
  @GetMapping("/from-iface") Object get();
}
`,
    };
    const controller = {
      path: 'C.java',
      src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class C implements Api {
  @GetMapping("/own") public Object get() { return null; }
}
`,
    };
    // The controller's own @GetMapping wins; the interface route is not also added.
    expect(inherited([iface, controller])).toEqual([]);
  });

  it('extractSpringRoutes suppresses an interface method route (handled by the pass)', () => {
    const iface = `package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api")
public interface OrderApi {
  @GetMapping("/orders") Object list();
}
`;
    // The interface file on its own must yield NO standalone route.
    expect(extractSpringRoutes(parse(iface), 'OrderApi.java')).toEqual([]);
  });

  it('still emits concrete class routes unchanged', () => {
    const ctrl = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class C {
  @GetMapping("/x") public Object x() { return null; }
}
`;
    const routes = extractSpringRoutes(parse(ctrl), 'C.java');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routePath: '/x', httpMethod: 'GET', prefix: '/api' });
  });
});
