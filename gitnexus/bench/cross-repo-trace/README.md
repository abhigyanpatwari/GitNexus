# Cross-repo trace — end-to-end verification

Verifies the cross-repo `trace` MCP tool against the **real pipeline** (not
hand-persisted graphs): `runFullAnalysis(--pdg)` on two repos → real `syncGroup`
HTTP contract extraction + bridge build → `callTool('trace', { repo: '@group' })`.

Run from `gitnexus/` (needs a current build for the parse worker):

```bash
node scripts/build.js
node bench/cross-repo-trace/verify.mjs
```

`verify.mjs` is self-contained — it generates each fixture inline, runs the real
analyze → sync → trace/impact pipeline, and prints PASS/FAIL per assertion
(exit non-zero on any failure). Expected verdict: **16/16 checks passed**.

## Cases covered (one scenario each)

1. **Named handlers, same file** — a frontend with named `fetch` wrappers
   (`fetchUsers`, `createUserReq`) and a backend with named express handlers
   (`listUsers`, `createUser`) on `/api/users` GET/POST. Asserts: all four
   contracts resolve a `symbolUid`; `trace` is **symbol-precise** (the GET pair
   selects `http::GET`, the POST pair `http::POST`, no file-fallback note); the
   destination trace lands at `listUsers`.
2. **Anonymous handler** — `router.get('/api/ping', (req,res) => …)`. Asserts the
   provider contract has an empty `symbolUid`, and the **destination trace**
   (omit `to`) reaches it, reported as `<http::GET::/api/ping handler>` with an
   anonymous note.
3. **Cross-repo `impact` fan-out** — `impact @group` on `fetchUsers` crosses the
   boundary (`cross_repo_hits >= 1`); the same `symbolUid` join was 0 before.
4. **Multi-language (Python)** — a Flask provider + `requests` consumer; asserts
   the Python line wiring resolves the consumer and the cross-repo `trace`
   stitches `fetch_items -> list_items`.
5. **Cross-file named handler** (#2275) — a route whose handler (`listUsers`) is
   imported from another file than its registration. Asserts the provider
   resolves to the handler via the import-pinned module lookup, and the trace is
   symbol-precise (no file-level fallback).
6. **Aliased cross-file import** (#2275) — `import { listUsers as handleUsers }`
   with an unrelated decoy `handleUsers` elsewhere. Asserts the route resolves
   through the import to the declared `listUsers` (not the alias or the decoy),
   proving import-pinned resolution.
7. **Python aliased import** (#2275) — a Flask `add_url_rule('/api/users',
   view_func=handle_users)` whose view is `from .handlers.users import list_users
   as handle_users`. Asserts the handler resolves through Python's dotted
   relative module to `list_users`, symbol-precise.

The **ambiguous-destination** (a file making several HTTP calls whose consumer
contracts have no resolved uid) and **degraded-member** (a member DB that throws
mid-resolution) paths need synthetic inputs the real analyzer cannot produce, so
they live in the unit suite (`test/unit/group/cross-trace.test.ts`).

## What it proves

- `analyze` + `syncGroup` build the correct `ContractLink`s (exact HTTP match).
- HTTP contracts carry a **real `symbolUid` whenever the endpoint resolves** —
  the extractor binds each detection to the function it lives in (the function
  CONTAINING the `fetch`; the named handler, or the inline handler by line-span
  containment, for a route). A handler/consumer that resolves to no named symbol
  (a fully anonymous handler, or a language plugin that does not yet set the
  call-site line) keeps an empty uid and degrades to the file/destination
  fallback. When resolved, contracts report
  `extractionStrategy: 'source_scan_resolved'` / `'graph_assisted'` with a uid.
- `trace @group from=<calling fn> to=<handler fn>` **stitches the cross-repo
  path** (`fetchUsers → listUsers`), reporting the `CONTRACT_LINK` hop and
  (with `pdg:true`) the data-flow enrichment, **symbol-precise** (GET pair →
  `http::GET` contract, POST → `http::POST`), with no file-fallback note.
- The same `symbolUid` fix makes `impact @group` fan out across the boundary
  (it was 0 cross-repo hits before — both tools join crossings on `symbolUid`).

## Resolution precedence & residual limits

The extractor resolves `symbolUid` in this order, falling through on a miss:

1. **Named handler** — `router.get('/x', listUsers)` resolves `listUsers` by name.
2. **Containment** — the innermost `Function`/`Method` whose line span encloses
   the call/registration line (consumers; inline-arrow providers).
3. **File-level boundary fallback** (in `cross-trace`) — only when 1–2 leave the
   uid empty: if the user's `from`/`to` resolves into the contract's file, that
   endpoint anchors the boundary. A `notes[]` entry flags it as file-level, not
   symbol-precise.

The call-site line is set by all bundled language plugins (Node/TS, Python, Go,
PHP, Kotlin, Java), and containment matches symbols by `filePath` across
`Function`/`Method`/`CodeElement`, so it also resolves methods nested in classes
(Java/Kotlin), not just top-level functions.

### Anonymous handlers — the destination trace

A **fully anonymous handler** (`router.get('/x', (req,res) => res.json(...))`)
has no symbol node at all, so it cannot be named as a `to` target. This is
handled by the **destination trace**: omit `to`/`to_uid`/`to_file` on an
`@group` trace and `trace from=<consumer>` follows the consumer's outgoing HTTP
call across the bridge and reports where it lands — by route + file:line, with a
`notes[]` entry flagging the handler as anonymous:

```
app/frontend:fetchUsers → app/backend:<http::GET::/api/users handler>   [CONTRACT_LINK]
```

To go deeper into an anonymous handler, trace to a named function it calls (the
provider segment then resolves normally).
