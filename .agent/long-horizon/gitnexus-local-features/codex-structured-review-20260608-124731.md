# Codex Structured Review - 2026-06-08

Generated: 2026-06-08T12:55+01:00

## Purpose

Capture a cookbook-style non-interactive Codex review of the current dirty-tree tranche before checkpointing or selecting another feature packet.

This review used `codex exec` as a structured second-pass reviewer. It was run in prompt-only mode after an earlier shell-enabled run hit a Windows PowerShell property-setting/language-mode error. The prompt-only run instructed the reviewer not to run tools, inspect files, or mutate anything; it reviewed only the supplied diff, untracked file contents, and selected line-numbered snippets.

## Command

```powershell
$tmp = 'C:\Users\steve\AppData\Local\Temp\gitnexus-codex-review-20260608-124731'
$prompt = Join-Path $tmp 'codex-prompt-prompt-only.md'
$schema = Join-Path $tmp 'codex-output-schema.json'
$output = Join-Path $tmp 'codex-output-prompt-only.json'
Get-Content -LiteralPath $prompt -Raw | codex exec --skip-git-repo-check --cd $tmp --sandbox read-only --output-schema $schema --output-last-message $output -
```

Exit code: `0`

Output artifact:

```text
C:\Users\steve\AppData\Local\Temp\gitnexus-codex-review-20260608-124731\codex-output-prompt-only.json
```

## Scope

Review of the supplied dirty-tree diff, untracked file contents, and line-numbered snippets only; no filesystem or tool inspection was performed by the reviewing Codex worker.

## Overall Result

Overall correctness: `patch is incorrect`

Confidence: `0.95`

Explanation:

The tranche introduces two correctness regressions in the new diff-to-impact path: `detect_changes` still collapses deletion-only or unmatched-only diffs to a zero-change summary, and deleted-symbol resolution is now applied to `compare` diffs even though the code still only has a HEAD graph, not a base graph. The other visible changes looked coherent from the supplied evidence.

## Findings

| Priority | Finding | Location | Confidence |
| --- | --- | --- | --- |
| P1 | `detect_changes` summary still reports deletion-only or unmatched-range-only diffs as no change. | `gitnexus/src/mcp/local/local-backend.ts:2715` | `0.99` |
| P2 | Deleted-symbol mapping now runs for `compare` diffs even though there is still no base-graph primitive. | `gitnexus/src/mcp/local/local-backend.ts:2456` | `0.91` |

### P1 - `detect_changes` Summary Hides Deletion/Unmatched Evidence

The backend now emits `changed_ranges`, `unmatched_ranges`, and `deleted_symbols`, but the returned summary is still derived only from `changedSymbols.length` and affected processes reachable from those symbols. In the current code, `summary.changed_count` is set from `changedSymbols.length` and `risk_level` is computed from `affectedProcesses` only, so deletion-only or new/unmapped-hunk diffs can still produce `changed_count: 0` and a low/none summary even though real change evidence exists.

The direct CLI formatter then short-circuits to `No changes detected.` whenever `summary.changed_count` is zero. This hides the new evidence arrays and misleads JSON consumers that rely on the summary fields.

Suggested fix:

- Count `unmatched_ranges` and `deleted_symbols` as real change evidence in the returned summary.
- Add focused CLI/direct-format tests so deletion-only and unmatched-only diffs no longer render as `No changes detected.`

### P2 - Compare-Scope Deleted Symbols Need Base-Graph Semantics

`detectChanges()` builds `git diff <base_ref>` for `scope: 'compare'`, but then resolves old-side deletion ranges against the current local graph using the same path as unstaged/staged worktree diffs.

That is only safe for local working-tree deletions where the graph still reflects the pre-edit file layout. In compare mode, those old-side coordinates belong to the base tree, so resolving them against the HEAD graph can fabricate or miss deleted symbols after unrelated line movement or renames. The supplied tests cover unstaged deletions, not compare-mode deletion mapping.

Suggested fix:

- Gate deleted-symbol resolution to local unstaged/staged scopes until a real base-graph mapping primitive exists.
- Alternatively, explicitly downgrade compare-mode old-side deletions to unknown/unmatched evidence instead of resolving them against the current graph.

## Verification Notes

- The review was performed from the supplied diff and snippets only; no commands or tests were run inside the reviewing worker.
- The supplied tests cover backend unstaged range/deletion behavior and PR-impact propagation.
- No supplied diff showed direct CLI formatter coverage for deletion-only or unmatched-only output.
- No supplied test covered compare-scope deleted-symbol behavior.

## Limits

- The prompt forbade shell/tool use, so the reviewing worker could not inspect additional nearby source beyond the provided diff/snippets.
- Some referenced behavior outside the supplied snippets, such as full `pr-impact` report rendering or `/api/info` server implementation, could not be independently verified from source.

## Interpretation

- The P1 finding independently confirms the manual review issue already recorded in `documentation.md`.
- The P2 finding is new and should be investigated before checkpointing the tranche.
- Recommended next packet: fix P1 and investigate or fix P2, then rerun focused detect-changes/tool tests and `git diff --check`.

## Resolution Note

Resolved: 2026-06-08T13:05+01:00

- P1 was fixed by making the direct formatter evidence-based and by including deleted symbols in affected-process lookup.
- P1/P2 were refined after the follow-up review: `summary.changed_count` remains the mapped changed-symbol count, while `summary.evidence_count` carries mapped changed symbols plus deleted symbols plus unmatched ranges.
- P2 was addressed by downgrading compare-scope deleted ranges to unmatched evidence instead of resolving them against the current graph.
- Verification passed: focused detect-changes/formatter/backend tests, adjacent parser/PR-impact tests, `npm run build`, and `git diff --check`.
