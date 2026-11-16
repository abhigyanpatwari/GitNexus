---
name: pr-tri-review
description: "Review a GitHub PR with three review methods (GitNexus PR swarm + ce-code-review personas + Codex on gpt-6-astra/xhigh by default), then a dedicated synthesis agent merges everything with honest cross-engine confidence weighting, a synthesis critic gates the result, and it posts as one inline-comment review. Use for a thorough, high-signal PR review that ends with inline comments on the PR."
---

# PR Tri-Review (two engines × {swarm, ce} + Codex adversarial → Claude synthesis → critic gate → inline comments)

Runs the **same two review methodologies on both engines** — Claude *and* Codex (`gpt-6-astra` by default) each run the GitNexus PR swarm and ce-code-review — plus a Codex-only adversarial pass. A **claude-mem recall** seeds every lane with cross-session prior context first. Every lane's full output is persisted to disk, then a **dedicated Claude synthesis agent** merges them weighting by **cross-engine** corroboration, an independent critic vets that digest, and it posts a single `COMMENT` review with inline comments.

```
/pr-tri-review <PR number or URL>
```

You are the coordinator. Run the phases below; do not flatten into a generic checklist. The phases are written for a coordinator running in **Claude**; when you are running in **Codex**, read *Which engine is home* first — Claude then supplies the other legs.

**Outward-facing gate.** Posting to a PR happens under the maintainer's identity on a contributor's branch. Only post when the user has asked for it (this skill's contract — `/pr-tri-review` invocation counts). Otherwise stop after Phase 4 and show the digest. A wrong maintainer-signed inline comment is expensive to retract, so the bar for posting is high (Phases 4–5).

## The lanes — two engines, five passes

Both engines run the **identical** two review methodologies, so cross-engine agreement is a clean same-prompt / different-engine A/B:

| Lane | Engine | What runs |
|---|---|---|
| A1 | **Claude** (Swarm mode) | GitNexus PR swarm — the `gitnexus-*` lanes per `pr-swarm-review/orchestration.md` |
| A2 | **Claude** | ce-code-review — the `compound-engineering:ce-*` persona pipeline |
| B1 | **Codex** `$CODEX_MODEL`/`xhigh` (Solo mode) | `$gitnexus-pr-review` — same swarm, all 7 personas run by one agent (orchestration.md Solo mode) |
| B2 | **Codex** `$CODEX_MODEL`/`xhigh` | `ce-code-review` — Codex's own copy, `mode:report-only` |
| B3 | **Codex** `$CODEX_MODEL` (no effort flag) | native `codex-companion adversarial-review` — Codex's red-team reviewer |

Then a **Claude** synthesis agent merges all five from disk; `gitnexus-synthesis-critic` gates the digest before posting.

> **Independence is the point of B.** A1/A2 are both Claude — agreement between them is *correlated* (shared priors, shared blind spots), so it's "consistent across personas," not independent confirmation. The strong signal is **a Codex lane (B) agreeing with a Claude lane (A) on the same finding** — same review scaffolding, genuinely different engine. Because B1/B2 run the *same* swarm/ce contracts as A1/A2, a finding both engines surface is the highest-confidence class. Never market the output as five independent confirmations — it's two engines.

> **Codex model.** Every Codex leg runs on `$CODEX_MODEL`: **`gpt-6-astra`** unless you set it, with **`gpt-6.1-sol`** as the cheaper tier (`CODEX_MODEL=gpt-6.1-sol`). Both take `--effort xhigh`. Use one model for all three legs of a run, and name the model actually used in the digest body.

> **Effort caveat.** The Codex `task` legs (B1, B2) honor `--model "$CODEX_MODEL" --effort xhigh`. The adversarial-review leg (B3) accepts `--model "$CODEX_MODEL"` but **not** `--effort` — the companion exposes reasoning effort only on `task`.

---

## Which engine is home

The engine you are running in is **home**; the other one supplies the independent legs. When this skill is run **from Codex, Claude is the other leg**: keep every phase, rule and artifact name below, and swap the roles.

| Role | Claude home (default) | Codex home |
|---|---|---|
| Home legs | A1 swarm (parallel `gitnexus-*` subagents), A2 ce personas | B1 swarm Solo mode, B2 ce report-only, B3 adversarial |
| Other-engine legs | B1–B3 through `codex-companion.mjs` | **C1** Claude swarm, **C2** Claude ce — headless `claude -p` |
| Prior-context recall | coordinator, claude-mem MCP | coordinator's own claude-mem tools when Codex has the plugin; else one `claude -p` call |
| Synthesis | a Claude `general-purpose` agent | a fresh Codex thread — never the coordinator's own context |
| Critic | `gitnexus-synthesis-critic` subagent | the same critic, `claude -p --agent gitnexus-synthesis-critic` |

Unchanged in both directions: the strong signal is a `claude-*` artifact and a `codex-*` artifact agreeing; files are named for the **engine that wrote them**, not for who coordinated; the critic is never the synthesizer. State in the digest body which engine coordinated.

### Codex home — the Claude legs

**Smoke-test first.** A Codex sandbox may block the network or writes under `~/.claude`, and then `claude` cannot run:

```bash
echo "Reply with exactly: ok" | claude -p --model haiku > "$ART/claude-smoke.txt" 2>&1; echo $? > "$ART/claude-smoke.exit"
```

Anything but exit 0 and `ok` means Claude is unavailable: say "Claude unavailable — degraded to Codex-only" in the body and claim no cross-engine corroboration (the mirror of synthesis rule 6).

**Run every `claude -p` from the trusted main checkout, never from `$W`.** A headless session loads `.claude/settings.json`, hooks, skills and agents from its working directory without a trust prompt; in a PR worktree those files are the contributor's. From `/workspace` the legs get this repo's own agents and skills and still read `$W` by path.

**Codex setup this direction assumes.** Codex carries the same two plugins Claude has. The dev container installs them (`node .devcontainer/agent-setup.cjs`, run by `post-create.sh`; see `.devcontainer/README.md` § Agent setup); `codex plugin list` must show `compound-engineering@compound-engineering-plugin` and `claude-mem@claude-mem-local` as `installed, enabled`. claude-mem comes from the checkout Claude already runs, so both tools share one version, worker and database — do not use `npx claude-mem install` for this, it also re-copies Claude's plugin and restarts the shared worker.

With compound-engineering installed, B2 is Codex's own `ce-code-review`. With claude-mem installed, you run the Phase-1 recall yourself with its search tools. claude-mem's Codex **hooks** run only after the person has approved them in an interactive Codex session; once they have, every Codex thread, review legs included, opens with claude-mem's session context. Tell each Codex leg in its prompt file that such context is possibly-stale leads and never evidence, exactly as for `prior-context.md`, and have synthesis mark a finding whose only support is recalled context as contaminated.

**Prior-context recall** (Phase 1), when Codex has no claude-mem tools, goes through Claude:

```bash
{ echo "Search claude-mem for prior context on PR #<PR>: changed files, their subsystem, linked issues, the PR theme."
  echo "Changed files:"; git -C "$W" diff --name-only "$BASE" HEAD
  echo "Reply with 5-15 evidence-tagged bullets (cite the observation id or PR#), flag anything possibly stale,"
  echo "or exactly: no relevant prior context"; } \
  | ( cd /workspace && claude -p --model claude-fable-5-2 --allowedTools Read Grep Glob mcp__plugin_claude-mem_mcp-search ) \
  > "$ART/prior-context.md" 2> "$ART/prior-context.err"
```

**Launch C1 and C2 first, as background jobs** (they are the slowest, and they do not draw on Codex's rate limit, so the two may run side by side). Prompt on stdin, findings on stdout, exit marker straight after:

```bash
CLAUDE_LEG=(claude -p --model claude-fable-5-2 --effort xhigh
            --settings '{"disableAllHooks":true}'
            --allowedTools Bash Read Grep Glob Agent Skill
            --disallowedTools Edit Write NotebookEdit)
PRIOR=$(cat "$ART/prior-context.md" 2>/dev/null || echo "no relevant prior context")

# C1 — GitNexus PR swarm, Swarm mode (Claude dispatches its own gitnexus-* subagents).
{ echo "[independent-lane]"
  echo "PRIOR CONTEXT (cross-session memory - possibly stale leads, verify before trusting):"; echo "$PRIOR"; echo
  echo "Run the gitnexus-pr-swarm-review skill on PR #<PR> in Swarm mode. PR-head worktree: $W. Diff base: $BASE."
  echo "Dispatch lanes 1-6 as subagents and start every subagent prompt with the line [independent-lane]."
  echo "Skip lane 7 (an external critic gates later). Read-only: never edit, commit, push or post."
  echo "Final answer: every lane's full structured findings, one section per lane"
  echo "(file, line, severity P0-P3, confidence, evidence quote + file:line, suggested_fix)."; } > "$ART/p-claude-swarm.txt"
( cd /workspace && SIDE_PANELS_BOARD=off "${CLAUDE_LEG[@]}" < "$ART/p-claude-swarm.txt" ) \
  > "$ART/claude-swarm.md" 2> "$ART/claude-swarm.err"; echo $? > "$ART/claude-swarm.exit"

# C2 — ce-code-review, report-only (Claude dispatches the ce persona subagents).
{ echo "[independent-lane]"
  echo "PRIOR CONTEXT (possibly stale, verify):"; echo "$PRIOR"; echo
  echo "Run the compound-engineering:ce-code-review skill on the PR-head worktree $W with arguments: mode:report-only base:$BASE"
  echo "Start every subagent prompt with the line [independent-lane]. Strictly read-only."
  echo "Final answer: the structured findings verbatim, one section per persona."; } > "$ART/p-claude-ce.txt"
( cd /workspace && SIDE_PANELS_BOARD=off "${CLAUDE_LEG[@]}" < "$ART/p-claude-ce.txt" ) \
  > "$ART/claude-ce.md" 2> "$ART/claude-ce.err"; echo $? > "$ART/claude-ce.exit"
```

- `--settings '{"disableAllHooks":true}'` is not optional. Session hooks otherwise open every headless leg with whatever the person's plugins inject: a claude-mem timeline of earlier sessions (uncontrolled prior context, possibly this PR's own earlier findings) and output-style modes that change how findings are written. A subagent lane in a Claude-home run gets neither, so a headless leg must not either. The recall call above keeps its hooks: it is not a lane.
- `--disallowedTools Edit Write NotebookEdit` is the read-only contract for a whole leg, its subagents included. Stdout is the artifact, so personas return their findings instead of writing files.
- `SIDE_PANELS_BOARD=off` keeps the side-panels agent board off in that process even when the person has it on, so no lane inside the leg is handed another lane's result.
- The model is pinned by id; change it here, not by relying on the session default.
- Stderr goes to `<name>.err`, not into the artifact: `claude` prints settings warnings there, and they are not findings.
- A leg writes nothing until it ends: an empty `claude-*.md` with no `.exit` file is a running leg, and exit 0 with a near-empty file is the "evaporated" case.

**Home legs (B1–B3).** Launch them exactly as Phase 3 does — each a fresh Codex thread, serial — so no leg sees another's reasoning and your own context stays clean for 4.2. If a nested Codex thread cannot start in your sandbox, run the three in your own context **before opening any `claude-*.md`**, and say in the body that the Codex legs shared one context.

**Synthesis (4.1)** is a fresh Codex thread, not you. Inline every `claude-*.md` and `codex-*.md` plus rules 1–6 into `$ART/p-synth.txt` (a Codex thread may not be able to read `/tmp`), run it as a `task --fresh`, capture stdout to `$ART/synthesis-raw.md`, and copy the final message — the text after the last `[codex]` status line — into `$ART/digest-draft.md`.

**Critic (4.3)** is the other engine:

```bash
{ echo "[independent-lane]"
  echo "Gate this PR review digest per your persona. PR-head worktree: $W. Diff base: $BASE."
  echo "Check each postable finding against the code. End with a 'Required corrections before posting' list (empty if none)."; echo
  cat "$ART/digest-draft.md"; } \
  | ( cd /workspace && SIDE_PANELS_BOARD=off claude -p --agent gitnexus-synthesis-critic \
        --settings '{"disableAllHooks":true}' \
        --allowedTools Bash Read Grep Glob --disallowedTools Edit Write NotebookEdit ) \
  > "$ART/critic.md" 2> "$ART/critic.err"; echo $? > "$ART/critic.exit"
```

Phases 4.2 and 5 are yours as written: you re-read every `[code-read]` finding yourself, and you post.

---

## Phase 1 — Scope (always)

Derive the repo and PR facts. **`$REPO` must be the base repo** (for a fork PR the reviews API targets the base, not the head fork):

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # base repo; never guess from `git remote`
ME=$(gh api user --jq .login)
gh pr view <PR> --repo "$REPO" --json number,title,state,headRefName,headRefOid,headRepositoryOwner,baseRefName,isCrossRepository,mergeable,mergeStateStatus,files
BASEREF=$(gh pr view <PR> --repo "$REPO" --json baseRefName -q .baseRefName)   # the branch the PR targets — usually main, but NOT always (release/stacked PRs)
export HEAD_OID=$(gh pr view <PR> --repo "$REPO" --json headRefOid -q .headRefOid)   # PR head sha — the Phase 5 review payload's commit_id
git fetch origin "$BASEREF" || { echo "fetch failed — BASE will be stale, abort"; exit 1; }   # stale base ref inflates the diff
gh pr checks <PR> --repo "$REPO"
```

**Idempotency probe — do not double-post.** Check whether *this skill* already reviewed the PR (its body carries the signature `<!-- pr-tri-review -->`):

```bash
gh api "repos/$REPO/pulls/<PR>/reviews" --jq ".[] | select(.user.login==\"$ME\") | select(.body|contains(\"<!-- pr-tri-review -->\")) | .id"
```

If this returns an id, a prior tri-review exists — **stop and ask the user** whether to skip, dismiss-and-replace, or post a fresh delta review. Do not silently append a second full set of inline comments.

Get the PR code locally (worktree keeps the current checkout clean; fork PRs resolve via the base-repo pull ref). **Idempotent setup** (a leftover worktree/branch from a prior run otherwise makes `worktree add`/`fetch` fail):

```bash
W=/workspace/.worktrees/pr-<PR>
git worktree remove "$W" --force 2>/dev/null; git branch -D pr-<PR> 2>/dev/null
git fetch origin pull/<PR>/head:pr-<PR>
git worktree add "$W" pr-<PR>
ln -s /workspace/gitnexus/node_modules "$W/gitnexus/node_modules"   # so tests/tsx run (see the worktree-node-modules memory)
```

**Artifact dir (persist every lane, like ce-code-review does).** Create one run dir up front; each lane writes its full output here as markdown so nothing is lost if this conversation is later compacted, and the synthesis agent rebuilds context by reading the dir from disk:

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
export ART=/tmp/pr-tri-review/<PR>/$RUN_ID
mkdir -p "$ART"
echo "artifacts: $ART"
```

Compute the **accurate** diff base, **sanity-check it**, and read the source yourself:

```bash
BASE=$(git -C "$W" merge-base HEAD "origin/$BASEREF")   # diff against the PR's ACTUAL base branch, not a hardcoded main
# Sanity guard: the merge-base file count must roughly match the PR's own file list. A sharp mismatch = wrong/stale base ref.
echo "diff files: $(git -C "$W" diff --name-only $BASE HEAD | wc -l) vs PR files: $(gh pr view <PR> --repo "$REPO" --json files -q '.files|length')"
git -C "$W" diff --stat $BASE HEAD
git -C "$W" diff $BASE HEAD -- <the source files>     # read the substance; skip giant golden/fixture blobs
git -C "$W" diff --check $BASE HEAD                   # whitespace/conflict hygiene
git -C "$W" grep -nP '[\x{202A}-\x{202E}\x{2066}-\x{2069}]' $(git -C "$W" diff --name-only $BASE HEAD)  # bidi controls
```

If the file counts diverge sharply, **don't dispatch yet** — an over-count usually means your local `origin/$BASEREF` is *behind* the base the PR branched from, so re-fetch `origin/$BASEREF` and recompute `BASE` first. (`git diff $BASE HEAD` from the merge-base equals the three-dot `git diff origin/$BASEREF...HEAD` GitHub uses, so once the ref is current the counts should align.) Only if they still diverge is the base genuinely wrong — confirm the PR's base branch. Every agent is given `BASE`, so a wrong base poisons the whole review.

**Prior-context recall (claude-mem).** Before dispatching, gather *cross-session* memory for the PR's surface — a different source from `gitnexus-pr-facts-historian` (which reads git/GitHub history): claude-mem holds what agents actually **did and learned** across past sessions — prior regressions in these files, decisions, known gotchas, "did we already solve this." Do this **once, on the Claude side** (the claude-mem MCP is reliably present here; a Codex `task` may not have it), then feed the distilled result to every lane and to the synthesis agent.

Query by the PR's actual surface — the changed file paths, the subsystem/area they sit in, the linked issue numbers, and the PR theme. Use the `mem-search` skill, or the claude-mem search tools directly (`mcp__plugin_claude-mem_mcp-search__smart_search` / `observation_search` / `memory_search`, and `timeline` for recent activity in the area). Distill the hits — don't dump raw observations — into a short briefing and persist it:

```
$ART/prior-context.md   # 5–15 bullets: prior bugs/regressions in these files, past decisions & their
                        # rationale, known gotchas, related PRs/issues, and any "we tried X, it failed because Y".
```

Keep it evidence-tagged (cite the observation/memory id or PR#) and **skeptical**: a recalled memory reflects what was true when written — flag anything that may be stale (a named file/flag that may have moved) rather than treating it as current fact. If recall returns nothing useful, write "no relevant prior context" and move on — this step is additive, never blocking.

---

## Phase 2 — Assemble the lanes

### Engine A — Claude (Swarm mode, parallel subagents)

**A1 — GitNexus PR swarm.** The swarm lanes from `pr-swarm-review/orchestration.md`, each its own `gitnexus-*` subagent: `gitnexus-pr-facts-historian`, `gitnexus-branch-hygiene-reviewer`, `gitnexus-risk-architect`, `gitnexus-test-ci-verifier`, `gitnexus-security-boundary-reviewer`, `gitnexus-docs-dod-reviewer`. (Lane 7, `gitnexus-synthesis-critic`, is **not** run here — it runs once on the unified digest in Phase 4.) Right-size: a focused 2-file PR can drop facts/docs/hygiene lanes; a risky multi-domain PR runs them all.

**A2 — ce-code-review personas.** The ce-code-review reviewer set, each its own `compound-engineering:ce-*` subagent. Always include the always-on core: `ce-correctness-reviewer`, `ce-testing-reviewer`, `ce-maintainability-reviewer`, `ce-project-standards-reviewer`. Then add ce-code-review's diff-selected conditionals:

| Diff signal | Add |
|---|---|
| Diff ≥50 changed non-test lines, or auth/payments/data-mutation/external-API | `compound-engineering:ce-adversarial-reviewer` |
| Auth, public endpoints, user input, permissions, secrets | `compound-engineering:ce-security-reviewer` |
| DB queries, data transforms, caching, async hot paths | `compound-engineering:ce-performance-reviewer` |
| Routes, serializers, exported type signatures, versioning | `compound-engineering:ce-api-contract-reviewer` |
| Error handling, retries, timeouts, background jobs | `compound-engineering:ce-reliability-reviewer` |

### Engine B — Codex on `--model "$CODEX_MODEL" --effort xhigh` (Solo mode, read-only)

Codex has both review skills installed (`$gitnexus-pr-review`, `ce-code-review`) and runs them **itself**, single-agent — the independent engine running the same scaffolding as A. Always include all three legs regardless of diff size:

- **B1 — GitNexus PR swarm (Solo mode).** Codex runs `$gitnexus-pr-review` adopting all 7 personas in dependency order (orchestration.md *Solo mode*).
- **B2 — ce-code-review (report-only).** Codex runs `ce-code-review mode:report-only`.
- **B3 — Codex adversarial-review.** The native `codex-companion adversarial-review` red-team pass (not a skill — a companion subcommand).

> **Naming, copied exactly.** Claude CE agents are `compound-engineering:ce-...`; Claude `gitnexus-*` agents are bare (no prefix). The Codex *skills* (`$gitnexus-pr-review`, `ce-code-review`) are invoked **by name inside Codex** — they are Codex's own copies, distinct from the Claude agents.

> **`codex-rescue` can't cover B.** The `codex:codex-rescue` agent is a thin forwarder limited to the companion's `task` command and is barred from `adversarial-review`. Phase 3 therefore drives all three Codex legs through `codex-companion.mjs` directly (which also lets you capture each leg's stdout straight to an artifact file).

Right-size: a focused 2-file PR can drop the swarm's facts/docs/hygiene lanes and lighter ce conditionals on **both** engines; core correctness/security/risk lanes and the B3 adversarial pass always run. **Tension with Phase 4's corroboration rule:** a domain covered by a single lane can't reach cross-engine agreement — the synthesis agent judges those on the verify-yourself gate (Phase 4, synthesis rule 3 + your 4.2 confirmation), not lane count.

---

## Phase 3 — Dispatch all lanes (read-only) and persist to disk

**Read-only contract.** Diagnosis only — **no edits, staging, commits, pushes, or builds; report findings.** Codex runs in a read-only sandbox; the Claude lanes carry the same instruction. Lanes run against a live worktree wired to real `node_modules`. Each lane's full output lands in `$ART` as markdown:
`claude-swarm-<lane>.md`, `claude-ce-<persona>.md`, `codex-swarm.md`, `codex-ce.md`, `codex-adversarial.md`.

**1. Launch Engine B (Codex) first — it's slowest — in the background.** Drive all three legs through the companion directly (resolve it once); each `--wait` call blocks until done, so run them with the Bash tool's `run_in_background` and let completion re-notify you. Run with `--cwd "$W"` so Codex sees PR-head code, and capture stdout to the artifact:

```bash
CC=$(ls /home/node/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs \
        /home/node/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)

CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"   # or gpt-6.1-sol; both take --effort xhigh

# Prompts go in files — `task` reads them via --prompt-file (the prompt is otherwise positional;
# --prompt is NOT a flag). Long multi-line prompts are far safer as files than as shell args.
# Inline the claude-mem briefing so Codex gets prior context too (its sandbox may not read /tmp).
PRIOR=$(cat "$ART/prior-context.md" 2>/dev/null || echo "no relevant prior context")
{ echo "PRIOR CONTEXT (cross-session memory — treat as possibly-stale leads, verify before trusting):"; echo "$PRIOR"; echo;
  echo "Run the \$gitnexus-pr-review skill on PR #<PR> in Solo mode per pr-swarm-review/orchestration.md."
  echo "Read-only: investigate and report only — never edit, commit, or post. Emit every lane's structured"
  echo "findings (file, line, severity P0–P3, confidence, evidence quote+file:line, suggested_fix)."
  echo "Skip your internal lane-7 critic — an external critic gates later."; } > "$ART/p-swarm.txt"
{ echo "PRIOR CONTEXT (cross-session memory — possibly stale, verify):"; echo "$PRIOR"; echo;
  echo "Run the ce-code-review skill with arguments: mode:report-only base:$BASE";
  echo "Strictly read-only. Return its structured findings verbatim."; } > "$ART/p-ce.txt"

# B1 — GitNexus swarm, Solo mode ($CODEX_MODEL / xhigh). `task` blocks in foreground (no --wait flag); no --write = read-only.
node "$CC" task --cwd "$W" --model "$CODEX_MODEL" --effort xhigh --prompt-file "$ART/p-swarm.txt" \
  > "$ART/codex-swarm.md" 2>&1; echo $? > "$ART/codex-swarm.exit"

# B2 — ce-code-review, report-only ($CODEX_MODEL / xhigh, read-only).
node "$CC" task --cwd "$W" --model "$CODEX_MODEL" --effort xhigh --prompt-file "$ART/p-ce.txt" \
  > "$ART/codex-ce.md" 2>&1; echo $? > "$ART/codex-ce.exit"

# B3 — native Codex adversarial-review ($CODEX_MODEL; --effort unsupported here, read-only by design). --wait IS valid here. Focus text is positional.
node "$CC" adversarial-review --wait --cwd "$W" --base "$BASE" --scope branch --model "$CODEX_MODEL" \
  "Red-team the PR's changed surface. Default to refuted unless you can construct a concrete trigger. Prior gotchas in this area to probe (verify, may be stale): $PRIOR" \
  > "$ART/codex-adversarial.md" 2>&1; echo $? > "$ART/codex-adversarial.exit"
```

> **Exit markers.** Each leg writes its exit code to `$ART/codex-<leg>.exit` the moment it ends (keep that `echo $?` directly after the leg's command, also when the legs run from one serial script). The marker is how anything outside this conversation — the side-panels Agents pane, a later session — tells a finished leg from a silent one; a leg with exit 0 and a near-empty artifact is the "Codex evaporated" case of rule 6.

> **Solo/report-only modes are the Codex-appropriate ones.** `$gitnexus-pr-review` Solo mode is one agent adopting all personas; `ce-code-review mode:report-only` is strictly read-only and returns findings without mutating. Do **not** use ce's `mode:headless` here — headless silently applies `safe_auto` fixes, which violates the read-only contract.
> **Resolution smoke-test (first run).** If you're unsure `$gitnexus-pr-review` / `ce-code-review` resolve in non-interactive `codex exec`, run one throwaway `task` that just prints each skill's lane/persona list. If a leg's artifact comes back as a "skill not found"/empty marker, treat that engine-leg as unavailable and say so in the digest (same handling as the Codex-empty case) — don't fabricate Codex findings.

**2. Dispatch Engine A (Claude) in parallel** (one message, multiple `Agent` calls — all A1 swarm lanes + all A2 ce personas). Just dispatch the `gitnexus-*` agents by `subagent_type` — **do not pass a persona path**; each self-loads its canonical persona (`pr-swarm-review/personas/…`). **Model:** the `gitnexus-*` agents pin their own model in frontmatter — do not set `model:` on them. CE agents are `model: inherit`; pass `model:"sonnet"` on the lighter lanes (maintainability, testing, performance, api-contract, reliability) and let correctness/adversarial/security inherit the session model (ce-code-review's own tiering rule).

Give every agent: the literal first line **`[independent-lane]`** (see *Side panels and the agent bus*), the PR id, the **worktree path**, the **sanity-checked `BASE` sha**, the source-diff summary, any **facts you already verified**, the **`$ART/prior-context.md` briefing** (the claude-mem recall — as possibly-stale leads to verify, not facts), and its **artifact path**. Require **structured findings**: `file`, `line` (anchored to the PR diff where possible), `severity` P0–P3, `confidence`, `evidence` (quote + file:line), `suggested_fix`. Ask adversarial/correctness to **default to refuted** unless they can construct a concrete trigger, and to say so when they find nothing.

**3. Persist each Claude lane.** Tell every CE persona (they carry a `Write` tool) to **write its full findings to `$ART/claude-ce-<persona>.md`** and return just a one-paragraph summary + that path — exactly how ce-code-review keeps detail on disk and context lean. The `gitnexus-*` swarm lanes have no `Write` tool: have them return their full findings and **you write each to `$ART/claude-swarm-<lane>.md`** on receipt. Either way, all five lanes' full text is on disk before Phase 4.

> Some `gitnexus-*` agents occasionally end mid-investigation (a partial thought, not findings). Re-dispatch a lane only if it produced nothing **and it is the sole lane covering its domain** — for a unique lane (e.g. security-boundary), an empty return means that issue class went unreviewed; cross-stream coverage does *not* fill a non-overlapping lane.

---

## Phase 4 — Claude synthesis (reads artifacts from disk) → coordinator verify → critic gate

Once all five lanes have written their files, **a dedicated Claude synthesis agent — not you — merges everything.** It reads the lane artifacts straight from `$ART`, so the merge runs in one fresh context rebuilt from disk; nothing depends on raw lane output still living in this conversation (which is exactly why each lane persisted its file).

**4.1 — Dispatch the synthesis agent.** Spawn one agent (`general-purpose`, session model; it needs Read/Grep/Bash to read `$ART` and check findings against the worktree). Hand it: the PR id, the worktree path, the `BASE` sha, and **the artifact dir `$ART`**. Tell it to read every `*.md` there — `claude-*` and `codex-*` are lane findings (labeled by engine via filename: `claude-*` = Claude, `codex-*` = Codex); **`prior-context.md` is context, not a finding** (the claude-mem recall) — use it only to flag when a finding is a *known recurring* regression (cite the memory/PR#) and to sanity-check, never as a finding on its own. Produce a **draft digest written to `$ART/digest-draft.md`** by applying these rules, staying read-only:

1. **Weight by cross-engine corroboration, not raw count.** Both engines ran the same swarm + ce scaffolding, so engine agreement is a clean same-prompt A/B:
   - **Strong:** a **Codex lane (B) and a Claude lane (A) independently reached it** (the genuine cross-engine signal — different engine, same review contract), **or** it was reproduced end-to-end. (Reproduction is often unavailable — worktrees can't `npm run build`; see Pitfalls — so don't rely on it.)
   - **Moderate:** only Claude lanes agree (A1+A2), or only Codex legs agree (B1/B2/B3) → "consistent within one engine," not independent confirmation. Same-engine convergence can be a *shared* false positive.
   - **Weak:** single lane.
2. **Severity overrides corroboration.** A **single-lane P0/P1** with a concrete trigger that was verified (rule 3 below) is postable — do **not** demote it to body-text just because one lane found it. This matters most for findings unique to one engine: the cross-engine miss is exactly where each engine's blind spots show. The "≥2 or reproduced" demotion applies **only to P2/P3**.
3. **Per-finding verification — operationalized.** For every finding marked postable, record: the concrete **trigger** (input/state/sequence), the **file:line evidence** confirmed in the worktree, and a tag — `[reproduced]` (executed) or `[code-read]` (re-read the code only). A non-empty trigger + evidence + tag is a **precondition for an inline comment**.
4. **Drop what the reviews refuted** — if an adversarial/correctness lane (either engine, including B3) probed a suspected issue and found no divergence, exclude it and say so in the body (validation is a feature).
5. **Dedup** by file+line+theme; keep the highest severity and record which lanes **and which engines** agreed.
6. **Per-leg liveness.** Check each Codex artifact (`codex-swarm.md`, `codex-ce.md`, `codex-adversarial.md`) holds real findings, not a "skill not found"/empty/error marker. The body must state which legs actually ran; if all of Engine B is empty, say "Codex unavailable — both-engine review degraded to Claude-only" and don't claim cross-engine corroboration anywhere.

**4.2 — Coordinator owns the result.** You post under the maintainer's identity, so the synthesis agent's draft is **input, not authority**. Read `$ART/digest-draft.md`; for every finding tagged `[code-read]` that you intend to inline, re-read the cited `file:line` yourself and confirm the trigger holds. Drop anything you can't stand behind. Re-reading and agreeing is the weakest confirmation — keep the honest tag.

**4.3 — Synthesis-critic gate (hard).** Dispatch `gitnexus-synthesis-critic` on `$ART/digest-draft.md` to check it is evidence-grounded, severity-prioritized, GitNexus-specific, and free of unverified claims; have it write its verdict to `$ART/critic.md`. **Do not post while its "required corrections" list is non-empty** — revise (re-dispatch the synthesis agent or fix `digest-draft.md` directly) and re-run. The critic is a *different* agent from the synthesis agent; never let one play both roles.

**Empty result:** if the vetted digest has no postable findings, post a short body — "Reviewed across N lanes (engines: …); no blocking issues found" — or, with user confirmation, skip posting. Never post an empty review.

**Huge PR:** if the diff is too large to read and verify in full, scope what was reviewed and **declare partial coverage in the body** — do not imply everything was verified.

---

## Phase 5 — Post one review (after the critic gate passes)

Re-check the Phase-1 idempotency probe. Then build a single review via the GitHub reviews API (one call posts body + all inline comments). Use **`event: "COMMENT"`** (collaborative — not `REQUEST_CHANGES`/`APPROVE` unless the user asks). **The body must start with the signature `<!-- pr-tri-review -->`** so future runs detect it. Construct the JSON in Python and post with `gh api … --input`:

```python
import json, os
DIGEST_BODY = open(os.path.join(os.environ["ART"], "digest-draft.md")).read()   # the critic-cleared digest, after your Phase-4 finalization
payload = {"commit_id": os.environ["HEAD_OID"],                  # captured + exported in Phase 1
           "event": "COMMENT", "body": "<!-- pr-tri-review -->\n" + DIGEST_BODY,
           "comments": [{"path": p, "line": n, "side": "RIGHT", "body": b}, ...]}   # p/n/b per verified finding
json.dump(payload, open("/tmp/pr-tri-review-payload.json", "w"))   # write the file --input reads
```

```bash
# Post, and CAPTURE the new review id for the confirmation step:
RID=$(gh api "repos/$REPO/pulls/<PR>/reviews" --method POST --input /tmp/pr-tri-review-payload.json --jq .id)
echo "posted review $RID"
```

Inline-comment rules:
- **Every inline comment requires the Phase-4 verification** (trigger + evidence + tag — synthesis rule 3, confirmed by you in 4.2) and is either Codex+Claude-corroborated or a coordinator-verified concrete trigger. Lower-confidence items go in the body, not inline. Under uncertainty, prefer body framing — an inline anchor reads as an assertion of fact.
- **Anchor only to lines present in the PR diff** (added/context lines, `side:"RIGHT"`). A finding in an **unchanged file** (e.g. an untouched caller that defeats new code) can't be inlined there — anchor on the nearest *in-diff* line and **reference** the real location in the body.
- Each comment: severity tag, one-line problem, evidence, fix, and the `[reproduced]`/`[code-read]` tag.

The digest **body** should: (1) state the **engine breakdown** — Claude ran swarm + ce; Codex (name the model, `xhigh`) ran swarm + ce + adversarial — and which Codex legs were actually live (per the 4.1 rule-6 liveness check); (2) **credit what's solid** (esp. correctness the reviews validated); (3) lead with the headline finding(s); (4) list inline findings briefly; (5) note lower-priority items, refuted suspicions, and test gaps; (6) include CI status; (7) note coverage limits if the PR was large; (8) close with a line that it's an automated multi-tool digest to verify before acting.

After posting, confirm the inline comments attached (using the captured `$RID`):
```bash
gh api "repos/$REPO/pulls/<PR>/comments" --jq ".[] | select(.pull_request_review_id==$RID) | \"\(.path):\(.line)\""
```

---

## Side panels and the agent bus (observe-only)

With the `side-panels` mod loaded (`/panels`), its **Agents** pane follows a run with no extra work from you: every Claude lane is a row (a click opens its transcript), every lane's final answer lands on the bus, and a **Review run** section reads `$ART` directly — `claude-*.md`, `codex-*.md`, `digest-draft.md`, `critic.md`, each with size and state. A running Codex leg shows its last `[codex]` status line; a finished one shows its exit marker, and "done, but nearly empty" is the liveness failure of rule 6. Keep those artifact names, directly under `$ART`, or the pane shows nothing.

The pane observes; it must never become a channel between lanes:

- **First line of every prompt this skill dispatches is `[independent-lane]`** — all A1/A2 lanes, the synthesis agent, the critic. With the agent board on (`/panels board on`), the mod appends other agents' results to each new worker's prompt; that line makes it skip the agent, whatever its type or description (CE personas dispatched as `general-purpose` are not recognizable otherwise). A lane that starts knowing another lane's finding returns it as corroboration — the seeded-fact failure, automated.
- **Codex legs never get the board.** Their prompts are the files you build; inline `prior-context.md` and the review context only, never bus or board content.
- **Do not forward one lane's finding to another** with the pane's message box or `SendMessage`. Message a running lane only to stop it or to correct its inputs (wrong base, wrong worktree).
- The bus and its claude-mem relay hold 300–600-character summaries. They are a progress view, **not** an input to synthesis: the synthesis agent reads `$ART`, nothing else.

Without the mod nothing here changes; the exit markers and the marker line are inert.

---

## Cleanup (always)

Remove the worktree and its branch so runs don't accumulate (this repo has leaked many `pr-*` worktrees). Drop the artifact dir only **after** a successful post (keep it on failure/critic-block — it's the evidence for the next attempt):

```bash
git worktree remove /workspace/.worktrees/pr-<PR> --force && git branch -D pr-<PR>
rm -rf "$ART"   # only after the review posted; on failure leave it for debugging
```

---

## Pitfalls (learned the hard way)

- **`$REPO` is the base repo** — `gh repo view --json nameWithOwner`, never guess from `git remote` (fork PRs have a `fork` remote that would 404 the reviews API).
- **Fetch the PR's actual base ref first** (`git fetch origin "$BASEREF"`, not a hardcoded `main` — release/stacked PRs differ), and sanity-check `BASE` by file count — a stale/wrong base turns a 5-file PR into a phantom diff and poisons every agent.
- **Both engines run the SAME swarm+ce scaffolding** — so the strong signal is a **Codex lane agreeing with a Claude lane** (different engine, same contract). Agreement *within* one engine (A1+A2, or B-legs together) is "consistent," not independent — it can be a shared false positive. State the engine breakdown in the body.
- **Don't demote a verified single-lane P0/P1** just because one lane found it — that's exactly where the other engine's blind spot was.
- **Codex (B1/B2) runs on `$CODEX_MODEL` / xhigh (`gpt-6-astra` by default, `gpt-6.1-sol` as the cheaper tier); B3 adversarial has no effort flag.** Drive all three Codex legs through `codex-companion.mjs` directly — `codex:codex-rescue` is a `task`-only forwarder and is **barred from `adversarial-review`**. `task` accepts `--model "$CODEX_MODEL" --effort xhigh`; `adversarial-review` accepts `--model` but **not** `--effort`. Run every leg `--cwd "$W"` (PR-head code) and read-only (no `--write`; `adversarial-review` is read-only by design).
- **Don't use `ce-code-review mode:headless` for the Codex ce leg** — headless silently applies `safe_auto` fixes (a write). Use `mode:report-only`, which is strictly read-only.
- **Codex can silently evaporate or fail to resolve a skill in `codex exec`** — check each `codex-*.md` artifact for real findings vs an empty/"skill not found" marker; if all of Engine B is empty, the body must say "Codex unavailable — degraded to Claude-only," and drop all cross-engine corroboration claims.
- **Persist every lane to `$ART` before synthesis** — CE personas self-write (they have `Write`); `gitnexus-*` swarm lanes have no `Write`, so the coordinator writes their returns. The synthesis agent reads `$ART` from disk, so a context compaction mid-run doesn't lose findings.
- **claude-mem recall is leads, not facts** — gather it once on the Claude side (the MCP may be absent in a Codex `task`), inline it into the Codex prompt files, and pass `prior-context.md` to every lane. A recalled memory reflects what was true when written: flag named files/flags that may have moved, verify before trusting, and never let `prior-context.md` become a standalone finding. It complements `gitnexus-pr-facts-historian` (git/GitHub history) with *session* history (what agents did/learned).
- **All dispatched lanes are read-only** — pass the diagnosis-only instruction explicitly (Codex sandbox read-only; CE agents carry `Write` and could mutate).
- **Three distinct agent roles** — lane reviewers, one synthesis agent (merges from disk), one `gitnexus-synthesis-critic` (gates). Don't let the coordinator hand-roll the digest, and don't let the synthesis agent grade its own work. The critic gate is hard — don't post while corrections remain.
- **The agent bus is a view, not a channel** — every dispatched prompt starts with `[independent-lane]`, Codex prompts carry no board content, and no lane is ever messaged another lane's finding; synthesis reads `$ART` only.
- **Run from Codex, Claude is the other leg** — C1/C2 and the critic go through headless `claude -p`, launched from the trusted main checkout (never `cd "$W"`: a headless session loads the worktree's settings and hooks unprompted), with `SIDE_PANELS_BOARD=off`, a pinned `--model`, and `--disallowedTools Edit Write NotebookEdit`. Smoke-test `claude -p` first; if it cannot run in the Codex sandbox, the review is Codex-only and says so.
- **A headless or plugin-equipped leg is not a clean lane by default** — `claude -p` legs run with `--settings '{"disableAllHooks":true}'` or they start with a claude-mem timeline and style modes injected; a Codex thread with the claude-mem plugin starts with session memory too. Recalled context is a lead, never a finding's evidence.
- **Idempotency** — check for a prior `<!-- pr-tri-review -->` review before posting; make worktree + artifact-dir setup idempotent.
- **Inline comments must land on diff lines** and clear the verify gate; non-diff / lower-confidence findings go in the body.
- **`COMMENT` event by default** — keep it high-signal; a wrong maintainer-signed comment does harm.
- Worktrees can't `npm run build` (symlinked deps) — agents validate via `tsx`/mocked tests, so "reproduced end-to-end" is often unavailable; lean on `[code-read]` honesty.
