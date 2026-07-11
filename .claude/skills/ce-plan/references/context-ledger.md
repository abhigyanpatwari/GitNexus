# Context ledger

The ledger is ce-plan's working memory. It exists to make repeated
investigation impossible-by-discipline: **before every GitNexus call and every
file read, check it.** Keep it as structured notes in your working context (or
a scratchpad file for very long sessions); it is never published verbatim —
the plan and context pack are distilled from it.

## Schema

```yaml
context_ledger:
  task:
    original_request: ""
    interpreted_goal: ""
    category: ""                 # Phase 0 classification
    acceptance_criteria: []

  established_facts: []          # each with its evidence source

  symbols:                       # budgeted: max_primary_symbols / max_related_symbols
    - name: ""
      kind: ""
      file: ""
      relevance: "primary | related | discarded"
      source_verified: false     # flipped in Phase 4; required before naming in Proposed Changes

  files_read:
    - file: ""
      ranges: []                 # e.g. ["120-188"]
      purpose: ""
      content_hash_or_version: ""  # e.g. git blob hash or "HEAD@<sha>"

  gitnexus_queries:
    - query: ""                  # tool + args
      purpose: ""                # the planning question it answers
      conclusion: ""             # one line; details stay in working memory

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

- the previous result was incomplete for a *new* question;
- the source changed (hash/version mismatch, or an edit is known to have
  happened);
- validation exposed a contradiction between graph and source.

When a repeat is justified, note in the ledger *why* the earlier entry was
insufficient. A ledger full of near-duplicate queries is the failure signal —
stop and plan with what is established.

## Discarding

Symbols and queries that turned out irrelevant stay in the ledger marked
`discarded` with a one-line reason. That is what prevents re-walking dead
ends later in the session.
