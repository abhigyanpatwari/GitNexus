---
name: gitnexus-work
description: 'Use when executing an engineering plan produced by gitnexus-plan (or a small bounded task directly) — implements step by step with GitNexus impact checks before every symbol edit, tests from the plan''s scenarios, and detect_changes gating every commit. Examples: "/gitnexus-work docs/plans/2026-07-11-gitnexus-plan-ingestion-retry.md", "/gitnexus-work" (latest plan), "execute the plan".'
---

# gitnexus-work — execute a gitnexus-plan

Execute an implementation plan produced by `gitnexus-plan`, shipping it as a
sequence of verified, atomic commits. The plan's section 11
(`implementation_context` pack) is the primary machine-readable input; the
prose sections are its rationale. This skill **does** edit code — it is the
executor counterpart to the planning-only `gitnexus-plan`.

```
/gitnexus-work <plan path>        # execute this plan
/gitnexus-work                    # newest docs/plans/*gitnexus-plan*.md here
/gitnexus-work <small task text>  # direct mode, see Input triage
```

## Input triage

- **Plan path** (or blank → the newest `docs/plans/*gitnexus-plan*.md` under
  the current repo root): the normal mode; continue to Phase 1. Schema-2
  plans have a normalized repo-relative
  `docs/plans/YYYY-MM-DD-gitnexus-plan-<3-5-word-slug>.md`
  `generated_plan_path`. Resolve only a lexical candidate, then invoke
  `scripts/evidence-provenance.mjs read-plan --repo <root> --generated-plan
<candidate>` and load only the exact bytes in its descriptor-anchored
  receipt. Require the receipt's canonical repo-relative path to equal the
  document's `generated_plan_path` byte-for-byte;
  reject an external, escaping, differently scoped, or mismatched value. A
  plan in another target repo may still be passed by explicit path. If Phase 1's
  pre-completed check finds every §7 step of the newest plan already landed,
  stop and ask instead of re-executing it.
- **Bare task text**: trivial and bounded (1–2 files, no architectural
  decisions) → implement directly with the same discipline: `impact` before
  every symbol edit, minimal change, tests when behavior changes,
  verification commands taken from the repo's own scripts (package.json /
  CI), `detect_changes` before every commit, and the shared
  Build-current/index-current procedure before graph-dependent impact and
  final verification. Anything larger → recommend running
  `/gitnexus-plan` first; honor the user's choice if they decline.

## Phase 1 — Load and re-anchor the plan

1. Resolve the target repo and normalized plan candidate, then invoke this
   skill's descriptor-anchored `scripts/evidence-provenance.mjs read-plan`
   command exactly as
   specified in `references/evidence-provenance.md`. Reject a missing,
   external, escaping, symlinked, or differently scoped path. Decode and read
   the receipt's exact `plan_bytes_base64` completely; never read or reopen the
   lexical path directly. It is a decision artifact, not a script: scope
   boundaries and `avoid` entries bind you; exact code is yours to write.
   Retain the receipt's canonical `generated_plan_path` and `plan_digest` in
   session state. Never edit the plan body.
2. Parse the §11 `implementation_context` pack: `acceptance_criteria`,
   `evidence_provenance`, `primary_symbols`, `related_symbols`,
   `files_to_modify`, `execution_path`, `pdg_constraints`,
   `architectural_patterns`, `tests`, `verification_commands`, `risks`,
   `assumptions`, `open_questions`, `avoid`. Compact plans carry the
   mini-pack subset — absent optional fields are empty, not errors.
   `evidence_provenance` is mandatory: absence or schema 1 means a legacy
   plan, not a clean tree. Before relying on it, require exact byte-for-byte
   equality between the read-plan receipt's canonical `generated_plan_path`
   and `evidence_provenance.generated_plan_path`.
3. **Two-layer drift check — always recompute.** Even when current HEAD is the
   same HEAD as the plan pin, recompute both the canonical global dirty digest
   and the sorted cited-path manifest. Read
   `references/evidence-provenance.md`, then invoke this skill's
   `scripts/evidence-provenance.mjs` with the plan's exact
   `generated_plan_path`, every cited manifest path, and schema version 2.
   Never recreate its bytes in shell or prose. Schema 1 cannot be recomputed
   unambiguously and requires conservative re-anchoring. Include
   object kind plus HEAD/index/worktree/untracked layer digests, and classify
   `staged`, `unstaged`, `untracked`, `deleted`, `renamed`, `mixed`,
   and `absent` evidence. Honor the generated-plan exclusion exactly; do not
   exclude all plans.
4. **Re-anchor on either mismatch.** Missing or legacy provenance, a HEAD
   mismatch, or a global dirty digest mismatch requires a conservative
   re-anchor before work:
   - Diff every cited-path manifest entry. Changed cited paths — including
     staged-only, unstaged-only, deleted, both rename endpoints, mixed
     staged+unstaged, and disappeared untracked paths — get their cited ranges
     re-read before reliance.
   - Compare the current whole-tree dirty set with the pinned global digest.
     New uncited dirty paths get a scope assessment: determine whether they
     overlap the plan, requirements, tests, or a key technical decision; do not
     silently ignore them merely because they are uncited.
   - Unreadable or unclassifiable cited evidence blocks every dependent step
     until it can be restored, read, or resolved with the user. Never substitute
     an invented digest or treat absence as an empty file.
   - Keep the re-anchor result in session state; never mutate the plan body.
     Use Deepen only if reconciliation invalidates scope, requirements, a key
     technical decision (KTD), or the planned implementation seam. Ordinary
     byte drift that leaves those decisions valid is re-verified locally.
5. **Re-verify `assumptions` cheaply** (each one names what to check).
   A failed assumption is a stop-and-replan signal for the steps that
   depend on it, not something to code around silently.
6. Note `open_questions` — if one blocks a step and the answer materially
   changes the work, ask the user before that step, not after.
7. **Pre-completed check.** If commits for this plan already exist on the
   branch (a prior partial run, or a post-route-back Deepen cycle), verify
   which §7 steps have landed at HEAD: those are skipped and reported as
   pre-completed, and execution resumes at the first unlanded step. All
   steps landed → report that and stop.

## Phase 2 — Environment

- On the default branch → create a feature branch named from the plan slug.
  On a feature branch already → stay only if it is meaningful _for this
  plan_ (name matches the plan slug, or the user confirms); otherwise
  branch from here with the slug name.
- If the plan document is not yet committed, commit it now
  (`docs(plans): add <slug> plan`) — the plan travels with the work it
  drives, and the final review diff then includes it.
- Confirm the `verification_commands` from the pack actually run in this
  checkout (dependencies installed, builds present) before starting, not
  after the last step.

### Build-current/index-current procedure

This is the single graph-freshness procedure owned by `gitnexus-work`; it
applies in plan mode and direct mode. Before every graph-dependent `impact`
query, run the Build-current/index-current procedure. Before final graph
verification, run the same Build-current/index-current procedure again.

1. Capture current HEAD and working-tree provenance. Read
   `gitnexus://repo/<name>/context` and use its typed `index.commit` and
   `index.runner_identity` receipt — never infer analyzer identity from prose,
   timestamps, or a path alone. Compare `index.commit` with current HEAD. A
   current receipt has `schemaVersion: 4`, resolved runtime path/version, CLI
   version, invoked-artifact path/digest, build
   kind/root/canonicalization/digest, and dependency-runtime
   manifest/lockfile/canonicalization/package-count/artifact-count/digest. Its
   dependency canonicalization is
   `gitnexus-analyzer-dependency-runtime-v4`. The dependency-runtime digest
   covers resolved package metadata and complete loadable package payloads,
   including JavaScript, JSON, native, Wasm, and parser artifacts; schema-1,
   schema-2, and schema-3 receipts are legacy/stale (the MCP context labels
   them `runner_identity_schema_status: legacy-or-unknown`). Require MCP
   `index.incomplete_reasons: []`. Run the exact candidate CLI's
   `status --json` command and require `index.runnerIdentityStatus: current`,
   `index.incompleteReasons: []`, and top-level `status: up-to-date`. The
   status comparator checks every semantic field while deliberately excluding
   only diagnostic `invokedArtifact`; a worker-authored persisted receipt and
   the CLI's live receipt may therefore differ in that field without becoming
   stale. Missing, malformed, differently versioned, semantically unequal, or
   incomplete receipts are unknown/stale, not a match.
2. Relationship-affecting committed and uncommitted edits invalidate
   freshness after the last successful procedure run. This includes staged,
   unstaged, untracked, deleted, or renamed analyzer/source/config changes
   that can alter symbols or edges. Any such edit between steps requires an
   inter-step refresh before the next graph query, even when HEAD did not move.
3. If the typed runner receipt is stale or unknown in an analyzer-source
   checkout, build current local source using the verified package script. In
   this repo: `cd gitnexus && npm run build`. Resolve the package's `bin`
   target and run that exact artifact's `status --json` command to capture its
   current receipt. Source/build timestamps are a conservative rebuild
   trigger, not proof that an artifact is current.
4. Invoke that exact freshly built local CLI from the target repo root with
   PDG layers enabled. In this repo:
   `node gitnexus/dist/cli/index.js analyze --index-only --pdg`.
   Add `--force` when the persisted receipt was absent, malformed,
   differently versioned, or unequal so an already-up-to-date fast path cannot
   leave legacy/stale provenance in place. The usual project-runner form,
   `node .gitnexus/run.cjs analyze`, is acceptable only when its proven runner
   identity resolves to that same freshly built artifact. Do not fall back to
   an older project runner, global install, or package download after
   resolving/building the local artifact.
5. Re-read index context, rerun the exact invoked CLI's `status --json`, and
   prove the post-refresh `index.commit` equals current HEAD, MCP
   `index.incomplete_reasons` is empty, and its complete
   `index.runner_identity` equals status `index.runnerIdentity` (the persisted
   receipt). Require status `index.runnerIdentityStatus: current`, empty
   `index.incompleteReasons`, and top-level `status: up-to-date`; do not require
   raw equality with `current.runnerIdentity` because `invokedArtifact` is a
   diagnostic entrypoint deliberately excluded from semantic freshness.
   Record the dirty-state digest indexed in this procedure so same-HEAD
   uncommitted edits can invalidate it later.
6. Any build, refresh, metadata-read, or identity-verification failure blocks
   graph-dependent impact work and final completion. Report the failing
   command and evidence; do not continue on an older graph.

## Phase 3 — Execute the Implementation Sequence

Work through plan §7 step by step, in order. For each step:

1. **Fresh impact before editing.** Run the Build-current/index-current
   procedure immediately before every graph-dependent
   `impact {target, direction: "upstream"}` query. Then account for every
   direct (d=1) dependent. HIGH or CRITICAL risk → surface it to the user
   with the blast radius before proceeding (repo mandate — see AGENTS.md
   GitNexus rules).
2. **Honor the constraints.** `pdg_constraints` entries state ordering and
   dependence facts the change must preserve; `avoid` entries are hard
   prohibitions; `architectural_patterns` name the shape to mirror (read the
   example location before inventing one).
3. **Implement minimally.** The smallest change that completes the step,
   following the surrounding code's conventions.
4. **Test from the plan's scenarios.** Each `tests[]` scenario (input →
   action → expected outcome) becomes a real test in the named file. Add
   coverage the plan missed if the step's behavior demands it; never delete
   or weaken an assertion to make a step pass. Prove a new regression test
   discriminates: when the failure mode is subtle, run it once against the
   pre-fix tree (write the test before the fix, or stash the fix) and watch
   it fail — a test that passes both ways pins nothing.
5. **Verify.** Run the step-relevant `verification_commands` (they carry
   their build prerequisites; use them as written). If any part of the
   change executes from build output — worker entrypoints, dist-shipped
   CLIs, bundled assets — rebuild that output before every verification
   run: a pass or fail against outdated build output is noise, and "the
   fix doesn't work" is more often "the fix never loaded".
6. **Commit atomically.** `detect_changes {scope: "staged"}` before every
   commit to confirm only the expected symbols and flows are affected
   (repo mandate); then one conventional commit per step. Run stage →
   `detect_changes` → commit as one unbroken sequence from the repository
   root — interleaving other work between the gate and the commit is how
   the gate gets skipped. Unexpected
   affected flows → investigate before committing, not after.

A relationship-affecting implementation edit or commit invalidates the
procedure's prior proof. The next step must perform the required inter-step
refresh before its impact query; final verification refreshes again after the
last edit.

Steps are independently actionable: after any commit the tree is coherent.
If a step reveals the plan is wrong, stop that step, re-verify the affected
claims at HEAD, and either adapt (small, in-scope deviation — record it in
the commit message and final summary) or route back to `gitnexus-plan`
Deepen mode (structural miss) — with a one-line ask to the user when the
choice isn't obvious.

## Phase 4 — Finish

1. Run the full `verification_commands` suite once, at the end, even if
   every step already passed individually.
2. Walk plan §13 (Definition of Done) and the pack's `acceptance_criteria`
   item by item; anything unmet is either finished now or reported as
   explicitly unmet — never silently dropped.
3. **Verify the final knowledge graph.** Before final graph verification, run
   the same Build-current/index-current procedure after the last edit, even
   when no commit landed or HEAD still equals the original pin. Then run
   `detect_changes {scope: "all"}` (or the repo's equivalent final graph
   check) against that proven-current index and account for every unexpected
   symbol or flow. A procedure failure blocks completion.
4. Report: steps completed, commits made, deviations from the plan (with
   why), assumptions that failed re-verification, DoD status, final indexed
   commit and runner identity, and anything deferred. Test failures are
   reported with their output, not smoothed over.

## Never

- Skip the Phase 3 gates: no symbol edit without `impact`, no commit without
  `detect_changes`.
- Expand scope beyond the plan — §12's deferred follow-ups stay deferred.
- Mutate the plan body (committing the file verbatim in Phase 2 is not
  mutation), weaken failing tests, or present unverified work as verified.

## Skill feedback (GitNexus repo only)

If this run exposed friction in this skill's own instructions — wrong or
missing guidance, a wasted tool budget, a phase that misrouted — and the repo
carries `eval/workflow_bench/`, append one JSON line to
`eval/workflow_bench/learnings.jsonl` (create the file if absent):
`{"skill": "gitnexus-work", "date": "YYYY-MM-DD", "task": "<one line>", "friction": "<one line>", "suggestion": "<one line>"}`.
Never edit this skill file itself from a live task: improvements go through
the offline candidate loop (`eval/workflow_bench/README.md` § Prompt and
skill evolution loop), where a candidate must beat the incumbent on the
paired benchmark before a human merges it.
