---
name: gitnexus-refactoring
description: Safe refactoring workflows for renaming, extracting, splitting, or restructuring code. Use when asked to rename symbols, extract functions, split classes, or refactor code
---

# GitNexus Refactoring Workflow

Use this skill for safe, graph-aware refactoring operations including renaming, extracting, splitting, and restructuring code.

## When to Use

- Renaming functions, classes, methods, or variables
- Extracting functions or methods
- Splitting large classes or modules
- Moving code between files
- Any structural code changes

## Core Principle

**NEVER edit a function/class/method without running impact analysis first.**

## Renaming Workflow

### Step 1: Impact Analysis
```
gitnexus_impact({
  target: "oldFunctionName",
  direction: "upstream"
})
→ Check risk level
→ Review d=1 (WILL BREAK) items
```

### Step 2: Preview Rename
```
gitnexus_rename({
  symbol_name: "oldFunctionName",
  new_name: "newFunctionName",
  dry_run: true
})
→ Review edits with confidence tags
→ graph: high confidence (safe)
→ text_search: lower confidence (review carefully)
```

### Step 3: Execute Rename
```
gitnexus_rename({
  symbol_name: "oldFunctionName",
  new_name: "newFunctionName",
  dry_run: false
})
```

### Step 4: Verify Changes
```
gitnexus_detect_changes({scope: "all"})
→ Confirm only expected files changed
→ Check affected processes
```

## Extracting/Splitting Workflow

### Step 1: Understand Context
```
gitnexus_context({name: "largeFunction"})
→ See all incoming refs (callers)
→ See all outgoing refs (callees)
→ Understand process participation
```

### Step 2: Impact Analysis
```
gitnexus_impact({
  target: "largeFunction",
  direction: "upstream"
})
→ Find all external callers
→ Assess blast radius
```

### Step 3: Extract Code
- Create new function/method
- Move code carefully
- Update all callers (from d=1 list)

### Step 4: Verify
```
gitnexus_detect_changes({scope: "all"})
→ Confirm scope matches expectations
→ No unexpected file changes
```

## Checklist

- [ ] Run impact analysis on target symbol
- [ ] Review risk level and d=1 items
- [ ] For renames: use gitnexus_rename with dry_run first
- [ ] Review preview edits (graph vs text_search confidence)
- [ ] Execute changes
- [ ] Run detect_changes to verify scope
- [ ] Update all d=1 (WILL BREAK) dependents
- [ ] Test affected processes

## Confidence Tags

When using `gitnexus_rename`, edits are tagged with confidence:

| Tag | Meaning | Action |
|-----|---------|--------|
| `graph` | Found via knowledge graph | High confidence, safe to accept |
| `text_search` | Found via regex search | Lower confidence, review carefully |

## Tools

**gitnexus_impact** — Assess blast radius:
```
gitnexus_impact({
  target: "UserService",
  direction: "upstream",
  relationTypes: ["CALLS", "IMPORTS", "HAS_METHOD"]
})
```

**gitnexus_rename** — Multi-file coordinated rename:
```
gitnexus_rename({
  symbol_name: "validateUser",
  new_name: "checkUserAuth",
  dry_run: true
})
```

**gitnexus_context** — 360-degree view:
```
gitnexus_context({name: "processPayment"})
→ All callers and callees
→ Process participation
```

**gitnexus_detect_changes** — Verify scope:
```
gitnexus_detect_changes({scope: "all"})
→ Changed symbols
→ Affected processes
```

## Example: Renaming a Function

User asks: "Rename validateUser to authenticateUser"

1. **Impact Analysis:**
```
gitnexus_impact({target: "validateUser", direction: "upstream"})
→ Risk: MEDIUM
→ d=1: 8 direct callers
→ Affected: LoginFlow, SignupFlow
```

2. **Preview Rename:**
```
gitnexus_rename({
  symbol_name: "validateUser",
  new_name: "authenticateUser",
  dry_run: true
})
→ 8 graph edits (high confidence)
→ 2 text_search edits (review needed)
```

3. **Review with User:**
"Found 8 high-confidence edits and 2 that need review. The function is used in LoginFlow and SignupFlow. Proceed?"

4. **Execute:**
```
gitnexus_rename({
  symbol_name: "validateUser",
  new_name: "authenticateUser",
  dry_run: false
})
```

5. **Verify:**
```
gitnexus_detect_changes({scope: "all"})
→ 5 files changed (expected)
→ LoginFlow, SignupFlow affected (expected)
```

## Example: Extracting a Method

User asks: "Extract validation logic from processPayment"

1. **Understand Context:**
```
gitnexus_context({name: "processPayment"})
→ Called by: checkout, refund, subscription
→ Calls: validateCard, chargeCard, sendReceipt
```

2. **Impact Analysis:**
```
gitnexus_impact({target: "processPayment", direction: "upstream"})
→ Risk: HIGH
→ d=1: 12 callers
```

3. **Extract:**
- Create `validatePaymentDetails()` function
- Move validation code
- Update `processPayment` to call new function
- All 12 callers still work (signature unchanged)

4. **Verify:**
```
gitnexus_detect_changes({scope: "all"})
→ 2 files changed (payment.ts, payment.test.ts)
→ No processes affected (internal refactor)
```

## Never Do

- NEVER rename with find-and-replace
- NEVER skip impact analysis before refactoring
- NEVER ignore HIGH/CRITICAL risk warnings
- NEVER commit without running detect_changes