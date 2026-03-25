---
name: gitnexus-impact-analysis
description: Analyze blast radius before making code changes. Use when asked "What breaks if I change X?" or before refactoring, renaming, or modifying shared code
---

# GitNexus Impact Analysis Workflow

Use this skill to assess the blast radius of code changes before making modifications.

## When to Use

- "What breaks if I change this function?"
- Before refactoring shared code
- Before renaming symbols
- Before modifying API contracts
- Assessing risk of code changes

## Workflow

1. **gitnexus_impact({target: "symbolName", direction: "upstream"})** → See what depends on this
2. Review the risk level: LOW / MEDIUM / HIGH / CRITICAL
3. Check d=1 items (WILL BREAK) — these are direct callers/importers
4. Check affected processes and modules
5. **gitnexus_context({name: "high-risk-symbol"})** → Deep dive on critical dependencies
6. Make informed decision about proceeding with changes

## Risk Levels

| Risk | Meaning | Action |
|------|---------|--------|
| LOW | Few dependencies, isolated change | Safe to proceed |
| MEDIUM | Some dependencies, manageable scope | Review d=1 items |
| HIGH | Many dependencies, wide impact | Careful planning needed |
| CRITICAL | Core infrastructure, system-wide impact | Requires team review |

## Depth Groups

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Checklist

- [ ] Run impact analysis on target symbol
- [ ] Review risk level and summary
- [ ] Examine all d=1 (WILL BREAK) items
- [ ] Check affected processes and modules
- [ ] Use context tool on high-risk dependencies
- [ ] Warn user if HIGH or CRITICAL risk
- [ ] Plan updates for all d=1 dependents

## Tools

**gitnexus_impact** — Symbol blast radius with confidence scores:

```
gitnexus_impact({
  target: "validateUser",
  direction: "upstream",
  maxDepth: 3
})
→ Risk: HIGH
→ d=1: 12 direct callers (WILL BREAK)
→ d=2: 45 indirect deps (LIKELY AFFECTED)
→ Affected processes: LoginFlow, SignupFlow, PasswordReset
```

**Advanced Options:**

```
gitnexus_impact({
  target: "UserService",
  direction: "upstream",
  relationTypes: ["CALLS", "IMPORTS", "HAS_METHOD"],
  minConfidence: 0.8,
  includeTests: false
})
```

## Edge Types

- `CALLS` — function/method calls
- `IMPORTS` — module imports
- `EXTENDS` — class inheritance
- `IMPLEMENTS` — interface implementation
- `HAS_METHOD` — class methods
- `HAS_PROPERTY` — class properties
- `OVERRIDES` — method overrides
- `ACCESSES` — field read/write

## Example Workflow

User asks: "Can I rename validateUser to checkUserAuth?"

1. Run impact analysis:
```
gitnexus_impact({target: "validateUser", direction: "upstream"})
```

2. Review results:
- Risk: HIGH
- 15 direct callers (d=1)
- 3 affected processes

3. Warn user:
"⚠️ HIGH RISK: This function has 15 direct callers across 3 execution flows. All must be updated."

4. Use gitnexus_rename instead of manual find-replace