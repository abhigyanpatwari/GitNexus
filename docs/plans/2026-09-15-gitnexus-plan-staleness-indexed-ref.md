# GitNexus Engineering Plan

> Task: Make the MCP tool staleness signal name the ref it describes, so an `impact`/`query`/`context`/`cypher` answer from a branch-pinned index is distinguishable from one from a current default-branch index (#3291).
> Evidence verified at commit dcf980581cbf861a411b5787774b723e5b1ccaf9; GitNexus index not used — graph unavailable (LadybugDB storage version 43 vs installed build 42) and analyzer provenance stale (index CLI 1.6.11 vs source 1.6.12); all findings are source-derived.
> Evidence provenance schema 2; global dirty digest d6072208e1a36d18ecb2ac068ae70837b4ced3395d77080cea7e1614ce76ca2a; cited-path manifest 24 sorted entries; exact generated plan path excluded.

## 1. Objective

A caller of the four hot read tools must be able to tell, **from the response alone**, which ref the answer describes — and distinguish "current index of the default branch" from "current index of some feature branch". Today both produce a response with no `staleness` field at all.

Scope is the MCP tool surface. `list_repos` and the HTTP repo routes already expose the ref as top-level fields and are deliberately left byte-identical.

## 2. Current Behaviour

Three verified facts compose into the bug.

1. `checkStalenessAsync` measures `<lastCommit>..HEAD` against **the clone's own checkout** `[verified]` (`gitnexus/src/core/git-staleness.ts:118`). A clone pinned to `feature/x` and analyzed at that branch's head counts 0 even when `feature/x` is short of `main`.
2. `stalenessPayload` suppresses the payload entirely for `current` `[verified]` (`gitnexus/src/core/staleness-status.ts:85`):

```ts
if (status === 'current') return undefined;
```

3. `attachToolStaleness` adds nothing when the payload is `undefined` `[verified]` (`gitnexus/src/mcp/local/local-backend.ts:1474-1480`).

Net: the `impact` response from a behind-main feature-branch index is `JSON.stringify`-identical to one from a current `main` index. **Reproduced live**, not argued from source: `gitnexus/test/unit/repro-3291-staleness-indexed-ref.test.ts` (2 tests, passing at this commit) drives real `callTool('impact')` against two real clones with real `git`, asserts a measured precondition (`rev-list <branchHead>..origin/main === 2`) and a negative control (behind-own-checkout **does** attach the field) `[verified]`.

The type itself cannot express the fix: `StalenessPayload.status` is `Exclude<StalenessStatus, 'current'>` `[verified]` (`staleness-status.ts:65`).

## 3. Relevant Architecture

One builder, three consumer surfaces `[verified]`:

- `stalenessPayload(info, opts)` — `core/staleness-status.ts:78`. Pure, no git, no I/O. Deliberately split from `git-staleness.ts` because the suite `vi.mock`s that module wholesale (`staleness-status.ts:5-8`).
- **Hot read tools** — `withToolStaleness` → `attachToolStaleness`, wired at `local-backend.ts:2763` (query), `:2766` (cypher), `:2769` (context), `:2775` (impact). Freshness is TTL-cached 5 s, keyed by `lbugPath` so flat and branch handles never share an entry (`:1500-1505`, `:2692-2718`).
- **`list_repos`** — `local-backend.ts:2494-2528`. Emits `staleness` *plus* top-level `branch`, `branches`, `indexedAt`, `lastCommit`.
- **HTTP `/api/repos` + `/api/repo`** — `server/repo-projection.ts:41-91`, called from `server/api.ts:1152,1188`. Same split: `stalenessField()` for the verdict, top-level `branch`/`branches` for identity (`repo-projection.ts:61-67`).

**The established pattern is therefore: ref identity lives beside the payload, not inside it** `[verified]`. #3226's own test spells out why identity had to be exposed at all — a pinned entry is otherwise only tellable apart by parsing a clone-directory slug (`test/unit/repo-projection.test.ts:103-114`).

The tool surface is the one place that pattern cannot be copied: a tool result is an arbitrary object, and the shape contract is that `attachToolStaleness` only ever adds the single key `staleness` (`local-backend.ts:1453-1461`, pinned by `test/unit/tool-staleness.test.ts:36-41`). Adding sibling top-level keys to an `impact` result would break that contract and risk colliding with tool fields. So on this surface the ref must ride **inside** the one added key.

## 4. GitNexus Findings

**Fallback mode — no graph findings.** The MCP graph tools are unusable for this repo: `query` returns *"Database file version: 43, Current build storage version: 42"*, and the index is 143 commits behind this worktree with stale analyzer provenance (CLI 1.6.11 vs source 1.6.12, from `gitnexus://repo/GitNexus/context`). Per the skill, stale provenance is disclosed, never repaired by a planning run. Every finding below is **source-derived** by targeted read/grep.

Direct (depth-1) dependents, enumerated by grep over `gitnexus/src` `[verified]`:

- `stalenessPayload` → `repo-projection.ts:42`; `local-backend.ts:1475`; `local-backend.ts:2506`; re-export `mcp/staleness.ts:8`.
- `attachToolStaleness` → `local-backend.ts:2678` only, plus tests.
- `StalenessPayload` (type) → `local-backend.ts:1372` (`RepoListing.staleness`); `repo-projection.ts:15,41`.
- `stalenessStatus` → `core/group/service.ts:901` (group status; separate shape, not a `stalenessPayload` consumer).

Ref availability on the handle `[verified]`:

- `RepoHandle` carries `indexedAt: string`, `lastCommit: string` (required) and `branch?: string` (`local-backend.ts:1070-1084`); populated from the registry entry at `:1824-1836`, and re-derived per branch scope at `:2103-2109` / `:2132-2138`.
- `branch` **is** stamped by a plain analyze: `branchLabel = options.branch ?? checkedOutBranch` (`run-analyze.ts:1089`) written as `branch: branchLabel ?? existingMeta?.branch` (`run-analyze.ts:4275`). It is absent only for detached HEAD, non-git, or never-stamped legacy metas. `repo-meta.ts:513-520`'s "absent for the default/legacy single-branch case" describes the pre-#2106 legacy shape, not current behaviour.

Consequence: **`lastCommit` and `indexedAt` are always available; `branch` is best-effort.** The fix must not depend on `branch` alone.

No cheap branch-name probe exists for the hot path: `getCurrentBranch` / `getDefaultBranch` (`storage/git.ts:651`, `:622`) are synchronous `execSync` spawns, excluded by the no-new-git-spawn constraint.

## 5. Statement-Level PDG Findings

**Empty — no PDG layer is reachable.** The graph tools are down for the storage-version reason in §4, so `pdg_query` and `impact {mode:"pdg"}` cannot run, and the skill forbids reconstructing dependence edges from source by hand. The control flow that matters is short and directly source-verified in §2 instead: a single early `return undefined` at `staleness-status.ts:85` gates the entire behaviour, and a single `if (!staleness || !canCarryStaleness(result))` at `local-backend.ts:1476` gates the attach.

## 6. Proposed Changes

### 6.1 `gitnexus/src/core/staleness-status.ts` — carry the ref, make `current` expressible

- Widen `StalenessPayload.status` to the full `StalenessStatus` (add `current`). Today it is `Exclude<StalenessStatus,'current'>` (`:65`).
- Add optional `branch?: string`, `lastCommit?: string`, `indexedAt?: string`, and `measuredAgainst?: 'HEAD'` — the last names the ref `commitsBehind` is counted against, which is issue part 2 and costs nothing.
- Extend the options bag: `stalenessPayload(info, { includeUnknown?, ref? })` where `ref` is `{ branch?, lastCommit, indexedAt }`. **When `ref` is absent, behaviour is bit-for-bit unchanged**, including the `current` short-circuit and the `unknown` gate — that is what keeps `list_repos` and both HTTP routes untouched.
- When `ref` is supplied, emit for **every** status including `current` and `unknown`, merging the ref fields and `measuredAgainst: 'HEAD'`.

Constraint: `commitsBehind` stays present only when git counted it (`diverged` must still carry no number — `:87`).

### 6.2 `gitnexus/src/mcp/local/local-backend.ts` — pass the handle's ref through

- `attachToolStaleness(result, info, ref?)` — forward `ref` to the builder. `canCarryStaleness` is **unchanged**: still one added key, still skipping arrays, error envelopes, and results that already carry `staleness`.
- `withToolStaleness` (`:2671`) builds the ref from the already-resolved handle: `{ branch: repo.branch, lastCommit: repo.lastCommit, indexedAt: repo.indexedAt }`. **No new git spawn, no new I/O** — the handle is already in hand and the freshness TTL cache is untouched.
- `listRepos` (`:2506`) is left exactly as-is — it already emits the ref top-level.

### 6.3 Docs — `.claude/skills/gitnexus-guide/SKILL.md` and the plugin mirror

Update the "Inline staleness signal" section (`:84-102`): the field is no longer absent when current; it now always names the ref on these four tools. Both copies must change together — `gitnexus/skills/gitnexus-guide.md` does **not** contain this section (pre-existing drift, confirmed by grep) and stays out of scope.

### 6.4 `gitnexus/test/unit/shipped-skills-sync.test.ts` — update the shape guard

`:270` hard-asserts the literal `'{ status, commitsBehind?, hint? }'`. It must become the new documented shape string. Leave the surrounding `diverged` / `commitsBehind` assertions intact.

## 7. Implementation Sequence

1. **Extend the builder** (§6.1). Add the `ref` option and widen the status union in `staleness-status.ts`. Add unit cases to `test/unit/tool-staleness.test.ts` covering: ref absent ⇒ identical legacy output for all four statuses; ref present ⇒ payload emitted for `current`; `diverged` + ref still carries no `commitsBehind`. Tree is coherent here — no caller passes `ref` yet, so every existing test must still pass **unchanged**. That is the regression gate for surfaces 2 and 3.
2. **Wire the tool surface** (§6.2). Thread `ref` through `attachToolStaleness` and `withToolStaleness`.
3. **Invert the repro** — rewrite `test/unit/repro-3291-staleness-indexed-ref.test.ts` so the feature-branch response now carries `staleness.branch === 'feature/x'` and differs from the main response; keep the measured `behindMain === 2` precondition and the negative control.
4. **Update the co-located tool tests** — `test/unit/tool-staleness.test.ts:31-34` and `:99-104` (the two "leaves a current index untouched" cases) now assert the ref-carrying payload when a ref is passed. `test/unit/calltool-dispatch.test.ts:5302` asserted the branch handle has no `staleness`; its real intent is cache keying, so re-express it as `flatRes.staleness.commitsBehind === 5` **and** `branchRes.staleness.status === 'current'` — which proves the same non-shared-cache property more strongly than absence did.
5. **Docs + guard together** (§6.3, §6.4) in one step — the guard reads the docs, so splitting them leaves a red commit.
6. **Full verification** — `npx tsc --noEmit`, `npm run test:unit`, `npm run test:integration`.

## 8. Test Strategy

**New / rewritten**

- `gitnexus/test/unit/repro-3291-staleness-indexed-ref.test.ts` — inverted, keeping its real-git two-clone harness and both non-vacuity guards:
  - feature-branch index 2 commits behind main → `impact` response carries `staleness.branch === 'feature/x'`, `staleness.lastCommit === <branchHead>`, `staleness.status === 'current'`.
  - main index at HEAD → response carries `staleness.branch === 'main'`.
  - the two responses are **no longer** `JSON.stringify`-equal (the exact assertion that fails today).
  - negative control retained: handle at `HEAD~2` → `status: 'behind'`, `commitsBehind: 2`.
- `gitnexus/test/unit/tool-staleness.test.ts` — add: ref omitted ⇒ output byte-identical to today for `behind` / `diverged` / `unknown` / `current`; ref present ⇒ `current` emits; ref present with `branch` undefined (detached HEAD) ⇒ `lastCommit` still present, no `branch` key.

**Updated**

- `gitnexus/test/unit/calltool-dispatch.test.ts` — the cache-keying case at `:5261-5303` per step 4.
- `gitnexus/test/unit/shipped-skills-sync.test.ts:260-273` — new shape string.

**Must stay green untouched** (this is the blast-radius check, not a formality)

- `gitnexus/test/unit/repo-projection.test.ts` — `stalenessField` `toEqual({})` for fresh (`:57`), exact payloads at `:62`, `:79`, `:83`.
- `gitnexus/test/integration/server-repo-freshness.test.ts:193`, `:220` — `toEqual` on the exact HTTP payload.
- `gitnexus/test/unit/staleness.test.ts`, `staleness-fallback.test.ts` — `StalenessInfo` contract, untouched by this change.

**Verification commands** (verified present in `gitnexus/package.json` and AGENTS.md §Testing)

- `npx tsc --noEmit`
- `npm run test:unit`
- `npm run test:integration` (carries its `pretest:integration` build)

## 9. Risk and Impact Analysis

| Risk | Assessment |
| --- | --- |
| **Response-size growth on every hot read call** | Real and accepted. The payload now rides on *every* `query`/`context`/`impact`/`cypher` response instead of only stale ones — roughly 100–150 bytes. This is the cost of the feature the issue asks for; it is bounded, constant, and carries no extra I/O. |
| **Reverses #3256's `unknown` suppression on hot tools** | Deliberate. #3256 suppressed `unknown` there because a repeated bare verdict was noise. With the ref attached the field is no longer only a warning — it is an identity statement, useful precisely when freshness is unmeasurable. Called out in §12. |
| **`list_repos` / HTTP regression** | Structurally prevented: those call sites pass no `ref`, and step 1 lands the builder change with every existing test unmodified. `repo-projection.test.ts` and `server-repo-freshness.test.ts` use `toEqual`, so any leakage fails loudly. |
| **Shape-contract breakage** | `canCarryStaleness` is untouched; still exactly one added key. `tool-staleness.test.ts:36-41` (raw-array cypher) and `:43-46` (error envelope) pin it. |
| **Hot-path latency** | Unchanged. The ref comes from the resolved `RepoHandle`; no git spawn, no I/O, TTL cache untouched. |
| **`branch` absent on detached HEAD / legacy metas** | Handled by design — `lastCommit` is required on the handle and always emitted; `branch` is optional. Explicitly tested. |
| **Docs drift** | `shipped-skills-sync.test.ts` + the `skill-sync.yml` workflow gate the two guide copies; step 5 changes docs and guard together. |

Depth-1 dependents from §4 are each accounted for: `repo-projection.ts:42` and `local-backend.ts:2506` are no-ref call sites (unchanged by construction); `local-backend.ts:1475` is the one changed call site; `mcp/staleness.ts:8` is a pure re-export; `group/service.ts:901` consumes `stalenessStatus`, not `stalenessPayload`, and is untouched.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `gitnexus/src/core/staleness-status.ts` | `StalenessPayload`, `stalenessPayload` | Carry the ref; make `current` expressible |
| `gitnexus/src/mcp/local/local-backend.ts` | `attachToolStaleness`, `withToolStaleness` | Pass the handle's ref through |
| `gitnexus/test/unit/repro-3291-staleness-indexed-ref.test.ts` | — | Invert the repro |
| `gitnexus/test/unit/tool-staleness.test.ts` | — | Ref-present / ref-absent cases |
| `gitnexus/test/unit/calltool-dispatch.test.ts` | — | Re-express the cache-keying assertion |
| `gitnexus/test/unit/shipped-skills-sync.test.ts` | — | New documented shape string |
| `.claude/skills/gitnexus-guide/SKILL.md` | — | Document the new signal |
| `gitnexus-claude-plugin/skills/gitnexus-guide/SKILL.md` | — | Byte-mirror of the above |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >
    Make the MCP hot-read-tool staleness signal name the indexed ref (branch,
    lastCommit, indexedAt) and emit it even when the index is current, so a
    branch-pinned index is distinguishable from a current default-branch index.
    list_repos and the HTTP repo routes already expose the ref top-level and
    must stay byte-identical.
  acceptance_criteria:
    - An impact response from a feature-branch index names that branch.
    - It is no longer JSON-identical to one from a current main index.
    - list_repos and /api/repos, /api/repo responses are unchanged.
    - No new git spawn or I/O on the hot read path.
    - '#3256 status axis intact: current is still distinct from unknown.'

  evidence_provenance:
    schema_version: 2
    head_commit: 'dcf980581cbf861a411b5787774b723e5b1ccaf9'
    generated_plan_path: 'docs/plans/2026-09-15-gitnexus-plan-staleness-indexed-ref.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: 'd6072208e1a36d18ecb2ac068ae70837b4ced3395d77080cea7e1614ce76ca2a'
    cited_path_manifest:
      - path: '.claude/skills/gitnexus-guide/SKILL.md'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        index_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        worktree_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        untracked_digest: absent
      - path: 'AGENTS.md'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:b0da2fc7e3115d1314fc30517a5e1e403d6b33e6ae0f37d4b16f2c2ff63e6a1f'
        index_digest: 'sha256:b0da2fc7e3115d1314fc30517a5e1e403d6b33e6ae0f37d4b16f2c2ff63e6a1f'
        worktree_digest: 'sha256:b0da2fc7e3115d1314fc30517a5e1e403d6b33e6ae0f37d4b16f2c2ff63e6a1f'
        untracked_digest: absent
      - path: 'gitnexus-claude-plugin/skills/gitnexus-guide/SKILL.md'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        index_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        worktree_digest: 'sha256:53c72fbf357c8ee1c612abbdf423e4a6991394255dead63957e953acfd240f17'
        untracked_digest: absent
      - path: 'gitnexus/package.json'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:b41019cd74d63fd463d81ceac40d205c6e0b69ef0f6f096ec31e3e32a746a7c2'
        index_digest: 'sha256:b41019cd74d63fd463d81ceac40d205c6e0b69ef0f6f096ec31e3e32a746a7c2'
        worktree_digest: 'sha256:b41019cd74d63fd463d81ceac40d205c6e0b69ef0f6f096ec31e3e32a746a7c2'
        untracked_digest: absent
      - path: 'gitnexus/src/core/git-staleness.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:b6aaf7c8b0149da9eb3e54e8599bec8600a50177c44c557d328521c4b96b5b73'
        index_digest: 'sha256:b6aaf7c8b0149da9eb3e54e8599bec8600a50177c44c557d328521c4b96b5b73'
        worktree_digest: 'sha256:b6aaf7c8b0149da9eb3e54e8599bec8600a50177c44c557d328521c4b96b5b73'
        untracked_digest: absent
      - path: 'gitnexus/src/core/group/service.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:7d9166cde42808a649f95309e9f5c051ca1e59f1cb31d1a5f43f1683ecdb0caf'
        index_digest: 'sha256:7d9166cde42808a649f95309e9f5c051ca1e59f1cb31d1a5f43f1683ecdb0caf'
        worktree_digest: 'sha256:7d9166cde42808a649f95309e9f5c051ca1e59f1cb31d1a5f43f1683ecdb0caf'
        untracked_digest: absent
      - path: 'gitnexus/src/core/run-analyze.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:c060b770a8a2387c56ac2db23b11fb3412edec7071e863b4a076056b495b38d6'
        index_digest: 'sha256:c060b770a8a2387c56ac2db23b11fb3412edec7071e863b4a076056b495b38d6'
        worktree_digest: 'sha256:c060b770a8a2387c56ac2db23b11fb3412edec7071e863b4a076056b495b38d6'
        untracked_digest: absent
      - path: 'gitnexus/src/core/staleness-status.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:e032e03288e881dcdf59fb5dbab12ba9971d98bbda9a5badbfdfd07c8848b439'
        index_digest: 'sha256:e032e03288e881dcdf59fb5dbab12ba9971d98bbda9a5badbfdfd07c8848b439'
        worktree_digest: 'sha256:e032e03288e881dcdf59fb5dbab12ba9971d98bbda9a5badbfdfd07c8848b439'
        untracked_digest: absent
      - path: 'gitnexus/src/mcp/local/local-backend.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:b888d56113ae0d3de4b2ce50e6eb1f21c76ea958ec45d1c8c4692a1a8ba55a53'
        index_digest: 'sha256:b888d56113ae0d3de4b2ce50e6eb1f21c76ea958ec45d1c8c4692a1a8ba55a53'
        worktree_digest: 'sha256:b888d56113ae0d3de4b2ce50e6eb1f21c76ea958ec45d1c8c4692a1a8ba55a53'
        untracked_digest: absent
      - path: 'gitnexus/src/mcp/resources.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:8d925b2ba207387af1f4229b53a5e196394f78a89a61c2069feb3bd782d0696f'
        index_digest: 'sha256:8d925b2ba207387af1f4229b53a5e196394f78a89a61c2069feb3bd782d0696f'
        worktree_digest: 'sha256:8d925b2ba207387af1f4229b53a5e196394f78a89a61c2069feb3bd782d0696f'
        untracked_digest: absent
      - path: 'gitnexus/src/mcp/staleness.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:81b27a1c01974808b3e094866df200e9098dd75915dd6b3324e3d5272599bbff'
        index_digest: 'sha256:81b27a1c01974808b3e094866df200e9098dd75915dd6b3324e3d5272599bbff'
        worktree_digest: 'sha256:81b27a1c01974808b3e094866df200e9098dd75915dd6b3324e3d5272599bbff'
        untracked_digest: absent
      - path: 'gitnexus/src/server/api.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:3135354d656ae4b69b2dc578c99766ce5bb4ff4ad16198d3b880ecd57aea83a3'
        index_digest: 'sha256:3135354d656ae4b69b2dc578c99766ce5bb4ff4ad16198d3b880ecd57aea83a3'
        worktree_digest: 'sha256:3135354d656ae4b69b2dc578c99766ce5bb4ff4ad16198d3b880ecd57aea83a3'
        untracked_digest: absent
      - path: 'gitnexus/src/server/repo-projection.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:57cb889ea53e65e9e6e020b9cc4045010c4058e5763742d935c5f1c377e8b5a7'
        index_digest: 'sha256:57cb889ea53e65e9e6e020b9cc4045010c4058e5763742d935c5f1c377e8b5a7'
        worktree_digest: 'sha256:57cb889ea53e65e9e6e020b9cc4045010c4058e5763742d935c5f1c377e8b5a7'
        untracked_digest: absent
      - path: 'gitnexus/src/storage/git.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:89d1531cc1bd33762c82b7288d546e2abb6638b95ffd114bfcbe76d551a4bae3'
        index_digest: 'sha256:89d1531cc1bd33762c82b7288d546e2abb6638b95ffd114bfcbe76d551a4bae3'
        worktree_digest: 'sha256:89d1531cc1bd33762c82b7288d546e2abb6638b95ffd114bfcbe76d551a4bae3'
        untracked_digest: absent
      - path: 'gitnexus/src/storage/repo-manager.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:b928dc301a3bf311e5e0215dc29af37f4e801828597d5513214fa3a57b1cd76d'
        index_digest: 'sha256:b928dc301a3bf311e5e0215dc29af37f4e801828597d5513214fa3a57b1cd76d'
        worktree_digest: 'sha256:b928dc301a3bf311e5e0215dc29af37f4e801828597d5513214fa3a57b1cd76d'
        untracked_digest: absent
      - path: 'gitnexus/src/storage/repo-meta.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:e412aa5a1f7ee90ea58df4605213a3997a8e04558e41e254a96d4ac6f740c3c4'
        index_digest: 'sha256:e412aa5a1f7ee90ea58df4605213a3997a8e04558e41e254a96d4ac6f740c3c4'
        worktree_digest: 'sha256:e412aa5a1f7ee90ea58df4605213a3997a8e04558e41e254a96d4ac6f740c3c4'
        untracked_digest: absent
      - path: 'gitnexus/test/integration/server-repo-freshness.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:50e0e9ea36263d3f6368c24c6da0fd8ccd4bf460f9145e6b86a6a6578b7c1e89'
        index_digest: 'sha256:50e0e9ea36263d3f6368c24c6da0fd8ccd4bf460f9145e6b86a6a6578b7c1e89'
        worktree_digest: 'sha256:50e0e9ea36263d3f6368c24c6da0fd8ccd4bf460f9145e6b86a6a6578b7c1e89'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/calltool-dispatch.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:6a29b13e98ad272cb304ebf6043fa71966efb7ee54e4f8e0c3c51f6cc7136c47'
        index_digest: 'sha256:6a29b13e98ad272cb304ebf6043fa71966efb7ee54e4f8e0c3c51f6cc7136c47'
        worktree_digest: 'sha256:6a29b13e98ad272cb304ebf6043fa71966efb7ee54e4f8e0c3c51f6cc7136c47'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/repo-projection.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:a3bbb6cefcd3a045caa2d2672cd586a38d879ee920a89f70e54933e8816c0002'
        index_digest: 'sha256:a3bbb6cefcd3a045caa2d2672cd586a38d879ee920a89f70e54933e8816c0002'
        worktree_digest: 'sha256:a3bbb6cefcd3a045caa2d2672cd586a38d879ee920a89f70e54933e8816c0002'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/repro-3291-staleness-indexed-ref.test.ts'
        object_kind: { head: absent, index: absent, worktree: absent, untracked: regular }
        state: untracked
        rename_from: null
        rename_to: null
        head_digest: absent
        index_digest: absent
        worktree_digest: absent
        untracked_digest: 'sha256:eb6fea91c4b4985109812b84ccb374e8f473a53460b56809ef558700d34f1de9'
      - path: 'gitnexus/test/unit/shipped-skills-sync.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:7015a5837e8d2e1a50ea3d25758946ae9e263ff3e587964cfc073eafa80a4542'
        index_digest: 'sha256:7015a5837e8d2e1a50ea3d25758946ae9e263ff3e587964cfc073eafa80a4542'
        worktree_digest: 'sha256:7015a5837e8d2e1a50ea3d25758946ae9e263ff3e587964cfc073eafa80a4542'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/staleness-fallback.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:cb4798a6ad06b9069bfd05bac00caa7736e1a0f7e94971d4e39d2130fa7f7e1f'
        index_digest: 'sha256:cb4798a6ad06b9069bfd05bac00caa7736e1a0f7e94971d4e39d2130fa7f7e1f'
        worktree_digest: 'sha256:cb4798a6ad06b9069bfd05bac00caa7736e1a0f7e94971d4e39d2130fa7f7e1f'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/staleness.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:2a0a91548feb9a18d26617a7d97d360d2224393c8cdcbc8c9b21958c9f0df4f7'
        index_digest: 'sha256:2a0a91548feb9a18d26617a7d97d360d2224393c8cdcbc8c9b21958c9f0df4f7'
        worktree_digest: 'sha256:2a0a91548feb9a18d26617a7d97d360d2224393c8cdcbc8c9b21958c9f0df4f7'
        untracked_digest: absent
      - path: 'gitnexus/test/unit/tool-staleness.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: 'sha256:5018a59d6f0b7c33c1b0777089ca3daa0802ada5dff940cef8e6c62c7bf3d4a5'
        index_digest: 'sha256:5018a59d6f0b7c33c1b0777089ca3daa0802ada5dff940cef8e6c62c7bf3d4a5'
        worktree_digest: 'sha256:5018a59d6f0b7c33c1b0777089ca3daa0802ada5dff940cef8e6c62c7bf3d4a5'
        untracked_digest: absent

  primary_symbols:
    - symbol: 'stalenessPayload'
      file: 'gitnexus/src/core/staleness-status.ts'
      lines: '78-89'
      role: 'The single builder; owns the current short-circuit at :85'
    - symbol: 'StalenessPayload'
      file: 'gitnexus/src/core/staleness-status.ts'
      lines: '64-68'
      role: 'Wire shape; status is Exclude<StalenessStatus,current> and must widen'
    - symbol: 'attachToolStaleness'
      file: 'gitnexus/src/mcp/local/local-backend.ts'
      lines: '1474-1480'
      role: 'Adds the single staleness key to a carryable tool result'
    - symbol: 'withToolStaleness'
      file: 'gitnexus/src/mcp/local/local-backend.ts'
      lines: '2671-2679'
      role: 'Holds the resolved RepoHandle; the ref source'
    - symbol: 'RepoHandle'
      file: 'gitnexus/src/mcp/local/local-backend.ts'
      lines: '1070-1084'
      role: 'Carries indexedAt/lastCommit (required) and branch (optional)'

  related_symbols:
    - symbol: 'canCarryStaleness'
      relationship: 'called-by attachToolStaleness'
      relevance: 'Shape contract; must stay unchanged'
    - symbol: 'stalenessField'
      relationship: 'calls stalenessPayload'
      relevance: 'HTTP surface; must stay byte-identical (no ref passed)'
    - symbol: 'LocalBackend.listRepos'
      relationship: 'calls stalenessPayload'
      relevance: 'Already emits ref top-level; must stay unchanged'
    - symbol: 'stalenessForTool'
      relationship: 'called-by withToolStaleness'
      relevance: 'TTL cache keyed by lbugPath; must not grow a git spawn'

  execution_path:
    - 'callTool(impact) resolves a RepoHandle via selectToolRepository'
    - 'withToolStaleness checks canCarryStaleness, then awaits stalenessForTool'
    - 'stalenessForTool returns TTL-cached checkStalenessAsync(repoPath, lastCommit)'
    - 'checkStalenessAsync runs git rev-list --count <lastCommit>..HEAD in that clone'
    - 'a branch-pinned clone at its own head counts 0 -> status current'
    - 'stalenessPayload returns undefined for current -> attachToolStaleness adds nothing'

  pdg_constraints: []   # no PDG layer reachable; see plan section 5

  architectural_patterns:
    - pattern: 'Ref identity beside the payload, not inside it'
      example_location: 'gitnexus/src/server/repo-projection.ts:61-67'
      usage_guidance: >
        list_repos and both HTTP routes emit branch/branches/lastCommit/indexedAt
        as top-level siblings of staleness. Follow this on those surfaces. The
        tool surface is the documented exception: attachToolStaleness may add
        exactly one key, so the ref rides inside it there.
    - pattern: 'Additive option leaves existing callers bit-identical'
      example_location: 'gitnexus/src/core/staleness-status.ts:78-81'
      usage_guidance: >
        includeUnknown is already an opt-in that changes behaviour only for the
        caller that passes it. Add ref the same way, so the no-ref call sites
        need no edits and their toEqual tests keep passing unmodified.

  files_to_modify:
    - file: 'gitnexus/src/core/staleness-status.ts'
      symbols: ['StalenessPayload', 'stalenessPayload']
      intended_change: >
        Widen status to the full StalenessStatus; add optional branch,
        lastCommit, indexedAt, measuredAgainst; add opts.ref. With no ref the
        output is unchanged for every status.
    - file: 'gitnexus/src/mcp/local/local-backend.ts'
      symbols: ['attachToolStaleness', 'withToolStaleness']
      intended_change: >
        Thread a ref built from the already-resolved RepoHandle into the
        builder. No new git spawn, no I/O, TTL cache untouched.
    - file: '.claude/skills/gitnexus-guide/SKILL.md'
      symbols: []
      intended_change: 'Rewrite the Inline staleness signal section for the new shape.'
    - file: 'gitnexus-claude-plugin/skills/gitnexus-guide/SKILL.md'
      symbols: []
      intended_change: 'Mirror the canonical guide edit.'

  tests:
    - file: 'gitnexus/test/unit/repro-3291-staleness-indexed-ref.test.ts'
      scenarios:
        - 'feature-branch clone 2 behind main -> impact response -> staleness.branch === feature/x'
        - 'main clone at HEAD -> impact response -> staleness.branch === main'
        - 'the two responses -> JSON.stringify compare -> NOT equal (fails today)'
        - 'handle at HEAD~2 -> impact response -> status behind, commitsBehind 2 (control)'
    - file: 'gitnexus/test/unit/tool-staleness.test.ts'
      scenarios:
        - 'no ref + behind/diverged/unknown/current -> output identical to today'
        - 'ref present + current -> payload emitted carrying branch and lastCommit'
        - 'ref present with branch undefined -> lastCommit present, no branch key'
        - 'ref present + diverged -> still no commitsBehind'
    - file: 'gitnexus/test/unit/calltool-dispatch.test.ts'
      scenarios:
        - 'flat handle 5 behind and branch handle current -> distinct payloads, proving the lbugPath-keyed cache'
    - file: 'gitnexus/test/unit/shipped-skills-sync.test.ts'
      scenarios:
        - 'both guide copies contain the new documented shape string'

  verification_commands:
    - 'npx tsc --noEmit'
    - 'npm run test:unit'
    - 'npm run test:integration'

  risks:
    - 'Every hot read response grows by ~100-150 bytes; accepted, bounded, no extra I/O.'
    - 'Reverses #3256 suppression of unknown on hot tools; deliberate, see open_questions.'
    - 'repo-projection and server-repo-freshness use toEqual; any leak into the no-ref path fails loudly.'

  assumptions:
    - 'branch is stamped by a plain analyze (run-analyze.ts:1089,:4275) and absent only for detached HEAD / non-git / legacy metas. Re-verify by reading those two lines before relying on it.'
    - 'No consumer outside this repo depends on staleness being ABSENT to infer freshness. Unverifiable here; the docs said absence means current, so treat it as a documented behaviour change.'
    - 'gitnexus/skills/gitnexus-guide.md lacks the Inline staleness signal section (pre-existing drift). Re-check with grep before deciding it is out of scope.'

  open_questions:
    - 'Should unknown now emit on hot tools because it carries the ref, reversing #3256? Plan says yes; a reviewer may prefer keeping unknown suppressed.'
    - 'Should commitsBehind additionally be measured against the default branch? Deferred: needs a fetch or an origin/HEAD that may not resolve, and would add a git spawn to the hot path.'

  avoid:
    - 'Do not repeat full repository discovery'
    - 'Do not replace established patterns without evidence'
    - 'Do not add branch/indexedAt as top-level siblings on tool results — attachToolStaleness adds exactly one key.'
    - 'Do not add any git spawn, fetch, or I/O to withToolStaleness or stalenessForTool.'
    - 'Do not change list_repos (local-backend.ts:2506) or stalenessField (repo-projection.ts:42).'
    - 'Do not reclassify current as stale, and do not collapse unknown back into current.'
    - 'Do not edit gitnexus/CHANGELOG.md in this PR.'
    - 'Do not delete the repro test — invert it.'
    - 'Do not run gitnexus analyze --force against /workspace/.gitnexus; ~180 worktrees share it.'
```

## 12. Assumptions and Open Questions

**Confirmed facts** — every `[verified]` claim in §2–§4 was source-read at `dcf980581`, and the bug itself is reproduced by a passing test, not inferred.

**Assumptions**

1. `branch` is populated by a plain analyze. Read from `run-analyze.ts:1089` and `:4275`; the conflicting comment at `repo-meta.ts:513-520` is read as describing legacy metas. An executor should re-read both before relying on it.
2. No external consumer relies on `staleness` being absent to infer "current". Cannot be verified from this repo. The guide documents absence as the freshness signal (`SKILL.md:102`), so this is a **documented behaviour change** and should be called out in the PR body.
3. The npm mirror `gitnexus/skills/gitnexus-guide.md` has no "Inline staleness signal" section (grep: 0 matches) and is out of scope.

**Open questions**

1. Whether `unknown` should now emit on the hot tools. This plan says yes — with a ref attached the field stops being a bare warning and becomes an identity statement. A reviewer may reasonably prefer preserving #3256's suppression.
2. Whether the payload should distinguish "the branch this index represents" from "the branch currently checked out in that clone". They can differ, and only the former is free. The plan emits the former and names the comparison basis as `measuredAgainst: 'HEAD'`.

**Explicitly deferred** (adjacent, not requested)

- Measuring `commitsBehind` against the default branch — needs a fetch or an `origin/HEAD` that may not resolve, and `getDefaultBranch` is a sync `execSync` (`storage/git.ts:622`). Out of scope under the no-new-spawn constraint.
- Carrying the ref on group status (`core/group/service.ts:887-901`), which has its own shape.
- Re-indexing GitNexus so the graph tools work again — a `--force` rebuild is required (storage 43 vs 42) and would mutate the shared `/workspace/.gitnexus`.

## 13. Definition of Done

1. `npx tsc --noEmit` clean; no `any` introduced.
2. `npm run test:unit` and `npm run test:integration` green.
3. The inverted repro test passes and would fail on `dcf980581` — the branch-index and main-index `impact` responses are no longer JSON-identical, and the feature-branch response names `feature/x`.
4. Its measured precondition and negative control are retained, so it cannot pass vacuously.
5. `repo-projection.test.ts` and `server-repo-freshness.test.ts` pass **unmodified** — proof that `list_repos` and both HTTP routes are byte-identical.
6. `tool-staleness.test.ts` covers ref-absent parity for all four statuses and ref-present emission for `current`.
7. Both guide copies document the new shape and `shipped-skills-sync.test.ts` asserts the new string; `skill-sync.yml` job green.
8. No new git spawn, fetch, or I/O on the hot read path — verified by reading `withToolStaleness` / `stalenessForTool`.
9. `gitnexus/CHANGELOG.md` untouched.
10. PR body states the documented behaviour change: the field is no longer absent when the index is current.
