---
name: gitnexus-debugging
description: Trace bugs and investigate failures using execution flow analysis. Use when asked "Why is X failing?" or debugging runtime errors, unexpected behavior, or regressions
---

# GitNexus Debugging Workflow

Use this skill to trace bugs, investigate failures, and understand unexpected behavior using execution flow analysis.

## When to Use

- "Why is this function failing?"
- "Trace this error back to its source"
- "What changed to break this feature?"
- Debugging runtime errors
- Investigating regressions
- Understanding unexpected behavior

## Workflow

1. **gitnexus_query({query: "<error or symptom>"})** → Find execution flows related to the issue
2. **gitnexus_context({name: "<suspect function>"})** → See all callers, callees, and process participation
3. **READ gitnexus://repo/{repoName}/process/{processName}** → Trace the full execution flow step by step
4. For regressions: **gitnexus_detect_changes({scope: "compare", base_ref: "main"})** → See what your branch changed

## Checklist

- [ ] Use query tool to find execution flows related to error/symptom
- [ ] Identify suspect functions from query results
- [ ] Use context tool on suspect functions to see all relationships
- [ ] READ process resources to trace full execution paths
- [ ] For regressions: detect_changes to see what changed
- [ ] Read source files to examine implementation
- [ ] Verify fix doesn't break other flows (run impact analysis)

## Debugging Strategies

### Strategy 1: Error Message Search
```
gitnexus_query({query: "NullPointerException user validation"})
→ Find processes that handle user validation
→ Examine symbols in those flows
```

### Strategy 2: Symptom-Based Search
```
gitnexus_query({query: "payment fails after checkout"})
→ Find CheckoutFlow, PaymentFlow processes
→ Trace execution step by step
```

### Strategy 3: Regression Analysis
```
gitnexus_detect_changes({
  scope: "compare",
  base_ref: "main"
})
→ See changed symbols and affected processes
→ Focus on high-risk changes
```

### Strategy 4: Call Chain Analysis
```
gitnexus_context({name: "processPayment"})
→ See all callers (who calls this?)
→ See all callees (what does this call?)
→ Identify where the chain breaks
```

## Tools

**gitnexus_query** — Find execution flows by concept:
```
gitnexus_query({
  query: "authentication failure",
  task_context: "debugging login issues",
  goal: "find where auth validation happens"
})
```

**gitnexus_context** — 360-degree symbol view:
```
gitnexus_context({name: "validateCredentials"})
→ Incoming: who calls this?
→ Outgoing: what does this call?
→ Processes: which flows use this?
```

**gitnexus_detect_changes** — Git diff impact analysis:
```
gitnexus_detect_changes({
  scope: "compare",
  base_ref: "main"
})
→ Changed symbols
→ Affected processes
→ Risk summary
```

## Example Debugging Session

**Problem:** "Login is failing with 'Invalid token' error"

1. Find related flows:
```
gitnexus_query({query: "token validation login"})
→ Found: LoginFlow, TokenRefreshFlow
```

2. Examine token validation:
```
gitnexus_context({name: "validateToken"})
→ Called by: authenticateUser, refreshSession
→ Calls: decodeJWT, checkExpiry, verifySignature
```

3. Trace the login flow:
```
READ gitnexus://repo/myapp/process/LoginFlow
→ Step 1: parseCredentials
→ Step 2: validateToken ← SUSPECT
→ Step 3: createSession
```

4. Check recent changes:
```
gitnexus_detect_changes({scope: "staged"})
→ Changed: validateToken (HIGH RISK)
→ Affected: LoginFlow, TokenRefreshFlow
```

5. Read the implementation:
```
read_file({path: "src/auth/token.ts"})
→ Found bug in line 45: wrong expiry check
```

## Tips

- Start broad with query, then narrow with context
- Use process resources to see full execution traces
- For regressions, always check detect_changes
- Verify fixes don't break other flows (impact analysis)
- Read actual source code for implementation details