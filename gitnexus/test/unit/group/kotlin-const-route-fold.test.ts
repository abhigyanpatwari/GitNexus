/**
 * Constant-valued Spring route paths on the Kotlin group plugin.
 *
 * Drives `KOTLIN_HTTP_PLUGIN.prepareRepo` + `scan(tree, ctx, rel)` with all
 * three arguments, which is the shape the http-route-extractor orchestrator
 * uses. The existing Kotlin guards call `scan(tree)` with ONE argument and are
 * therefore structurally blind here: without a repo context the plugin has no
 * constant map and drops every constant-valued route.
 *
 * Asserted:
 *   • the four reference forms fold to the right provider contract — qualified
 *     access, fully-qualified name, single-name import, `+`-concatenation;
 *   • a CONSTANT class prefix suppresses every method route under that class,
 *     literal ones included (the prefix is not knowable here, and emitting the
 *     methods unprefixed would publish paths the application does not serve) —
 *     the rule `java.ts` already applies;
 *   • an unresolvable constant emits nothing rather than a guessed path;
 *   • without a repo context the plugin emits nothing (the documented skip
 *     floor, and the branch the 1-argument guards cannot reach);
 *   • literal routes are untouched and are not emitted twice.
 */

import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { KOTLIN_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/kotlin.js';
import type { HttpLanguagePlugin } from '../../../src/core/group/extractors/http-patterns/types.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Optional grammar; the suite skips when its native binding is unavailable.
}

const describeKotlin = Kotlin && KOTLIN_HTTP_PLUGIN ? describe : describe.skip;
// Non-null only inside `describeKotlin`, which is skipped when the plugin is null.
const plugin = KOTLIN_HTTP_PLUGIN as HttpLanguagePlugin;

const parseSource = (p: Parser, src: string): Parser.Tree => {
  p.setLanguage(Kotlin as Parser.Language);
  return p.parse(src);
};

/** prepareRepo + a 3-argument scan over every file; provider contracts only. */
function providers(files: Record<string, string>): string[] {
  const ctx = plugin.prepareRepo?.({
    repoPath: '/virtual',
    files: Object.keys(files),
    parser: new Parser(),
    readFile: (rel: string) => files[rel] ?? null,
    parseSource,
  });
  const out: string[] = [];
  for (const rel of Object.keys(files)) {
    for (const d of plugin.scan(parseSource(new Parser(), files[rel]), ctx, rel)) {
      if (d.role === 'provider') out.push(`${d.method} ${d.path}`);
    }
  }
  return out.sort();
}

const CONSTS = 'src/main/kotlin/com/example/app/api/ApiPaths.kt';
const CONTROLLER = 'src/main/kotlin/com/example/app/web/OrderController.kt';

const CONSTS_SRC = `package com.example.app.api

object ApiPaths {
    const val BASE = "/api/v1"
    const val ORDERS = BASE + "/orders"
}
`;

describeKotlin('Kotlin constant-valued Spring routes (group plugin)', () => {
  it('folds a qualified reference in a positional argument', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('folds a named `value =` / `path =` argument and an inline concatenation', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @PostMapping(value = ApiPaths.BASE + "/orders/create")
    fun create() {}

    @DeleteMapping(path = ApiPaths.ORDERS)
    fun remove() {}
}
`,
      }),
    ).toEqual(['DELETE /api/v1/orders', 'POST /api/v1/orders/create']);
  });

  it('folds a fully-qualified reference and a single-name import', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths.ORDERS

@RestController
class OrderController {
    @GetMapping(ORDERS)
    fun list() {}

    @PutMapping(com.example.app.api.ApiPaths.ORDERS)
    fun replace() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders', 'PUT /api/v1/orders']);
  });

  it('ignores a non-route named argument', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(path = ApiPaths.ORDERS, produces = [MediaType.APPLICATION_JSON_VALUE])
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders']);
  });

  it('suppresses every method route under a CONSTANT class prefix', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping(ApiPaths.BASE)
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}

    @GetMapping("/literal")
    fun literal() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('still applies a LITERAL class prefix to a folded method path', () => {
    expect(
      providers({
        [CONSTS]: CONSTS_SRC,
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
@RequestMapping("/api/v1")
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/api/v1/orders']);
  });

  it('emits nothing when the constant cannot be resolved', () => {
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
      }),
    ).toEqual([]);
  });

  it('emits nothing for a constant route scanned without a repo context', () => {
    // This is the branch the 1-argument guards cannot reach; pin it so it is
    // not silently dead in the suite.
    const tree = parseSource(
      new Parser(),
      `package com.example.app.web

import com.example.app.api.ApiPaths

@RestController
class OrderController {
    @GetMapping(ApiPaths.ORDERS)
    fun list() {}
}
`,
    );
    expect(plugin.scan(tree).filter((d) => d.role === 'provider')).toEqual([]);
  });

  it('leaves literal routes unchanged and emits each exactly once', () => {
    expect(
      providers({
        [CONTROLLER]: `package com.example.app.web

@RestController
@RequestMapping("/api/v1")
class OrderController {
    @GetMapping("/orders")
    fun list() {}

    @PostMapping(value = "/orders")
    fun create() {}
}
`,
      }),
    ).toEqual(['GET /api/v1/orders', 'POST /api/v1/orders']);
  });
});
