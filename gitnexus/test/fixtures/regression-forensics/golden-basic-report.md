# GitNexus Regression Forensics Report

Confidence: MEDIUM

Schema: regression-forensics.v1alpha1

Recommendation: Investigate candidate causes before retrying the failing command.

## Failure Evidence

- Command: `npm test -- test/unit/pr-impact-report.test.ts`
- Exit code: 1
- Environment: local (Windows, node 24)
- Known good ref: not provided
- Known bad ref: `HEAD`

## Failing Tests

- PR Impact report core > builds versioned experimental JSON

## Failure Excerpt

```text
expected report.verdict to be BLOCK // Object.is equality
Received: NEEDS_DISCUSSION
```

## PR Impact Linkage

- Schema: pr-impact.v1alpha1
- Verdict: BLOCK
- Files changed: 2
- Mapped symbols: 1
- Test signal: unknown_or_unreferenced

## Candidate Causes

| Symbol | File | Confidence | Reason |
| --- | --- | --- | --- |
| `computeVerdict` | `src/core/pr-impact/report.ts` | HIGH | High-risk changed symbol is linked to the failing surface. |

## Evidence

- computeVerdict: PR Impact verdict: BLOCK; Risk: HIGH; Direct dependents: 4; Processes affected: 2; Test reference: unknown_or_unreferenced

## Caveats

- No known-good ref was provided; confidence is capped below HIGH.
- High-risk impact has no known graph-derived test reference.
- Report identifies candidate causes, not a proven root cause.
