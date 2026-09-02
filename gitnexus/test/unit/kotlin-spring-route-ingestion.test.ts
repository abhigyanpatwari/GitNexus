/**
 * Kotlin Spring decorator-route extraction for the ingestion pipeline (#3130).
 *
 * The Kotlin grammar is optional. Importing the extractor itself must not load
 * that grammar; only this guarded test setup does.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { extractKotlinSpringRoutes } from '../../src/core/ingestion/route-extractors/kotlin-spring.js';
import { kotlinProvider } from '../../src/core/ingestion/languages/kotlin.js';
import {
  extractKotlinModuleConstants,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/kotlin-const-resolver.js';
import { joinPath } from '../../src/core/ingestion/route-extractors/spring-shared.js';
import { KOTLIN_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/kotlin.js';

let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Optional grammar; skip positive assertions when its native binding is absent.
}

const parser = new Parser();
if (Kotlin) parser.setLanguage(Kotlin as Parser.Language);

const parse = (source: string): Parser.Tree => parser.parse(source);
const describeKotlin = Kotlin ? describe : describe.skip;

function constantsOf(files: Record<string, string>): RepoConstants {
  return new Map(
    Object.entries(files).map(([filePath, source]) => [
      filePath,
      extractKotlinModuleConstants(parse(source)),
    ]),
  );
}

describeKotlin('extractKotlinSpringRoutes', () => {
  it('extracts direct RestController functions with independent class prefixes and handlers', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping("/api")
class ApiController {
    @GetMapping("/pets")
    fun list(): String = "pets"

    @PostMapping(path = "/items")
    fun create(): String = "item"
}

@RestController
@RequestMapping(value = "/admin")
class AdminController {
    @PutMapping("/items")
    fun replace() {}

    @DeleteMapping(value = "/items")
    fun remove() {}

    @PatchMapping("/items")
    fun patch() {}
}
`),
      'Controllers.kt',
    );

    expect(
      routes
        .map((route) => ({
          method: route.httpMethod,
          path: route.routePath,
          prefix: route.prefix,
          handler: route.handlerName,
        }))
        .sort((a, b) => `${a.method}:${a.handler}`.localeCompare(`${b.method}:${b.handler}`)),
    ).toEqual([
      { method: 'DELETE', path: '/items', prefix: '/admin', handler: 'remove' },
      { method: 'GET', path: '/pets', prefix: '/api', handler: 'list' },
      { method: 'PATCH', path: '/items', prefix: '/admin', handler: 'patch' },
      { method: 'POST', path: '/items', prefix: '/api', handler: 'create' },
      { method: 'PUT', path: '/items', prefix: '/admin', handler: 'replace' },
    ]);
  });

  it('recognizes marker, constructor, constructor-argument, and FQN RestController forms', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
class MarkerController {
    @GetMapping("/marker")
    fun marker() {}
}

@RestController()
class ConstructorController {
    @GetMapping("/constructor")
    fun constructor() {}
}

@RestController("namedBean")
class NamedController {
    @GetMapping("/named")
    fun named() {}
}

@org.springframework.web.bind.annotation.RestController
class FqnController {
    @org.springframework.web.bind.annotation.GetMapping("/fqn")
    fun fqn() {}
}
`),
      'ControllerForms.kt',
    );

    expect(routes.map((route) => [route.routePath, route.handlerName]).sort()).toEqual([
      ['/constructor', 'constructor'],
      ['/fqn', 'fqn'],
      ['/marker', 'marker'],
      ['/named', 'named'],
    ]);
  });

  it('emits pathless mappings and method-level RequestMapping constraints', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
class RequestMappings {
    @GetMapping
    fun root() {}

    @RequestMapping("/any")
    fun any() {}

    @RequestMapping(path = "/get", method = RequestMethod.GET)
    fun get() {}

    @RequestMapping(value = "/inspect", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun inspect() {}
}
`),
      'RequestMappings.kt',
    );

    expect(
      routes
        .map((route) => [route.httpMethod, route.routePath, route.handlerName])
        .sort((a, b) => a.join(':').localeCompare(b.join(':'))),
    ).toEqual([
      ['*', '/any', 'any'],
      ['GET', '', 'root'],
      ['GET', '/get', 'get'],
      ['GET', '/inspect', 'inspect'],
      ['HEAD', '/inspect', 'inspect'],
    ]);
  });

  it('intersects class-level and function-level RequestMapping HTTP methods', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping(path = "/api", method = RequestMethod.GET)
class GetOnlyController {
    @PostMapping("/rejected")
    fun rejected() {}

    @RequestMapping("/inherited")
    fun inherited() {}

    @RequestMapping(path = "/also-get", method = [RequestMethod.GET, RequestMethod.POST])
    fun alsoGet() {}
}
`),
      'Constrained.kt',
    );

    expect(
      routes.map((route) => [route.httpMethod, route.routePath, route.handlerName]).sort(),
    ).toEqual([
      ['GET', '/also-get', 'alsoGet'],
      ['GET', '/inherited', 'inherited'],
    ]);
  });

  it('restricts extraction to concrete RestController classes and their direct functions', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@Controller
class MvcController {
    @GetMapping("/mvc")
    fun mvc() {}
}

class Ordinary {
    @GetMapping("/ordinary")
    fun ordinary() {}
}

@RestController
interface Contract {
    @GetMapping("/contract")
    fun contract()
}

@RestController
@FeignClient(name = "remote")
interface RemoteClient {
    @GetMapping("/remote")
    fun remote()
}

@RestController
class Concrete {
    @GetMapping("/direct")
    fun direct() {
        @GetMapping("/local")
        fun local() {}
    }

    class Nested {
        @GetMapping("/nested")
        fun nested() {}
    }
}
`),
      'Boundaries.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      httpMethod: 'GET',
      routePath: '/direct',
      handlerName: 'direct',
    });
  });

  it('drops abstract and sealed RestController classes', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
package app

@RestController
abstract class AbstractApi {
    @GetMapping("/abstract")
    fun abstractHandler() {}
}

@RestController
sealed class SealedApi {
    @GetMapping("/sealed")
    fun sealedHandler() {}
}

@RestController
class ConcreteApi {
    @GetMapping("/ok")
    fun ok() {}
}
`),
      'Abstract.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      httpMethod: 'GET',
      routePath: '/ok',
      handlerName: 'ok',
    });
  });

  it('parses Kotlin RequestMapping method arrays without changing Java brace parsing', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
package app

@RestController
class Api {
    @RequestMapping("/items", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun items() {}
}
`),
      'Items.kt',
    );

    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.httpMethod).sort()).toEqual(['GET', 'HEAD']);
    expect(routes.every((route) => route.routePath === '/items')).toBe(true);
  });

  it('does not manufacture a handler from class-only annotations', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping("/api")
class EmptyController
`),
      'EmptyController.kt',
    );

    expect(routes).toEqual([]);
  });

  it('suppresses every function when a class prefix is not one plain scalar string', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping(ApiPaths.BASE)
class ConstantPrefix {
    @GetMapping("/items")
    fun items() {}
}

@RestController
@RequestMapping(["/a", "/b"])
class ArrayPrefix {
    @GetMapping("/items")
    fun items() {}
}

@RestController
@RequestMapping("/\${dynamic}")
class InterpolatedPrefix {
    @GetMapping("/items")
    fun items() {}
}
`),
      'UnknownPrefixes.kt',
    );

    expect(routes).toEqual([]);
  });

  it('treats an empty class path arrayOf() as no prefix', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping(arrayOf())
class ArrayOfEmpty {
    @GetMapping("/pets")
    fun pets() {}
}
`),
      'ArrayOfEmpty.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routePath: '/pets', httpMethod: 'GET', handlerName: 'pets' });
    expect(routes[0].prefix).toBeUndefined();
  });

  it('treats an empty method path collection_literal as a pathless mapping', () => {
    // Class-level `@RequestMapping([])` is often recovered as prefix_expression
    // (no class_declaration) by tree-sitter-kotlin; method-level `[]` still
    // exercises the same empty-collection classification.
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
class MethodEmpty {
    @GetMapping([])
    fun pets() {}
}
`),
      'MethodEmpty.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routePath: '',
      httpMethod: 'GET',
      handlerName: 'pets',
    });
  });

  it('keeps a trailing comma on RequestMapping from dropping the controller', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
@RequestMapping("/api",)
class Trailing {
    @GetMapping("/pets",)
    fun pets() {}
}
`),
      'Trailing.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      prefix: '/api',
      routePath: '/pets',
      handlerName: 'pets',
      httpMethod: 'GET',
    });
  });

  it('skips interpolated, array, and dynamic function paths', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
class DynamicPaths {
    @GetMapping("/$id")
    fun interpolated() {}

    @GetMapping(["/a", "/b"])
    fun array() {}

    @GetMapping(buildPath())
    fun dynamic() {}

    @GetMapping("/literal")
    fun literal() {}
}
`),
      'DynamicPaths.kt',
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routePath: '/literal', handlerName: 'literal' });
  });

  it('emits constant operands without inventing a path', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
@RestController
class ConstantController {
    @GetMapping(ApiPaths.PETS)
    fun pets() {}

    @PostMapping(value = ApiPaths.BASE + "/items")
    fun items() {}
}
`),
      'ConstantController.kt',
    );

    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      routePath: '',
      routePathExpr: 'ApiPaths.PETS',
      routePathOperands: [{ kind: 'ref', name: 'ApiPaths.PETS' }],
      handlerName: 'pets',
    });
    expect(routes[1]).toMatchObject({
      routePath: '',
      routePathExpr: 'ApiPaths.BASE + "/items"',
      routePathOperands: [
        { kind: 'ref', name: 'ApiPaths.BASE' },
        { kind: 'literal', value: '/items' },
      ],
      handlerName: 'items',
    });
  });

  it('qualifies same-file companion and enclosing-object operands proven by the AST', () => {
    const routes = extractKotlinSpringRoutes(
      parse(`
object Outer {
    object Paths {
        const val NESTED = "/nested"
    }

    @RestController
    class NestedController {
        companion object {
            const val OWN = "/own"
        }

        @GetMapping(OWN)
        fun own() {}

        @GetMapping(Outer.Paths.NESTED)
        fun nested() {}
    }
}
`),
      'OwnedConstants.kt',
    );

    expect(routes.map((route) => route.routePathOperands)).toEqual([
      [{ kind: 'ref', name: 'Outer.NestedController.OWN' }],
      [{ kind: 'ref', name: 'Outer.Paths.NESTED' }],
    ]);
  });

  it('registers only the dedicated route and constant hooks on kotlinProvider', () => {
    expect(kotlinProvider.extractDecoratorRoutes).toBe(extractKotlinSpringRoutes);
    expect(kotlinProvider.extractModuleConstants).toBe(extractKotlinModuleConstants);
    expect(kotlinProvider.foldRoutePathOperands).toBeTypeOf('function');
    expect(kotlinProvider.moduleConstantHeuristic).toBeUndefined();
    expect(kotlinProvider.decoratorRouteHandlerName).toBeUndefined();
  });

  it('folds imported, wildcard, concatenated, and same-file companion route operands', () => {
    const constantsKey = 'src/main/kotlin/com/example/api/ApiPaths.kt';
    const controllerKey = 'src/main/kotlin/com/example/web/PetsController.kt';
    const files = {
      [constantsKey]: `package com.example.api

const val WILDCARD = "/wildcard"
object ApiPaths {
    const val BASE = "/api"
    const val PETS = BASE + "/pets"
}
`,
      [controllerKey]: `package com.example.web

import com.example.api.ApiPaths
import com.example.api.*

@RestController
class PetsController {
    companion object {
        const val OWN = "/own"
    }

    @GetMapping(ApiPaths.PETS)
    fun imported() {}

    @PostMapping(ApiPaths.BASE + "/items")
    fun concatenated() {}

    @PutMapping(WILDCARD)
    fun wildcard() {}

    @PatchMapping(OWN)
    fun companion() {}
}
`,
    };
    const repo = constantsOf(files);
    const fold = kotlinProvider.foldRoutePathOperands;
    expect(fold).toBeTypeOf('function');
    if (!fold) throw new Error('expected Kotlin route operand fold hook');
    const routes = extractKotlinSpringRoutes(parse(files[controllerKey]), controllerKey);
    const folded = new Map(
      routes.map((route) => [
        route.handlerName,
        fold(route.filePath, route.routePathOperands ?? [], repo),
      ]),
    );

    expect(folded).toEqual(
      new Map([
        ['imported', '/api/pets'],
        ['concatenated', '/api/items'],
        ['wildcard', '/wildcard'],
        ['companion', '/own'],
      ]),
    );
  });

  it('keeps unresolved and unfoldable route operands on the skip floor', () => {
    const controllerKey = 'src/main/kotlin/com/example/web/PetsController.kt';
    const source = `package com.example.web

@RestController
class PetsController {
    @GetMapping(ApiPaths.MISSING)
    fun missing() {}

    @GetMapping(BROKEN)
    fun broken() {}
}

val BROKEN = buildPath()
`;
    const repo = constantsOf({ [controllerKey]: source });
    const routes = extractKotlinSpringRoutes(parse(source), controllerKey);
    const fold = kotlinProvider.foldRoutePathOperands;
    if (!fold) throw new Error('expected Kotlin route operand fold hook');

    expect(routes.map((route) => route.handlerName)).toEqual(['missing', 'broken']);
    for (const route of routes) {
      expect(fold(route.filePath, route.routePathOperands ?? [], repo)).toBeNull();
    }
  });

  it('preserves a successful empty-string fold and its handler name', () => {
    const key = 'src/main/kotlin/com/example/web/RootController.kt';
    const source = `package com.example.web

const val ROOT = ""

@RestController
class RootController {
    @GetMapping(ROOT)
    fun root() {}
}
`;
    const repo = constantsOf({ [key]: source });
    const [route] = extractKotlinSpringRoutes(parse(source), key);
    const fold = kotlinProvider.foldRoutePathOperands;
    if (!route || !fold) throw new Error('expected root route and Kotlin fold hook');

    expect(route).toMatchObject({ routePath: '', handlerName: 'root' });
    expect(fold(key, route.routePathOperands ?? [], repo)).toBe('');
  });

  it('matches the group Kotlin plugin for an in-scope literal controller fixture', () => {
    expect(KOTLIN_HTTP_PLUGIN).not.toBeNull();
    if (!KOTLIN_HTTP_PLUGIN) throw new Error('expected Kotlin HTTP plugin');
    const source = `
@RestController
@RequestMapping("/api")
class PetsController {
    @GetMapping("/pets")
    fun list() {}

    @PostMapping("/pets")
    fun create() {}
}
`;
    const tree = parse(source);
    const ingestion = new Set(
      extractKotlinSpringRoutes(tree, 'PetsController.kt').map(
        (route) => `${route.httpMethod} ${joinPath(route.prefix ?? '', route.routePath)}`,
      ),
    );
    const group = new Set(
      KOTLIN_HTTP_PLUGIN.scan(tree, undefined, 'PetsController.kt')
        .filter((detection) => detection.role === 'provider')
        .map((detection) => `${detection.method} ${detection.path}`),
    );

    expect(ingestion).toEqual(group);
  });

  it('resolves vendor-derived mapping aliases like Java (WinGetMapping / WinRequestMapping)', () => {
    expect(KOTLIN_HTTP_PLUGIN).not.toBeNull();
    if (!KOTLIN_HTTP_PLUGIN) throw new Error('expected Kotlin HTTP plugin');
    const source = `
@RestController
@WinRequestMapping("/vendor")
class VendorController {
    @WinGetMapping("/users")
    fun users(): String = "ok"
}
`;
    const tree = parse(source);
    const ingestion = extractKotlinSpringRoutes(tree, 'VendorController.kt');
    expect(ingestion).toHaveLength(1);
    expect(ingestion[0]?.httpMethod).toBe('GET');
    expect(ingestion[0]?.prefix).toBe('/vendor');
    expect(ingestion[0]?.routePath).toBe('/users');

    const group = KOTLIN_HTTP_PLUGIN.scan(tree, undefined, 'VendorController.kt').filter(
      (detection) => detection.role === 'provider',
    );
    expect(group).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'GET', path: '/vendor/users' })]),
    );
  });

  it('does not treat unregistered suffix annotations as Kotlin routes', () => {
    const source = `
@RestController
class AuditController {
    @AuditPostMapping("/audit")
    fun audit(): String = "x"
}
`;
    expect(extractKotlinSpringRoutes(parse(source), 'AuditController.kt')).toHaveLength(0);
  });
});
