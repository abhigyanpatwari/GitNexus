/**
 * Chunk-level content-addressed parse cache.
 *
 * The pipeline always parses every file (correctness invariant: cross-file
 * resolution and downstream phases need full graph data). What this cache
 * does is skip the tree-sitter worker dispatch when a chunk's contents
 * haven't changed since the last run.
 *
 * Granularity: chunk-level. The parse phase chunks files into ~20MB byte
 * budgets. The cache key is `sha256(joined(filePath:contentHash for each
 * file in the chunk, sorted))`. A change to a single file invalidates only
 * that file's chunk — typically 1 of ~50 chunks on a 1000-file repo.
 *
 * Why not per-file:
 * - Workers process sub-batches and emit aggregated `ParseWorkerResult`s.
 *   Splitting back to per-file would require reworking the worker contract.
 * - Chunk-level invalidation gives a useful speedup floor (98% on a single
 *   1-of-50 invalidated chunk) without touching the worker.
 *
 * Survives `--force` because it's content-addressed: the same bytes always
 * produce the same key. `--force` only matters for the LadybugDB writeback;
 * the cache itself is always safe to reuse.
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ParseWorkerResult } from '../core/ingestion/workers/parse-worker.js';

/**
 * Cache version composed of:
 *   - A schema bump knob (`SCHEMA_BUMP`) for hand-controlled invalidation
 *     when ParseWorkerResult shape or upstream parse semantics change.
 *   - The current `gitnexus` npm package version, read at module load.
 *     Any release that ships an updated tree-sitter grammar or revised
 *     extractor logic implies a version bump in package.json, which
 *     automatically invalidates the on-disk cache. Without this, a user
 *     running `npm i -g gitnexus@latest` after a parser-affecting
 *     release would silently replay pre-upgrade ParseWorkerResults
 *     against the new graph schema (Bugbot/Claude review on #1479).
 *
 * On version mismatch, `loadParseCache` returns an empty cache and the
 * next save overwrites the on-disk file with the new version baked in.
 */
// Bumped to 4 in #1983: on-disk parse-cache shards omit legacy DAG fields
// (`calls`, `assignments`, `constructorBindings`) unused after RING4-1 (#942)
// and the worker `parsedFiles` (the worker writes those to the disk ParsedFile
// store instead). #2038 added a DURABLE, content-addressed ParsedFile store
// (`parsedfile-cache/`, see parsedfile-store.ts) keyed by chunk hash that
// mirrors THIS cache's lifecycle — version-gated by PARSE_CACHE_VERSION, pruned
// in lockstep to the surviving keys. On a warm parse-cache hit the chunk's
// ParsedFiles are restored from it, so scope-resolution does NOT re-extract on
// the main thread (the #1983 OOM). Because the two stores share this version,
// any future change to the `ParsedFile` serialization shape MUST bump
// SCHEMA_BUMP so both invalidate in lockstep.
// v35: Java/Kotlin Spring @Bean factory and @Resource side-channel facts
// (#2413). ParsedFile results are content-addressed and replayed verbatim, so
// the feature/schema inventory alone cannot invalidate pre-#2413 captures.
// (Cut as v32 on this branch; `main` took 32 for #2742 and 33/34 for #2747
// first, so this series is renumbered at merge time — see the v21 note.)
// v34: the receiver-chain capture is emitted by ALL 14 language emitters, not
// just TypeScript. v33 landed with the TypeScript-only emission; the rollout to
// the other 13 languages changed the capture set AGAIN, so a cache stamped 33 by
// an intermediate build of that series is not equivalent to one stamped at this
// commit — it would be treated as current while every non-TypeScript file
// replayed pre-rollout captures, leaving the feature silently inert for 13 of 14
// languages. Bumped there so the version tracks the FINAL capture set rather
// than the first divergence.
// v33: TypeScript call matches carry `@reference.receiver-chain`, a compact
// encoding of a receiver that is itself an expression.
// v32: Rust items are qualified by their enclosing `mod` chain (#2742). The
// qualified name is computed in the parse worker, so a warm cache replays the
// old unqualified ids verbatim and the collapse persists.
// v31: Rust `mod_item` gained `@declaration.namespace` and scoped call sites
// gained `@reference.qualified-name` (#2730). Both are PARSE-TIME captures, so a
// warm cache replays the old capture set verbatim: `rawQualifiedName` comes back
// undefined and no Namespace def exists to hang a module prefix on, which turns
// the whole module-qualified resolution tier into a no-op on unchanged files.
// Re-checked against origin/main at commit time per the v29 note below.
// v29: closure-binding declaration rules for PHP/Rust/Kotlin/Ruby/Dart, a Rust
// graph node for `let f = || …`, a Dart closure scope, and function-local VALUES
// (Variable/Const/Property/Static) qualified by their enclosing callable plus
// position (#2699 parts A1 + B). All parse-time, so a warm cache would replay
// the old captures and the pre-qualification ids verbatim.
//
// This is 29 and not 28 because of the exact collision the v21 note below warns
// about: this branch cut at 27 and bumped to 28, while #2415 bumped 27 -> 28 and
// merged FIRST. Re-checking against origin/main at merge time — not at branch
// time — is what caught it; leaving it at 28 would have shipped this change with
// NO parse-cache invalidation, so every warm cache keeps serving the pre-fix
// captures and ids.
// v28: Java/Kotlin capture side-channels persist Spring condition facts and
// annotation-source line numbers (#2415).
// v26: the enclosing-callable walk stops at class bodies and anonymous-class
// construction sites (#2699 follow-up); a v25 cache replays worker results carrying the
// wrong Java anonymous-class ids. Cached results are replayed verbatim — including
// across `--force` — so without this bump a warm cache keeps serving them.
// v25: function-local callables are qualified by their enclosing-callable chain
// plus their own position, and JS/TS gain block scopes (#2699). Both the node
// ids AND the scope tree in a cached worker result are therefore stale. Cached
// results are replayed verbatim — including across `--force` — so without this
// bump a warm cache keeps serving the colliding ids and the block-less scopes.
// v24: function scopes carry `Scope.ownsReceivers`, marking the JS/TS forms
// that bind their own `this` (#2701). The flag lives on the cached `Scope`, so
// without this bump a warm cache replays scopes that lack it and every `this`
// inside an ordinary `function` keeps resolving to the enclosing class —
// verified by probe: `--force` alone does NOT re-derive it.
// v23: closure bindings emit callable nodes in Dart, Ruby, Java, C# and PHP
// (plus JS/TS `var`), and Dart/PHP gain the scope declarations and flow
// captures their forms were missing (#2693). Cached worker results are replayed
// verbatim, so without this bump a warm cache keeps serving the old labels.
// v22: `const X = <arrow | function-expression>` emits one `Function` node
// instead of a `Function` plus an edgeless `Const` twin (#2687). Cached worker
// results are replayed verbatim — including across `--force` — so without this
// bump a warm cache keeps serving the old two-node set.
// v21: TWO changes share this number — a collision, not a typo. #2632
// (Java/Kotlin Spring DI facts: constructor, field/property and method
// injection sites plus bean-name and @Primary provider metadata) bumped 20 -> 21
// and merged first; #2653 (Java local class/enum/record/interface captures using
// javac-compatible, source-type-relative JLS 13.1 identities and
// declaration-to-block scopes, #2562) had branched at 20, bumped to 21 as well,
// and merged second — so it shipped with NO invalidation of its own. An index
// already stamped 21 by the first change was treated as current by the second
// and kept serving stale local-class identities from the warm cache. Harmless
// now (anything below the current value is rejected), and left as-is because
// both genuinely shipped as 21 — renumbering would misstate history. Read this
// as the reason to re-check SCHEMA_BUMP against origin/main immediately before
// merging, not just when the branch is cut; the same collision hit
// the DB schema version in #2653/#2654 (that constant is gone — the DB side is
// a derived fingerprint now, see SCHEMA_FINGERPRINT; SCHEMA_BUMP below is still
// hand-maintained because no declarative artifact describes a capture set).
// v27: generator EXPRESSIONS bound to a name emit a callable definition capture,
// and nested-callable caller attribution appends the localIdentity suffix the
// definition phase already used. Both are parse-time, so a warm cache would
// otherwise replay the old captures and ids verbatim.
// v30/schema v22: CommonJS export capture emission (#2723) — new @definition/@declaration
// captures for exports.X, aliased receivers, module-level `this`, re-export
// forwarding and `module.exports = fn`, plus prototype/`this` Methods. A warm
// cache would otherwise replay the pre-fix captures verbatim.
// v20: Java/Kotlin capture side-channels persist package and class-annotation
// facts for shared Spring Bean resolution.
// v19: Java enum constant bodies emit E$N Class nodes; anonymous naming uses
// JLS 13.1 immediate-host chains (#2555).
// v18: Worker$N anonymous bodies. v17: callable-value-flow operand identity.
// v16: direct callee identity.
// v36: bound-callable graph `startLine` follows the initializer so multi-line
// closure bindings join the scope channel (#2735). Warm cache would otherwise
// keep serving wrapper-line startLines and drop the CALLS edge.
// v37: Java/Kotlin capture side-channels include Spring AOP owner/advice facts
// (#2416). Warm cache entries at v36 do not carry those facts and would silently
// omit ADVISED_BY evidence.
// v38: Swift nested conditional-compilation directives are blanked before the
// parse (#2771), so a class body that previously error-recovered away now
// survives. The chunk key hashes raw on-disk bytes and `preprocessSource` runs
// after it is computed, so unchanged Swift files would otherwise replay their
// pre-fix `ParseWorkerResult` verbatim — including across `--force`. Allocated
// on `main`, NOT by this branch — kept so the number is not reused a third time.
// v39: receiver-chain wire format v2 — the encoded chain gained name-free
// `await` and `index` step kinds, so the VERSION prefix moved 1 -> 2 and every
// persisted chain string changed. A v2 decoder REFUSES a v1 payload (that is
// the point: a chain missing its await or index hop decodes cleanly as a
// different, shorter chain and would type the receiver against the wrong
// member), so a stale cache replays chains this build silently discards —
// the feature degrades to the text cascade with no error anywhere. Bumped so
// the stale cache is rejected rather than half-read.
//
// NUMBERED 39, AFTER TWO REALLOCATIONS. This branch first used 37; `main` took
// 37 for Spring AOP (#2416) mid-flight, so it moved to 38; `main` then took 38
// for the Swift directive fix (#2771), landing on the branch's number AGAIN.
// That is the EIGHTH collision in this series and the SECOND exact clash — two
// incompatible schemas claiming one number, twice running. The lesson is not
// "pick a bigger number": it is that the check must happen immediately before
// merge, because the window between review and merge is exactly when `main`
// allocates. Re-check against origin/main before merging this.
// v40: inference-typed class fields emit type-binding captures in SIX languages
// (#2807) — TypeScript/JavaScript `public_field_definition|field_definition` with a
// `new_expression` value and `this.<field> = new X()`; Python `self.x = Outer()`;
// Ruby `@ivar = Foo.new`; Swift optional property annotations; Dart inferred-type
// and final field declarations plus constructor-body field writes. Every one of
// these is PARSE-TIME capture emission, so a warm cache replays the pre-fix
// capture set verbatim for byte-unchanged files and the new receiver edges never
// appear — silently, with no error, exactly the v27/v30 failure mode. `analyze`
// skips tree-sitter dispatch for unchanged chunks (GUARDRAILS.md), so a plain
// re-analyze does NOT surface them without this bump.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING — main was also at 39
// when this was allocated, and this file records eight prior collisions.
// v41: the v40 Dart field-write binding gained its READ-side mask (#2807 review)
// — a Dart class-member body that rebinds one of its class's field names now
// emits `@receiver-owner.shadowed-fields` on its synthesized `@scope.function`
// match, which becomes `Scope.ownsReceivers`. Parse-time capture emission again,
// so a v40 warm cache replays scope matches with no marker and the receiver walk
// still reaches the class field — i.e. it keeps serving the WRONG edge this
// bump's fix removes, silently. Same bump-or-nothing situation as v40.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// v42: the v40/v41 Python constructor-field arm stopped accepting a DOTTED
// callee (#2807 review). `self.svc = f.Alpha()` no longer emits a
// `@type-binding.constructor` capture at all, which is what removes the
// fabricated edge to the same-named class `Alpha` and what stops
// `self.conn = Registry.get()` displacing an earlier real `self.conn = Outer()`.
// A within-PR re-bump, not a collision fix: v41 was allocated by this same
// unmerged branch, so v41-stamped caches exist only on it — but they exist on
// every reviewer's and CI runner's checkout of it, and parse-time emission means
// they replay the pre-fix capture set for byte-unchanged files and keep serving
// the fabricated edge. main is at 39, so 40/41/42 are all this branch's.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// v43: Go embedded fields now emit `@reference.embedded-pointer` when written
// as `*T` rather than `T` (#2813 exact method sets). Go's method-set rules make
// the two forms genuinely different — `struct{ Base }` does NOT get Base's
// pointer-receiver methods in its value method set while `struct{ *Base }` does
// — so structural interface satisfaction cannot be exact without the spelling.
// This is PARSE-TIME capture emission, so a warm cache replays the pre-fix
// capture set for byte-unchanged files and the distinction never appears:
// silently, with no error, the v27/v30 failure mode. `analyze` skips tree-sitter
// dispatch for unchanged chunks (GUARDRAILS.md), so a plain re-analyze does NOT
// surface it without this bump.
//
// 42 -> 43: this branch originally allocated 43 while sitting at 39, because
// main had already taken 40/41/42 for #2807. main has since merged those and
// this branch rebased onto it, so 43 remains the next free number and the
// value is unchanged by the rebase — the reason it was chosen is simply now
// visible in the history above. RE-CHECK AGAINST origin/main IMMEDIATELY
// BEFORE MERGING; this file records eight prior collisions, two EXACT.
// Moved 43 -> 44 for #2842's TypeScript heritage capture, which now emits
// `@reference.inherits` for `interface_declaration` and
// `abstract_class_declaration`. That is PARSE-TIME emission, so a v43 warm
// cache would serve entries that are missing those matches entirely — the
// exact failure a bump exists to prevent. Verified against origin/main at
// a857f4c5a, which is still on 43, so 44 is free. RE-CHECK BEFORE MERGE.

// 44 -> 45: #2837 re-anchors Go's struct/interface captures from the
// `type_declaration` onto the `type_spec` (`languages/go/query.ts`
// @scope.class/@declaration.struct/@declaration.interface, and GO_QUERIES
// @definition.struct/@definition.interface in `tree-sitter-queries.ts`). Every
// Go file declaring a type therefore emits DIFFERENT capture ranges — measured:
// 70 fixture digests moved with zero change in capture COUNT — and a grouped
// `type (...)` block emits nodes it previously did not emit at all. Parse-time,
// so a warm cache would replay pre-fix ParsedFiles and the fix would be a silent
// no-op on every incremental analyze while still passing every cold-run test.
//
// This branch originally took 44 and it COLLIDED: #2842 above merged first and
// claimed it. The ninth entry in this ledger, and the third EXACT clash. Worth
// recording HOW it was caught, because the pin test cannot catch it — both PRs
// asserted `toBe(44)`, which passes even when main is already 44, so the two
// capture schemas would have shared one PARSE_CACHE_VERSION and the durable
// ParsedFile store would have replayed pre-fix ParsedFiles verbatim for one of
// them. Only comparing against origin/main at MERGE time surfaces it.
// PR #2840 (Objective-C, draft) still claims 44 as well — it must move too.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 45 -> 46 for the JavaScript bare-identifier read captures (A2), which emit
// `@reference.read.identifier` in value positions (call arguments,
// default-parameter values, return statements) so a module-scope `const` read
// only by bare name finally mints a reference site, plus the object-literal
// `@definition.property` rule and the TypeScript shape-member captures. All
// PARSE-TIME emission, so a warm cache serves entries carrying none of those
// matches and the new nodes and edges never appear — observed directly while
// developing: a full `analyze --force` produced a byte-identical graph and read
// as a failed hypothesis until the cache was cleared by hand.
//
// This branch originally took 45 and it COLLIDED: #2837 above merged first and
// claimed it. The TENTH entry in this ledger and the FOURTH exact clash, caught
// exactly as the note above says it must be — by comparing against origin/main
// at merge time, not at review time. The pin test cannot catch it: both sides
// asserted `toBe(45)`, which passes while main is already 45, so two capture
// schemas would have shared one PARSE_CACHE_VERSION and the durable ParsedFile
// store would have replayed pre-fix ParsedFiles verbatim for one of them.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
//
// 46 -> 47: method-level Spring `@RequestMapping` now emits wildcard routes
// and one route per static `RequestMethod.X` value. These decorator routes live
// in ParseWorkerResult and are replayed verbatim on warm cache hits, so keeping
// the previous version would make the fix a no-op for every unchanged Java file.
// PR #2856 claims 46, so this branch owns 47. Verified against upstream/main at
// 021ac3037 (still 45). RE-CHECK BEFORE MERGE.
//
// ── The FIFTH clash, and the first one the ledger's own convention prevented ──
// #2857 above merged while this branch sat waiting, and it did the right thing:
// it read this PR's claim on 46 and took 47 instead of colliding. That left the
// clash one step further up — 46 was safe, but THIS branch's own 47 (below) was
// not, and neither was anything after it. Every entry from here down has been
// renumbered +1 at merge time. Nothing about the capture sets changed; only the
// numbers did, which is the whole point of re-checking at merge rather than at
// review. Ledger entries 11 through 15.
//
// SIXTH clash, same shape, one merge later: #2833 then took 48 for a generic-
// receiver fix, so this branch's chain shifted +1 AGAIN and now runs 49-53.
// The capture sets have never moved; only the numbers have. This is the cost of
// a single global counter with concurrent PRs, and #2860 is the mechanical fix.
//
// 48 -> 49 for the round-2 capture work: object literals behind an
// identity-preserving wrapper (`const X = Object.freeze({ ... })`) now mint
// `@definition.property` for their keys. Parse-time like every entry above, and
// this one was ALSO observed as a false negative first: `analyze --force`
// against a fixture carrying the new shape returned the pre-change node set and
// read as "the query does not match", until the on-disk cache was removed by
// hand and the same run produced the node. `--force` re-runs the pipeline but
// still serves ParsedFiles from the durable store, so it does not substitute
// for this bump.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
//
// 49 -> 50 for the TypeScript object-literal captures (R3-3): named
// object-literal keys and the identity-wrapper form now mint `@definition.property`
// in TYPESCRIPT_QUERIES, as they already did for JavaScript. Parse-time, so a
// warm cache would replay ParsedFiles carrying none of those matches and the
// keys would stay invisible.
//
// #2860 adds a CI check comparing this against the base branch — the merge-time
// re-check this ledger has asked for by hand across ten entries and four exact
// clashes. It is NOT on this branch, so until that one merges the re-check
// below is still manual.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 50 -> 51 for the return-shape and shorthand captures (R3-4): keys of an
// anonymous literal in return position, and shorthand keys in both that and the
// variable-bound form. Parse-time again.
//
// The v34 hazard, and this branch has already tripped it: a build stamped 48
// (now 50) was installed and used to analyze two repos BEFORE these captures
// existed, so caches stamped 48 exist that carry none of them. Within one PR the version
// only has to differ from main's, but an INTERMEDIATE build of the same series
// is a different capture set wearing the same number — which is exactly what
// the note above records for 33/34.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 51 -> 52 is NOT needed for R3-5: that pass is scope-resolution, not
// parse-time capture, so a warm cache replays ParsedFiles that already carry
// everything it reads. Recorded because the reflex on this branch has been to
// bump, and a bump nobody needs still forces every user a full re-parse.
//
// 51 -> 52 IS needed for dispatch-guard routes (R3-7): the JS/TS providers now
// implement `extractDecoratorRoutes`, and decorator routes are worker output
// carried in the parse cache. A warm cache replays a worker result whose
// `decoratorRoutes` predates the extractor entirely, so every hand-rolled route
// stays invisible and `route_map` keeps answering empty — the exact symptom the
// change exists to fix, wearing the mask of "the extractor does not work".
//
// 52 -> 53 for the same-file constant folding that followed it. The v34 hazard
// again, and this branch has now tripped it TWICE: a build stamped 50 (now 52)
// was used to analyze before folding existed, so those caches carry the unfolded
// route set. Caught by measuring — the post-folding run came back suspiciously
// fast and would have reported the pre-folding number, which is precisely how
// "an intermediate build of the same series is a different capture set wearing
// the same number" shows up in practice. Within one PR the version only has to
// differ from main's; against a cache YOU wrote, it has to differ from itself.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
//

// 47 -> 48: #2833 makes a generic-typed FIELD usable as a call receiver. Three
// parse-time changes ride on this one value:
//   - C++ (`languages/cpp/query.ts`) gains `field_declaration` rules whose
//     `type:` is a `template_type` or a `qualified_identifier` wrapping one.
//     The rules that existed all required a bare `type_identifier`, so
//     `Repo<User> repo;` and `std::vector<Item> items;` matched NONE of them and
//     the member got no type binding at all — new captures where there were none.
//   - Python (`languages/python/interpret.ts`) reduces a subscripted type its
//     container allow-lists do not claim to its base name, so `Repo[User]` binds
//     as `Repo`. That rewrites `TypeRef.rawName`, which is serialized into the
//     cached ParsedFile.
//   - `SymbolDefinition.typeParameters` — the DECLARED parameter list
//     (`template <class T>`, `class Box<T extends Repo>`), captured nowhere
//     before and on a different axis from the existing `templateArguments`. Six
//     per-language declaration queries gained `@declaration.type-parameters` and
//     `scope-extractor.ts` reads it onto every class-like def.
// A warm cache would replay the pre-fix ParsedFiles, so every file served from
// it would carry the old captures while passing every cold-run test — the exact
// failure this constant exists to prevent.
//
// WHAT THE BUMP DOES NOT COVER. It invalidates the PARSE half only. Whether the
// re-parsed captures reach the graph is a separate gate: `isIncremental`
// (`core/run-analyze.ts`) tests `!options.force`, an existing meta,
// `!schemaFingerprintMismatch(...)`, feature parity, non-empty `fileHashes` and
// a git repo — SCHEMA_BUMP appears in none of them — and an incremental run then
// writes back only `hashDiff.toWrite`, logging the rest as "unchanged file rows
// preserved". SCHEMA_FINGERPRINT is a hash of node/relation DDL, which this
// branch does not touch, so it is byte-identical and moves nothing either.
// Net: after this bump an incremental analyze re-parses an unchanged file
// correctly but keeps its existing rows, and the new edges land on the next full
// rebuild (`--force`, or any run whose runner identity or DDL moved). That is
// the pre-existing contract for every capture change, not a regression here.
//
// THIS BRANCH COLLIDED TWICE, which is why it lands on 48 rather than 46.
// It first took 46 (the C++/Python captures) and then 47 (typeParameters), both
// verified free against origin/main at 021ac3037. By merge time main had moved:
// #2856 claims 46 and #2857 took 47 and merged first. The eleventh entry in this
// ledger and the FOURTH and FIFTH exact clashes — and note what caught them.
// Not the pin test: this branch asserted `toBe(47)` and so did #2857, and both
// pass, because a literal pin cannot see the other side. Only diffing
// origin/main at the moment of merge surfaces it. Every value this branch
// published (46, 47) is superseded by 48, so a warm cache stamped with either is
// correctly invalidated.
//
// 53 -> 54 for W2-8: `@declaration.type-parameters` is now captured on generic
// FUNCTIONS, generator functions and type ALIASES in TYPESCRIPT_SCOPE_QUERY, not
// only on class/interface declarations. Parse-time emission, so a warm cache
// replays ParsedFiles whose defs carry no parameter list and the shadowing guard
// that consumes it silently does nothing — the feature would look implemented
// and be inert, which is the failure this constant exists to prevent.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 54 -> 55 for W2-9: the dispatch-guard verb walk now tracks boolean POLARITY,
// so `(req.method === 'GET' ? false : true) && pathname === '/x'` no longer
// reports GET — the one method that branch guarantees the request does not have
// — and `!!(req.method === 'GET')` no longer loses its verb. Routes are emitted
// at parse time and replayed verbatim from a warm cache, so without this bump an
// already-indexed repo keeps serving the inverted verb and the fix looks inert.
// Same reason 51 and 52 were taken for R3-7.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 55 -> 56 for R3-8 (part 1): a dispatch guard's verb walk now returns ALL the
// methods a guard serves, so `(req.method === 'GET' || req.method === 'POST') &&
// pathname === '/x'` emits two routes instead of reporting GET alone, and a
// disjunction with a non-verb operand emits none instead of the first verb it
// saw. Routes are parse-time output replayed verbatim from a warm cache.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 56 -> 57 for R3-8 (part 2): `pathname.match(RE)` is read as a route test
// alongside `RE.test(pathname)`, a bound match takes its verb from where the
// binding is TESTED rather than where it is bound, a regex named by a same-file
// const resolves, and `regexToRoutePath` accepts a CAPTURING segment wildcard
// (`([^/]+)`) — the form every real dispatcher writes and the one it refused.
// All parse-time route output, replayed verbatim from a warm cache.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 57 -> 58 for #2897: the fetch capture no longer requires a LITERAL url, so a
// call passing a variable is recorded as an outward-action site. Measured, 44 of
// 47 fetch calls in this repo pass a variable, so the R3-6 sink signal was
// absent from 94% of them. Parse-time capture output replayed verbatim from a
// warm cache, so without the bump an indexed repo keeps its empty sink set and
// the fix looks inert.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
// 58 -> 59 for the #2899 REVIEW FOLLOW-UP to the dispatch-guard route walk. Two
// route-output changes, both parse-time and both replayed verbatim from a warm
// cache, so without this bump an already-indexed repo keeps serving the wrong
// routes and both fixes look implemented while being inert:
//   (a) `matchBindings` / `tested` are keyed on (enclosing function, name)
//       instead of the bare identifier. A same-named non-match binding in
//       ANOTHER function used to mint a fabricated verbed route under the wrong
//       handler — reproduced: `DELETE /api/live/positions/{param1}/replay
//       handler=handleSettings` — which then EVICTED the true verb-less route
//       through `reconcileDispatchGuardRoutes`. `buildRegexConstantMap` refuses
//       a name rebound to a non-regex for the same reason.
//   (b) `verbsFromTernary` INTERSECTS the operands of a conjunction instead of
//       taking the first non-empty set. `(GET||POST) ? (POST||PUT) : false`
//       emitted GET and POST where only POST is reachable, and
//       `GET ? POST : false` emitted GET for an unsatisfiable guard.
// Both changes strictly REMOVE routes, so a stale cache serves strictly more
// wrong answers than a cold one — which is exactly the state this constant
// exists to make unreachable. Same reason 55, 56 and 57 were taken.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
//
// 59 -> 60 for #2864's `ParsedImport.reexportsName` plus the `@import.publishes`
// capture that gates it. The FIELD is the easy half to miss: it is not a
// capture, but `parsedfile-store.ts` serializes the whole ParsedFile
// generically, so a new optional property on `ParsedImport` is part of the
// cached shape all the same. Without the bump a warm cache replays pre-fix
// `ParsedImport`s carrying no flag, `isNamedReexport`'s strict `=== true` takes
// the old path, and the whole fix is a silent no-op on incremental analyze while
// every cold-run test passes — landing hardest on `__init__.py`, the
// rarest-changing and highest-cache-hit files in a Python repo. The MARKER makes
// it a capture change too, confirmed independently by
// `bench/python-scope/measure.mjs` drifting.
//
// This branch is the SIXTH exact clash, and the first one the re-check caught
// where the number did NOT have to move. It staged 60 while main was 53,
// deliberately clearing the two claims visible at the time (#2899 and #2891).
// #2899 then merged and cascaded main 53 -> 59 in five steps — far past the 54
// its diff appeared to claim, because reading a PR's LAST bump hunk understates a
// branch that bumps repeatedly. 60 survived only because it was chosen above the
// highest claim rather than at main + 1; had it been staged at 54 it would now be
// buried four deep inside main's own ledger. Take the next free value above every
// in-flight MAXIMUM, not above origin/main.
//
// Still open at this commit: #2891 also claims 59, which main now holds. That is
// a live exact clash for #2891 to renumber, not for this branch.
//
// 60 -> 62 for the two optional `ParsedImport` fields the cycle-checker fix
// adds: `typeOnly` (TS `import type`) and `runsOnlyWhenCalled` (an import
// written inside a function body). This is #2864's lesson arriving again, in
// the same shape and for the same reason — neither field is a capture, but
// `parsedfile-store.ts` serializes the whole ParsedFile generically, so both are
// part of the cached shape. Without the bump a warm cache replays pre-fix
// `ParsedImport`s carrying no flag, the strict `=== true` reads in
// `finalize-algorithm.ts` and `imports-to-edges.ts` take the untagged path, and
// `check --cycles` keeps reporting the erased and deferred imports this branch
// exists to stop reporting — a silent no-op on incremental analyze while every
// cold-run test in the branch passes. The failure is toward OVER-reporting, so
// it is loud rather than dangerous, but it is still the whole fix not applying.
// (`typeOnly` also has a capture half — `@import.type-only` from
// `typescript/import-decomposer.ts` — so that side would drift a capture bench;
// `runsOnlyWhenCalled` is decided in scope-extractor Pass 3 from the scope tree
// and has no marker at all, which is exactly the half that gets missed.)
//
// 63, not 62, and not 61: main holds 60, #2935 claims 61, and #2936 claims 62.
// Per the rule three paragraphs up, this is the next free value above every
// in-flight MAXIMUM, not above origin/main. #2891's 59 is already buried by main
// and is theirs to renumber; #1616's 2 is stale.
//
// This staged 62 first and was correct when written. #2936 opened four hours
// later and also took 62 — bumping for #2917's implicit Java record-component
// accessors, a genuinely different cached shape — because it re-checked against
// main (60) rather than against the in-flight claims, which is the SEVENTH exact
// clash and the same mistake the ledger above keeps recording. Moving rather
// than standing on seniority: 63 is above every claim, so it is correct whichever
// of the two merges first, and needs no coordination to stay correct. An exact
// clash is the dangerous shape precisely because neither side invalidates the
// other — a warm cache written by #2936's build would be read as valid by this
// one, and the accessor definitions it materializes are not in this branch's
// ParsedFile shape at all.
//
// 63 -> 64 for Java enum heritage plus annotated class, record, interface,
// enum, and explicit-super base names emitting corrected captures (#2918).
// Warm v63 ParsedFiles lack those captures and must be re-extracted.
// 64 -> 66 adds the synthetic-declaration sidecar used to keep anonymous class
// implementations from evicting ordinary implementors at the dispatch cap.
// That PR published a v64 head first, so 66 kept all the shapes in flight at the
// time distinct. (It also named a v65 claim from this branch; that claim was
// superseded before either landed — see the 66 -> 67 entry below. Nothing holds
// 65 now.)
//
// 66 -> 67 for #2917's implicit Java record-component accessor definitions and
// scope declarations. A warm cache would otherwise replay ParsedFiles without
// the synthesized accessors. This branch staged 65 before #2918's 66 landed on
// main; 67 is the next free value above every in-flight claim (main 66, #2939's
// 64), which is the ledger rule above — re-check against the claims, not just
// against main.
//
// 67 -> 68 for #2912's `ReferenceSite.typeArguments`: the generic arguments a
// heritage reference was written with (`: IValidator<string>`), derived at
// EXTRACTION time from the anchor's spelling. A warm cache replays `inherits`
// sites with the field absent, absence is the fail-open "unknown", and
// generic-instantiation filtering therefore degrades to the pre-fix fan-out on
// exactly the unchanged files — silent, and passing every cold-run test.
//
// This branch staged 64 when main held 60 and #2935/#2936/#2934 claimed 61/62/63.
// All three have since landed and cascaded main to 67, burying 64 inside main's
// own ledger — the EIGHTH time the re-check moved a number, and the reason the
// re-check is a merge step rather than a one-time choice. 68 is the next free
// value above every in-flight claim at this merge (main 67, #2891's 59, #1616's
// stale 2), which is the rule above: above every claim, not above origin/main.
// RE-CHECK AGAINST origin/main IMMEDIATELY BEFORE MERGING.
//
// 68 -> 69 added #2969's JS/TS data-route-table decoratorRoutes. A warm v68
// cache would replay unchanged worker results without those routes. Version 70
// then adds Spring non-HTTP handler side-channel facts (#2417 / #2891), so Java
// and Kotlin caches persist scheduled, event, messaging, and managed-job facts.
//
// This PR originally carried its own bump (47 -> 48) for the Java constant-route
// capture set change (route-extractors/java-const-resolver.ts + the spring.ts
// operand branch + the parse-worker Java constant harvest): a warm pre-feature
// cache replays `moduleConstants=0` captures verbatim and silently drops every
// constant-based Spring route on unchanged files. After rebasing onto current
// main the ledger already sits at 70, whose capture set post-dates and includes
// this harvest — v70 invalidates those caches, so no additional bump is needed.
const SCHEMA_BUMP = 70;
const GITNEXUS_PKG_VERSION = (() => {
  try {
    // package.json sits at gitnexus/package.json — two levels up from
    // gitnexus/src/storage/parse-cache.ts (or its dist/ equivalent).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', '..', 'package.json'), // src/storage → gitnexus/
      path.join(here, '..', '..', '..', 'package.json'), // dist/storage → gitnexus/
    ];
    const requireCJS = createRequire(import.meta.url);
    for (const c of candidates) {
      try {
        const pkg = requireCJS(c);
        if (typeof pkg?.version === 'string') return pkg.version;
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return '0.0.0-unknown';
})();
export const PARSE_CACHE_VERSION = `${SCHEMA_BUMP}+${GITNEXUS_PKG_VERSION}`;

const LEGACY_CACHE_FILENAME = 'parse-cache.json';
const CACHE_DIRNAME = 'parse-cache';
const CACHE_INDEX_FILENAME = 'index.json';

/** Keys on disk always come from `computeChunkHash` — 64-char lowercase hex. */
const CHUNK_CACHE_KEY_HEX_RE = /^[a-f0-9]{64}$/;

const isValidChunkCacheKey = (chunkHash: string): boolean => CHUNK_CACHE_KEY_HEX_RE.test(chunkHash);

/** On-disk shape for the legacy single-file format. */
interface ParseCacheFile {
  version: string;
  /** key = chunk hash (hex) → cached chunk result list. */
  entries: Record<string, ParseWorkerResult[]>;
}

/** On-disk shape for the sharded directory format. */
interface ShardedParseCacheIndex {
  version: string;
  keys: string[];
}

/** Runtime view: keyed Map for fast lookup; mutated in place during a run. */
export interface ParseCache {
  version: string;
  entries: Map<string, ParseWorkerResult[]>;
  /**
   * Hashes referenced (hit OR miss-and-stored) by the current run.
   * The parse phase populates this as it processes chunks; the orchestrator
   * uses it as input to `pruneCache` before saving so entries that no
   * longer correspond to any chunk in the current scan are discarded.
   * Transient — never serialized to disk.
   */
  usedKeys: Set<string>;
  /**
   * When set, chunk payloads are loaded from / flushed to sharded files on
   * demand instead of retaining every chunk in `entries` for the whole run
   * (#1983 — Linux kernel OOM from duplicate in-memory cache + graph).
   */
  storagePath?: string;
  /** Index of chunk hashes known to exist under `storagePath/parse-cache/`. */
  onDiskKeys?: Set<string>;
}

/** SHA-256 hex of a single string or buffer. */
const sha256Hex = (input: Buffer | string): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input) : input)
    .digest('hex');

/** Stable hash of a single file's contents — used by callers to compose a chunk hash. */
export const fileContentHash = (content: Buffer | string): string => sha256Hex(content);

/**
 * Compute the canonical cache key for a chunk's contents.
 *
 * `entries` is the list of (filePath, file content hash) for every file
 * in the chunk. We sort by filePath before hashing so chunks composed of
 * the same files in different order produce the same key.
 */
/** PDG/CFG cache namespace (#2081 M1) — every input that changes the
 *  WORKER-EMITTED `cfgSideChannel` must be folded into the chunk key, and
 *  ONLY those. The classification test for a future option: does the worker
 *  see it (workerData) and does it change the bytes the worker writes to the
 *  shard? `pdgMaxEdgesPerFunction` famously fails that test — it is applied
 *  at EMIT time on the main thread (scope-resolution run.ts), the worker
 *  never receives it, and the cached output is byte-identical across cap
 *  values; folding it in (as a prior review round did) only forced a
 *  spurious full re-parse on every cap change (#2099 F3). Options that
 *  change the PERSISTED GRAPH but not the shard belong in the RepoMeta pdg
 *  stamp (incremental-eligibility), not here. */
export interface PdgCacheKey {
  readonly pdg?: boolean;
  /** Per-function source-line cap (changes WHICH functions get a CFG —
   *  applied in the worker, so it shapes the cached shard). Callers must
   *  pass the RESOLVED value (the production call site in parse-impl.ts
   *  applies the worker's default before folding) so an explicit-default
   *  run shares the default run's keys — this function folds whatever it
   *  is given verbatim. */
  readonly maxFunctionLines?: number;
}

export const computeChunkHash = (
  entries: Array<{ filePath: string; contentHash: string }>,
  pdg: boolean | PdgCacheKey = false,
): string => {
  const sorted = [...entries].sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
  const joined = sorted.map((e) => `${e.filePath}:${e.contentHash}`).join('\n');
  const opts: PdgCacheKey = typeof pdg === 'boolean' ? { pdg } : pdg;
  // pdg-off path keeps its pre-#2081 chunk-KEY format verbatim. Note this does
  // NOT mean caches survive the M1 upgrade: SCHEMA_BUMP 4→5 changed
  // PARSE_CACHE_VERSION, and both loadParseCache (below) and the durable
  // parsedfile-store index hard-invalidate on it — every user pays one full
  // cold re-parse on upgrade regardless of --pdg. Keeping the key format
  // stable only means no SECOND invalidation class is introduced here.
  if (!opts.pdg) return sha256Hex(joined);
  // Fold the worker-visible --pdg configuration into the key: the boolean
  // plus `maxFunctionLines` (decides which functions get a CFG at all, in the
  // worker). Without it a warm chunk built under one cap is served to a run
  // with a different cap → a stale/under-built CFG: the #2038-class
  // option-blind-key trap. `def` marks an unset (default) value so two
  // default-cap runs share a key. The emit-time edge cap is deliberately
  // absent — see the PdgCacheKey doc comment.
  //
  // NAMESPACE VERSION (`pdg:5`): bumped when the worker-emitted
  // `cfgSideChannel` SHAPE changes for pdg-mode runs only — pdg:1→2 in #2083
  // M3 U1 (TsHarvester emits taint `sites` on StatementFacts); pdg:2→3 in the
  // #2227 follow-up U1 (every C-family / TS harvester now stamps the call-site
  // anchor `SiteRecord.at`, which the resolved-callee-id join reads); pdg:3→4 in
  // the #2227 tri-review-2 U4 (the Rust harvester now emits a `kind:'new'` site
  // for `struct_expression`, a new worker-output site the join consumes); pdg:4→5
  // in the FU-C call-summary soundness fix (the TS harvester now stamps
  // `BindingEntry.formalIndex` on param bindings so the PDG call-summary keys
  // return-flow on the enclosing FORMAL position, not the flattened binding
  // ordinal — a warm chunk lacking it would route the harvest to its conservative
  // empty-summary fallback). A warm chunk built by a worker predating the relevant
  // change carries a stale site shape, so the join skips it and
  // `BasicBlock.calleeIds` is silently empty (or missing the struct constructor)
  // even though `callees` is populated — exactly the #2225-class shape skew this
  // version token exists to prevent. Invalidates pdg-mode chunks and their durable
  // parsedfile-cache entries; flag-off chunk keys never reach this line and stay
  // byte-identical, so non-pdg users pay nothing. Deliberately NOT a SCHEMA_BUMP —
  // that gates the whole cache version and would force a full cold re-parse on
  // EVERY user (the M1 bump comment above records that cost).
  const ns = `pdg:5;maxFn=${opts.maxFunctionLines ?? 'def'}`;
  return sha256Hex(`${ns}\n${joined}`);
};

/**
 * JSON replacer that round-trips Map/Set instances through plain JSON.
 *
 * `ParseWorkerResult.parsedFiles[*].scopes[*].typeBindings` is a
 * `ReadonlyMap<string, TypeRef>`; without this transform it serializes
 * to `{}` and downstream code that iterates / `.get()`s on it crashes
 * with "is not iterable". Applied symmetrically by `mapReviver` on
 * load so the in-memory shape stays Map-typed.
 */
const MAP_TAG = '__$mapEntries$__';
const SET_TAG = '__$setValues$__';

export const mapReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  if (value instanceof Set) return { [SET_TAG]: Array.from(value.values()) };
  return value;
};

export const mapReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v[MAP_TAG])) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(v[SET_TAG])) return new Set(v[SET_TAG] as unknown[]);
  }
  return value;
};

const getLegacyCachePath = (storagePath: string): string =>
  path.join(storagePath, LEGACY_CACHE_FILENAME);

const getCacheDirPath = (storagePath: string): string => path.join(storagePath, CACHE_DIRNAME);

const getCacheIndexPath = (storagePath: string): string =>
  path.join(getCacheDirPath(storagePath), CACHE_INDEX_FILENAME);

const getCacheChunkPath = (storagePath: string, chunkHash: string): string =>
  path.join(getCacheDirPath(storagePath), `${chunkHash}.json`);

/**
 * Drop fields that are not replayed by `mergeChunkResults` / parse-impl after
 * RING4-1 (#942). Shrinks on-disk shards and peak RSS during cold runs.
 */
export const slimParseWorkerResultsForCache = (
  chunkResults: readonly ParseWorkerResult[],
): ParseWorkerResult[] => {
  const slim: ParseWorkerResult[] = [];
  for (const result of chunkResults) {
    slim.push({
      ...result,
      calls: [],
      assignments: [],
      constructorBindings: [],
      parsedFiles: [],
      // #2112: a clone-safety skip list is per-run telemetry, not graph data —
      // replay ignores it. Drop it so it doesn't bloat the cached shard.
      skippedPaths: [],
    });
  }
  return slim;
};

const readParseCacheChunkFromDisk = async (
  storagePath: string,
  chunkHash: string,
): Promise<ParseWorkerResult[] | undefined> => {
  if (!isValidChunkCacheKey(chunkHash)) return undefined;
  try {
    const chunkRaw = await fs.readFile(getCacheChunkPath(storagePath, chunkHash), 'utf-8');
    const chunkData = JSON.parse(chunkRaw, mapReviver) as ParseWorkerResult[];
    return Array.isArray(chunkData) ? chunkData : undefined;
  } catch {
    return undefined;
  }
};

/** Load one chunk shard. Does not retain it in `cache.entries`. */
export const loadParseCacheChunk = async (
  cache: ParseCache,
  chunkHash: string,
): Promise<ParseWorkerResult[] | undefined> => {
  const inMemory = cache.entries.get(chunkHash);
  if (inMemory !== undefined) return inMemory;
  if (cache.storagePath && cache.onDiskKeys?.has(chunkHash)) {
    return readParseCacheChunkFromDisk(cache.storagePath, chunkHash);
  }
  return undefined;
};

/**
 * Cache directories already created this process. `persistParseCacheChunk` runs
 * once per cache-miss chunk; without this guard every miss re-issues a redundant
 * `mkdir` syscall (hundreds on a large cold repo) (#1983). Storage paths are
 * process-scoped, so the Set stays bounded.
 */
const createdCacheDirs = new Set<string>();

/**
 * Persist one chunk shard and avoid retaining it in RAM for the rest of the
 * run. Falls back to `cache.entries` when `storagePath` is unset (unit tests).
 */
export const persistParseCacheChunk = async (
  cache: ParseCache,
  chunkHash: string,
  chunkResults: readonly ParseWorkerResult[],
): Promise<void> => {
  const slim = slimParseWorkerResultsForCache(chunkResults);
  if (cache.storagePath) {
    const cacheDir = getCacheDirPath(cache.storagePath);
    if (!createdCacheDirs.has(cacheDir)) {
      await fs.mkdir(cacheDir, { recursive: true });
      createdCacheDirs.add(cacheDir);
    }
    const payload = JSON.stringify(slim, mapReplacer);
    await fs.writeFile(getCacheChunkPath(cache.storagePath, chunkHash), payload, 'utf-8');
    cache.onDiskKeys ??= new Set<string>();
    cache.onDiskKeys.add(chunkHash);
    cache.entries.delete(chunkHash);
    return;
  }
  cache.entries.set(chunkHash, slim);
};

const loadLegacyParseCache = async (storagePath: string): Promise<ParseCache> => {
  const cachePath = getLegacyCachePath(storagePath);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw, mapReviver) as ParseCacheFile;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== PARSE_CACHE_VERSION ||
      typeof data.entries !== 'object' ||
      data.entries === null
    ) {
      return emptyCache(storagePath);
    }
    const entries = new Map<string, ParseWorkerResult[]>();
    for (const [k, v] of Object.entries(data.entries)) {
      if (Array.isArray(v)) entries.set(k, v as ParseWorkerResult[]);
    }
    return { version: PARSE_CACHE_VERSION, entries, usedKeys: new Set<string>(), storagePath };
  } catch {
    return emptyCache(storagePath);
  }
};

const loadShardedParseCache = async (storagePath: string): Promise<ParseCache | null> => {
  const indexPath = getCacheIndexPath(storagePath);
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const data = JSON.parse(raw) as ShardedParseCacheIndex;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== PARSE_CACHE_VERSION ||
      !Array.isArray(data.keys)
    ) {
      return emptyCache(storagePath);
    }

    const onDiskKeys = new Set<string>();
    for (const chunkHash of data.keys) {
      if (typeof chunkHash === 'string' && isValidChunkCacheKey(chunkHash)) {
        onDiskKeys.add(chunkHash);
      }
    }

    // Lazy: index only — load individual shards on cache hit (#1983).
    return {
      version: PARSE_CACHE_VERSION,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
      storagePath,
      onDiskKeys,
    };
  } catch {
    return null;
  }
};

/**
 * Load the parse cache. Returns an empty cache on any failure (missing
 * file, corrupt JSON, version mismatch). Never throws on a normal load.
 */
export const loadParseCache = async (storagePath: string): Promise<ParseCache> => {
  const sharded = await loadShardedParseCache(storagePath);
  if (sharded) return sharded;
  return loadLegacyParseCache(storagePath);
};

/**
 * Persist the cache to disk using a temp directory + rename.
 *
 * Writes shards under `${cacheDir}.tmp`, then removes the old `cacheDir` and
 * renames the temp directory into place. There is a crash window after
 * `rm(cacheDir)` and before `rename(tmpDir, cacheDir)` where no cache exists;
 * that is acceptable — `loadParseCache` yields empty and the next run
 * reparses. This is not a single atomic swap of the whole tree, but avoids
 * leaving a half-written shard set visible to readers.
 */
export const saveParseCache = async (storagePath: string, cache: ParseCache): Promise<string[]> => {
  await fs.mkdir(storagePath, { recursive: true });
  const cacheDir = getCacheDirPath(storagePath);
  const tmpDir = `${cacheDir}.tmp`;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const keys = [...cache.usedKeys].filter(isValidChunkCacheKey).sort();
  // Track hashes whose shard was actually written/copied this save. A hash can
  // be in `usedKeys` without a backing shard — its in-memory serialize threw, or
  // its on-disk copy failed/was-absent (e.g. a worker-quarantined chunk added to
  // usedKeys but never persisted). Writing such a hash into `index.keys` would
  // make the next load reference a shard that doesn't exist (#1983). Build the
  // index from what we persisted, not from the raw usedKeys snapshot.
  const writtenKeys: string[] = [];
  for (const chunkHash of keys) {
    const chunkPath = path.join(tmpDir, `${chunkHash}.json`);
    const inMemory = cache.entries.get(chunkHash);
    if (inMemory !== undefined) {
      let payload: string;
      try {
        payload = JSON.stringify(inMemory, mapReplacer);
      } catch {
        continue;
      }
      await fs.writeFile(chunkPath, payload, 'utf-8');
      writtenKeys.push(chunkHash);
      continue;
    }
    const existingPath = getCacheChunkPath(storagePath, chunkHash);
    try {
      await fs.copyFile(existingPath, chunkPath);
      writtenKeys.push(chunkHash);
    } catch {
      /* shard missing — skip; next run treats as cache miss */
    }
  }

  const index: ShardedParseCacheIndex = {
    version: cache.version,
    keys: writtenKeys,
  };
  await fs.writeFile(path.join(tmpDir, CACHE_INDEX_FILENAME), JSON.stringify(index), 'utf-8');

  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.rename(tmpDir, cacheDir);
  await fs.rm(getLegacyCachePath(storagePath), { force: true });
  // The authoritative final key set actually backed by a shard on disk.
  // Callers (the durable ParsedFile store) prune to exactly these so the two
  // content-addressed stores stay coherent — a chunk is cached iff BOTH have it.
  return writtenKeys;
};

/**
 * Drop entries whose hashes are not in `usedHashes`. Called at the end
 * of a run so chunks that no longer correspond to any current chunk
 * don't keep their stale entries forever.
 */
export const pruneCache = (cache: ParseCache, usedHashes: ReadonlySet<string>): number => {
  let removed = 0;
  for (const k of cache.entries.keys()) {
    if (!usedHashes.has(k)) {
      cache.entries.delete(k);
      removed++;
    }
  }
  if (cache.onDiskKeys) {
    for (const k of cache.onDiskKeys) {
      if (!usedHashes.has(k)) {
        cache.onDiskKeys.delete(k);
        removed++;
      }
    }
  }
  return removed;
};

const emptyCache = (storagePath?: string): ParseCache => ({
  version: PARSE_CACHE_VERSION,
  entries: new Map<string, ParseWorkerResult[]>(),
  usedKeys: new Set<string>(),
  storagePath,
  onDiskKeys: storagePath ? new Set<string>() : undefined,
});
