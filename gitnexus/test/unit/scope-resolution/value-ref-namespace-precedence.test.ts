/**
 * `findNamespaceValueRefTarget` precedence: a name the target module DECLARES
 * beats a name it merely re-publishes, and it beats it whether or not the
 * declaration happens to be callable (#3219 review round 8).
 *
 * The channel resolves `bridge.accessor(hub.scale, …)` by reading the target
 * module's own module-scope bindings first and its re-published ones second.
 * The order is only meaningful if the FIRST lookup decides on the NAME: it
 * applies `CALL_TARGET_TYPES` while it selects, so a target module declaring a
 * non-callable `scale` answers nothing there and — before this guard — fell
 * through to the published channel and bound an imported callable under a name
 * the module's own declaration owns. `findExportedDef` does not behave that
 * way: it returns any local def and lets the caller's type gate reject it, so
 * `findExportedDefIncludingImportedNames` never reaches the imported names for
 * a name the file declares. `hub.scale` and `hub.scale()` must not disagree
 * about which module owns `scale`.
 *
 * WHY THE INDEXES ARE HAND-BUILT, stated so this is not read as a fixture that
 * "just happens" to be synthetic. Zig forbids declaring a name twice in one
 * container, and Zig is today the only provider that sets
 * `namespaceExportsIncludeImportedNames`, so no valid Zig source can put a
 * local non-callable and a published callable under one name in one module —
 * there is no source-level fixture to write. The shape becomes reachable the
 * moment a second provider opts in, or a receiver name binds more than one
 * target file. Building the indexes directly is what lets the guard be pinned
 * before that happens; the middle case below fails without it.
 */

import { describe, it, expect } from 'vitest';
import { resolveValueRefTarget } from '../../../src/core/ingestion/scope-resolution/passes/property-dispatch.js';
import type { BindingRef, ReferenceSite, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';

const CONSUMER_FILE = 'src/Element.zig';
const HUB_FILE = 'src/hub.zig';
const CONSUMER = 'scope:consumer:module' as ScopeId;
const HUB = 'scope:hub:module' as ScopeId;

const def = (nodeId: string, type: string, filePath: string): SymbolDefinition =>
  ({ nodeId, name: 'scale', type, filePath }) as unknown as SymbolDefinition;

const ref = (d: SymbolDefinition, origin: string): BindingRef =>
  ({ def: d, origin }) as unknown as BindingRef;

/** The callable `hub.zig` re-publishes from `dom_utils.zig`. */
const PUBLISHED = def('Function:src/dom_utils.zig:scale', 'Function', 'src/dom_utils.zig');
/** A `scale` the hub declares ITSELF, in the two kinds that matter. */
const LOCAL_CONST = def('Const:src/hub.zig:scale', 'Const', HUB_FILE);
const LOCAL_FN = def('Function:src/hub.zig:scale', 'Function', HUB_FILE);

function moduleScope(id: ScopeId, filePath: string): Scope {
  return {
    id,
    kind: 'Module',
    parent: null,
    filePath,
    range: { startLine: 1, startCol: 0, endLine: 99, endCol: 0 },
    bindings: new Map(),
    typeBindings: new Map(),
    imports: [],
    ownedDefs: [],
  } as unknown as Scope;
}

/**
 * Everything `resolveValueRefTarget` reads for a qualified site whose receiver
 * is a namespace handle: the consumer's namespace import edge, and the target
 * module's local (`scopes.bindings`) and published (`bindingAugmentations`)
 * channels. `qualifiedNames` answers nothing so the CONTAINER channel — which
 * runs only if this one declines — cannot supply the resolution instead and
 * make a declining assertion pass for the wrong reason.
 */
function indexes(opts: {
  local?: readonly BindingRef[];
  published?: readonly BindingRef[];
}): ScopeResolutionIndexes {
  const scopesById = new Map<ScopeId, Scope>([
    [CONSUMER, moduleScope(CONSUMER, CONSUMER_FILE)],
    [HUB, moduleScope(HUB, HUB_FILE)],
  ]);
  const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
  if (opts.local !== undefined) bindings.set(HUB, new Map([['scale', opts.local]]));
  const augmentations = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
  if (opts.published !== undefined) augmentations.set(HUB, new Map([['scale', opts.published]]));
  return {
    scopeTree: { getScope: (id: ScopeId) => scopesById.get(id) },
    moduleScopes: new Map<string, ScopeId>([
      [CONSUMER_FILE, CONSUMER],
      [HUB_FILE, HUB],
    ]),
    imports: new Map([[CONSUMER, [{ kind: 'namespace', localName: 'hub', targetFile: HUB_FILE }]]]),
    bindings,
    bindingAugmentations: augmentations,
    workspaceFqnBindings: new Map(),
    namespaceFqnBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
    defs: new Map(),
    qualifiedNames: { get: () => [], has: () => false, size: 0 },
  } as unknown as ScopeResolutionIndexes;
}

/** `bridge.accessor(hub.scale, …)` written at the consumer's module scope. */
const SITE = {
  name: 'scale',
  kind: 'value-ref',
  inScope: CONSUMER,
  explicitReceiver: { name: 'hub' },
  atRange: { startLine: 10, startCol: 4, endLine: 10, endCol: 20 },
} as unknown as ReferenceSite;

const MODEL = {} as unknown as SemanticModel;

const resolve = (scopes: ScopeResolutionIndexes): SymbolDefinition | undefined =>
  resolveValueRefTarget(SITE, CONSUMER_FILE, scopes, MODEL, true);

describe('findNamespaceValueRefTarget — local declarations outrank re-published ones', () => {
  it('resolves a re-published callable when the hub declares nothing under the name', () => {
    // The control: this is the HUB case the channel exists for, and every
    // assertion below is only meaningful while it holds. If the guard were
    // written as "decline whenever anything is bound in the target module",
    // this is what would break.
    expect(resolve(indexes({ published: [ref(PUBLISHED, 'reexport')] }))?.nodeId).toBe(
      PUBLISHED.nodeId,
    );
  });

  it('declines when the hub declares a NON-callable under the name', () => {
    // The regression. The local lookup type-gates before precedence is settled,
    // so `scale` answered nothing locally and the published channel bound
    // `dom_utils.scale` — a USES edge to a member the hub does not expose under
    // that name, and the opposite of what `hub.scale()` resolves to.
    expect(
      resolve(
        indexes({
          local: [ref(LOCAL_CONST, 'local')],
          published: [ref(PUBLISHED, 'reexport')],
        }),
      ),
    ).toBeUndefined();
  });

  it('still prefers a local CALLABLE over a re-published one', () => {
    // The guard suppresses the published channel; it must not suppress the
    // local answer that made the precedence rule worth stating.
    expect(
      resolve(
        indexes({
          local: [ref(LOCAL_FN, 'local')],
          published: [ref(PUBLISHED, 'reexport')],
        }),
      )?.nodeId,
    ).toBe(LOCAL_FN.nodeId);
  });

  it('declines a re-published callable for a provider that does not publish its imports', () => {
    // `namespaceExportsIncludeImportedNames` is opt-in: in a language where a
    // module's imports are NOT its exports, the hub channel stays closed and
    // the guard above is never consulted.
    expect(
      resolveValueRefTarget(
        SITE,
        CONSUMER_FILE,
        indexes({ published: [ref(PUBLISHED, 'reexport')] }),
        MODEL,
        false,
      ),
    ).toBeUndefined();
  });
});
