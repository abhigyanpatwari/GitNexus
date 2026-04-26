/**
 * Unit tests for the dev-mode I8 binding-immutability validator.
 *
 * Mirrors `validateOwnershipParity` (#909) — happy path + drift
 * detection + production no-op gating. Pinning these so a
 * future contributor can't silently re-introduce the issue #1066
 * shape (a hook mutating `indexes.bindings` instead of
 * `indexes.bindingAugmentations`) without tripping the validator.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGate = process.env.VALIDATE_SEMANTIC_MODEL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalGate === undefined) delete process.env.VALIDATE_SEMANTIC_MODEL;
    else process.env.VALIDATE_SEMANTIC_MODEL = originalGate;
  });

  it('is silent when finalized buckets are frozen and augmentation buckets are mutable', () => {
    process.env.NODE_ENV = 'development';
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
    process.env.NODE_ENV = 'development';
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
    process.env.NODE_ENV = 'development';
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

  it('counts violations across multiple scopes', () => {
    process.env.NODE_ENV = 'development';
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
    process.env.NODE_ENV = 'production';
    const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>([
      ['scope:a:module', new Map([['Foo', [mkRef('def:Foo')] as readonly BindingRef[]]])],
    ]);
    const augmentations = new Map<ScopeId, Map<string, BindingRef[]>>();
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(mkIndexes(bindings, augmentations), onWarn);

    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('is a no-op when VALIDATE_SEMANTIC_MODEL=0', () => {
    process.env.NODE_ENV = 'development';
    process.env.VALIDATE_SEMANTIC_MODEL = '0';
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
