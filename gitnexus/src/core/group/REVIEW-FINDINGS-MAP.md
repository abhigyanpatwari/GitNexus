# Review findings → commits (PR #3012)

Every finding raised in review of this PR, and the commit that closes it. The
Definition of Done claims each finding has exactly one commit and that reverting
that commit reintroduces that finding and no other; this is what makes the claim
checkable without the reviewer's report in hand.

**Not under `docs/`** — that path is gitignored, so a map written there would
never reach the PR and nobody but its author could perform the audit. It lives
beside the code it describes, as `PIPELINE.md` does.

## Revert contract

Revertability is **dependency-aware**. Where one commit extracts a helper that
later commits consume, reverting the helper alone does not build. The contract
is: reverting a commit reintroduces its own finding and no other _finding_, with
its prerequisite commits retained.

One coupled set exists:

| Set                        | Commits                                             | Why coupled                                                                            |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Shared completeness helper | `4c203ac7b` ← `79f6f5bcb`, `0fe6fc9d4`, `dbc3953b0` | The three consumers call `crossRepoCompleteness`; reverting it alone breaks the build. |

## Primary findings

| #   | Finding                                                                          | Commit      |
| --- | -------------------------------------------------------------------------------- | ----------- |
| 1   | Malformed `meta.json` crashes cross-repo impact and leaks the bridge handle      | `27b0069f2` |
| 2   | Unreadable repos still contribute contracts through deferred manifest resolution | `7037e8441` |
| 3   | Strict read accepts a registry row that cannot identify a repo                   | `5245b22d7` |
| 4   | Unstamped bridge metadata is trusted without any check                           | `94f2a8757` |
| 5   | A subgroup-scoped query is marked incomplete by repos it excluded                | `79f6f5bcb` |
| 6   | The preserved registry and the bridge disagree about the same sync               | `4676abf03` |
| 7   | Three surfaces compute completeness three different ways                         | `4c203ac7b` |
| 8   | `group_contracts` has no channel for its own completeness                        | `0fe6fc9d4` |
| 9   | `group status` cannot tell a missing entry from an unreadable registry           | `a12b846c9` |
| 10  | The sync summary describes a write that did not happen that way                  | `5a668455c` |
| 11  | The total-failure log promises preservation where there is nothing to preserve   | `c4b356b29` |
| 12  | The bridge-failure warning promises a truncation the code never reports          | `1df79bb9a` |
| 13  | Two concurrent syncs of one group lose each other's writes                       | `4f07359bf` |
| 14  | The bridge swap needs the lock its caller already holds                          | `3b6215862` |
| 15  | The byte guard misses most tracked text files, and all extensionless ones        | `07bf8be75` |
| 16  | The byte guard reads the vendored grammar tree it does not need to judge         | `3ef831a0a` |
| 17  | The strict-read test cannot see which registry read ran                          | `eccc3c682` |
| 18  | The CLI branches this PR introduced have no assertions                           | `535d2ad29` |
| 19  | The MCP payloads have no assertions                                              | `2c253b4a8` |
| 20  | Corrupt-registry errors quote the file's bytes, credentials included             | `24ba2a537` |
| 21  | The mtime pairing's limits are recorded nowhere a reader will look               | `ca0aca106` |
| 22  | The bridge-input docstring narrows what `unreadableRepos` means                  | `8c930f470` |
| 23  | The strict-read docstring's call-site count is wrong                             | `a95838954` |
| 24  | Contract staging crashes on the engine's argument limit                          | `57eac7558` |
| 25  | The sync tool's description names two of three reachable outcomes                | `8bfd1a6ab` |
| 26  | The impact tool and status resource do not explain incompleteness                | `dbc3953b0` |
| 27  | A lock timeout blames an `analyze` it cannot establish                           | `2d2a0119e` |
| 28  | A losing sync downgrades the one that beat it to the lock                        | `e407f05cf` |

## Findings raised in review and deliberately not implemented as suggested

| Finding                                  | Suggested fix                                               | What shipped, and why                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unstamped metadata is trusted            | Treat every absent stamp as incomplete                      | Rejected. It would mark every pre-existing bridge a lower bound until re-synced — a repo-wide regression traded for a narrow window. The write-order pairing in `94f2a8757` is the narrower fix.                   |
| Stale bridge signal after a failed write | Re-stamp the metadata so the warning's promise becomes true | Rejected. Re-stamping recreates the metadata/database mis-pairing that stamping exists to prevent. `1df79bb9a` corrects the warning instead.                                                                       |
| Strict row gate                          | Require all three fields non-blank                          | Narrowed to `name` and `storagePath`. This gate rejects the whole registry, which is machine-wide, so a field tightened past what identification needs lets one blank value break every group sync on the machine. |

## Found during execution, not in the review

| What                                                                                          | Commit      |
| --------------------------------------------------------------------------------------------- | ----------- |
| A half-written bridge stamp read as a verified match (found by the repo's own contract check) | `066f2d802` |
| `readBridgeMeta`'s widened return type blocked the merge on contract drift                    | `a9d281dd4` |
| `group contracts --json` discarded every field it did not re-serialize                        | `b7753575d` |
| `sync.ts` renders as a binary diff because the base blob carries a NUL                        | `1667c24b4` |

## Corrections to the plan, found while executing it

Recorded because each was a claim in the plan that the code contradicted.

| Claim                                                                           | Reality                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The strict gate should require the fields "the resolution path consumes"        | `defaultResolveHandle` **does** consume `path`. The distinction is what _identifies_ the repo.                                                |
| Pass the trace's two endpoint repos as the scope predicate                      | A destination trace declares no `to`. Narrowing to `from` would report an unreadable provider as "no outgoing link".                          |
| Filter the incomplete set by the subgroup prefix                                | The query's own repo must stay in scope, or an unreadable origin becomes a confident "nothing depends on this".                               |
| `group status`'s third failure mode is a row that resolves but cannot be opened | Unreachable — `loadMeta` returns `null` on every error and `checkStaleness` catches everything. The reachable case is `resolveRepo` throwing. |
| The mtime rule can only demote pairs already broken                             | False. `cp -r` and `rsync` without `-t` demote an intact pair. Recorded at the code in `ca0aca106`.                                           |
| `.scm` files are "edited constantly" here                                       | Every tracked `.scm` is vendored. This repo writes tree-sitter queries inline in TypeScript.                                                  |

## Residual risks, recorded rather than closed

- **Credentials in the registry.** HTTPS remote URLs are persisted with their
  userinfo intact. `24ba2a537` stops one channel echoing them; it does not stop
  them being written. Pre-existing, tracked separately.
- **`readRegistryFile`'s read error.** The ENOENT-guarded outer catch still
  rethrows the raw `fs.readFile` error into `unresolvableReason`. Node embeds
  the path, not file contents, so no registry bytes leak — but it is the one
  remaining foreign error object on that path.
- **Abstract-socket lock scope.** Linux abstract sockets are
  network-namespace-scoped, so two containers sharing a bind-mounted group
  directory do not contend unless the file backend is forced. Recorded at
  `group-lock.ts`.
- **Scope filter at depth > 1.** The declared-scope intersection is sound only
  while `MAX_SUPPORTED_CROSS_DEPTH` is 1. At depth 2 an out-of-scope repo can
  sit between two in-scope ones. Recorded at the intersection site.
- **R14 is unmet on this PR.** `.gitattributes` makes TypeScript diffs render as
  text, and it works locally — but GitHub resolves the attribute from the base
  side, which does not carry it. `sync.ts` renders as binary in this PR's web
  view and will render as text for every PR after this one merges.
