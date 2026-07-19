---
name: gitnexus-review
description: 'Review code changes with GitNexus from a GitHub PR URL or number, a branch/ref or commit range, or local staged, unstaged, and untracked changes. Use when the user asks for a code review, merge-risk assessment, regression hunt, missing-test analysis, or a verdict on whether a PR, branch, commit range, or local diff is safe.'
---

# GitNexus review

Review the requested change surface without editing source, committing, pushing,
posting, or resolving threads. A later explicit request may authorize those
actions. Use GitNexus for structural evidence and source inspection for proof;
neither substitutes for the other.

## Resolve the target

Accept these forms:

| Input                                                  | Review surface                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| PR URL, `owner/repo#42`, `#42`, or bare number         | GitHub PR                                                                   |
| `base...head`                                          | Merge-base range                                                            |
| `base..head`                                           | Exact two-dot range                                                         |
| Branch, tag, or commit                                 | Ref against the repository default branch                                   |
| `local`, `staged`, `unstaged`, or working-tree wording | Local changes                                                               |
| No target                                              | Current branch's open PR; otherwise local changes; otherwise current branch |

An explicit target always wins. Interpret a bare number as a PR only in a
GitHub repository with working `gh` authentication; otherwise ask for a ref or
URL. If implicit mode finds both branch commits and local changes, review them
as two labeled surfaces rather than silently dropping or blending either one.

Record the resolved target kind, repository root, default branch, base SHA,
head SHA, merge-base when applicable, and included local states. Resolve the
default branch from remote metadata (`refs/remotes/<remote>/HEAD` or GitHub
repository metadata); use `main` or `master` only as an explicit fallback and
say when doing so.

### PR

Use `gh pr view`/`gh api` to pin the PR number, repository, title, URL, base
ref, base SHA, head ref, and head SHA. Fetch those exact commits without
switching the user's branch. Compute `git merge-base <base> <head>` and use
that SHA as the review base: GitHub PR diffs are merge-base diffs, while
`detect_changes(scope: "compare")` is a two-dot comparison.

Use the local `git diff <merge-base> <head>` as the complete diff source of
truth; use GitHub metadata for PR facts and review state. For fork PRs, fetch
the pull ref or the contributor remote instead of assuming the head branch
exists on `origin`.

### Branch, ref, or range

Resolve every ref to a commit before reviewing. For a branch or `A...B`, use
the merge-base as the comparison base. For an explicit `A..B`, honor `A` as
the exact base. Do not compare a feature branch directly with a moving default
branch tip when merge-base semantics were intended.

### Local changes

Inspect `git status --short`, the staged diff, the unstaged diff, and every
untracked file. Use `detect_changes` with `staged`, `unstaged`, or `all` as
requested. Untracked files are not guaranteed to appear in Git diff or graph
mapping, so read them directly and list them in the review provenance.

## Align the checkout and index

The graph and diff must describe the same head. Reuse an existing worktree only
when it is at the exact target SHA. Otherwise create a temporary detached
worktree for the PR/ref head, review there, and remove only that temporary
worktree afterward. Never switch or reset the user's current worktree.

Check GitNexus status in the target worktree. If stale, run
`node .gitnexus/run.cjs analyze --index-only` before trusting graph results
(temporary worktrees never carry the gitignored `run.cjs` — fall back to the
installed `gitnexus` CLI, then `npx gitnexus`), and include `--pdg` in that
same refresh when the diff plausibly touches trust or data-flow boundaries,
so the taint pass below doesn't pay a second full analyze. Taint and
dependence evidence needs that PDG layer: when the workflow's taint pass
finds it missing, rebuild with `analyze --pdg --index-only` and record the
rebuild in provenance. For local changes, refresh the index so new or
modified source is represented.
If an exact target checkout/index cannot be established, state the limitation
and do not claim a complete graph-backed review.

## Review workflow

1. Read the full diff and changed-file list. Separate generated files,
   dependency churn, tests, and behavior changes.
2. Run `detect_changes` against the exact surface:
   - PR/branch/`...`: `scope: "compare"`, `base_ref: <merge-base SHA>`.
   - Explicit `A..B`: `scope: "compare"`, `base_ref: <A SHA>` from a worktree
     at `B`.
   - Local: `scope: "staged"`, `"unstaged"`, or `"all"`.
     Pass `worktree` when the MCP server is attached elsewhere.
3. Run upstream `impact` with `includeTests: true` for each behaviorally changed
   symbol. Prioritize public contracts, shared types, control flow, persistence,
   security boundaries, and error handling; skip mechanical/generated changes.
4. Inspect every direct (`d=1`) dependent that is outside the diff. A dependent
   outside the diff is a lead, not automatically a bug—verify the changed
   contract and caller behavior in source.
5. Use `context` on key or ambiguous symbols and inspect affected execution
   flows. Read the surrounding implementation and tests at cited locations.
6. **Taint and dependence pass.** For changed code on trust or data-flow
   boundaries — external input, persistence, process execution, network,
   auth — run `explain` on the changed files or symbols and judge its
   source→sink taint findings against the diff: a flow the change
   introduces, or a sanitizer/guard the change removes, is a finding; a
   pre-existing flow is context, not a defect of this change. When the
   change claims to guard or sanitize something, verify with `pdg_query`:
   what controls the changed statement, and where its values flow. This
   needs a `--pdg` index; if one cannot be built, state that the taint pass
   was skipped rather than implying coverage.
7. Check whether tests exercise the changed behavior, boundary conditions, and
   affected flows. Run focused read-only validation when practical. When the
   diff refreshes a committed baseline, fingerprint, or golden, re-run the
   exact CI check command against the head instead of trusting the committed
   value — a stale artifact is invisible in the diff and fails only in CI.
8. Reconcile graph evidence with the raw diff. New files, dynamic dispatch,
   configuration, reflection, and untracked content may require direct review
   even when graph results are empty. Version and invalidation constants are
   review surface: when the diff changes what gets emitted or persisted,
   verify every schema/version constant gating caches, incremental
   writebacks, and fingerprint baselines was bumped or regenerated — in
   GitNexus itself, for example: `INCREMENTAL_SCHEMA_VERSION` (the
   incremental write set covers only changed files, so new cross-file edges
   never reach an existing index without the bump), the parse-store
   `SCHEMA_BUMP`, and both bench fingerprint sets.

## Expert lenses

Depth comes from matching reviewers to what actually changed, not from one
generalist pass. After workflow step 2, group the changed files and symbols
by the functional areas the graph already knows — the index's cluster
listing; `context` names each symbol's cluster — and give each touched area
an expert lens: a reviewer charged with that domain's contracts, invariants,
and failure modes, grounded in the repo's own material (architecture docs,
agent rules, the domain's tests) before judging the diff. A lens verifies,
not just reads: when the changed code is a pure function reachable from the
repo's own toolchain — parsers, extractors, capture emitters, formatters —
execute it on the candidate failing shape (a scratch probe, deleted
afterward) and cite the observed output. An empirical probe outranks source
reading in the evidence hierarchy; role swaps, dead branches, and
error-recovery-dependent behavior repeatedly pass a reading and fail a
ten-line probe. The numbered
workflow runs exactly once; dispatch the lens passes after step 6, handing
each lens the evidence already collected rather than letting lenses repeat
the `impact`, `context`, or taint calls. In GitNexus
itself, for example: shared ingestion-pipeline changes get an ingestion
expert plus one language expert per changed language extractor; embeddings
changes an embeddings expert; LadybugDB/storage changes a Ladybug expert.

Four cross-cutting lenses run regardless of domain:

- **Architectural fit** — the change lands where the architecture says the
  concern lives, reuses existing seams, and adds no parallel structure.
- **Language conformance** — the repo's own type/lint/test contract as
  configured (tsconfig strictness, lint rules, test conventions); in a
  strict TypeScript repo, for example: strictness intact, no `any`/`as any`
  escapes, module boundaries typed. Judge by the repo's contract, never a
  universal style bar.
- **Definition of Done** — changed behavior has tests, docs the change makes
  stale are updated, and sync/drift guards (shipped copies, manifests,
  changelogs) still hold.
- **Simplicity** — YAGNI and clear-code check: flag speculative abstraction,
  unused knobs, and overengineering; the smallest diff that meets the
  Definition of Done is the standard.

Scale effort to the surface: a single-domain change of a few files gets one
combined pass covering its domain lens plus the four cross-cutting checks;
a multi-domain change gets one lens per touched area — run as parallel
subagents where the harness supports them, each scoped to its own files
plus the shared graph evidence, and as sequential passes otherwise. Never
spawn a lens for a domain the diff does not touch. Merge lenses that ground
in the same material — two lenses reading the same files pay twice for one
read's coverage, so give one reviewer both charges. Where the harness
offers model or effort tiers, run mechanical lenses (rename sweeps,
doc-consistency checks) on a cheaper tier and reserve the strongest engine
for adversarial judgment. Every lens reports
through the Finding standard below; merge and dedup before the verdict,
dropping anything without a concrete failing scenario.

## Finding standard

Report a finding only when the reviewed change introduces a concrete defect,
regression, security issue, compatibility break, material coverage gap, or a
maintainability cost with a concrete carrying scenario (a dead knob, a
duplicated contract, a drift-prone copy).
Each finding must include:

- severity and a precise `path:line` anchor;
- the failing scenario or contract;
- GitNexus evidence (dependent symbol/process) when applicable;
- why existing code or tests do not mitigate it;
- a concise remediation or missing test.

Do not report style preferences, pre-existing issues, raw risk counts, or
speculation as defects. Do not infer safety from zero graph hits. Calibrate
overall risk from consequence, reachability, reversibility, and test evidence,
not from the number of changed symbols alone.

## Output

Lead with findings in severity order. If there are none, say so explicitly.
Then provide:

```markdown
## Review: <target>

### Findings

- [HIGH|MEDIUM|LOW] `path:line` — <problem, evidence, impact, remediation>

### Change and blast-radius summary

- Target/base/head/merge-base and local states reviewed
- Changed symbols and affected execution flows

### Coverage and residual risk

- Tests present, tests missing, graph/diff limitations

### Verdict

APPROVE | REQUEST CHANGES | NEEDS DISCUSSION
```

For a branch or local review, use `READY`, `NOT READY`, or `NEEDS DISCUSSION`
instead of a PR approval action. Include the exact target SHAs so a later run
can tell whether the evidence is stale.
