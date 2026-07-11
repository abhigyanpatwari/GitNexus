# Context ledger

The ledger is ce-plan's working memory. It exists to make repeated
investigation impossible-by-discipline: **before every GitNexus call and
every repo file read, check it.** Keep it as structured notes in your working
context (or a scratchpad file *outside the repo* for very long sessions); it
is never published verbatim — the plan and context pack are distilled from
it. This skill's own reference files are exempt from ledger bookkeeping.

## Schema

```yaml
context_ledger:
  task:
    original_request: ""
    interpreted_goal: ""
    category: ""                 # Phase 0 classification
    acceptance_criteria: []

  verified_at_commit: ""         # target repo HEAD, recorded once in Phase 1;
                                 # every line citation in the plan pins to it

  established_facts: []          # each with its evidence source

  symbols:                       # budgets count active (primary/related) only;
                                 # discards are free — but on budget overflow,
                                 # discard something before promoting
    - name: ""
      kind: ""
      file: ""
      relevance: "primary | related | discarded"
      source_verified: false     # flipped in Phase 4; required before naming in Proposed Changes

  files_read:
    - file: ""
      ranges: []                 # e.g. ["120-188"]
      purpose: ""

  gitnexus_queries:
    - query: ""                  # tool + args
      purpose: ""                # the planning question it answers
      conclusion: ""             # one line; details stay in working memory
      key_output: ""             # one-line raw quote when the plan leans on this result

  pdg_slices:
    - symbol: ""
      purpose: ""
      conclusion: ""

  unresolved_questions: []
  assumptions: []                # explicit, carried into plan §12
  decisions: []                  # with rationale, carried into plan §6/§7
```

## Reread rules

Do **not** repeat a query or reread a source range unless one of:

- the previous result was incomplete for the question at hand;
- the source is known to have changed (an edit happened);
- validation exposed a contradiction between graph and source.

**Allowed repeats** (deliberate escalations, not violations):

- `summaryOnly: true` → full drill-down on the same `impact` target;
- an `ambiguous` result retried once with `kind` / `file_path` / uid narrowing;
- the same tool re-run with a changed parameter that answers a *new* planning
  question (e.g. `pdg_query` `controls` then `flows` on one function).

When a repeat is justified, note in the ledger *why* the earlier entry was
insufficient. A ledger full of near-duplicate queries is the failure signal —
stop and plan with what is established.

## Discarding

Symbols and queries that turned out irrelevant stay in the ledger marked
`discarded` with a one-line reason. That is what prevents re-walking dead
ends later in the session.
