# GitNexus PR Impact Report

Verdict: BLOCK

Schema: pr-impact.v1alpha1

## Summary

- Diff scope: compare main..HEAD
- Files changed: 3
- Mapped symbols: 2
- Unmatched ranges: 1
- Deleted symbols: 0
- New or unmapped symbols: 1
- Impact entries: 2
- API impact entries: 1
- Test signal: unknown_or_unreferenced

## Changed Symbols

| Symbol | Kind | File | Change |
| --- | --- | --- | --- |
| `updateGrant` | Function | `app/api/grants/route.ts` | modified |
| `useGrants` | Function | `hooks/useGrants.ts` | modified |

## Unmatched Ranges

| File | Lines | Reason |
| --- | --- | --- |
| `app/api/grants/route.ts` | 44-46 | No indexed symbol overlapped this changed range |

## New Or Unmapped Symbols

| Symbol | Kind | File | Reason |
| --- | --- | --- | --- |
| `formatGrantRow` | Function | `components/GrantRow.tsx` | New symbol is not present in the base graph |

## Impact

| Symbol | Risk | Direct | Processes | Test Reference |
| --- | --- | ---: | ---: | --- |
| `updateGrant` | HIGH | 4 | 2 | unknown_or_unreferenced |
| `useGrants` | MEDIUM | 2 | 1 | has_test_reference |

## API Impact

| Route | Risk | Consumers | Mismatches |
| --- | --- | ---: | ---: |
| `/api/grants` | MEDIUM | 3 | 1 |

## Caveats

- Graph evidence is current for commit abc123.
- Unmatched high-risk ranges require human review.
- High-risk impact has no known graph-derived test reference.
