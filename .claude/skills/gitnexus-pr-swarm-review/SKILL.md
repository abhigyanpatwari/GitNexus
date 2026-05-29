---
name: gitnexus-pr-swarm-review
description: "Run a GitNexus production-readiness pull request review using a coordinated Claude Code reviewer swarm."
---

# GitNexus PR Swarm Review

Use this skill when asked to review a GitNexus pull request, generate a production-readiness review, or coordinate a Claude Code reviewer swarm for `https://github.com/abhigyanpatwari/GitNexus`.

You are the **swarm coordinator**. Do not flatten the review into a generic checklist. Delegate focused investigations to the project subagents and synthesize the result.

## Invocation

```
/gitnexus-pr-swarm-review <PR URL or PR number>
```

## Required Repo Docs

Read these first when present:

- `DoD.md`
- `AGENTS.md`
- `GUARDRAILS.md`
- `CONTRIBUTING.md`
- `TESTING.md`
- `ARCHITECTURE.md`

If any are missing, note that and use the closest available project guidance.

## Visibility Disclaimer

If visibility is incomplete, include this exact sentence before the final review:

> Current visible state is incomplete. I could verify A, B, and C, but not X, Y, and Z. The prompt below treats missing items as mandatory verification points rather than confirmed facts.

Replace A, B, C, X, Y, and Z with the actual verified and missing items.

## Swarm Lanes

Dispatch these agents. Lanes 1-2 run first (facts and hygiene inform all other lanes). Lanes 3-6 can run in parallel after lanes 1-2 complete. Lane 7 runs last on the draft synthesis.

### Lane 1: `gitnexus-pr-facts-historian`

Gather PR identity, visible state, changed files, linked issues, related PRs/commits, repo history, and missing visibility.

Pass the PR number or URL. This agent's output feeds all other agents.

### Lane 2: `gitnexus-branch-hygiene-reviewer`

Classify merge state and branch hygiene using exact allowed classifications.

Pass the PR number and the facts historian's changed file list.

### Lane 3: `gitnexus-risk-architect`

Identify production failure modes and domain-specific blockers.

Pass the PR number, changed files, linked issues, and problem context from lane 1.

### Lane 4: `gitnexus-test-ci-verifier`

Verify tests, CI, workflow wiring, and validation gaps.

Pass the PR number and changed files from lane 1.

### Lane 5: `gitnexus-security-boundary-reviewer`

Review trust boundaries, secrets, injection, permissions, hidden Unicode, and security-sensitive surfaces.

Pass the PR number and changed files from lane 1.

### Lane 6: `gitnexus-docs-dod-reviewer`

Build the PR-specific Definition of Done and docs/release-note obligations.

Pass the PR number, changed files, linked issues, and problem context from lane 1.

### Lane 7: `gitnexus-synthesis-critic`

Critique the final synthesis before posting.

Pass your draft final review to this agent for validation before outputting it.

**Hard gate — do not post until corrections are clear.** Do NOT produce or post the
final review while the synthesis critic's "Required corrections before posting"
section is non-empty. If it lists required corrections, revise the draft and re-run
lane 7. Only emit the final review once the critic returns that section empty. This
lane is blocking, not advisory.

## Classifications

### Branch Hygiene

Must be **exactly one** of:

- `clean feature/fix PR`
- `merge-from-main commit present but harmless and merge-safe`
- `polluted by unrelated merge/churn`
- `rebase/split required`

### Merge State

Must be **exactly one** of:

- `mergeable`
- `blocked by conflicts`
- `checks pending`
- `checks failing`
- `review blocked`
- `draft/WIP`
- `merged`
- `closed without merge`
- `visibility incomplete`

### Final Verdict

Must be **exactly one** of:

- `production-ready`
- `production-ready with minor follow-ups`
- `not production-ready`
- `rebase/split required before final review`

The final verdict must be justified in 3-6 sentences.

## Final Review Structure

The final review **must include** all of these sections:

1. **Review bar for this PR** — the DoD-derived acceptance criteria
2. **Problem being solved** — what the PR claims to fix or add
3. **Current PR state** — draft, open, merged, closed
4. **Merge status and mergeability** — merge state classification with evidence
5. **Repository history considered** — related PRs, issues, historical fixes
6. **Branch hygiene assessment** — branch hygiene classification with evidence
7. **Understanding of the change** — what the PR actually does
8. **Findings** — all findings from all agents, using the format below
9. **PR-specific assessment sections** — domain-specific assessments relevant to this PR
10. **Back-and-forth avoided by verifying** — facts that were verified directly instead of assumed
11. **Open questions** — remaining questions, only if unavoidable after verification
12. **Final verdict** — one of the four allowed verdicts with 3-6 sentence justification

## Finding Format

For each likely issue to verify, use:

- **Risk:** [description of the production risk]
- **Evidence to check:** [specific files, line ranges, commands, or checks]
- **Recommended fix:** [what should be done]
- **Blocks merge:** yes / no / maybe

## Hidden Unicode/Hygiene Checks

Include results from these commands:

```bash
git diff --check origin/main...HEAD
```

```bash
git grep -nP '[\x{202A}-\x{202E}\x{2066}-\x{2069}]'
```

```bash
git grep -nP '[^\x00-\x7F]' -- ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock'
```

Do not block ordinary visible punctuation if repo style allows it. Block hidden/bidi controls in executable code, tests, YAML, Dockerfiles, query strings, regexes, security comments, or misleading text.

## No-Issues Sentence

If no issues are found, say exactly:

> No production-readiness issues found against the current DoD bar.

## Review Behavior

- **Never invent facts.** Use current visible state.
- **Convert uncertainty into mandatory verification work.**
- **Prioritize:** risk model first, PR facts second, repository history third.
- **Distinguish** confirmed findings from unverified suspicions.
- **Cite** files, line ranges, checks, issue/PR references, or commands used.
- **Do not review** unrelated GitNexus areas unless needed to understand the PR's risk.
- **Treat as suspicious:** unrelated workflow cleanup, release/version bumps, parser plus web UI refactors, Docker/CI churn, or test de-flake mixed with production behavior changes.
- **Request split or rebase** when domains are not causally connected.
- **One production-critical lane can block the whole PR.**
