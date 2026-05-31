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
  workspace: Map<string, readonly BindingRef[]> = new Map(),
  extra: Partial<{
    workspaceTypeBindings: Map<string, unknown>;
    namespaceFqnBindings: Map<string, Map<string, readonly BindingRef[]>>;
    namespaceTypeBindings: Map<string, Map<string, unknown>>;
  }> = {},
): ScopeResolutionIndexes =>
  ({
    bindings,
    bindingAugmentations: augmentations,
    workspaceFqnBindings: workspace,
    workspaceTypeBindings: extra.workspaceTypeBindings ?? new Map(),
    namespaceFqnBindings: extra.namespaceFqnBindings ?? new Map(),
    namespaceTypeBindings: extra.namespaceTypeBindings ?? new Map(),
    accessibleNamespacesByScope: new Map(),
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

  it('warns when a bucket in indexes.workspaceFqnBindings IS frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const workspace = new Map<string, readonly BindingRef[]>([
      ['User', Object.freeze([mkRef('def:User')]) as BindingRef[]],
    ]);
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(
      mkIndexes(new Map(), new Map(), workspace),
      onWarn,
    );

    expect(violations).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.workspaceFqnBindings/);
    expect(onWarn.mock.calls[0][0]).toMatch(/I8/);
  });

  it('warns when indexes.workspaceTypeBindings IS frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onWarn = vi.fn();

    const violations = validateBindingsImmutability(
      mkIndexes(new Map(), new Map(), new Map(), {
        workspaceTypeBindings: Object.freeze(new Map([['GetUser', {}]])) as Map<string, unknown>,
      }),
      onWarn,
    );

    expect(violations).toBe(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.workspaceTypeBindings/);
    expect(onWarn.mock.calls[0][0]).toMatch(/I8/);
  });

  it('warns when a per-namespace bucket in indexes.namespaceFqnBindings IS frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onWarn = vi.fn();
    const nsFqn = new Map<string, Map<string, readonly BindingRef[]>>([
      ['App', new Map([['User', Object.freeze([mkRef('def:User')]) as BindingRef[]]])],
    ]);

    const violations = validateBindingsImmutability(
      mkIndexes(new Map(), new Map(), new Map(), { namespaceFqnBindings: nsFqn }),
      onWarn,
    );

    expect(violations).toBe(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.namespaceFqnBindings\[App\]\[User\]/);
    expect(onWarn.mock.calls[0][0]).toMatch(/I8/);
  });

  it('warns when a per-namespace map in indexes.namespaceTypeBindings IS frozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onWarn = vi.fn();
    const nsType = new Map<string, Map<string, unknown>>([
      ['App', Object.freeze(new Map([['GetUser', {}]])) as Map<string, unknown>],
    ]);

    const violations = validateBindingsImmutability(
      mkIndexes(new Map(), new Map(), new Map(), { namespaceTypeBindings: nsType }),
      onWarn,
    );

    expect(violations).toBe(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/indexes\.namespaceTypeBindings\[App\]/);
  });

  it('is silent when the new channels are present and unfrozen', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onWarn = vi.fn();
    const violations = validateBindingsImmutability(
      mkIndexes(new Map(), new Map(), new Map(), {
        workspaceTypeBindings: new Map([['GetUser', {}]]),
        namespaceFqnBindings: new Map([['App', new Map([['User', [mkRef('def:User')]]])]]),
        namespaceTypeBindings: new Map([['App', new Map([['GetUser', {}]])]]),
      }),
      onWarn,
    );
    expect(violations).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
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
