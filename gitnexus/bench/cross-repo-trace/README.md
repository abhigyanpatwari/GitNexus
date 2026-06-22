# Cross-repo trace — end-to-end verification

Verifies the cross-repo `trace` MCP tool against the **real pipeline** (not
hand-persisted graphs): `runFullAnalysis(--pdg)` on two repos → real `syncGroup`
HTTP contract extraction + bridge build → `callTool('trace', { repo: '@group' })`.

Run from `gitnexus/` (needs a current build for the parse worker):

```bash
node scripts/build.js
node bench/cross-repo-trace/verify-named.mjs
```

Fixture (`fixtures-named/`): a frontend with named `fetch` wrappers
(`fetchUsers`, `createUserReq`) and a backend with named express handlers
(`listUsers`, `createUser`), linked by `/api/users` GET/POST.

## What it proves

- `analyze` + `syncGroup` build the correct `ContractLink`s (exact HTTP match).
- HTTP contracts now carry a **real `symbolUid`** — the extractor resolves each
  detection to the function it lives in (the function CONTAINING the `fetch`;
  the named/inline handler for a route) via line-span containment over the
  `File-[DEFINES]->symbol` graph. Contracts report
  `extractionStrategy: 'source_scan_resolved'` / `'graph_assisted'` with a uid.
- `trace @group from=<calling fn> to=<handler fn>` **stitches the cross-repo
  path** (`fetchUsers → listUsers`), reporting the `CONTRACT_LINK` hop and
  (with `pdg:true`) the data-flow enrichment. Expected verdict: **2/2 ok**,
  **symbol-precise** (GET pair → `http::GET` contract, POST → `http::POST`),
  with no file-fallback note.
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

Residual (inherent): a **fully anonymous handler with no named callee**
(`router.get('/x', (req,res) => res.json(...))`) exposes no symbol to name as a
trace target — those rely on the file fallback (or a named function the handler
calls). The line is set per language plugin; plugins that do not yet set it fall
through to the file fallback with no regression.
