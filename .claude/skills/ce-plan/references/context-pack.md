# Implementation context pack

Section 11 of the plan. The stable, machine-readable contract a follow-up
implementation agent (a future `ce-implement`, or any executor) consumes to
start work **without repeating the investigation**. Distilled from the
ledger; every entry traceable to verified evidence.

## Schema

```yaml
implementation_context:
  task_summary: ""
  acceptance_criteria: []

  primary_symbols:
    - symbol: ""
      file: ""
      lines: ""
      role: ""

  related_symbols:
    - symbol: ""
      relationship: ""           # CALLS / IMPORTS / EXTENDS / test-of / ...
      relevance: ""

  execution_path: []             # ordered prose steps, from §2/§5

  pdg_constraints:               # from the PDG slice; empty + note if no layer
    - description: ""
      affected_statements: []    # "<file>:<line>" refs
      implementation_consequence: ""

  architectural_patterns:
    - pattern: ""
      example_location: ""       # repo-relative file (+ symbol)
      usage_guidance: ""

  files_to_modify:
    - file: ""
      symbols: []
      intended_change: ""

  tests:
    - file: ""                   # existing file to update, or new path to create
      scenarios: []              # input → action → expected outcome

  verification_commands: []      # real commands verified to exist AND be runnable —
                                 # prefer npm/CI scripts that carry their pre-hooks

  risks: []
  assumptions: []                # faithful condensation of plan §12 assumptions
  open_questions: []             # faithful condensation of plan §12 open questions

  avoid:
    - "Do not repeat full repository discovery"
    - "Do not replace established patterns without evidence"
    # + task-specific prohibitions discovered during planning
```

## Must not contain

- full files;
- large raw GitNexus responses;
- unfiltered PDG dumps;
- duplicate code excerpts (cite `file:line`, don't re-quote);
- speculative implementation details presented as facts.

## Stability contract

Field names above are the interface for a future `ce-implement`. Add fields
freely; do not rename or repurpose existing ones. `assumptions` and `avoid`
are load-bearing: an executor treats `assumptions` as things to re-verify
cheaply before relying on them, and `avoid` as hard constraints.
