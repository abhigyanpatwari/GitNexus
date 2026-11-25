/**
 * #2744 — the summary `impact()`/`context()` read to decide exact vs
 * lower-bound. Keyed by member name because a dropped site's callee is
 * unknown; see the module doc for why per-target attribution is impossible.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReceiverOrigin } from '../../../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import {
  buildReceiverOriginEvidence,
  classifyReceiverOrigin,
} from '../../../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { decodeReceiverChain } from '../../../../../src/core/ingestion/utils/receiver-chain-codec.js';
import { javaScopeResolver } from '../../../../../src/core/ingestion/languages/java/scope-resolver.js';
import {
  buildScopeModel,
  type ScopeModelFixture,
} from '../../../../../test/helpers/scope-model.js';

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
type OriginHooks = Parameters<typeof classifyReceiverOrigin>[5];

/** Classify the receiver of the (unique) reference site invoking `memberName`
 *  under `hooks`, through exactly the arguments the pass threads at its drop
 *  recorder. */
function classifyOriginOf(
  fixture: ScopeModelFixture,
  memberName: string,
  hooks: OriginHooks,
): ReceiverOrigin {
  const site =
    fixture.sites.find(
      (candidate) => candidate.name === memberName && candidate.explicitReceiver !== undefined,
    ) ?? assert.fail(`no receiver site invokes \`${memberName}\``);
  const receiver =
    site.explicitReceiver ?? assert.fail(`\`${memberName}\` has no explicit receiver`);
  return classifyReceiverOrigin(
    decodeReceiverChain(site.receiverChain),
    site.inScope,
    receiver.name,
    site.name,
    fixture.scopes,
    hooks,
  );
}

/** The normal path: the language's own contract hooks, built by the same
 *  factory the pass calls. The fold flags mirror the ones the pass hands
 *  `resolveCompoundReceiverClass`, read off the resolver. */
function originOf(fixture: ScopeModelFixture, memberName: string): ReceiverOrigin {
  const { resolver } = fixture;
  return classifyOriginOf(
    fixture,
    memberName,
    buildReceiverOriginEvidence({
      parsedFiles: [fixture.parsed],
      scopes: fixture.scopes,
      index: fixture.index,
      foldOptions: {
        fieldFallback: resolver.fieldFallbackOnMethodLookup ?? true,
        elementTypeOf: resolver.elementTypeOf,
        hoistTypeBindingsToModule: resolver.hoistTypeBindingsToModule === true,
        stripTypePreservingDecoration: resolver.stripTypePreservingDecoration,
        resolveThisViaEnclosingClass: resolver.resolveThisViaEnclosingClass,
      },
      stripTypePreservingDecoration: resolver.stripTypePreservingDecoration,
      isBuiltInName: resolver.languageProvider.isBuiltInName,
      externalReceiverNames: resolver.languageProvider.externalReceiverNames,
      isExternalModuleSpecifier: resolver.languageProvider.isExternalModuleSpecifier,
    }),
  );
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
        Set.copyOf(names);
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
  // ── Java (#2744) ────────────────────────────────────────────────────────
  // Before Java had a built-in set, every assertion in this block read
  // `lower-bound`-inducing `unknown`.

  it('reports a Java static platform receiver as external', () => {
    // `System.out.println(...)` — the chain base is `System`, not `out`.
    assert.equal(originOf(javaFixture, 'println'), 'external');
    assert.equal(originOf(javaFixture, 'format'), 'external');
  });

  it('reports a Java base whose declared type is a platform type as external', () => {
    // `String raw` — the parameter is in-program, the member it dispatches is not.
    assert.equal(originOf(javaFixture, 'trim'), 'external');
    // A FIELD declared `List<String>`. Java binds a known container to its
    // ELEMENT type, so what reaches the built-in check is `String`, not `List` —
    // asserting this from the source spelling would pin the wrong thing. Either
    // way the verdict is the honest one, and without the set it read `in-program`
    // off the value channel and hedged every JDK collection call in the repo.
    assert.equal(originOf(javaFixture, 'iterator'), 'external');
  });

  it('reports a java.util static receiver as external despite its import', () => {
    // `import java.util.List` resolves to no workspace file, so it leaves no
    // in-program binding and `List` falls through to the built-in set.
    assert.equal(originOf(javaFixture, 'of'), 'external');
  });

  it('still reports Java receivers the program declares as in-program', () => {
    assert.equal(originOf(javaFixture, 'assist'), 'in-program');
    assert.equal(originOf(javaFixture, 'loadUser'), 'in-program');
  });

  it('still hedges a Java receiver whose declared type is simply unknown here', () => {
    // `OrderRepository` is declared nowhere in this program and is not a platform
    // name. Absence of evidence stays `unknown` — the safe direction.
    assert.notEqual(originOf(javaFixture, 'findAll'), 'external');
    assert.equal(originOf(javaFixture, 'findAll'), 'unknown');
  });

  it('hedges an unimported platform name deliberately kept OUT of the set', () => {
    // `Set.copyOf(...)` is the exact syntactic twin of the `List.of(...)` above,
    // and nothing in the file imports `Set`. `Set` is a name applications really
    // do declare, and in Java an unimported one can only be a type of this
    // package, so it stays out and its drops keep hedging. This pins the
    // under-inclusion choice as a choice, not an oversight.
    assert.equal(originOf(javaFixture, 'copyOf'), 'unknown');
  });

  it('reads an explicit platform import as evidence whatever the set says', () => {
    // `import java.util.Map` shadows any same-package `Map` (JLS §6.4.1) and can
    // never resolve in-workspace, so the import itself places `Map.entry(...)`
    // in the JDK. Before the import counted, this drop hedged on set membership
    // alone.
    assert.equal(originOf(javaFixture, 'entry'), 'external');
  });

  it('degrades every Java verdict to unknown when the hook is withheld', () => {
    assert.equal(originOfWithoutHooks(javaFixture, 'format'), 'unknown');
    assert.equal(originOfWithoutHooks(javaFixture, 'trim'), 'unknown');
  });
});

const javaLibraryFixture = buildScopeModel(
  javaScopeResolver,
  `public class Probe {
    public void qualified() {
        java.util.Optional.of("x");
    }

    public void shadowed(Holder java) {
        java.util.run();
    }
}

class Holder {
    Util util;
}

class Util {
    void run() {}
}
`,
  'src/Probe.java',
);

describe('classifyReceiverOrigin — library and runtime receivers', () => {
  for (const example of [['Java platform package root', javaLibraryFixture, 'of']] as const) {
    it(`reports ${example[0]} as external`, () => {
      const [_label, fixture, memberName] = example;

      assert.equal(originOf(fixture, memberName), 'external');
    });
  }

  for (const example of [
    ['a Java parameter named java', 'in-program', javaLibraryFixture, 'run'],
  ] as const) {
    it(`keeps ${example[0]} ${example[1]}`, () => {
      const [_label, expected, fixture, memberName] = example;

      assert.equal(originOf(fixture, memberName), expected);
    });
  }
});
