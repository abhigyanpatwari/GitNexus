/**
 * Unit tests for the dev-mode I8 binding-immutability validator.
 *
 * Mirrors `validateOwnershipParity` (#909) — happy path + drift
 * detection + opt-in runtime gating. Pinning these so a
 * future contributor can't silently re-introduce the issue #1066
 * shape (a hook mutating `indexes.bindings` instead of
 * `indexes.bindingAugmentations`) without tripping the validator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BindingRef, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { validateBindingsImmutability } from '../../../src/core/ingestion/scope-resolution/pipeline/validate-bindings-immutability.js';

const mkRef = (nodeId: string): BindingRef =>
  ({
    def: { nodeId, filePath: 'x.ts', type: 'Class' },
    origin: 'local',
  }) as unknown as BindingRef;

const mkIndexes = (
  bindings: Map<ScopeId, Map<string, readonly BindingRef[]>>,
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
): ScopeResolutionIndexes =>
  ({
    bindings,
    bindingAugmentations: augmentations,
  }) as unknown as ScopeResolutionIndexes;

describe('validateBindingsImmutability', () => {
  beforeEach(() => {
    // Insulate against an ambient VALIDATE_SEMANTIC_MODEL in a developer's
    // shell. Per-test env tweaks override this baseline as needed.
    vi.stubEnv('VALIDATE_SEMANTIC_MODEL', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is silent when finalized buckets are frozen and augmentation buckets are mutable', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', Object.freeze([mkRef('def:Foo')])]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>([
      ['scope:a:module', new Map([['Bar', [mkRef('def:Bar')]]])],
    ]);
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns when a bucket in indexes.bindings is NOT frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/binding-immutability/);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.bindings/);
    expect(onWarn.mock.calls[0][0]).toMatch(/I8/);
  });

  it('warns when a bucket in indexes.bindingAugmentations IS frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>([
      ['scope:a:module', new Map([['Bar', Object.freeze([mkRef('def:Bar')]) as BindingRef[]]])],
    ]);
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/binding-immutability/);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.bindingAugmentations/);
    expect(onWarn.mock.calls[0][0]).toMatch(/I8/);
  });

  it('does not detect semantically wrong frozen replacements in indexes.bindings', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', Object.freeze([mkRef('def:Wrong')])]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('counts violations across multiple scopes', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
      ['scope:b:module', new Map([['Bar', [mkRef('def:Bar')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(2);
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('is a no-op in default CLI env when NODE_ENV is unset', () => {
    vi.stubEnv('NODE_ENV', undefined);
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('runs when VALIDATE_SEMANTIC_MODEL=1 even if NODE_ENV is unset', () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('VALIDATE_SEMANTIC_MODEL', '1');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when VALIDATE_SEMANTIC_MODEL=0', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VALIDATE_SEMANTIC_MODEL', '0');
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });
});
