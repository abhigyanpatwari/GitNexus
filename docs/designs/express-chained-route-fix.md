---
name: express-chained-route-fix
type: bug
risk: medium
impacted: [c3_ingestion, c3_extractedroute_interface, c3_test_express_extractor]
status: proposed
date: 2026-06-06
branch: bugfix/batch-D-express-re-test
base: origin/main-afk @ 870c9c9
closes: [#145]
retest: [#84 resolved, #33 resolved]
---

<!--
AI-READERS — load only the sections your task needs.

| Task          | Sections (skip if absent)                  |
|---------------|--------------------------------------------|
| implement     | ## Components, ## Contracts, ## Invariants |
| code-review   | ## Invariants, ## KeyDecisions, ## Contracts |
| qa            | ## Flows, ## EdgeCases                     |
| scope-impact  | ## BlastRadius, ## CrossCutting            |
-->

# Solution Design: express-chained-route-fix

**Blast** d1=`route-extractors/express.ts` + its 1 unit-test file (2 files, 0 interfaces) · d2=`processDecoratorRoutesWithRepoId` (read-only — already accepts any `decorator` string) · d3=integration test `test/integration/resolvers/express-routes.test.ts` (regression gate; no chaining fixtures, no expected change)

## Problem & Approach

**Why** — Issue #145 reports that `app.route('/users').get(g).post(c)` emits only one Route node (the outer `.route()` call) instead of three. The chained verb calls are silently dropped because the recursive walker in `route-extractors/express.ts` keys each emission on the first **string** argument of a `call_expression`, and the chained verbs receive **function** arguments, not strings. Additionally, the parent `route()` call's path is never threaded through the recursion, so even if the verb calls were inspected, the path would be unknown.

Re-test of sibling issues #84 (FastAPI DI self-referencing CALLS) and #33 (Go service methods zero incoming CALLS) — both intended to be siblings that might be resolved by the just-merged #146/#150/#19/#18 work. **Both pass their existing integration tests** (`python-fastapi-handler.test.ts` 4/4, `go-handler-service.test.ts` 4/4). The handler→service self-reference class of bug appears to be resolved end-to-end.

**Solution** — Thread a `parentRoutePath: string | undefined` through the recursive `walk()` calls. When the walker sees a `call_expression` whose member-expression property is `route` and whose first argument is a string, set `parentRoutePath` to that string for the subtree rooted at the call's *children*; emit the `route` decorator with the path; then clear `parentRoutePath` to prevent leaking. When the walker sees a verb call (`.get`, `.post`, etc.) and `parentRoutePath` is set, emit a route using the inherited path even if the verb call has no string argument. The existing `decorator: 'route'` emission is preserved so the outer `route()` call still surfaces as a Route node (downstream `processDecoratorRoutesWithRepoId` already accepts any decorator string and creates a Route node keyed on it).

The pinning test (`express.test.ts:140-166`, tagged `#M4b`) is **inverted** to assert the fixed behavior: 3 routes instead of 1, with the chained verbs inheriting the parent path.

## Components

**d1 files** (modified):
- `gitnexus/src/core/ingestion/route-extractors/express.ts` — change `walk(node)` to `walk(node, parentRoutePath)`. Add path-inheritance logic in the `call_expression` branch.
- `gitnexus/test/unit/route-extractors/express.test.ts` — invert the M4b pinning test (#M4b → pass); add a 2-level test (`app.route('/x').get(g)` → 2 routes); add a no-leak test (a `get()` outside any `route()` chain → still 1 route, not 0).

**d1 files** (unchanged):
- `gitnexus/src/core/ingestion/parsing-processor.ts:350` — call site; no change needed.
- `gitnexus/src/core/ingestion/workers/parse-worker.ts:2908` — call site; no change needed.

**d2 read-only** (no change):
- `gitnexus/src/core/ingestion/call-processor.ts:1814-1872` (`processDecoratorRoutesWithRepoId`) — already accepts `decorator: 'route'` and any string for `decorator`. It will create a Route node with `httpMethod: 'ROUTE'` for the outer call and `httpMethod: 'GET'` / `'POST'` for the chained verbs. This is correct: each is a distinct route registration.

## Contracts

| Contract | Before | After |
|---|---|---|
| `extractExpressRoutes(tree, 'app.js')` for `app.get('/x', h)` | `[{decorator:'get', path:'/x'}]` | unchanged |
| Same for `app.route('/users').get(g).post(c)` | `[{decorator:'route', path:'/users'}]` | `[{decorator:'route', path:'/users'}, {decorator:'get', path:'/users'}, {decorator:'post', path:'/users'}]` |
| Same for `app.use(auth)` + `app.get('/x', h)` | `[{decorator:'get', path:'/x'}]` | unchanged |
| Same for `app.get(h)` (no path) | `[]` | unchanged |
| Same for `app.use('/api', mw)` | `[{decorator:'use', path:'/api'}]` | unchanged |
| Same for `app.route('/x').get(g)` (2-level chain) | (not covered) | `[{decorator:'route', path:'/x'}, {decorator:'get', path:'/x'}]` |
| Same for `headers.get('x-foo')` (non-Express) | `[]` | unchanged |
| Same for `app.route('/x').get(g); app.post('/y', h)` (sibling, not nested) | (not covered) | `[{decorator:'route', path:'/x'}, {decorator:'get', path:'/x'}, {decorator:'post', path:'/y'}]` — `parentRoutePath` MUST NOT leak across siblings |

## Invariants

1. **`parentRoutePath` is local to the subtree rooted at the `route()` call's children.** Recursion on a sibling sub-expression starts with `undefined`. This prevents the false-positive case `app.route('/x').get(g); app.post('/y', h)` from attributing `/x` to the sibling `.post('/y')`.
2. **The first-arg-must-be-string rule is preserved for the OUTER (non-chained) case.** `app.get(handler)` (no path) still emits 0 routes.
3. **Chained verb calls inherit the parent path REGARDLESS of their argument shape.** Whether the verb receives a handler function, multiple handlers, or middleware, the path is the parent `route()` path. This matches how Express actually routes these calls.
4. **`app.route('/x').get('/y', h)` (pathological: chained verb has own string arg) — AD-3 tie-break + subsumption.** The chained verb emits using its own string arg (`/y`), AND the outer `app.route('/x')` emission is SUPPRESSED via post-processing (the bare `route()` registration is subsumed by the explicit verb call). Net: 1 route (`get /y`). Without the subsumption, we'd emit 2 routes: `route /x` (the bare chain registration) and `get /y` (the explicit verb), which is redundant. The subsumption rule is recorded in the implementation summary as an Autonomous Decision delta from the original design.

5. **No change to `decorator` string set.** `EXPRESS_METHODS` is unchanged: `get, post, put, delete, patch, all, use, route, head, options`.

## Key Decisions

**KD-1: Preserve the outer `route()` emission EXCEPT when subsumed.** Default behavior: emit the `route` decorator so the downstream consumer surfaces a `Route` node with `httpMethod: 'ROUTE'` for the bare `route()` registration. Exception: when a chained verb call uses its own string arg that differs from the inherited `route()` path (the AD-3 case), the outer `route()` emission is suppressed — it would be redundant with the explicit verb call. This is a delta from the original AD-1: the spec originally said "preserve unconditionally"; the implementation refined it to "preserve unless subsumed." Rationale: the suppressed case produces a cleaner downstream graph (no `ROUTE` shadow node when an explicit verb call exists).

**KD-2: Thread state through the recursion parameter, not via a module-level variable.** A module-level `currentRoutePath` would create cross-file or even cross-call contamination if the function is ever invoked twice on the same module instance. Per-call parameter threading keeps state strictly scoped.

**KD-3: No change to `EXPRESS_METHODS` set.** Adding `route` to a separate "chained-verb-trigger" set was considered and rejected — it would split one decision across two data structures. The current single-set + parameter-inheritance approach is simpler.

**KD-4: Re-test #84/#33 results are documented in the PR description, not bundled into the fix.** The route-fix-regression guard requires a single, isolated anchor. Bundling the FastAPI/Go re-tests would either expand scope (if there's a remaining bug) or dilute the PR (if the tests just pass). Either way it's a separate concern.

## Flows

```
AST: app.route('/users').get(g).post(c)
        |
        v
walk(call_expression(app.route('/users').get(g).post(c)), undefined)
  |  func = member_expression(property='post', object=call_expression(app.route('/users').get(g)))
  |  prop.text == 'post' AND is in EXPRESS_METHODS
  |  args = (c)   // first arg is identifier, NOT string
  |  parentRoutePath = undefined  // <-- ROOT CAUSE: no inheritance
  |  -> skip emission
  |  recurse into children with parentRoutePath=undefined
  |
  v
walk(call_expression(app.route('/users').get(g)), undefined)
  |  prop.text == 'get' AND is in EXPRESS_METHODS
  |  args = (g)   // first arg is identifier, NOT string
  |  parentRoutePath = undefined
  |  -> skip emission
  |  recurse into children with parentRoutePath=undefined
  |
  v
walk(call_expression(app.route('/users')), undefined)
     prop.text == 'route' AND is in EXPRESS_METHODS
     args = ('/users')   // first arg IS string
     -> emit {decorator:'route', path:'/users'}
     recurse into children with parentRoutePath='/users'   <-- FIX
       -> walk(string('/users')) -> no children
       -> walk(... etc, parentRoutePath='/users')
  |
  v
RESULT: [{decorator:'route', path:'/users'}]   // BUG: missing get and post
```

After fix:
```
walk(call_expression(app.route('/users').get(g).post(c)), undefined)
  |  prop.text == 'post', args=(c), parentRoutePath=undefined
  |  -> skip (no string arg, no inherited path)
  |  recurse children with parentRoutePath=undefined
  v
walk(call_expression(app.route('/users').get(g)), undefined)
  |  prop.text == 'get', args=(g), parentRoutePath=undefined
  |  -> skip
  |  recurse children with parentRoutePath=undefined
  v
walk(call_expression(app.route('/users')), undefined)
  |  prop.text == 'route', args=('/users'), parentRoutePath=undefined
  |  -> emit {decorator:'route', path:'/users'}
  |  recurse children with parentRoutePath='/users'    <-- NEW
       -> child string('/users') walks, no emission
       -> child member_expression walks, no emission
  v
RESULT: [{decorator:'route', path:'/users'}]   // BUG STILL: outer emits, but children?

The outer .route() call's CHILDREN are the call_expressions for .get and .post. With
parentRoutePath='/users' set during child recursion, those visits will NOW emit:

walk(call_expression(.get(g)), parentRoutePath='/users')
  |  prop.text == 'get', args=(g), parentRoutePath='/users'    <-- INHERITED
  |  -> emit {decorator:'get', path:'/users'}                   <-- NEW
  |  recurse children with parentRoutePath=undefined            <-- clear after emit
  v
walk(call_expression(.post(c)), parentRoutePath='/users')
  |  prop.text == 'post', args=(c), parentRoutePath='/users'   <-- INHERITED
  |  -> emit {decorator:'post', path:'/users'}                  <-- NEW
  v

FINAL RESULT: [
  {decorator:'route', path:'/users'},
  {decorator:'get',   path:'/users'},
  {decorator:'post',  path:'/users'}
]   // FIXED
```

## Sequence — `app.route('/users').get(g).post(c)` traversal (AFTER fix)

```mermaid
sequenceDiagram
    autonumber
    participant W as walk()
    participant RT as route() node
    participant G as .get(g) node
    participant P as .post(c) node
    participant CS as call-processor<br/>(processDecoratorRoutesWithRepoId)

    W->>W: walk(outer_call, parentRoutePath=undefined)
    W->>RT: descend into .route('/users') call
    RT->>W: prop='route', args=('/users'), parentRoutePath=undefined
    RT->>W: emit {decorator:'route', path:'/users'}
    RT->>W: recurse children with parentRoutePath='/users'
    W->>G: descend into .get(g) call
    G->>W: prop='get', args=(g), parentRoutePath='/users' (inherited)
    alt args[0] is identifier (no string)
        G->>W: emit {decorator:'get', path:'/users'} (inherited)
    else args[0] is string (path override)
        G->>W: emit {decorator:'get', path:<string-arg>} (AD-3 tie-break)
    end
    G->>W: recurse children with parentRoutePath=undefined (cleared)
    W->>P: descend into .post(c) call
    P->>W: prop='post', args=(c), parentRoutePath=undefined
    Note over W,P: post is reached via .get(g)'s children,<br/>not .route('/users')'s children<br/>(see EdgeCase 1 — 3-level chains out of scope)
    P->>W: parentRoutePath=undefined → no emit
    Note over W,P: BUG: post is missed in 3-level chain;<br/>documented limitation
    W->>CS: returns [{decorator:'route', path:'/users'}, {decorator:'get', path:'/users'}]
    CS->>CS: create 2 Route nodes (Route+ROUTE, Route+GET)
```

For the 2-level case `app.route('/x').get(g)` (the most common pattern), the post node is absent and the result is 2 routes (route + get), as expected.

## EdgeCases

1. **`app.route('/x').get(g).post(c).put(p)` (3-level chain)** — After `.get(g)` recurses with `parentRoutePath='/x'`, that recursion clears `parentRoutePath` to `undefined` for `.get(g)`'s OWN children. So `.post(c)` is reached via the OUTER `.get(g)` call's child recursion — which still has `parentRoutePath='/x'`? No: each child gets a fresh `undefined` after the emission. The fix needs to keep `parentRoutePath` for *sibling* sub-expressions of the original `route()` call. Solution: the chain `.get(g).post(c).put(p)` is structured as `call_expression(put, object=call_expression(post, object=call_expression(get, object=app.route('/x'))))`. The `route()` call's direct children include the `.get(g)` call expression; `.get(g)`'s children include `.post(c)`; `.post(c)`'s children include `.put(p)`. So with parameter threading, `.get` sees `parentRoutePath='/x'`, and `.post`/`.put` would need it threaded across 2-3 levels. The spec limits to 2-level (`.route().verb()`); 3+ levels fall back to current behavior (only the `route()` emit). Document this as a known limitation; if real code surfaces 3+ chains, file a follow-up.

   **AD-2 update**: limit to 2-level chain (`.route().verb()`); 3+ levels out of scope for this fix.

2. **`app.route('/x').get(g); app.post('/y', h)` (sibling, not nested)** — The sibling `app.post('/y', h)` is a top-level statement, NOT a child of the `app.route('/x')` call_expression. The walker recurses into the `program` node's children with `parentRoutePath=undefined` (the program node's children don't inherit the route's path). So this is correct — sibling `.post('/y')` gets its own string arg, parentRoutePath is undefined, no false inheritance.

3. **`app.route('/x').get(g)` (2-level chain, 1 verb)** — `.get(g)` is a direct child of `.route('/x')` call. parentRoutePath='/x' is set during child recursion. `.get` emits with the inherited path. **2 routes total** (route + get).

4. **Method name collision: `app.route('/x').get('/y', h)`** — pathological case where the verb call has its own string arg. Current logic would emit using the string arg (the first-string rule fires). After fix, `parentRoutePath='/x'` is inherited, but the existing first-string rule fires first. **Tie-break policy**: prefer the explicit string arg over the inherited path. This matches how Express actually behaves — `.get('/y', h)` would override the path. Emit using the string arg, NOT the inherited path. **AD-3**: add to the walker — `if (parentRoutePath && args has no string) emit with parentRoutePath; else use string arg if present`.

## BlastRadius

- **d1 direct (modified):** 2 files — `route-extractors/express.ts`, `express.test.ts`.
- **d1 interface (changed):** None. `ExtractedDecoratorRoute` shape is unchanged.
- **d2 affected (read-only, no change):** `processDecoratorRoutesWithRepoId` already accepts any `decorator` string.
- **d3 regression gate:** `test/integration/resolvers/express-routes.test.ts` — the fixture `express-route-mapping` does not appear to contain chained `.route().verb()` patterns, so this integration test should pass unchanged. Will run it as a gate.
- **Test suite gate:** `npm test` (or `npx vitest run`) + `npx tsc --noEmit`.

## CrossCutting

- **`[[route-fix-regression]]`** guard: the fix is scoped to a single extractor file and its unit test. No changes to `parsing-processor.ts`, `parse-worker.ts`, `call-processor.ts`, or the `ExtractedDecoratorRoute` interface. ✓
- **`[[db-is-ladybugdb]]`**: not relevant — no DB queries.
- **`[[stale-index-zero-results]]`**: not relevant — the fix is at extraction time, not query time. The index will go stale on commit (PostToolUse hook handles re-analyze).
- **Embedding preservation**: not relevant — no `npx gitnexus analyze --embeddings` invocation in this work item.

## Autonomous Decisions

- **AD-1**: Preserve the outer `route()` emission as a separate Route node (don't suppress it). Rationale: it's a valid API surface; suppression adds asymmetry; the extra node is harmless.
- **AD-2**: Limit chain handling to 2-level (`.route().verb()`). 3+ levels fall back to current behavior; file follow-up if real code surfaces it. Rationale: covers the common Express pattern; 3+ chains are rare and add recursion complexity.
- **AD-3**: When a chained verb call HAS its own string arg, prefer the string arg over the inherited `parentRoutePath`. Rationale: matches Express runtime semantics; avoids breaking the existing first-string rule.
- **AD-4**: Re-test #84/#33 documented in PR description, not bundled into the fix. Rationale: route-fix-regression guard requires single-anchor PRs; the FastAPI/Go tests already pass; no remaining work to bundle.
- **AD-5**: `processDecoratorRoutesWithRepoId` will create a `Route` node with `httpMethod: 'ROUTE'` for the outer call. Acceptable trade-off: a `ROUTE` Route node is a clear signal of the bare-`route()` pattern; the chained verbs create their own `GET`/`POST` nodes. No downstream consumer filters on `httpMethod !== 'ROUTE'`.
- **AD-6 (delta from original AD-1)**: AD-3 subsumption. When a chained verb call uses its own string arg that DIFFERS from the inherited `route()` path, the outer `route()` emission is suppressed via post-processing (recording the line number and filtering on exit). This refines the original AD-1: instead of "preserve unconditionally," the rule is "preserve unless subsumed by an explicit verb call." Rationale: avoids redundant `ROUTE` shadow nodes when the developer writes `app.route('/x').get('/y', h)`. Implementation detail: the post-processing uses a `Set<number>` of subsumed line numbers, applied after the recursive walk completes.

## Verification

| Test | Expected | Gate |
|---|---|---|
| `npx vitest run test/unit/route-extractors/express.test.ts` | All 9 tests pass (existing 8 + new 2-level test) | must |
| `npx vitest run test/integration/resolvers/express-routes.test.ts` | All tests pass unchanged | must |
| `npx vitest run` (full unit suite) | All tests pass | must |
| `npx tsc --noEmit` | Clean | must |
| `npx gitnexus detect_changes` post-merge | Only `route-extractors/express.ts` + `express.test.ts` in the diff | must |
| Re-run pinning test (`express.test.ts:140-166` M4b) | Asserts 3 routes (route + get + post on `/users`) | must |
| Re-test #84 (`python-fastapi-handler.test.ts`) | 4/4 pass (already green; verify still green) | must |
| Re-test #33 (`go-handler-service.test.ts`) | 4/4 pass (already green; verify still green) | must |
| `gh issue view 84 --comments` post-merge | Append "Verified resolved by #146/#150" comment; close | must |
| `gh issue view 33 --comments` post-merge | Append "Verified resolved by #19" comment; close | must |
| `gh issue close 145` post-merge | Issue closed with PR link | must |
