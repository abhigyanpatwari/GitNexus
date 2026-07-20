# Implementation context pack

Section 11 of the plan. The stable, machine-readable contract a follow-up
implementation agent (`gitnexus-work`, or any executor) consumes to start
work **without repeating the investigation**. Distilled from the ledger;
every entry traceable to verified evidence.

**Compact plans emit the mini-pack** — only: `task_summary`,
`evidence_provenance`, `files_to_modify`, `tests`,
`verification_commands`, `pdg_constraints` (only when a slice actually
ran), `assumptions`, `open_questions`, `avoid`. Full plans emit every
field. Field semantics are identical in both; `evidence_provenance` is
mandatory in both forms. `gitnexus-work` treats absent optional fields as
empty, not as errors.

## Schema

This is the sole normative emitted `evidence_provenance` field schema. The
portable byte contract and executable serializer live in
`evidence-provenance.md` and `../scripts/evidence-provenance.mjs`; sibling
documents must reference them rather than reimplementing canonical bytes.

```yaml
implementation_context:
  task_summary: ''
  acceptance_criteria: []

  evidence_provenance:
    schema_version: 2
    head_commit: '' # full commit SHA that source citations pin to
    # normalized repo-relative docs/plans/<date>-gitnexus-plan-<3-5-word-slug>.md;
    # safely written; exact path excluded from global_dirty_digest
    generated_plan_path: ''
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '' # digest only; do not embed the whole dirty-path manifest
    cited_path_manifest: # sorted by normalized repo-relative path
      - path: ''
        object_kind: # per layer: regular | symlink | gitlink | directory | absent
          head: ''
          index: ''
          worktree: ''
          untracked: ''
        state: 'clean | staged | unstaged | untracked | deleted | renamed | mixed | absent'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:<hex> | absent'
        index_digest: 'sha256:<hex> | absent'
        worktree_digest: 'sha256:<hex> | absent'
        untracked_digest: 'sha256:<hex> | absent'

  primary_symbols:
    - symbol: ''
      file: ''
      lines: ''
      role: ''

  related_symbols:
    - symbol: ''
      relationship: '' # CALLS / IMPORTS / EXTENDS / test-of / ...
      relevance: ''

  execution_path: [] # ordered prose steps, from §2/§5

  pdg_constraints: # from the PDG slice; empty + note if no layer
    - description: ''
      affected_statements: [] # "<file>:<line>" refs
      implementation_consequence: ''

  architectural_patterns:
    - pattern: ''
      example_location: '' # repo-relative file (+ symbol)
      usage_guidance: ''

  files_to_modify:
    - file: ''
      symbols: []
      intended_change: ''

  tests:
    - file: '' # existing file to update, or new path to create
      scenarios: [] # input → action → expected outcome

  verification_commands: [] # real commands verified to exist AND be runnable —
    # prefer npm/CI scripts that carry their pre-hooks

  risks: []
  assumptions: [] # faithful condensation of plan §12 assumptions;
    # each entry names WHAT to check and HOW —
    # gitnexus-work re-verifies them before executing
  open_questions: [] # faithful condensation of plan §12 open questions

  avoid:
    - 'Do not repeat full repository discovery'
    - 'Do not replace established patterns without evidence'
    # + task-specific prohibitions discovered during planning
```

## Must not contain

- full files;
- the repository-wide raw dirty-path manifest (store only its canonical
  `global_dirty_digest`; detailed entries are bounded to cited paths);
- large raw GitNexus responses;
- unfiltered PDG dumps;
- duplicate code excerpts (cite `file:line`, don't re-quote);
- speculative implementation details presented as facts.

## Stability contract

Field names above are the interface consumed by `gitnexus-work` (fields it
does not act on directly travel as executor context). Add fields
freely; do not rename or repurpose existing ones. `assumptions` and `avoid`
are load-bearing: an executor treats `assumptions` as things to re-verify
cheaply before relying on them, and `avoid` as hard constraints.
`evidence_provenance` is also load-bearing: its version, global digest, and
sorted cited-path manifest let the executor distinguish commit drift from
staged, unstaged, untracked, deleted, renamed, mixed, or absent working-tree
evidence. Legacy packs that lack it or use schema 1 require a conservative
schema-2 re-anchor; they are not interpreted as a clean tree.
`generated_plan_path` is always normalized, relative to the target repo, and
scoped to the generated-plan filename shape under `docs/plans/`; schema 2 has
no external-output representation. An executor must load the plan with the
helper's descriptor-anchored `read-plan` command and require this field to
equal the receipt's canonical target-repo-relative path byte-for-byte.
