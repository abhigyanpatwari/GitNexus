# Context ledger

The ledger is gitnexus-plan's working memory. It exists to make repeated
investigation impossible-by-discipline: **before every GitNexus call and
every repo file read, check it.** Keep it as structured notes in your working
context (or a scratchpad file _outside the repo_ for very long sessions); it
is never published verbatim — the plan and context pack are distilled from
it. This skill's own reference files are exempt from ledger bookkeeping.

## Schema

```yaml
context_ledger:
  task:
    original_request: ''
    interpreted_goal: ''
    category: '' # Phase 0 classification
    acceptance_criteria: []

  verified_at_commit:
    '' # target repo HEAD, recorded once in Phase 1;
    # every line citation in the plan pins to it

  evidence_provenance: {} # required immutable working snapshot; populate
    # exactly from context-pack.md's normative schema

  index_refresh:
    '' # analyze --index-only runs: command + outcome
    # (or "skipped: <reason>"). Budget is
    # owned by SKILL.md Phase 1: one refresh plus
    # at most one Phase 3 --pdg upgrade per session

  established_facts: [] # each with its evidence source

  symbols: # budgets count active (primary/related) only;
    # discards are free — but on budget overflow,
    # discard something before promoting
    - name: ''
      kind: ''
      file: ''
      relevance: 'primary | related | discarded'
      source_verified: false # flipped in Phase 4; required before naming in Proposed Changes

  files_read:
    - file: ''
      ranges: [] # e.g. ["120-188"]
      purpose: ''

  gitnexus_queries:
    - query: '' # tool + args
      purpose: '' # the planning question it answers
      conclusion: '' # one line; details stay in working memory
      key_output: '' # one-line raw quote when the plan leans on this result

  pdg_slices:
    - symbol: ''
      purpose: ''
      conclusion: ''

  unresolved_questions: []
  assumptions: [] # explicit, carried into plan §12
  decisions: [] # with rationale, carried into plan §6/§7
```

## Evidence provenance

`context-pack.md` is the sole normative emitted field schema, and
`evidence-provenance.md` plus `../scripts/evidence-provenance.mjs` are the
normative byte contract and implementation. Keep the helper's exact schema-2
output in the ledger; do not redefine, abbreviate, or independently reproduce
its canonicalization here.

Build `evidence_provenance` immediately before composing the plan, after all
source verification, by invoking the helper exactly as described in
`evidence-provenance.md`. It is a versioned, canonical snapshot of both the
whole working tree and every path that supports a plan citation:

- `global_dirty_digest` is SHA-256 over the helper's versioned, NUL-framed
  records for
  **every dirty repo-relative path**, not only cited paths. Each record includes
  path, state, object kind, every available layer digest, and both endpoints of
  a rename. Overlapping porcelain facts for one path are merged; for example,
  a staged deletion plus a recreated untracked file is `mixed` and retains
  both its Git-backed and untracked layers. States are `staged`, `unstaged`,
  `untracked`, `deleted`, `renamed`, or `mixed`. Exclude only this run's
  normalized repo-relative generated plan path so writing the plan cannot
  invalidate its own evidence; do not exclude the rest of `docs/plans/`.
- `cited_path_manifest` is sorted by normalized repo-relative path and
  includes every path cited by a `[verified]` claim or named as evidence in
  the context pack. Record clean paths too. A path entry has this shape:

```yaml
- path: 'src/example.ts'
  object_kind: # each layer: regular | symlink | gitlink | directory | absent
    head: 'regular'
    index: 'regular'
    worktree: 'regular'
    untracked: 'absent'
  state: 'clean | staged | unstaged | untracked | deleted | renamed | mixed | absent'
  rename_from: null
  rename_to: null
  head_digest: 'sha256:<hex> | absent'
  index_digest: 'sha256:<hex> | absent'
  worktree_digest: 'sha256:<hex> | absent'
  untracked_digest: 'sha256:<hex> | absent'
```

Use Git object contents for HEAD and index digests and filesystem bytes for
worktree/untracked digests; never confuse an absent layer with an empty file.
Hash symlink targets as link text and gitlinks as object IDs. If a cited path
cannot be classified or read, the plan must mark the evidence unavailable
instead of emitting a digest it did not prove.

## Reread rules

Do **not** repeat a query or reread a source range unless one of:

- the previous result was incomplete for the question at hand;
- the source is known to have changed (an edit happened);
- validation exposed a contradiction between graph and source.

**Allowed repeats** (deliberate escalations, not violations):

- `summaryOnly: true` → full drill-down on the same `impact` target;
- an `ambiguous` result retried once with `kind` / `file_path` / uid narrowing;
- the same tool re-run with a changed parameter that answers a _new_ planning
  question (e.g. `pdg_query` `controls` then `flows` on one function).

When a repeat is justified, note in the ledger _why_ the earlier entry was
insufficient. A ledger full of near-duplicate queries is the failure signal —
stop and plan with what is established.

## Discarding

Symbols and queries that turned out irrelevant stay in the ledger marked
`discarded` with a one-line reason. That is what prevents re-walking dead
ends later in the session.
