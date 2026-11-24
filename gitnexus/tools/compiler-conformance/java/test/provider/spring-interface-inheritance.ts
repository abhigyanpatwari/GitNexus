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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  extractSpringRoutes,
  extractSpringTypes,
} from '../../../../../src/core/ingestion/route-extractors/spring.js';
import { resolveInheritedSpringRoutes } from '../../../../../src/core/ingestion/route-extractors/spring-shared.js';
import { JAVA_HTTP_PLUGIN } from '../../../../../src/core/group/extractors/http-patterns/java.js';

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
    assert.deepEqual(routes, [
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
    assert.deepEqual(keys, new Set(['GET /v1/api/list', 'POST /v1/api/a', 'POST /v1/api/b']));
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
    assert.deepEqual(inherited([iface, controller]), []);
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
    assert.deepEqual(extractSpringRoutes(parse(iface), 'OrderApi.java'), []);
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
    assert.equal(routes.length, 1);
    assert.partialDeepStrictEqual(routes[0], {
      routePath: '/x',
      httpMethod: 'GET',
      prefix: '/api',
    });
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(groupInheritedKeys(files), new Set(['GET /orders']));
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
    assert.deepEqual(group, new Set(['POST /v1/api/a', 'POST /v1/api/b', 'GET /v1/api/list']));
    assert.deepEqual(ingestionInheritedKeys(files), group);
  });

  it('agrees on inherited @RequestMapping verbs and wildcard mappings', () => {
    const files = [
      {
        path: 'LegacyApi.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api")
public interface LegacyApi {
  @RequestMapping(path = "/save", method = RequestMethod.POST) Object save();
  @RequestMapping("/all") Object all();
}
`,
      },
      {
        path: 'LegacyController.java',
        src: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class LegacyController implements LegacyApi {
  public Object save() { return null; }
  public Object all() { return null; }
}
`,
      },
    ];

    const expected = new Set(['POST /api/save', '* /api/all']);
    assert.deepEqual(groupInheritedKeys(files), expected);
    assert.deepEqual(ingestionInheritedKeys(files), expected);
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(groupInheritedKeys(files), new Set(['GET /api/list']));
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(ingestionInheritedKeys(files), new Set());
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(groupInheritedKeys(files), new Set(['GET /api/read', 'POST /api/write']));
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(ingestionInheritedKeys(files), new Set());
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
    assert.deepEqual(ingestionInheritedKeys(files), groupInheritedKeys(files));
    assert.deepEqual(groupInheritedKeys(files), new Set(['GET /api/inherited']));
  });
});
