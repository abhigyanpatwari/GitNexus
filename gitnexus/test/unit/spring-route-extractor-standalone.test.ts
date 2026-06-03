/**
 * Unit Tests: Standalone Spring route extractor (#91)
 *
 * The standalone `extractSpringRoutes` in
 * `src/core/ingestion/route-extractors/spring.ts` had three bugs that
 * the production pipeline (workers/spring-route-extractor.ts) handled
 * correctly, so production index quality was unaffected. The standalone
 * variant is used for direct invocation, unit testing, and as a
 * reference implementation. This suite covers:
 *  1. `@RequestMapping(method = {RequestMethod.GET})` (single-element
 *     bracket array) → method = GET, not ANY.
 *  2. `@RequestMapping(method = {RequestMethod.GET, RequestMethod.POST})`
 *     (multi-element bracket array) → two separate routes, not one ANY.
 *  3. `@PatchMapping("/{id}")` → method = PATCH, not ANY.
 *  4. The bare `@RequestMapping(value = "/x")` (no method attr) → still
 *     ANY (the documented contract for "matches all methods").
 */

import { describe, it, expect } from 'vitest';
import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring.js';

describe('Standalone Spring route extractor (#91)', () => {
  describe('@RequestMapping method array', () => {
    it('parses single-element bracket array as the named HTTP method', async () => {
      // (#91) The reproduction: ContractIntController has
      //   @RequestMapping(value = "/x", method = {RequestMethod.GET})
      // The previous check matched `array_initializer` but tree-sitter
      // emits `element_value_array_initializer` for the bracket form,
      // so the method fell through to the default `['ANY']`.
      const code = `
        @RestController
        public class ContractIntController {
          @RequestMapping(value = "/x", method = {RequestMethod.GET})
          public String get() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const getRoute = routes.find(r => r.path === '/x');
      expect(getRoute).toBeDefined();
      expect(getRoute?.method).toBe('GET');
      // Single-element array must produce exactly one route, not two.
      expect(routes.filter(r => r.path === '/x').length).toBe(1);
    });

    it('parses multi-element bracket array as one route per method', async () => {
      // (#91) For `@RequestMapping(method = {RequestMethod.GET, RequestMethod.POST})`
      // we expect TWO separate routes — one GET, one POST — not a single
      // route with method=ANY. The for-loop on httpMethods already
      // produces one route per method; the bug was the parser never
      // populating httpMethods in the first place.
      const code = `
        @RestController
        public class MultiMethodController {
          @RequestMapping(value = "/x", method = {RequestMethod.GET, RequestMethod.POST})
          public String getOrCreate() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const xRoutes = routes.filter(r => r.path === '/x');
      expect(xRoutes).toHaveLength(2);
      const methods = xRoutes.map(r => r.method).sort();
      expect(methods).toEqual(['GET', 'POST']);
    });

    it('still emits ANY when @RequestMapping has no method attribute', async () => {
      // Backward compat: bare `@RequestMapping(value = "/x")` with no
      // method attr matches any HTTP method. The contract is unchanged
      // — the fix only adds the array-parse path, it does not
      // alter the default.
      const code = `
        @RestController
        public class AnyMethodController {
          @RequestMapping(value = "/x")
          public String any() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const anyRoute = routes.find(r => r.path === '/x');
      expect(anyRoute).toBeDefined();
      expect(anyRoute?.method).toBe('ANY');
    });
  });

  describe('@PatchMapping recognition', () => {
    it('recognizes @PatchMapping as PATCH (not ANY)', async () => {
      // (#91) The reproduction: `@PatchMapping("/{id}")` was
      // unrecognized — MAPPING_ANNOTATIONS had Get/Post/Put/Delete but
      // not Patch. Every PATCH endpoint extracted with method=ANY.
      const code = `
        @RestController
        public class PatchController {
          @PatchMapping("/{id}")
          public String patch() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const patchRoute = routes.find(r => r.path === '/{id}');
      expect(patchRoute).toBeDefined();
      expect(patchRoute?.method).toBe('PATCH');
    });

    it('recognizes @PatchMapping with class-level @RequestMapping prefix', async () => {
      // Class-level prefix must combine with the method-level path.
      // Mirrors the AuthController / ProjectsController test
      // structure at test/unit/spring.extract.test.ts.
      const code = `
        @RestController
        @RequestMapping("/api")
        public class PatchController {
          @PatchMapping("/v1/{id}")
          public String patch() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const patchRoute = routes.find(r => r.method === 'PATCH');
      expect(patchRoute).toBeDefined();
      expect(patchRoute?.path).toBe('/api/v1/{id}');
    });
  });

  describe('regression — other methods unchanged', () => {
    it('still recognizes @GetMapping / @PostMapping / @PutMapping / @DeleteMapping', async () => {
      const code = `
        @RestController
        public class AllController {
          @GetMapping("/g") public String g() { return ""; }
          @PostMapping("/p") public String p() { return ""; }
          @PutMapping("/u") public String u() { return ""; }
          @DeleteMapping("/d") public String d() { return ""; }
        }
      `;
      const routes = await extractSpringRoutes(code);
      const byMethod = Object.fromEntries(routes.map(r => [r.method, r.path]));
      expect(byMethod.GET).toBe('/g');
      expect(byMethod.POST).toBe('/p');
      expect(byMethod.PUT).toBe('/u');
      expect(byMethod.DELETE).toBe('/d');
    });
  });
});
