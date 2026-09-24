/**
 * #2744 — the summary `impact()`/`context()` read to decide exact vs
 * lower-bound. Keyed by member name because a dropped site's callee is
 * unknown; see the module doc for why per-target attribution is impossible.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_UNRESOLVED_RECEIVER_MEMBERS,
  lookupExternalCallCount,
  lookupUnresolvedCallCount,
  summarizeUnresolvedReceivers,
} from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import { classifyReceiverShape } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import type {
  ReceiverOrigin,
  ResolutionOutcome,
} from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import { classifyReceiverOrigin } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { decodeReceiverChain } from '../../../src/core/ingestion/utils/receiver-chain-codec.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { goScopeResolver } from '../../../src/core/ingestion/languages/go/scope-resolver.js';
import { javaScopeResolver } from '../../../src/core/ingestion/languages/java/scope-resolver.js';
import { buildScopeModel, type ScopeModelFixture } from '../../helpers/scope-model.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 1 };

function dropped(
  name: string,
  siteKind: 'call' | 'read' | 'write' = 'call',
  receiverOrigin?: ReceiverOrigin,
): ResolutionOutcome {
  return {
    kind: 'suppressed',
    reason: 'receiver-unresolved',
    candidateIds: [],
    phase: 'receiver-bound-calls',
    filePath: 'a.py',
    name,
    range,
    siteKind,
    ...(receiverOrigin === undefined ? {} : { receiverOrigin }),
  };
}

describe('summarizeUnresolvedReceivers', () => {
  it('returns undefined when nothing was dropped, so a clean repo stores no key', () => {
    expect(summarizeUnresolvedReceivers([])).toBeUndefined();
  });

  it('ignores suppressions that are not receiver-unresolved', () => {
    const ambiguous: ResolutionOutcome = {
      kind: 'suppressed',
      reason: 'member-lookup-ambiguous',
      candidateIds: ['a', 'b'],
      phase: 'receiver-bound-calls',
      filePath: 'a.py',
      name: 'save',
      range,
    };
    const resolved: ResolutionOutcome = {
      kind: 'resolved',
      targetId: 't',
      phase: 'receiver-bound-calls',
      filePath: 'a.py',
      name: 'save',
      range,
    };
    expect(summarizeUnresolvedReceivers([ambiguous, resolved])).toBeUndefined();
  });

  it('counts dropped sites per member name', () => {
    expect(
      summarizeUnresolvedReceivers([dropped('save'), dropped('save'), dropped('run')]),
    ).toMatchObject({
      counts: { save: 2, run: 1 },
      totalSites: 3,
    });
  });

  it('caps the map, keeps the highest counts, and reports what it omitted', () => {
    const outcomes: ResolutionOutcome[] = [];
    // One name well past the cap that must survive on count alone.
    for (let i = 0; i < 5; i++) outcomes.push(dropped('zzz_hottest'));
    for (let i = 0; i < MAX_UNRESOLVED_RECEIVER_MEMBERS + 10; i++) {
      outcomes.push(dropped(`member${i}`));
    }
    const summary = summarizeUnresolvedReceivers(outcomes);
    expect(Object.keys(summary!.counts)).toHaveLength(MAX_UNRESOLVED_RECEIVER_MEMBERS);
    expect(summary!.counts.zzz_hottest).toBe(5);
    // The true total always reflects every drop, not just the kept sample.
    expect(summary!.totalSites).toBe(MAX_UNRESOLVED_RECEIVER_MEMBERS + 15);
    expect(summary!.omittedNames).toBe(11);
  });

  it('orders deterministically so the persisted metadata does not churn', () => {
    const a = summarizeUnresolvedReceivers([dropped('b'), dropped('a'), dropped('c')]);
    const b = summarizeUnresolvedReceivers([dropped('c'), dropped('b'), dropped('a')]);
    expect(Object.keys(a!.counts)).toEqual(Object.keys(b!.counts));
  });

  it('counts CALL sites only — a property read or write is not a dropped call', () => {
    // Case 0's recorder gates on the receiver's punctuation, not on what the
    // reference IS, so reads and writes land in the same bucket as lost calls
    // (25 of 124 on the fixture corpus). Counting them made the consumer's
    // "N call sites invoking X were dropped" literally false.
    const summary = summarizeUnresolvedReceivers([
      dropped('save', 'call'),
      dropped('name', 'write'),
      dropped('kind', 'read'),
    ]);
    expect(summary).toMatchObject({ counts: { save: 1 }, totalSites: 1 });
    expect(summary?.counts).not.toHaveProperty('name');
    expect(summary?.counts).not.toHaveProperty('kind');
  });

  it('returns undefined when every drop is a property access', () => {
    expect(summarizeUnresolvedReceivers([dropped('name', 'write')])).toBeUndefined();
  });

  it('does not leak Object.prototype members through the counts lookup', () => {
    // `counts` is revived from JSON and carries `Object.prototype`, so a bare
    // `counts[symName]` returns a FUNCTION for these names — and `NaN <= 0` is
    // false, so a `<= 0` guard lets it through. `impact({target:"constructor"})`
    // then reported `epistemic: 'lower-bound'` and interpolated
    // `function Object() { [native code] }` as the call count.
    const summary = summarizeUnresolvedReceivers([dropped('save')]);
    for (const polluted of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__',
    ]) {
      expect(lookupUnresolvedCallCount(summary, polluted)).toBeUndefined();
    }
    // A genuinely recorded name still reads back.
    expect(lookupUnresolvedCallCount(summary, 'save')).toBe(1);
    expect(lookupUnresolvedCallCount(summary, 'neverRecorded')).toBeUndefined();
    expect(lookupUnresolvedCallCount(undefined, 'save')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Origin routing. `external` is the one verdict that makes a drop STOP hedging,
// so it is the one verdict that must come from positive evidence — everything
// else has to keep counting.
// ---------------------------------------------------------------------------

describe('summarizeUnresolvedReceivers origin routing', () => {
  it('keeps an external-rooted drop out of totalSites but inside the artifact', () => {
    const summary = summarizeUnresolvedReceivers([
      dropped('save', 'call', 'in-program'),
      dropped('log', 'call', 'external'),
    ]);
    expect(summary).toMatchObject({
      counts: { save: 1 },
      totalSites: 1,
      externalCounts: { log: 1 },
      externalSites: 1,
    });
    // Routed, not discarded: the split stays auditable and reversible.
    expect(summary?.counts).not.toHaveProperty('log');
  });

  it('counts an unknown-origin drop, because unproven completeness is the unsafe direction', () => {
    // The `droppedCall(svc)` population: an unannotated parameter is recorded
    // nowhere in the scope model, so the classifier can prove nothing about it.
    // It must hedge, exactly like `in-program`.
    expect(
      summarizeUnresolvedReceivers([
        dropped('save', 'call', 'unknown'),
        dropped('run', 'call', 'in-program'),
      ]),
    ).toMatchObject({ counts: { save: 1, run: 1 }, totalSites: 2 });
  });

  it('counts a drop that carries no origin at all', () => {
    expect(summarizeUnresolvedReceivers([dropped('save')])).toMatchObject({
      counts: { save: 1 },
      totalSites: 1,
    });
  });

  it('reports external truncation past the cap, symmetrically with omittedNames', () => {
    // Without the twin, `lookupExternalCallCount` returns `undefined` for a
    // truncated name — indistinguishable from "this member had no external
    // drops" — and `externalSites` exceeds the sum of `externalCounts` with
    // nothing in the artifact to explain the gap.
    const outcomes: ResolutionOutcome[] = [];
    for (let i = 0; i < 5; i++) outcomes.push(dropped('zzz_hottest', 'call', 'external'));
    for (let i = 0; i < MAX_UNRESOLVED_RECEIVER_MEMBERS + 10; i++) {
      outcomes.push(dropped(`ext${i}`, 'call', 'external'));
    }
    const summary = summarizeUnresolvedReceivers(outcomes);
    expect(Object.keys(summary!.externalCounts!)).toHaveLength(MAX_UNRESOLVED_RECEIVER_MEMBERS);
    expect(summary).toMatchObject({
      totalSites: 0,
      externalSites: MAX_UNRESOLVED_RECEIVER_MEMBERS + 15,
      externalOmittedNames: 11,
    });
    // The hottest name survives the cap on count alone and still reads back.
    expect(lookupExternalCallCount(summary, 'zzz_hottest')).toBe(5);
  });

  it('omits the external truncation marker when nothing was truncated', () => {
    const summary = summarizeUnresolvedReceivers([dropped('log', 'call', 'external')]);
    expect(summary).toMatchObject({ externalSites: 1 });
    expect(summary).not.toHaveProperty('externalOmittedNames');
  });
});

// ---------------------------------------------------------------------------
// `classifyReceiverOrigin` — the classifier the routing above consumes.
//
// Built from real scope extraction rather than hand-assembled indexes: the
// defect being pinned is that source-level intuition about what a binding
// CONTAINS is wrong (Go normalizes a free parameter's `*Host` to `Host` at
// capture but leaves a method receiver's spelled `*Host` intact), so a fixture
// that asserts the binding shape by hand would pin the intuition, not the code.
// ---------------------------------------------------------------------------

/** The provider-hook bag `classifyReceiverOrigin` reads. Derived from the
 *  function so the two cannot drift. */
type OriginHooks = Parameters<typeof classifyReceiverOrigin>[4];

/** Classify the receiver of the (unique) reference site invoking `memberName`
 *  under `hooks`, through exactly the arguments the pass threads at its drop
 *  recorder. */
function classifyOriginOf(
  fixture: ScopeModelFixture,
  memberName: string,
  hooks: OriginHooks,
): ReceiverOrigin {
  const site = fixture.sites.find(
    (candidate) => candidate.name === memberName && candidate.explicitReceiver !== undefined,
  );
  expect(site).toBeDefined();
  return classifyReceiverOrigin(
    decodeReceiverChain(site!.receiverChain),
    site!.inScope,
    site!.explicitReceiver!.name,
    fixture.scopes,
    hooks,
  );
}

/** The normal path: the language's own contract hooks, exactly as the pass
 *  supplies them. */
function originOf(fixture: ScopeModelFixture, memberName: string): ReceiverOrigin {
  return classifyOriginOf(fixture, memberName, {
    stripTypePreservingDecoration: fixture.resolver.stripTypePreservingDecoration,
    isBuiltInName: fixture.resolver.languageProvider.isBuiltInName,
  });
}

/** The degradation path: the same site with the language's provider hooks
 *  WITHHELD, as for a language that declares neither.
 *
 *  Named rather than spelled `originOf(fixture, name, {})` — an empty options
 *  object reads as "defaults", so a reader "simplifying" it away silently
 *  flips the assertion from the degradation path to the normal path, and some
 *  of these would still pass while no longer testing anything. */
function originOfWithoutHooks(fixture: ScopeModelFixture, memberName: string): ReceiverOrigin {
  return classifyOriginOf(fixture, memberName, {});
}

const goFixture = buildScopeModel(
  goScopeResolver,
  `package main

type Host struct{ name string }

func (h *Host) Inner() *Host { return h }

func (h *Host) Run() {
	h.Inner().Dispatch()
}
`,
  'main.go',
);

const tsFixture = buildScopeModel(
  typescriptScopeResolver,
  `export class User {
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
}

// The PR's own integration fixture. An unannotated parameter is recorded
// NOWHERE in the scope model — no type binding, no value binding, no qualified
// name — so nothing about it can be demonstrated in either direction.
export function droppedCall(svc): void {
  svc.getUser().save();
}

// A local the program demonstrably declares, whose initializer we cannot type.
export function viaLocal(): void {
  const loc = makeIt();
  loc.getUser().persist();
}

// Genuinely outside: the language itself names \`console\`.
export function viaConsole(): void {
  console.log('x');
}

// Declared type is a bare built-in, so the member lives outside too.
export function viaDate(d: Date): void {
  d.getTime();
}
`,
  'main.ts',
);

// #2744. Java is the language the boundary signal matters most for (the
// Spring/DI analysis is built on it) and the one that had no built-in set at
// all, so every drop in it hedged. Same construction as the fixtures above —
// real scope extraction, real provider hook — because the cases that matter are
// exactly the ones source-level intuition gets wrong: a `java.util` import does
// NOT produce an in-program binding (so the base still reaches the built-in
// set), and a `List<String>` declaration does not bind its base to `List`.
const javaFixture = buildScopeModel(
  javaScopeResolver,
  `import java.util.List;
import java.util.Map;

public class Probe {
    private UserService svc;
    private List<String> names;

    public void go(OrderRepository repo, String raw) {
        System.out.println("x");
        String.format("%s", raw);
        raw.trim();
        names.iterator();
        List.of("a");
        Map.entry("a", "b");
        Helper.assist();
        svc.loadUser();
        repo.findAll();
    }
}

class Helper {
    static void assist() {}
}

class UserService {
    User loadUser() { return null; }
}

class User {}
`,
  'src/Probe.java',
);

describe('classifyReceiverOrigin', () => {
  // #2766. \`func (h *Host)\` binds \`h\` to the literal \`*Host\`; a free parameter
  // \`x *Host\` is normalized to \`Host\` at capture. Only the receiver spelling
  // needs the stripper, which is why the defect hid behind passing tests.
  it('reads a Go pointer receiver as in-program', () => {
    expect(originOf(goFixture, 'Dispatch')).toBe('in-program');
  });

  it('degrades to unknown, never external, when the language gives no stripper', () => {
    // The same site with the hook withheld: \`*Host\` still resolves to no class,
    // and the honest answer is that we could not tell — NOT that the JDK owns
    // it. Returning `external` here is what published `epistemic: 'exact'` over
    // every drop in a Go method body.
    expect(originOfWithoutHooks(goFixture, 'Dispatch')).toBe('unknown');
  });

  it('does not call an unannotated parameter external', () => {
    expect(originOf(tsFixture, 'save')).not.toBe('external');
    expect(originOf(tsFixture, 'save')).toBe('unknown');
  });

  it('reads a declared local with an untypable initializer as in-program', () => {
    expect(originOf(tsFixture, 'persist')).toBe('in-program');
  });

  // The test that proves the feature was fixed rather than deleted.
  it('still reports a language built-in receiver as external', () => {
    expect(originOf(tsFixture, 'log')).toBe('external');
  });

  it('still reports a base whose declared type is a bare built-in as external', () => {
    expect(originOf(tsFixture, 'getTime')).toBe('external');
  });

  it('never claims external without the built-in hook', () => {
    // A language that declares no built-in set has no positive external evidence
    // available at all, so every one of its drops must hedge. Java used to be
    // such a language; COBOL still is.
    expect(originOfWithoutHooks(tsFixture, 'log')).toBe('unknown');
    expect(originOfWithoutHooks(tsFixture, 'getTime')).toBe('unknown');
  });

  // ── Java (#2744) ────────────────────────────────────────────────────────
  // Before Java had a built-in set, every assertion in this block read
  // `lower-bound`-inducing `unknown`.

  it('reports a Java static platform receiver as external', () => {
    // `System.out.println(...)` — the chain base is `System`, not `out`.
    expect(originOf(javaFixture, 'println')).toBe('external');
    expect(originOf(javaFixture, 'format')).toBe('external');
  });

  it('reports a Java base whose declared type is a platform type as external', () => {
    // `String raw` — the parameter is in-program, the member it dispatches is not.
    expect(originOf(javaFixture, 'trim')).toBe('external');
    // A FIELD declared `List<String>`. Java binds a known container to its
    // ELEMENT type, so what reaches the built-in check is `String`, not `List` —
    // asserting this from the source spelling would pin the wrong thing. Either
    // way the verdict is the honest one, and without the set it read `in-program`
    // off the value channel and hedged every JDK collection call in the repo.
    expect(originOf(javaFixture, 'iterator')).toBe('external');
  });

  it('reports a java.util static receiver as external despite its import', () => {
    // `import java.util.List` resolves to no workspace file, so it leaves no
    // in-program binding and `List` falls through to the built-in set.
    expect(originOf(javaFixture, 'of')).toBe('external');
  });

  it('still reports Java receivers the program declares as in-program', () => {
    expect(originOf(javaFixture, 'assist')).toBe('in-program');
    expect(originOf(javaFixture, 'loadUser')).toBe('in-program');
  });

  it('still hedges a Java receiver whose declared type is simply unknown here', () => {
    // `OrderRepository` is declared nowhere in this program and is not a platform
    // name. Absence of evidence stays `unknown` — the safe direction.
    expect(originOf(javaFixture, 'findAll')).not.toBe('external');
    expect(originOf(javaFixture, 'findAll')).toBe('unknown');
  });

  it('hedges a platform name deliberately kept OUT of the set', () => {
    // `Map.entry(...)` is the exact syntactic twin of the `List.of(...)` above;
    // the only thing separating the two verdicts is set membership. `Map` is a
    // name applications really do declare (and in Java a same-package type needs
    // no import to shadow it), so it stays out and its drops keep hedging. This
    // pins the under-inclusion choice as a choice, not an oversight.
    expect(originOf(javaFixture, 'entry')).toBe('unknown');
  });

  it('degrades every Java verdict to unknown when the hook is withheld', () => {
    expect(originOfWithoutHooks(javaFixture, 'format')).toBe('unknown');
    expect(originOfWithoutHooks(javaFixture, 'trim')).toBe('unknown');
  });
});

describe('classifyReceiverShape', () => {
  it('reports no-chain when the site carried no chain', () => {
    expect(classifyReceiverShape(undefined)).toBe('no-chain');
  });

  it('reports no-chain for a chain with no steps', () => {
    expect(classifyReceiverShape({ steps: [] })).toBe('no-chain');
  });

  it('reports chain-call when every step is a call', () => {
    expect(classifyReceiverShape({ steps: [{ kind: 'call' }, { kind: 'call' }] })).toBe(
      'chain-call',
    );
  });

  it('reports chain-field when every step is a field', () => {
    expect(classifyReceiverShape({ steps: [{ kind: 'field' }] })).toBe('chain-field');
  });

  // The distinction that makes the census actionable: a mixed chain fails for
  // different reasons than a pure one, so collapsing it into either bucket
  // would misattribute the population a fix has to target.
  it('reports chain-mixed when the chain interleaves calls and fields', () => {
    expect(classifyReceiverShape({ steps: [{ kind: 'call' }, { kind: 'field' }] })).toBe(
      'chain-mixed',
    );
  });
});
