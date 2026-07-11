# Building the PDG context slice

Statement-level evidence for the 1–3 functions most central to the change.
Goal: a compact slice the planning LLM can hold, never a graph dump.

## Tools (all verified against `gitnexus/src/mcp/tools.ts`)

| Question | Call |
| --- | --- |
| Under what condition does X run? Guards? | `pdg_query {mode: "controls", target}` |
| Where does variable Y flow inside the function? | `pdg_query {mode: "flows", target, variable}` |
| What depends on the statement at line N? | `impact {mode: "pdg", target, line: N}` |
| Source→sink taint paths (security mode) | `explain {target}` |

Contract caveats that shape interpretation:

- CDG branch sense is `'T'`/`'F'` in the edge's `reason`; a guard's sense
  depends on its predicate (`if (!ok) return;` rides `'T'`) — never filter
  guards by a fixed label. Early return/throw edges carry `guard: true`.
- `pdg_query` is intra-procedural and always anchored. Cross-function flow is
  taint's domain (`explain`) or `impact {mode:"pdg"}`'s inter-procedural reach.
- Every `switch` case arm is `'T'` (per-case conditions not distinguished).
- No `--pdg` layer → the tools return a "no PDG layer" note, not an error.
  Record it, skip the slice, recommend `analyze --pdg`. Do not reconstruct
  edges from source by hand.

## Inclusion criteria

A statement enters the slice only if it is at least one of:

- directly matched to the task;
- a data-flow predecessor or successor of a relevant statement (within
  `pdg_data_depth`, default 2);
- a control dependency of a relevant statement (within `pdg_control_depth`,
  default 2);
- a state mutation affecting the requested behavior;
- an external call on the execution path;
- an error-handling or fallback branch;
- part of an affected return value;
- required to explain a test assertion.

Everything else is cut. If the slice exceeds ~15 statements per function,
tighten relevance rather than raising depth.

## Slice representation (goes into the ledger; summarized in plan §5)

```yaml
pdg_context:
  entry_symbol: "processFileGroup"
  source: { file: "gitnexus/src/core/ingestion/worker.ts", start_line: 120, end_line: 188 }
  relevant_statements:
    - id: "stmt-12"                # stable id or "<file>:<line>"
      lines: "128-130"
      type: "condition | call | mutation | return | throw"
      code: "if (request.retryable) {"
      relevance: "Controls whether retry scheduling is entered"
      defines: []
      uses: ["request.retryable"]
      control_dependencies: ["stmt-4"]
      data_dependencies: []
  execution_flow:                  # ordered, prose steps
    - "Validate request"
    - "Schedule retry"
  critical_dependencies:
    - { from: "stmt-7", to: "stmt-18", type: "data", explanation: "Validated request becomes scheduler input" }
  behavioural_observations:
    - "Persistence occurs before scheduler invocation"
  planning_implications:
    - "Changes to scheduling must account for partial failure"
```

Adapt field names to what the tools actually returned; keep it
machine-readable and short. `behavioural_observations` are confirmed facts;
`planning_implications` are inferences — keep the distinction.

## Security mode (task category: security)

Additionally identify and record: untrusted inputs, validation points,
sanitisation points, authn/authz checks, privilege boundaries, sensitive data,
persistence operations, network calls, dangerous sinks, and error paths that
bypass validation. Run `explain {target}` for persisted source→sink taint
paths and include the hop paths for findings relevant to the task. Absence of
a taint finding is **not** proof of safety (intra-procedural only) — say so
when it matters.

## Performance mode (task category: performance)

Additionally scan the slice for: loops, repeated calls, blocking operations,
network calls, database calls, allocation-heavy paths, caching boundaries,
concurrency, fan-out, repeated data transformations. State likely hot-path
implications as inferences; never claim measured improvements without
benchmark evidence.
