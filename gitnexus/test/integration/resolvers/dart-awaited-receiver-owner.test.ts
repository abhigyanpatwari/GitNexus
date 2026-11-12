/**
 * DART-04 — `(await svc.getUserAsync()).save()` must resolve to the exact
 * `User.save`, never to the same-named `Address.save`
 * (docs/languages/dart-ingestion-gaps.md).
 *
 * Dart has no call node: a member call is a flat run of `selector` siblings
 * after a head, and `computeReceiverText` names the receiver only when that
 * head is a bare identifier / `this` / `super`. A parenthesized head
 * (`(await …)`) left the call with NO receiver, so it was resolved as a
 * receiver-less member call: the free-call tier found `save` through the
 * wildcard import of `models.dart`, whose per-file export index keeps the
 * FIRST declaration of each simple name — `Address.save`, by declaration
 * order. `Address` is declared BEFORE `User` here on purpose: that order is
 * what made the wrong edge win, so the fixture must keep it to stay able to
 * fail.
 *
 * The emitter now gives such a call its receiver text (an untypable receiver
 * is a recorded drop, not a name guess) and a structural receiver chain
 * (`2|svc|cgetUserAsync|a`). The hoisted return binding of `getUserAsync`
 * carries `Future<User>` WHOLE (it used to arrive as a bare `Future` and be
 * suppressed), so a member called on the un-awaited Future types nothing,
 * and the fold's `await` step unwraps it to `User` through the Dart
 * `elementTypeOf` await route.
 *
 * Contract:
 *   - the awaited call (and its doubly-parenthesized twin) resolves to the
 *     exact `User.save` node ID, and only it;
 *   - a parenthesized plain chain, and a parenthesized explicit-type-argument
 *     call (tree-sitter-dart nests `<User>` inside the `argument_part`, so it
 *     is an ordinary call step), resolve like the unparenthesized control;
 *   - `svc.getUserAsync().save()` WITHOUT an await — a member of the Future
 *     itself — stays unresolved: no CALLS edge, a recorded drop (the guard
 *     that a whole `Future<User>` binding exists for);
 *   - an awaited call whose declared result is unknown (`Future<dynamic>`)
 *     stays unresolved — no CALLS edge, and a `receiver-unresolved` drop;
 *   - an awaited call-result BINDING (`final u = await makeUserAsync()`,
 *     `@type-binding.awaited` → `TypeRef.awaited`, unwrapped on chain follow
 *     through the same await route) types `u` as `User`, so `u.save()` reaches
 *     the exact owner; the unknown-typed twin (`Future<dynamic>`) emits nothing;
 *   - that inference is refused when the awaited call is not the whole operand
 *     (`await make().then(…)`) and when the local is written anywhere else in
 *     its body — assignment, `??=`, destructuring patterns, a closure, a
 *     `late` re-init, an `if-case` shadow; a `Future<models.User>` keeps its
 *     qualifier, read in the PRODUCER's scope: a same-file decoy `User` and a
 *     consumer that reuses the prefix for another file can never answer
 *     (codex review findings F1–F3, F2b, F3b);
 *   - review round 2 (`SHADOWED`, `UNAWAITED_WRAPPER`, `stray.dart`): one
 *     Function scope keeps ONE binding per name, so a local is inferred only
 *     when its name has exactly one binder in its OUTERMOST body and is
 *     assigned nowhere in it (`dartLocalInferenceAllowed`): a closure
 *     parameter, catch variable or local-function parameter reusing the
 *     name, sibling argument closures each declaring it, an outer local
 *     redeclared in a closure, and `if`/`else` branches each declaring it all
 *     get NO inferred binding from either declaration — every call on the
 *     name is a missing edge, never the other binder's owner. An un-awaited
 *     `.then(…)`-suffixed call binds nothing (the call must be the whole
 *     initializer), a reassigned un-awaited local binds nothing, and a whole
 *     `Future<T>` spelling never names an owner even when the workspace
 *     declares a `class Future<T>` (`stray.dart`): `final f = makeUserAsync();
 *     f.save()` is a recorded drop and the headline `(await …).save()` still
 *     reaches `User.save` beside the stray class;
 *   - the decoy `Address.save` (and the stray `Future.save`) is never chosen
 *     by anyone;
 *   - every parenthesized head the chain cannot type (index, non-null `!`,
 *     type arguments, a call on a bare name, a cast, an operator, more than
 *     MAX_CHAIN_DEPTH hops) carries receiver text but no chain, emits no
 *     `save` edge to either owner, and is a recorded `receiver-unresolved`
 *     drop — never a name guess.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
  type RelEdge,
} from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';

// Same guard as dart.test.ts: the module can load while the native grammar
// fails on setLanguage, so probe the parser rather than trust availability.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

const MODELS = `class Address {
  void save() {}
}

class User {
  Address address = Address();
  void save() {}
}

class Service {
  User getUser() => User();
  User getTyped<T>() => User();
  Future<User> getUserAsync() async => User();
  Future<dynamic> getDynamic() async => User();
}

User make() => User();
Future<User> makeUserAsync() async => User();
Future<Address> makeAddressAsync() async => Address();
Future<dynamic> makeDynamicAsync() async => User();
void take(Object o) {}
void run(Function f) {}
`;

/** A workspace class named `Future`, imported by nobody — the shape of an SDK
 *  stub or a mock SDK. A whole `Future<T>` binding must never bind to it. */
const STRAY = `class Future<T> {
  int save() => 0;
}
`;

const CALLERS = `import 'models.dart';
import 'api.dart' as api;

Future<void> awaitParen(Service svc) async {
  (await svc.getUserAsync()).save();
}

Future<void> nestedParen(Service svc) async {
  ((await svc.getUserAsync())).save();
}

void parenPlain(Service svc) {
  (svc.getUser()).save();
}

void plainChain(Service svc) {
  svc.getUser().save();
}

void parenTypeArgs(Service svc) {
  (svc.getTyped<User>()).save();
}

Future<void> nonAwait(Service svc) async {
  svc.getUserAsync().save();
}

Future<void> parenNonAwait(Service svc) async {
  (svc.getUserAsync()).save();
}

Future<void> prefixedQualifiedFactory() async {
  final x = await api.fetch();
  x.save();
}

Future<void> awaitedBinding() async {
  final u = await makeUserAsync();
  u.save();
}

Future<void> awaitedUnknownBinding() async {
  final d = await makeDynamicAsync();
  d.save();
}

Future<void> awaitedThenChain() async {
  final x = await makeUserAsync().then((_) => Address());
  x.save();
}

Future<void> awaitedReassigned() async {
  dynamic x = await makeUserAsync();
  x = Address();
  x.save();
}

Future<void> awaitedRecordPattern() async {
  dynamic x = await makeUserAsync();
  dynamic y;
  (x, y) = (Address(), 0);
  x.save();
}

Future<void> awaitedListPattern() async {
  dynamic x = await makeUserAsync();
  [x] = [Address()];
  x.save();
}

Future<void> awaitedNullAssign() async {
  dynamic x = await makeUserAsync();
  x ??= Address();
  x.save();
}

Future<void> awaitedClosureWrite() async {
  dynamic x = await makeUserAsync();
  final rebind = () {
    x = Address();
  };
  rebind();
  x.save();
}

Future<void> awaitedLateReinit() async {
  late dynamic x = await makeUserAsync();
  x = Address();
  x.save();
}

Future<void> awaitedIfCaseShadow(Object v) async {
  dynamic x = await makeUserAsync();
  if (v case var x) {
    x.save();
  }
  x.save();
}

Future<void> unknownAwait(Service svc) async {
  (await svc.getDynamic()).save();
}

void refuseIndex(List<User> repos) {
  (repos[0]).save();
}

void refuseNonNull(Service svc) {
  (svc.getUser().address!).save();
}

void refuseFreeCall() {
  (make()).save();
}

void refuseCast(dynamic x) {
  (x as User).save();
}

void refuseOperator(int a, int b) {
  (a + b).save();
}

Future<void> refuseDeepChain(Service svc) async {
  (await svc.getUserAsync()).address.city.name.save();
}

Future<void> shadowClosureParamTyped(List<Address> addrs) async {
  final x = await makeUserAsync();
  addrs.forEach((Address x) {
    x.save();
  });
}

Future<void> shadowClosureParamUntyped(List<Address> addrs) async {
  final x = await makeUserAsync();
  addrs.forEach((x) {
    x.save();
  });
}

Future<void> shadowCatch() async {
  final x = await makeUserAsync();
  try {
    take(x);
  } on Address catch (x) {
    x.save();
  }
}

Future<void> shadowLocalFunctionParam() async {
  final x = await makeUserAsync();
  void inner(Address x) {
    x.save();
  }
  inner(Address());
}

Future<void> siblingClosures() async {
  run(() async {
    final r = await makeUserAsync();
    r.save();
  });
  run(() async {
    final r = await makeAddressAsync();
    r.save();
  });
}

Future<void> outerRedeclaredInClosure() async {
  final u = Address();
  run(() async {
    final u = await makeUserAsync();
    u.save();
  });
  u.save();
}

Future<void> branchRedeclared(bool cached) async {
  if (cached) {
    final resp = Address();
    resp.save();
  } else {
    final resp = await makeUserAsync();
    resp.save();
  }
}

Future<void> wholeFutureLocal() async {
  final f = makeUserAsync();
  f.save();
}

Future<void> thenChainUnawaited() async {
  final f = makeUserAsync().then((u) => u.address);
  (await f).save();
}

Future<void> reassignedUnawaited() async {
  dynamic f = makeUserAsync();
  f = makeAddressAsync();
  (await f).save();
}

Future<User> makeUserAsyncLocal() async => User();

Future<void> awaitedSameFileBinding() async {
  final u = await makeUserAsyncLocal();
  u.save();
}
`;

/** 1-based line of the `save` call inside the named caller. */
function callLineOf(caller: string): number {
  const lines = CALLERS.split('\n');
  const start = lines.findIndex((line) => line.includes(` ${caller}(`));
  expect(start).toBeGreaterThanOrEqual(0);
  const call = lines.findIndex((line, i) => i > start && line.includes('.save()'));
  expect(call).toBeGreaterThan(start);
  return call + 1;
}

/** `import 'models.dart' as models;` plus a same-named local DECOY class: the
 *  qualifier in `Future<models.User>` is what rules the decoy out. */
const QUALIFIED = `import 'models.dart' as models;

class User {
  void save() {}
}

Future<models.User> fetchQualified() async => models.User();

Future<void> awaitedQualified() async {
  final x = await fetchQualified();
  x.save();
}
`;

/** Cross-file reused prefix: the producer's `models` is models.dart, the
 *  consumer's `models` is decoy.dart. The awaited yield `models.User` must be
 *  read in the PRODUCER's scope. */
const DECOY = `class User {
  void save() {}
}
`;
/** A prefixed factory whose yield is qualified: `api.fetch()` returns
 *  `Future<models.User>`. Recall boundary 5 in the gaps doc. */
const API = `import 'models.dart' as models;

Future<models.User> fetch() async => models.User();
`;
const PRODUCER = `import 'models.dart' as models;

Future<models.User> fetchAcross() async => models.User();
`;
const CALLER = `import 'producer.dart';
import 'decoy.dart' as models;

Future<void> crossFileQualified() async {
  final x = await fetchAcross();
  x.save();
}
`;

/** Locals the awaited inference must refuse because they are written
 *  elsewhere in their body (review F3/F3b). */
const WRITTEN = [
  'awaitedReassigned',
  'awaitedRecordPattern',
  'awaitedListPattern',
  'awaitedNullAssign',
  'awaitedClosureWrite',
  'awaitedLateReinit',
  'awaitedIfCaseShadow',
] as const;

/** Review round 2: a same-named binder the written-elsewhere guard never
 *  visited (closure parameter, catch variable, local-function parameter),
 *  sibling argument closures whose locals land in the enclosing function's
 *  table, an outer local redeclared inside a closure, and `if`/`else`
 *  branches each declaring the name. One function has ONE binding table per
 *  name, so a name bound more than once in its outermost body gets no
 *  inferred binding at all — from either declaration — and every call on it
 *  is a missing edge, never the other binder's owner. */
const SHADOWED = [
  'shadowClosureParamTyped',
  'shadowClosureParamUntyped',
  'shadowCatch',
  'shadowLocalFunctionParam',
  'siblingClosures',
  'outerRedeclaredInClosure',
  'branchRedeclared',
] as const;
/** Review round 2: an UN-awaited binding that reaches a whole `Future<T>`
 *  (`final f = makeUserAsync()`) with a workspace class named `Future` in
 *  the repo, a `.then(…)`-suffixed call bound to its first callee, and an
 *  un-awaited local reassigned before `(await f)`: none may type `f`. */
const UNAWAITED_WRAPPER = [
  'wholeFutureLocal',
  'thenChainUnawaited',
  'reassignedUnawaited',
] as const;

const RESOLVING = [
  'awaitParen',
  'nestedParen',
  'parenPlain',
  'plainChain',
  'parenTypeArgs',
] as const;
/** Members of the un-awaited Future (`nonAwait`, and `parenNonAwait` whose
 *  parenthesized head goes through the structural fold — with a workspace
 *  `class Future<T>` present, only the fold's owner guard keeps it off the
 *  stray `Future.save`), of an unknown awaited result (`unknownAwait`), and
 *  an awaited prefixed factory with a qualified yield
 *  (`prefixedQualifiedFactory`, recall boundary 5): no edge, a recorded drop. */
const UNRESOLVED = [
  'nonAwait',
  'parenNonAwait',
  'unknownAwait',
  'prefixedQualifiedFactory',
] as const;
/** Parenthesized heads the chain refuses to type (see `dartSelectorSteps` /
 *  `parenthesizedRun`): each keeps its receiver text so the site is resolved
 *  THROUGH the receiver and dropped, instead of falling to the receiver-less
 *  name lookup that produced the wrong edge. */
const REFUSED = [
  'refuseIndex',
  'refuseNonNull',
  'refuseFreeCall',
  'refuseCast',
  'refuseOperator',
  'refuseDeepChain',
] as const;

describe.skipIf(!dartAvailable)('Dart awaited receiver owner (DART-04)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;
  let qualifiedDecoySaveId: string;
  let crossFileDecoySaveId: string;
  let straySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-awaited-receiver-owner-'));
    writeFixtureRepo(tmpDir, {
      'models.dart': MODELS,
      'callers.dart': CALLERS,
      'qualified.dart': QUALIFIED,
      'decoy.dart': DECOY,
      'producer.dart': PRODUCER,
      'caller.dart': CALLER,
      'stray.dart': STRAY,
      'api.dart': API,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    // Exact owner IDs come from the graph, not from a hand-written string, so
    // the assertions below compare full node IDs rather than member names.
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string, file: string): string => {
      const edge = hasMethod.find(
        (e) => e.source === owner && e.target === 'save' && e.sourceFilePath === file,
      );
      if (edge === undefined) throw new Error(`fixture lost ${file} ${owner}.save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User', 'models.dart');
    decoySaveId = own('Address', 'models.dart');
    qualifiedDecoySaveId = own('User', 'qualified.dart');
    crossFileDecoySaveId = own('User', 'decoy.dart');
    straySaveId = own('Future', 'stray.dart');
    expect(
      new Set([userSaveId, decoySaveId, qualifiedDecoySaveId, crossFileDecoySaveId, straySaveId])
        .size,
    ).toBe(5);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mints the receiver text and the structural chain for a parenthesized head', () => {
    const calls = emitDartScopeCaptures(CALLERS, 'callers.dart').filter(
      (m) => m['@reference.call.member'] !== undefined && m['@reference.name']?.text === 'save',
    );
    const at = (caller: string) => {
      const line = callLineOf(caller);
      const match = calls.find((m) => m['@reference.name']!.range.startLine === line);
      if (match === undefined) throw new Error(`no save() capture on line ${line}`);
      return {
        receiver: match['@reference.receiver']?.text,
        chain: match['@reference.receiver-chain']?.text,
      };
    };
    expect(at('awaitParen')).toEqual({
      receiver: '(await svc.getUserAsync())',
      chain: '2|svc|cgetUserAsync|a',
    });
    expect(at('nestedParen')).toEqual({
      receiver: '((await svc.getUserAsync()))',
      chain: '2|svc|cgetUserAsync|a',
    });
    expect(at('parenPlain')).toEqual({ receiver: '(svc.getUser())', chain: '2|svc|cgetUser' });
    expect(at('parenTypeArgs')).toEqual({
      receiver: '(svc.getTyped<User>())',
      chain: '2|svc|cgetTyped',
    });
    expect(at('unknownAwait')).toEqual({
      receiver: '(await svc.getDynamic())',
      chain: '2|svc|cgetDynamic|a',
    });
    // The unparenthesized controls keep their text-only route, unchanged.
    expect(at('plainChain')).toEqual({ receiver: 'svc.getUser()', chain: undefined });
    expect(at('nonAwait')).toEqual({ receiver: 'svc.getUserAsync()', chain: undefined });
    expect(at('parenNonAwait')).toEqual({
      receiver: '(svc.getUserAsync())',
      chain: '2|svc|cgetUserAsync',
    });
    // Refused shapes: receiver text present (so the site has a receiver), no
    // chain (so nothing short or partial can be folded).
    for (const fn of REFUSED) {
      const got = at(fn);
      expect(got.receiver, fn).toMatch(/^\(/);
      expect(got.chain, fn).toBeUndefined();
    }
  });

  it.each(RESOLVING)('%s resolves save() to the exact User.save node', (fn) => {
    expect(saveCallsFrom(fn).map((e) => e.rel.targetId)).toEqual([userSaveId]);
  });

  it('awaitedBinding types the awaited call result and reaches the exact User.save', () => {
    expect(saveCallsFrom('awaitedBinding').map((e) => e.rel.targetId)).toEqual([userSaveId]);
  });

  it('awaitedUnknownBinding (awaited Future<dynamic> result) emits no save edge', () => {
    expect(saveCallsFrom('awaitedUnknownBinding')).toEqual([]);
  });

  // Codex review findings on the awaited-binding inference (precision over recall).
  it('awaitedThenChain: a trailing `.then(...)` means the call is not the awaited value — no edge', () => {
    expect(saveCallsFrom('awaitedThenChain')).toEqual([]);
  });

  it.each(WRITTEN)(
    '%s: a local written elsewhere in its body is never inferred — no edge',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it.each(SHADOWED)(
    '%s: a name bound more than once in the outermost body has no inferred binding — no edge from any of its call sites',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it.each(UNAWAITED_WRAPPER)(
    '%s: an un-awaited binding never types a member through a whole Future, a `.then(…)` callee or a reassigned local — no edge',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it('awaitedSameFileBinding: the extractor-side follow (producer in the same file) reaches the exact User.save', () => {
    expect(saveCallsFrom('awaitedSameFileBinding').map((e) => e.rel.targetId)).toEqual([
      userSaveId,
    ]);
  });

  it("crossFileQualified: the producer's `models` wins over the consumer's reused prefix", () => {
    // producer.dart: `import 'models.dart' as models; Future<models.User>`;
    // caller.dart: `import 'decoy.dart' as models;`. The yield is read in the
    // producer's scope and re-anchored at models.dart, so the consumer's
    // `models` → decoy.dart never enters.
    expect(saveCallsFrom('crossFileQualified').map((e) => e.rel.targetId)).toEqual([userSaveId]);
  });

  it('awaitedQualified: `Future<models.User>` keeps its qualifier and binds models.dart:User, never the same-file decoy', () => {
    // The `.` qualifier is read as the namespace-import handle, so the awaited
    // result binds the class that import names; the decoy `User` declared
    // beside the producer is exactly what the qualifier was written to rule out.
    expect(saveCallsFrom('awaitedQualified').map((e) => e.rel.targetId)).toEqual([userSaveId]);
  });

  it.each(UNRESOLVED)('%s stays unresolved (no edge to either save)', (fn) => {
    // unknownAwait used to point at Address.save — a wrong edge, not a missing
    // one; nonAwait would point at User.save if the Future were typed as its
    // result. Nothing may be emitted for either.
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it.each(UNRESOLVED)('%s is a recorded receiver-unresolved drop', (fn) => {
    const line = callLineOf(fn);
    expect(
      getResolutionOutcomes(result)
        .filter((outcome) => outcome.kind === 'suppressed')
        .filter(
          (outcome) =>
            outcome.filePath === 'callers.dart' &&
            outcome.name === 'save' &&
            outcome.range.startLine === line,
        )
        .map((outcome) => `${outcome.reason}:${outcome.siteKind}`),
    ).toEqual(['receiver-unresolved:call']);
  });

  it.each(REFUSED)('%s (untypable parenthesized head) emits no save edge to either owner', (fn) => {
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it.each(REFUSED)('%s is a recorded receiver-unresolved drop, not a name guess', (fn) => {
    const line = callLineOf(fn);
    expect(
      getResolutionOutcomes(result)
        .filter((outcome) => outcome.kind === 'suppressed')
        .filter(
          (outcome) =>
            outcome.filePath === 'callers.dart' &&
            outcome.name === 'save' &&
            outcome.range.startLine === line,
        )
        .map((outcome) => `${outcome.reason}:${outcome.siteKind}`),
    ).toEqual(['receiver-unresolved:call']);
  });

  it('never picks Address.save, qualified.dart:User.save, decoy.dart:User.save or stray.dart:Future.save from any caller', () => {
    const decoys = new Set([decoySaveId, qualifiedDecoySaveId, crossFileDecoySaveId, straySaveId]);
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => decoys.has(c.rel.targetId));
    expect(toDecoy).toEqual([]);
  });
});
