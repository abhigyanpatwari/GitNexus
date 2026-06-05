---
name: issue-triage-batch-plan-2026-06-04
description: Plan for resuming batch-based issue triage against 48 currently-open GitNexus issues; v2 triage doc is stale (assumed 86, actual 48)
metadata:
  type: project
---

Triage plan reconciled 2026-06-04 against current `gh issue list --state open` (48 open, not the 86 in [[open-issues-batch-2026-06-03-v2]]). 40 issues closed via 40 merged PRs since the doc was written.

**Why:** 30-min `/loop` cadence is wrong for `/at-planning` + `/wf-implement` + QE verify + PR-per-batch. User confirmed: **one batch per real session**, PRs opened not auto-merged (per user's `Zero Auto-Commits` rule).

**How to apply:**

Recommended next-batch order (start with the in-flight #72):

1. Resume in-flight #72 on `bugfix/72-rename-class-definition` (WIP stashed). 44-line diff in `gitnexus/src/mcp/local/local-backend.ts` adds file-level ripgrep for Class/Interface renames, gated, dedup'd via `seenEdits`.
2. Batch A — Verify-and-Close: #102, #55, #21, #51. Two are `describe.skip`; #21/#51 likely fixed by #99/#103. ~half a day, 3-4 closures.
3. Batch C — Spring route: #90, #92, #81, #93 (#91 done in #133).
4. Batch B — document-endpoint: ~6 still-open of the original 14.
5. Batch G — Rename: #63, #62, #72. Reuses #61/#37/#60 harness.
6. Batch D — extractors: #5, #6, #78, #84, #33, #79, #80, #70. Re-test vs merges first.
7. Batch L — Index health: #106, #108, #109 (#109 done in #126).
8. Batch F — Cross-repo: #46, #50, #105 (#28/#12/#47/#49 already done).
9. Batch H — Interface/Class typing: 9 open.
10. Batch E — Angular/TS: 8 open incl #107.
11. Batch I — Cypher: 7 open, engine-blocked subset.
12. Batch J — Param plumbing: 8-9 open (#64 done).
13. Batch K — Traversal: #36, #23, #34, #13.

Open PR #104 (placeholder for #24) is empty body, no diff — needs triage separately.
