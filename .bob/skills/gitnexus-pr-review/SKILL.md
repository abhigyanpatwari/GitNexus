---
name: gitnexus-pr-review
description: Use when the user wants to review a pull request, understand what a PR changes, assess risk of merging, or check for missing test coverage. Examples: "Review this PR", "What does PR #42 change?", "Is this PR safe to merge?"
---

# GitNexus PR Review Workflow

Use this skill to review pull requests using GitNexus execution flow analysis.

## When to Use

- "Review this PR"
- "What does PR #42 change?"
- "Is this safe to merge?"
- "What's the blast radius of this PR?"
- "Are there missing tests for this PR?"
- Reviewing someone else's code changes before merge

## Workflow

1. **gh pr diff <number>** → Get the raw diff
2. **gitnexus_detect_changes({scope: "compare", base_ref: "main"})** → Map diff to affected flows
3. For each changed symbol:
   **gitnexus_impact({target: "<symbol>", direction: "upstream"})** → Blast radius per change
4. **gitnexus_context({name: "<key symbol>"})** → Understand callers/callees
5. **READ gitnexus://repo/{name}/processes** → Check affected execution flows
6. Summarize findings with risk assessment

If "Index is stale" → run `npx gitnexus analyze` in terminal before reviewing.

## Checklist

- [ ] gitnexus_detect_changes to map changes to affected execution flows
- [ ] gitnexus_impact on each non-trivial changed symbol
- [ ] Review d=1 items (WILL BREAK) — are callers updated?
- [ ] gitnexus_context on key changed symbols to understand full picture
- [ ] Check if affected processes have test coverage
- [ ] Assess overall risk level
- [ ] Write review summary with findings

## Review Dimensions

| Dimension | How GitNexus Helps |
|-----------|-------------------|
| **Correctness** | `context` shows callers — are they all compatible with the change? |
| **Blast radius** | `impact` shows d=1/d=2/d=3 dependents — anything missed? |
| **Completeness** | `detect_changes` shows all affected flows — are they all handled? |
| **Test coverage** | `impact({includeTests: true})` shows which tests touch changed code |
| **Breaking changes** | d=1 upstream items that aren't updated in the PR = potential breakage |

## Risk Assessment

| Scope | Risk Level |
|-------|-----------|
| Changes touch 1-2 symbols, 1 process | LOW |
| Changes touch 3-10 symbols, 2-5 processes | MEDIUM |
| Changes touch >10 symbols or many processes | HIGH |
| Changes touch auth, payments, or data integrity code | CRITICAL |
| d=1 callers exist outside the PR diff | Potential breakage — flag it |

## Tools

**gitnexus_detect_changes** — map PR diff to affected execution flows:

```
gitnexus_detect_changes({scope: "compare", base_ref: "main"})
→ Changed: 8 symbols in 4 files
→ Affected processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Risk: MEDIUM
```

**gitnexus_impact** — blast radius per changed symbol:

```
gitnexus_impact({target: "validatePayment", direction: "upstream"})
→ d=1: 5 direct callers
→ d=2: 12 indirect deps
→ Affected processes: CheckoutFlow, RefundFlow
```

**gitnexus_context** — understand callers/callees:

```
gitnexus_context({name: "processPayment"})
→ Called by: checkout, refund, subscription
→ Calls: validateCard, chargeCard, sendReceipt
```

## Example PR Review

**User asks:** "Review PR #123"

1. **Get diff:**
```bash
gh pr diff 123
```

2. **Map to flows:**
```
gitnexus_detect_changes({scope: "compare", base_ref: "main"})
→ Changed: validateUser, authenticateToken
→ Affected: LoginFlow, SignupFlow
→ Risk: MEDIUM
```

3. **Check blast radius:**
```
gitnexus_impact({target: "validateUser", direction: "upstream"})
→ d=1: 8 callers (all updated in PR ✓)
→ d=2: 15 indirect deps
```

4. **Review key symbols:**
```
gitnexus_context({name: "authenticateToken"})
→ Called by: validateUser, refreshSession, apiMiddleware
→ All callers updated in PR ✓
```

5. **Check test coverage:**
```
gitnexus_impact({
  target: "validateUser",
  direction: "upstream",
  includeTests: true
})
→ Tests: test_login.py, test_signup.py (both updated ✓)
```

6. **Summary:**
```
✅ SAFE TO MERGE (MEDIUM risk)

Changes:
- Modified validateUser and authenticateToken
- Affects LoginFlow and SignupFlow

Blast radius:
- 8 direct callers (all updated)
- 15 indirect dependencies (tested)

Test coverage:
- All affected flows have tests
- Tests updated in PR

Recommendation: Approve with confidence
```

## Red Flags

⚠️ **Flag these issues:**

- d=1 callers exist outside the PR diff (potential breakage)
- Affected processes have no test coverage
- Changes touch auth/payments/data integrity without tests
- HIGH or CRITICAL risk without team review
- Breaking API changes without migration plan

## Tips

- Always run detect_changes first to understand scope
- Use impact analysis on each non-trivial changed symbol
- Check if d=1 items are all updated in the PR
- Verify test coverage for affected processes
- Summarize findings with clear risk assessment
- Be specific about what needs fixing