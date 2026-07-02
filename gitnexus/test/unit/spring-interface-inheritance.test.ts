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
import { JAVA_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/java.js';

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

/** ingestion inherited routes as a `METHOD path` set (cross-file pass result). */
function ingestionInheritedKeys(files: Array<{ path: string; src: string }>): Set<string> {
  return new Set(inherited(files).map((r) => r.key));
}

/** group inherited provider routes via the project-level scan, as a `METHOD path` set. */
function groupInheritedKeys(files: Array<{ path: string; src: string }>): Set<string> {
  const inputs = files.map((f) => ({ filePath: f.path, tree: parse(f.src) }));
  const out = new Set<string>();
  for (const fileDet of JAVA_HTTP_PLUGIN.scanProject?.(inputs) ?? []) {
    for (const d of fileDet.detections) {
      if (d.role === 'provider') out.add(`${d.method} ${d.path}`);
    }
  }
  return out;
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

describe('Spring interface-inheritance parity — ingestion vs group scanProject (#2078)', () => {
  // The strongest anti-drift guard: the same fixture must yield the same
  // inherited provider routes from the ingestion cross-file pass and the group
  // project-level scan. Both call the shared resolveInheritedSpringRoutes, so
  // this pins that the two SharedSpringType collectors agree on every shape.

  it('agrees on a plain interface-inherited route', () => {
    const files = [
      {
        path: 'OrderApi.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface OrderApi { @GetMapping("/orders") Object list(); }
`,
      },
      {
        path: 'OrderController.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController implements OrderApi { public Object list() { return null; } }
`,
      },
    ];
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(groupInheritedKeys(files)).toEqual(new Set(['GET /orders']));
  });

  it('agrees with interface + controller prefixes and an array mapping', () => {
    const files = [
      {
        path: 'Api.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api")
public interface Api {
  @GetMapping("/list") Object list();
  @PostMapping({"/a", "/b"}) Object multi();
}
`,
      },
      {
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
      },
    ];
    const group = groupInheritedKeys(files);
    // Pin the expected set — this is the array-form fixture (the #2265 root),
    // so the parity assertion must not be vacuously true on two empty sets.
    expect(group).toEqual(new Set(['POST /v1/api/a', 'POST /v1/api/b', 'GET /v1/api/list']));
    expect(ingestionInheritedKeys(files)).toEqual(group);
  });

  it('agrees on fully-qualified annotation names', () => {
    // Both sides normalise an FQN annotation to its trailing segment, so an
    // interface using `@org.springframework...GetMapping` still resolves.
    const files = [
      {
        path: 'Api.java',
        src: `package com.example;
@org.springframework.web.bind.annotation.RequestMapping("/api")
public interface Api {
  @org.springframework.web.bind.annotation.GetMapping("/list") Object list();
}
`,
      },
      {
        path: 'C.java',
        src: `package com.example;
@org.springframework.web.bind.annotation.RestController
public class C implements Api { public Object list() { return null; } }
`,
      },
    ];
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(groupInheritedKeys(files)).toEqual(new Set(['GET /api/list']));
  });

  it('agrees that an ambiguous (duplicated) interface name drops its routes', () => {
    const files = [
      {
        path: 'a/Api.java',
        src: `package a;
import org.springframework.web.bind.annotation.*;
public interface Api { @GetMapping("/x") Object x(); }
`,
      },
      {
        path: 'b/Api.java',
        src: `package b;
import org.springframework.web.bind.annotation.*;
public interface Api { @GetMapping("/y") Object x(); }
`,
      },
      {
        path: 'C.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class C implements Api { public Object x() { return null; } }
`,
      },
    ];
    // Ambiguous interface name → both sides drop the inherited routes.
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(ingestionInheritedKeys(files)).toEqual(new Set());
  });

  it('agrees on a controller implementing multiple interfaces', () => {
    const files = [
      {
        path: 'ReadApi.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface ReadApi { @GetMapping("/read") Object read(); }
`,
      },
      {
        path: 'WriteApi.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface WriteApi { @PostMapping("/write") Object write(); }
`,
      },
      {
        path: 'C.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class C implements ReadApi, WriteApi {
  public Object read() { return null; }
  public Object write() { return null; }
}
`,
      },
    ];
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(groupInheritedKeys(files)).toEqual(new Set(['GET /api/read', 'POST /api/write']));
  });

  it('agrees that a non-controller class does NOT inherit interface routes', () => {
    const files = [
      {
        path: 'Api.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface Api { @GetMapping("/x") Object x(); }
`,
      },
      {
        path: 'PlainImpl.java',
        src: `package com.example;
// No @RestController/@Controller — not a provider, must inherit nothing.
public class PlainImpl implements Api { public Object x() { return null; } }
`,
      },
    ];
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(ingestionInheritedKeys(files)).toEqual(new Set());
  });

  it('agrees when a controller mixes its own mapping with an inherited one', () => {
    // `own()` carries its own @*Mapping (resolved by extractSpringRoutes, NOT the
    // inheritance pass); `inh()` inherits from the interface. The inheritance
    // result must contain only the inherited route on both sides.
    const files = [
      {
        path: 'Api.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
public interface Api { @GetMapping("/inherited") Object inh(); }
`,
      },
      {
        path: 'C.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class C implements Api {
  @GetMapping("/own") public Object own() { return null; }
  public Object inh() { return null; }
}
`,
      },
    ];
    expect(ingestionInheritedKeys(files)).toEqual(groupInheritedKeys(files));
    expect(groupInheritedKeys(files)).toEqual(new Set(['GET /api/inherited']));
  });
});
