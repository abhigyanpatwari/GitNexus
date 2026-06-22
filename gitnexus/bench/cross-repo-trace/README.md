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
- `trace @group from=<calling fn> to=<handler fn>` **stitches the cross-repo
  path** (`fetchUsers → listUsers`), reporting the `CONTRACT_LINK` hop and
  (with `pdg:true`) the data-flow enrichment. Expected verdict: **2/2 ok**.

## Known limitations (by design, surfaced via `notes[]`)

HTTP (and other source-scan) contracts hardcode `symbolUid:''` — the extraction
does not resolve the HTTP call/handler to a symbol node id. `trace` (and
`impact`) join crossings by `symbolUid`, so cross-trace falls back to a
**file-level boundary**: when the user's `from`/`to` resolve into the contract's
file, that endpoint anchors the boundary. Consequences:

1. **Anonymous handlers can't be traced** — there is no named target symbol
   (e.g. `router.get('/x', (req,res) => …)`). The user must name a real function.
2. **File-level precision** — when several contracts share the same consumer/
   provider files (e.g. GET + POST in one file), the file fallback can attach the
   wrong `contractId` to a correct path. The `notes[]` entry flags this.

The proper fix is upstream in the HTTP contract extraction (populate `symbolUid`
by resolving the call site to its containing function); that benefits `impact`
too and is tracked as follow-up. This benchmark is the regression gate for it.
