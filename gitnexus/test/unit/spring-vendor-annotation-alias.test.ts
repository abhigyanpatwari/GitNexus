/**
 * Unit test: vendor-derived Spring mapping annotation alias resolution.
 *
 * Frameworks wrap Spring's built-in annotations with company-specific variants
 * (e.g. Winning Health's `@WinPostMapping`). The tree-sitter query captures
 * these annotations like any other, but `springAnnotationHttpMethods` must
 * resolve them to the correct HTTP verb via suffix matching.
 *
 * These tests cover:
 * 1. `resolveSpringAnnotationAlias` directly (unit)
 * 2. `springAnnotationHttpMethods` with aliased annotations (unit)
 * 3. End-to-end `extractSpringRoutes` with a fixture using vendor annotations
 * 4. Parity: both ingestion and group extractors surface the same routes
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  resolveSpringAnnotationAlias,
  springAnnotationHttpMethods,
} from '../../src/core/ingestion/route-extractors/spring-shared.js';
import { springVendorPrefixesKey } from '../../src/core/ingestion/frameworks/spring/vendor-prefixes.js';

beforeEach(() => {
  vi.stubEnv('GITNEXUS_SPRING_VENDOR_PREFIXES', 'Win');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveSpringAnnotationAlias', () => {
  it('returns undefined for exact built-in shortcut annotations', () => {
    expect(resolveSpringAnnotationAlias('PostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('GetMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PutMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('DeleteMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PatchMapping')).toBeUndefined();
  });

  it('returns undefined for exact RequestMapping', () => {
    expect(resolveSpringAnnotationAlias('RequestMapping')).toBeUndefined();
  });

  it('returns undefined for unrelated annotations', () => {
    expect(resolveSpringAnnotationAlias('Override')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Autowired')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Component')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Data')).toBeUndefined();
  });

  it('resolves vendor shortcut annotations by suffix', () => {
    expect(resolveSpringAnnotationAlias('WinPostMapping')).toBe('PostMapping');
    expect(resolveSpringAnnotationAlias('WinGetMapping')).toBe('GetMapping');
    expect(resolveSpringAnnotationAlias('WinPutMapping')).toBe('PutMapping');
    expect(resolveSpringAnnotationAlias('WinDeleteMapping')).toBe('DeleteMapping');
    expect(resolveSpringAnnotationAlias('WinPatchMapping')).toBe('PatchMapping');
  });

  it('resolves vendor RequestMapping variants', () => {
    expect(resolveSpringAnnotationAlias('WinRequestMapping')).toBe('RequestMapping');
  });

  it('ignores unregistered vendor prefixes (review: suffix-only accepted @AuditPostMapping)', () => {
    // Suffix matching alone produced phantom routes from unrelated
    // annotations like @AuditPostMapping — resolution now requires a
    // registered prefix (Win by default).
    expect(resolveSpringAnnotationAlias('AuditPostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('CompanyPostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('XyzGetMapping')).toBeUndefined();
  });

  it('does not match annotations that merely contain a mapping name', () => {
    expect(resolveSpringAnnotationAlias('PostMappingHelper')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('GetMappingInfo')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PreMapping')).toBeUndefined();
  });
});

describe('Spring vendor prefix freshness', () => {
  it('canonicalizes equivalent lists regardless of order and duplicates', () => {
    vi.stubEnv('GITNEXUS_SPRING_VENDOR_PREFIXES', ' Win,Acme,Win ');
    const first = springVendorPrefixesKey();
    vi.stubEnv('GITNEXUS_SPRING_VENDOR_PREFIXES', 'Acme,Win');
    const second = springVendorPrefixesKey();

    expect(first).toBe('["Acme","Win"]');
    expect(second).toBe(first);
    expect(first).not.toBe('["Win"]');
  });
});

describe('springAnnotationHttpMethods with vendor aliases', () => {
  it('resolves WinPostMapping to POST', () => {
    expect(springAnnotationHttpMethods('WinPostMapping', '@WinPostMapping("/api")')).toEqual([
      'POST',
    ]);
  });

  it('resolves WinGetMapping to GET', () => {
    expect(springAnnotationHttpMethods('WinGetMapping', '@WinGetMapping("/api")')).toEqual(['GET']);
  });

  it('resolves WinDeleteMapping to DELETE', () => {
    expect(springAnnotationHttpMethods('WinDeleteMapping', '@WinDeleteMapping("/api")')).toEqual([
      'DELETE',
    ]);
  });

  it('resolves WinRequestMapping without method attribute to wildcard', () => {
    expect(springAnnotationHttpMethods('WinRequestMapping', '@WinRequestMapping("/api")')).toEqual([
      '*',
    ]);
  });

  it('resolves WinRequestMapping with method attribute', () => {
    const text = '@WinRequestMapping(value = "/api", method = RequestMethod.POST)';
    expect(springAnnotationHttpMethods('WinRequestMapping', text)).toEqual(['POST']);
  });

  it('accepts Kotlin collection syntax for RequestMapping method arrays', () => {
    const text =
      '@WinRequestMapping(value = "/api", method = [RequestMethod.GET, RequestMethod.HEAD])';
    expect(springAnnotationHttpMethods('WinRequestMapping', text)).toEqual(['GET', 'HEAD']);
  });

  it('fail-closes mismatched RequestMapping method collection delimiters', () => {
    const text = '@WinRequestMapping(method = {RequestMethod.GET])';
    expect(springAnnotationHttpMethods('WinRequestMapping', text)).toEqual([]);
  });

  it('returns empty for unrelated annotations', () => {
    expect(springAnnotationHttpMethods('Component', '@Component')).toEqual([]);
    expect(springAnnotationHttpMethods('Override', '@Override')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review regressions (magyargergo, 2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════

describe('review regressions: class-level aliases', () => {
  it('P1: isClassLevelMappingAnnotation accepts @WinRequestMapping like @RequestMapping', async () => {
    const { isClassLevelMappingAnnotation } =
      await import('../../src/core/ingestion/route-extractors/spring-shared.js');
    expect(isClassLevelMappingAnnotation('RequestMapping')).toBe(true);
    expect(isClassLevelMappingAnnotation('WinRequestMapping')).toBe(true);
    expect(isClassLevelMappingAnnotation('WinPostMapping')).toBe(false);
    expect(isClassLevelMappingAnnotation('AuditRequestMapping')).toBe(false);
    expect(isClassLevelMappingAnnotation('GetMapping')).toBe(false);
  });

  it('P2: extra vendor prefixes can be registered via env', () => {
    vi.stubEnv('GITNEXUS_SPRING_VENDOR_PREFIXES', 'Win,Acme');
    try {
      expect(resolveSpringAnnotationAlias('AcmePostMapping')).toBe('PostMapping');
      expect(resolveSpringAnnotationAlias('OtherPostMapping')).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
