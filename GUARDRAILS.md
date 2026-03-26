# Guardrails — GitNexus (repo + agents)

Rules for **human contributors** and **AI agents** working on this codebase or publishing artifacts. These complement `AGENTS.md` / `CLAUDE.md` (which focus on GitNexus-in-GitNexus workflows).

## Scope (typical agent session)

When automating changes in this repository, treat scope as **least privilege**:

- **Read:** Source, tests, docs, public config as needed for the task.  
- **Write:** Only files required for the requested fix or feature; avoid unrelated formatting or refactors.  
- **Execute:** Tests, typecheck, and documented CLI commands; do not run destructive commands on user data outside the repo without explicit approval.  
- **Off-limits:** Other people’s machines, production deployments you don’t own, and credentials you didn’t receive permission to use.

Adjust explicitly if the maintainer defines a different scope for a task.

---

## Non-negotiables

1. **Never commit secrets** — API keys, tokens, `.env` with real values, private URLs, or session cookies. Use `.env.example` with placeholders only.  
2. **Never rename symbols with blind find-and-replace** when working in a GitNexus-indexed project — use the **`rename` MCP tool** with **`dry_run: true` first**, then review `graph` vs `text_search` edits. (There is no separate `gitnexus rename` CLI; renaming goes through MCP or editor integration.)  
3. **Run impact analysis before editing shared symbols** — use **`impact`** (upstream) for functions/classes/methods others call; do not ignore **HIGH** / **CRITICAL** risk without maintainer sign-off.  
4. **Prefer `detect_changes` before commit** — confirm diffs map to expected symbols/processes when the graph is available.  
5. **Preserve embeddings** — if `.gitnexus/meta.json` shows embeddings, run `npx gitnexus analyze --embeddings` when refreshing the index; plain `analyze` can drop them.

---

## Signs (recurring failure patterns)

Use this format: **Trigger → Instruction → Reason**.  
Append new Signs here when the same mistake repeats (e.g. CI broken twice the same way).

### Sign: Stale graph after edits

- **Trigger:** MCP or resources warn the index is behind `HEAD`, or code search doesn’t match latest commit.  
- **Instruction:** Run `npx gitnexus analyze` from the repo root (plus `--embeddings` if the project used them).  
- **Reason:** Tools query LadybugDB built at last analyze; git changes are invisible until re-indexed.

### Sign: Embeddings vanished after analyze

- **Trigger:** Semantic search quality drops; `stats.embeddings` in `.gitnexus/meta.json` is 0 after a refresh.  
- **Instruction:** Re-run `npx gitnexus analyze --embeddings` and confirm `meta.json` reflects stored embeddings.  
- **Reason:** Embedding generation is opt-in; analyze without the flag does not preserve prior vectors.

### Sign: MCP lists no repos

- **Trigger:** MCP stderr says no indexed repos.  
- **Instruction:** Run `npx gitnexus analyze` in the target repository; verify `npx gitnexus list` shows it.  
- **Reason:** The MCP server discovers repos via `~/.gitnexus/registry.json`, populated by analyze.

### Sign: Wrong repo in multi-repo setups

- **Trigger:** Query/impact results clearly belong to another project.  
- **Instruction:** Call `list_repos`, then pass **`repo`** on subsequent tools (or use per-workspace MCP config).  
- **Reason:** Default target may be ambiguous when multiple repos are registered.

### Sign: LadybugDB lock / “database busy”

- **Trigger:** Errors opening `.gitnexus/lbug` while MCP and analyze both run.  
- **Instruction:** Stop overlapping processes; one writer at a time. Retry analyze or restart MCP.  
- **Reason:** Embedded DB expects single-process ownership of the store.

---

## Publishing & supply chain

- **npm:** Do not publish from unreviewed automation; follow maintainer release process. Bump version intentionally; tag releases to match `package.json`.  
- **Dependencies:** Prefer minimal, auditable changes to `package.json`; run tests and CI after lockfile updates.  
- **License:** This project ships under **PolyForm Noncommercial 1.0.0** — do not relicense or imply a different license in docs or metadata without maintainer approval.

---

## Escalation

Stop and ask a **human maintainer** when:

- Impact analysis shows **HIGH** / **CRITICAL** risk and the task still requires the change.  
- You need to alter **CI**, **release**, or **security-sensitive** config.  
- Requirements conflict (e.g. “speed up analyze” vs “must keep all embeddings on huge repo”).  
- You are unsure whether data loss is acceptable (`clean`, forced migrations, schema changes).

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow.  
- [RUNBOOK.md](RUNBOOK.md) — commands for recovery.  
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR and commit expectations.
