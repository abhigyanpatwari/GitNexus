# GitNexus Router And Indexing Note

Created: 2026-06-05
Repository: `C:\Users\steve\projects\gitnexus\source-rc109-integration`
Branch: `local/gitnexus-local-features`
Purpose: record what happened while trying to make this local GitNexus checkout available to GitNexus code-intelligence tooling.

Authority note: this note is subordinate historical evidence only. Stable status and task decisions live in `documentation.md` and `plans.md`; this file is not part of the four-file control surface and must not be treated as a live queue.

## Summary

While preparing to use GitNexus against the GitNexus source checkout, we discovered that `gitnexus` on this workstation is not a single direct executable. It is a router that chooses between a Podman-backed GitNexus environment and a host-installed GitNexus CLI.

Current conclusion:

- The router is observed workstation state, not upstream GitNexus behavior.
- Upstream Docker/Podman usage is explicit: run `gitnexus` inside the container with `podman compose exec` / `docker compose exec`, or use a clearly named helper such as `gitnexus-podman`.
- Future workflow should not teach agents to rely on hidden bare-`gitnexus` routing.
- The hidden router was quarantined on 2026-06-05; Podman is now explicit, and the host npm CLI was later aligned to `1.6.6-rc.109`.

The default router could not index or inspect this checkout because the checkout was not mapped into the Podman policy list. An explicit host route was possible, but the host-installed global CLI was older than the repo-local GitNexus version and did not finalize the index cleanly. The successful route was to use the repo-local rc.109 CLI directly:

```powershell
node gitnexus\dist\cli\index.js analyze --force --index-only --embeddings --name gitnexus-local-features
```

The repo-local index completed successfully with embeddings. On this Windows host, LadybugDB VECTOR indexing is unavailable, so semantic search uses exact-scan fallback over generated embeddings.

## Observed Historical Router State

At the time of this indexing pass, the normal command:

```powershell
gitnexus
```

routes through:

```text
C:\Users\steve\.local\bin\gitnexus.py
```

Before quarantine, the router supported at least these relevant diagnostic and origin-selection flags:

```powershell
gitnexus --gitnexus-router-diagnostics <command>
gitnexus --gitnexus-router-origin host <command>
gitnexus --gitnexus-router-origin podman <command>
```

Host-side wrappers:

```text
C:\Users\steve\.local\bin\gitnexus-host.py
C:\Users\steve\.local\bin\gitnexus-host.cmd
C:\Users\steve\AppData\Roaming\npm\gitnexus.cmd
```

Podman-side wrappers:

```text
C:\Users\steve\.local\bin\gitnexus-podman.py
C:\Users\steve\.local\bin\gitnexus-podman.cmd
```

The running Podman service observed during this work:

```text
Container: gitnexus-server
Image: localhost/gitnexus:rc109-missingshadow-fix5-20260603
Port: 127.0.0.1:4747->4747/tcp
```

This section is evidence, not future guidance. Once the hidden router is disabled, these flags should disappear from normal workflow and remain only as historical/rollback references.

## 2026-06-05 Router Quarantine

The hidden bare-`gitnexus` router was quarantined on 2026-06-05 as interim pre-main cleanup before local-feature implementation resumes.

Files renamed:

```text
C:\Users\steve\.local\bin\gitnexus.cmd -> C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.cmd
C:\Users\steve\.local\bin\gitnexus.py  -> C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.py
```

Files intentionally preserved:

```text
C:\Users\steve\.local\bin\gitnexus-podman.cmd
C:\Users\steve\.local\bin\gitnexus-podman.py
C:\Users\steve\.local\bin\gitnexus-host.cmd
C:\Users\steve\.local\bin\gitnexus-host.py
```

Immediate post-quarantine observations before host CLI alignment:

```text
Get-Command gitnexus -All no longer resolves first to C:\Users\steve\.local\bin\gitnexus.cmd.
gitnexus --version reports 1.6.6-rc.53 through the host/npm shim.
Historical pre-quarantine check: gitnexus-host --version reported 1.6.6-rc.53.
gitnexus-podman --version reports 1.6.6-rc.109.
gitnexus-podman list sees deepwiki-open and Prometheus.
http://127.0.0.1:4747/api/health returns { "status": "ok" }.
```

Later on 2026-06-05, the host/npm CLI was aligned to the pinned rc.109 line:

```text
gitnexus --version reports 1.6.6-rc.109.
Historical pre-quarantine check: gitnexus-host --version reported 1.6.6-rc.109 before the redundant helper was quarantined.
gitnexus-podman --version reports 1.6.6-rc.109.
```

Current rule:

- Use `gitnexus-podman` for the explicit Podman-backed rc.109 runtime.
- Use bare `gitnexus` for the host/npm CLI, now aligned to `1.6.6-rc.109`.
- `gitnexus-host` was quarantined on 2026-06-05 as a redundant compatibility helper; do not use it in new workflow.
- Treat bare `gitnexus` as the host/npm CLI. It is version-aligned after the 2026-06-05 update, but it is not the same route as `gitnexus-podman`.
- Do not restore the hidden router as a convenience path for normal work.

## 2026-06-05 Podman Embedding Route Check

The Podman route does have a llama.cpp embedding server configured and running.

Observed container:

```text
Name: llama-cpp-gitnexus-embeddings
Image: ghcr.io/ggml-org/llama.cpp:server-cuda
Status: running and healthy
Network alias: gitnexus-embed
Command: --host 0.0.0.0 --port 8080 --embeddings --model /models/snowflake-arctic-embed-l-v2.0-f16.gguf --alias snowflake-arctic-embed-l-v2.0 --pooling cls --ctx-size 8192 --batch-size 2048 --ubatch-size 2048 --parallel 1 --n-gpu-layers all
```

Observed `gitnexus-server` embedding environment:

```text
GITNEXUS_EMBEDDING_URL=http://gitnexus-embed:8080/v1
GITNEXUS_EMBEDDING_MODEL=snowflake-arctic-embed-l-v2.0
GITNEXUS_EMBEDDING_DIMS=1024
GITNEXUS_EMBEDDING_API_KEY=unused
```

Smoke check from inside `gitnexus-server`:

```text
POST http://gitnexus-embed:8080/v1/embeddings
status: 200
model: snowflake-arctic-embed-l-v2.0
dims: 1024
```

Important routing distinction:

- `gitnexus-podman` / `gitnexus-server` is wired to the Podman llama.cpp embedding server.
- Host/npm `gitnexus` is not automatically wired to that container through the current PowerShell environment. Host checks showed no `GITNEXUS_EMBEDDING_URL`, `GITNEXUS_EMBEDDING_MODEL`, or `GITNEXUS_EMBEDDING_DIMS`; only `OLLAMA_BASE_URL=http://localhost:11434` was present.
- The llama.cpp container currently has no host-published port in `podman port`; it is reachable on the Podman network as `gitnexus-embed:8080` from `gitnexus-server`.
- Therefore, host CLI embedding behavior and Podman runtime embedding behavior should not be treated as equivalent unless the host route is explicitly configured.

GitHub/source evidence checked:

- Upstream PR `abhigyanpatwari/GitNexus#395` introduced the generic HTTP embedding backend for OpenAI-compatible `/v1/embeddings` endpoints. It documents `GITNEXUS_EMBEDDING_URL`, `GITNEXUS_EMBEDDING_MODEL`, optional `GITNEXUS_EMBEDDING_DIMS`, and optional `GITNEXUS_EMBEDDING_API_KEY`; it explicitly names llama.cpp as a supported self-hosted endpoint class.
- Upstream issue `#695` asks for Ollama/external embeddings and remains open/backlog as of 2026-05-16. For this workstation, do not wait for a special Ollama-only implementation; use the existing generic HTTP embedding backend.
- Upstream PR `#1055` / issue `#1047` changed the embedding preservation rule: plain analyze should preserve existing embeddings by default; use `--embeddings` to generate vectors for new/changed nodes, and `--drop-embeddings` only for an intentional wipe/model swap.
- Upstream issue `#1365` records the Windows VECTOR-unavailable/exact-scan behavior. Exact-scan fallback is expected when embeddings exist but LadybugDB VECTOR is unavailable on this platform.
- The local Podman compose file at `C:\Users\steve\podman\gitnexus\compose.yaml` already gives `gitnexus-server` the HTTP embedding env vars. It does not publish `gitnexus-embed:8080` to a Windows host port.

Practical implication:

- The default workstation route for Podman-managed repos is container-side indexing: run `gitnexus` inside `gitnexus-server`, or use the explicit `gitnexus-podman` helper against `/workspace/<repo>`.
- Steve's local Podman profile extends upstream Docker with an internal llama.cpp sidecar. That sidecar is intentionally container-network-only at `http://gitnexus-embed:8080/v1`.
- Host/npm `gitnexus` is a separate Windows route. It should not be assumed to use the Podman llama.cpp sidecar, and host PowerShell/User `GITNEXUS_EMBEDDING_*` variables are not part of the default route.
- Host-to-Podman llama.cpp parity is an explicit opt-in only. It would require deliberately publishing the sidecar to `127.0.0.1:<port>` and setting matching host `GITNEXUS_EMBEDDING_*` variables.
- Verification on 2026-06-05 confirmed `podman port llama-cpp-gitnexus-embeddings` has no host mapping, `gitnexus-server` can resolve the Snowflake model through `gitnexus-embed`, and the current host environment has no `GITNEXUS_EMBEDDING_*` variables.

## Podman Policy State

The Podman wrapper policy only listed these mapped repositories:

```text
C:\Users\steve\projects\Prometheus        -> /workspace/Prometheus
C:\Users\steve\projects\codex-lab         -> /workspace/codex-lab
C:\Users\steve\projects\deepwiki-open     -> /workspace/deepwiki-open
```

This GitNexus checkout was not mapped:

```text
C:\Users\steve\projects\gitnexus\source-rc109-integration
```

As a result, the router refused repo-scoped operations such as `status` and `analyze` for this checkout under the default/Podman route.

Representative refusal from router diagnostics:

```text
repo inspection requires cwd/path to be mounted in the GitNexus Podman container
```

Representative refusal from analyze:

```text
repo index mutation requires a mapped repo with an isolated Podman-owned .gitnexus
```

For plain analyze, the router also protects against accidental repo writes unless the repo is both mapped and policy-approved:

```text
plain analyze requires a mapped repo with an isolated Podman-owned .gitnexus
```

## Attempted Routes

### 1. Default Router / Podman Route

Command shape:

```powershell
gitnexus analyze --index-only --embeddings --name gitnexus-local-features
```

Outcome:

- Refused before indexing.
- Reason: this checkout was not mapped in the Podman wrapper policy.
- No source files were changed.

The important distinction is that the refusal was not about embeddings. The refusal was about repo mapping and isolated index ownership.

### 2. Explicit Host Route

Command shape:

```powershell
gitnexus --gitnexus-router-origin host analyze --index-only --embeddings --name gitnexus-local-features
```

Outcome:

- The command ran for roughly 15 minutes and timed out from the Codex tool call.
- A `.gitnexus` database was created and grew, but the host `status` command still reported `Repository not indexed`.
- The global host CLI reported GitNexus `1.6.6-rc.53`, older than the repo-local codebase.

Evidence:

```powershell
gitnexus --gitnexus-router-origin host --version
```

reported:

```text
1.6.6-rc.53
```

This mismatch made the host route a poor source of truth for this rc.109 checkout.

### 3. Repo-Local CLI Route

Command shape:

```powershell
node gitnexus\dist\cli\index.js analyze --force --index-only --embeddings --name gitnexus-local-features
```

Outcome:

- Successful.
- Used the repo-local GitNexus CLI, version `1.6.6-rc.109`.
- Rebuilt the ignored `.gitnexus` index in the checkout.
- Generated embeddings.
- Did not mutate tracked source files.

Successful completion output:

```text
Repository indexed successfully (1344.4s)

32,221 nodes | 51,510 edges | 1186 clusters | 300 flows
C:\Users\steve\projects\gitnexus\source-rc109-integration
```

Final repo-local status:

```text
Repository: C:\Users\steve\projects\gitnexus\source-rc109-integration
Indexed: 05/06/2026, 09:13:25
Indexed commit: b5ce5ab
Current commit: b5ce5ab
Status: up-to-date
```

## Embeddings And VECTOR Caveat

Embeddings were generated, but the Windows host reported that the LadybugDB VECTOR extension is unavailable.

Observed warning:

```text
VECTOR extension unavailable; semantic embeddings fall back to exact scan.
```

The successful analyzer output also stated:

```text
Semantic embeddings were generated without a VECTOR index; queries will use exact-scan fallback within the configured limit.
```

Practical meaning:

- Embedding data exists.
- Semantic search can still use exact-scan fallback.
- This is not the same as having a VECTOR index.
- For very large semantic workloads, exact-scan behavior may be slower or bounded by the configured exact-scan limit.

## Current Index Artifacts

The successful repo-local index lives under:

```text
C:\Users\steve\projects\gitnexus\source-rc109-integration\.gitnexus
```

Important files observed:

```text
.gitnexus\lbug
.gitnexus\meta.json
.gitnexus\parse-cache
.gitnexus\analyze-rc109-stdout.log
.gitnexus\analyze-rc109-stderr.log
```

The `.gitnexus` directory is ignored by the repository `.gitignore`, so the local index is runtime/index state rather than source state.

## MCP Visibility Caveat

The currently available GitNexus MCP server initially listed only Podman-visible indexed repositories:

```text
deepwiki-open
Prometheus
```

That means the successful repo-local host index does not automatically imply that the already-running Podman MCP server can see this checkout. If an agent wants GitNexus MCP tools to target this checkout, one of these must be true:

- the MCP server must be launched from or configured for the repo-local host index, or
- the Podman routing policy must be updated so this checkout is mounted and indexed inside the Podman GitNexus environment.

Do not assume that a host-local `.gitnexus` index is visible to the existing Podman MCP server.

## Lessons For Future Agents

1. Treat the hidden bare-`gitnexus` router as historical workstation drift.

   Do not design new workflows around:

   ```powershell
   gitnexus --gitnexus-router-diagnostics status
   gitnexus --gitnexus-router-origin host --version
   ```

   Those commands are pre-quarantine evidence only. They work again only after the disabled router files are restored for rollback/forensics.

2. Expected Docker/Podman behavior is explicit container execution.

   Use command shapes like:

   ```powershell
   podman compose exec gitnexus-server gitnexus analyze /workspace/<repo> --embeddings
   gitnexus-podman analyze /workspace/<repo> --embeddings
   ```

   Do not expect Docker/Podman to install a host-side auto-router.

3. Expected host CLI behavior is normal upstream/npm `gitnexus`.

   Before making bare `gitnexus` authoritative again, align the host npm CLI version with the intended GitNexus version or make bare `gitnexus` refuse with clear guidance.

4. The repo-local Node CLI route was an emergency/source-aligned workaround for this indexing pass.

   It is valid when intentionally testing the current checkout's built `dist`, but it should not be the standing workstation workflow:

   ```powershell
   node gitnexus\dist\cli\index.js analyze --force --index-only --embeddings --name gitnexus-local-features
   ```

5. Use `--index-only` when the intent is code-intelligence indexing only. This avoids AGENTS/CLAUDE/skill injection and keeps repo-tracked files stable.

6. Use embeddings when semantic search is desired, but remember that this Windows host may use exact-scan fallback rather than a VECTOR index.

7. Verify completion with the same explicit route that created the index.

8. Treat router failures as environment topology evidence, not GitNexus source/product failures.

## Recommended Future Workflow For This Checkout

After the hidden router is disabled, use one of these explicit routes.

### Host CLI Route

```powershell
cd C:\Users\steve\projects\gitnexus\source-rc109-integration
gitnexus status
```

If stale:

```powershell
gitnexus analyze --index-only --embeddings --name gitnexus-local-features
```

Use this only after verifying the host npm CLI is the intended version. Bare `gitnexus` is now the recommended host/npm route; the previous `gitnexus-host` helper is quarantined historical evidence only.

### Explicit Podman Route

Use this only when the checkout is mounted into the GitNexus Podman runtime:

```powershell
podman compose -f C:\Users\steve\podman\gitnexus\compose.yaml exec gitnexus-server gitnexus analyze /workspace/<repo> --embeddings
```

or a documented explicit helper:

```powershell
gitnexus-podman analyze /workspace/<repo> --embeddings
```

### Repo-Local CLI Route

Use this for source-aligned one-off indexing of this checkout's built CLI:

```powershell
node gitnexus\dist\cli\index.js status
node gitnexus\dist\cli\index.js analyze --index-only --embeddings --name gitnexus-local-features
```

If a full rebuild is needed, add `--force`.

If MCP needs to see the same repo, first confirm which MCP server is active and whether it is host-local or Podman-backed. Do not assume visibility across those boundaries.

Do not reintroduce the hidden bare-`gitnexus` router to solve MCP visibility. Mount/index the repo in the intended runtime or launch the intended MCP server explicitly.

## Verification Commands Used

```powershell
node gitnexus\dist\cli\index.js --version
node gitnexus\dist\cli\index.js status
gitnexus --version
gitnexus --gitnexus-router-diagnostics status
gitnexus --gitnexus-router-origin host --version
gitnexus --gitnexus-router-origin host doctor
git status --short --branch
Get-Content .gitnexus\analyze-rc109-stdout.log -Tail 40
Get-Content .gitnexus\analyze-rc109-stderr.log -Tail 40
```

These are historical verification commands from the original indexing pass. Router-specific commands in this block are invalid in the current post-quarantine state unless the disabled router is restored first. After router removal, replace router-specific commands with explicit host/Podman checks:

```powershell
Get-Command gitnexus -All
gitnexus --version
gitnexus-podman --version
gitnexus-podman list
```

Observed final working-tree state:

```text
## local/gitnexus-local-features
?? .agent/long-horizon/gitnexus-local-features/enterprise-feature-intended-functions-scratchpad.md
```

After this note is added, this note itself is also expected to appear as an untracked planning/documentation artifact until committed.
