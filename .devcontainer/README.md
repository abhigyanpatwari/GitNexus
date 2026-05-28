# GitNexus Devcontainer

A cross-platform Dev Container that pre-installs Claude Code, OpenAI Codex CLI, and Cursor CLI alongside the GitNexus native build chain. Supported hosts: **macOS, Linux, Windows 11 (native), and Windows 11 via WSL2.** Windows-native needs a **one-time `HOME` env var setup** — handled automatically by the `initializeCommand` on first run (see [Windows 11 setup](#windows-11-setup)).

## Quick start

1. Install [Docker Desktop](https://docs.docker.com/desktop/) (Windows/macOS) or Docker Engine (Linux).
2. Install [VS Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
3. Install [Node.js](https://nodejs.org/) on the **host** (Node 18+). This is the only host-side toolchain dependency beyond Docker and VS Code — the devcontainer's `initializeCommand` runs `node .devcontainer/ensure-host-config-dirs.cjs` to set up the bind-mount source directories before container create. If you already use Claude Code or another Node-based CLI on the host, you're already set.
4. Open the repo in VS Code → Command Palette → **Dev Containers: Reopen in Container**.
5. Wait for the first build (~3–6 minutes) and `postCreateCommand` to finish installing workspace dependencies.
6. Authenticate the three CLIs once — see [First-time CLI authentication](#first-time-cli-authentication) below.

## Windows 11 setup

### Windows-native (one-time setup, then "just works")

The host bind mounts use `${localEnv:HOME}/.claude` (and `.codex`, `.cursor`, `.ssh`, `.config/git`, `.config/gh`, `.gitconfig`). VS Code resolves `${localEnv:HOME}` by reading its own process env, and Windows doesn't set `HOME` by default — it uses `USERPROFILE`. So the bind mounts can't resolve until you tell Windows to also expose your profile as `HOME`.

The `initializeCommand` (`node .devcontainer/ensure-host-config-dirs.cjs`) handles this automatically:

1. **First time you Reopen in Container**, the script detects the missing `HOME`, runs `setx HOME "%USERPROFILE%"` (which writes to your user-level Windows env — no admin needed), prints a one-time setup banner, and exits.
2. **Close all VS Code windows** (File → Exit) and reopen. VS Code picks up the new `HOME` at startup.
3. **Reopen in Container again.** The script now sees `HOME=C:\Users\<you>`, skips the setup block, creates the bind-mount source dirs, and Docker brings the container up.

Subsequent rebuilds work normally with no extra steps. The `HOME` env var is set persistently in your Windows user environment, so it'll be there for every future VS Code session (and any other tool that wants `HOME`).

If you'd rather set it manually before opening the container:

```powershell
setx HOME "%USERPROFILE%"
# Close & reopen VS Code
```

### Known trade-offs of Windows-native vs WSL2

Windows-native works, but Docker Desktop's Windows bind-mount layer has rough edges that WSL2 avoids:

- **File watchers can miss events.** Vite / jest `--watch` running inside the container watching workspace files mounted from `D:\...` may miss changes — chokidar polling (`CHOKIDAR_USEPOLLING=true`) is the usual workaround.
- **`npm install` is 3-5× slower** through the Windows-to-Linux bind-mount translation than on a WSL2-native filesystem.
- **Permission edge cases.** The husky `.husky/_/h` EPERM class we hit earlier in this PR is specific to Windows-side bind mounts changing UID ownership between container runs. `post-create.sh` clears the cache defensively to keep this from being fatal, but it's still a real source of friction.

If you hit any of those and want to migrate to WSL2 later, the steps are below.

### WSL2 (faster, fewer edge cases)

To clone and open the repo inside WSL2:

```bash
# 1. Install WSL2 and a Linux distro if you haven't already.
wsl --install -d Ubuntu

# 2. Enter WSL.
wsl

# 3. Clone the repo inside your WSL2 home directory.
cd ~
git clone https://github.com/abhigyanpatwari/GitNexus.git
cd GitNexus

# 4. Launch VS Code from inside WSL — this opens VS Code attached to the WSL2
#    filesystem, so `${localEnv:HOME}` resolves to the WSL user's home and
#    subsequent "Reopen in Container" uses the WSL2-side path.
code .
```

Then run **Dev Containers: Reopen in Container**. The workspace will be bind-mounted from `\\wsl$\Ubuntu\home\<user>\GitNexus`, which is fast and gives reliable file-system events. **Make sure Docker Desktop's WSL integration is enabled** for your distro: Docker Desktop → Settings → Resources → WSL Integration → toggle on the distro you cloned into.

## macOS

Open the repo folder in VS Code → **Reopen in Container**. The image is multi-arch; on Apple Silicon you'll pull the `linux/arm64` variant automatically.

## Linux

Same as macOS — open in VS Code and reopen in container. `updateRemoteUserUID: true` (default) shifts the container's `node` user UID/GID to match your host user, so bind-mounted files stay writable without extra setup.

## How CLI state is shared with your host

### AI CLIs (Claude Code, Codex, Cursor): direct RW bind for shareable content + per-container credentials

The three AI CLIs use a **hybrid mount topology**: shareable subdirs/files (plugins, skills, agents, memory, commands, settings) are RW bind-mounted from host so reads AND writes go bidirectionally; credentials + identity stay in per-container named volumes so logging in/out in the container doesn't affect the host. Bind mounts at sub-paths override the named volume's content at those paths (Docker mount precedence — more specific path wins).

| Mount | Source | Target | Mode | Purpose |
|---|---|---|---|---|
| Container Claude config dir | _named volume_ `claude-config-${devcontainerId}` | `/home/node/.claude` | rw | Per-container credentials + identity |
| Container Codex config dir | _named volume_ `codex-config-${devcontainerId}` | `/home/node/.codex` | rw | Per-container credentials |
| Container Cursor config dir | _named volume_ `cursor-config-${devcontainerId}` | `/home/node/.cursor` | rw | Per-container credentials |
| Host Claude state, read-only stage | `$HOME/.claude` | `/host/.claude` | **read-only** | `post-create.sh` reads credentials + identity from here on container-create |
| Host Codex state, read-only stage | `$HOME/.codex` | `/host/.codex` | **read-only** | Same purpose for Codex |
| Host Cursor state, read-only stage | `$HOME/.cursor` | `/host/.cursor` | **read-only** | Same purpose for Cursor |
| **Claude shareable subdirs** (overlay on the volume) | `$HOME/.claude/{plugins/marketplaces,plugins/cache,skills,agents,memory,commands}` | same under `/home/node/.claude/` | rw | **Bidirectional** dir binds — install plugin on host or in container, both sides see it |
| **Codex shareable subdirs** | `$HOME/.codex/{plugins,prompts,memories,skills}` | same under `/home/node/.codex/` | rw | **Bidirectional** — whole `plugins/` dir bound (no path-bearing registry inside it) |
| **Cursor shareable subdirs** | `$HOME/.cursor/{plugins/marketplaces,plugins/local,rules,commands,agents,skills}` | same under `/home/node/.cursor/` | rw | **Bidirectional** — cursor-agent shares the Cursor 2.5 plugin/rules/commands surface |

**What gets shared bidirectionally (RW dir bind from host):**

- **Claude**: `plugins/marketplaces`, `plugins/cache`, `skills/`, `agents/`, `memory/`, `commands/`
- **Codex**: `plugins/` (whole dir — installed plugins land on host), `prompts/`, `memories/`, `skills/`
- **Cursor**: `plugins/marketplaces`, `plugins/local`, `rules/`, `commands/`, `agents/`, `skills/`

Install a plugin on the host or inside the container — both sides see it immediately. `/plugin marketplace add` from inside the container lands in your host `~/.<cli>/plugins/`, and `codex plugin add` / `cursor-agent` plugin installs write straight through to Windows. Save a memory from either side and it persists to the same host file.

**Single config files are copied on container-create, not bind-mounted** — on Docker Desktop Windows a single-file bind is 9p while the named volume is ext4, and atomic config writes (`tmp` → rename onto target) trip EXDEV (this is what caused Codex's `config/batchWrite failed in TUI`). So these are synced from host on rebuild and the container rewrites its own copy until the next rebuild: `settings.json` + `$HOME/.claude.json` (Claude), `config.toml` (Codex), `cli-config.json` + `mcp.json` (Cursor). `hooks.json` (Cursor) is deliberately **not** synced — Cursor hooks execute shell commands, so sharing them would widen the supply-chain attack surface; add it yourself if you want it.

**Plugin registry files with absolute paths are translated, not shared** — Claude's `known_marketplaces.json` / `installed_plugins.json` / `plugin-catalog-cache.json` and Cursor's `installed_plugins.json` bake in `C:\Users\…` (Windows) or `/Users/…` (macOS) install paths. `post-create.sh` rewrites those to `/home/node/.<cli>/plugins/…` and writes the result into the named volume, so plugins resolve inside Linux instead of failing with `cache-miss`. Codex needs no translation — its enablement registry is `config.toml` (git URLs + logical keys, no filesystem paths), which is why its whole `plugins/` dir can be bound directly.

**What stays per-container (in the named volume) and is synced from host on container-create:**

- `.credentials.json` (Claude OAuth tokens), `auth.json` (Codex), `cli-config.json` (Cursor) — credentials
- `~/.claude/.claude.json` (Claude's identity-only file: `userID`, `oauthAccount`, migration tracking) — kept per-container so logging in via container doesn't overwrite host's stored identity

`post-create.sh` runs on every container-create, copies host's credentials into the volume if present, then container manages refresh from there. Sync is "always overwrite if host has the file, otherwise leave container alone". So:

- Host has credentials → container starts logged in.
- Host has no credentials → `claude login` / `codex login --device-auth` / `cursor-agent login` inside container; credentials stay in the named volume across rebuilds (volume is keyed by `${devcontainerId}`, stable for the workspace path).
- `claude logout` inside container clears volume credentials only; host is untouched.

**Why CLAUDE_CONFIG_DIR is intentionally NOT set:** Claude's default `~/.claude` matches the named-volume mount target, so the env var added no behavior — but setting it changed which file Claude reads `hasCompletedOnboarding` from. With it set, Claude reads `$CLAUDE_CONFIG_DIR/.claude.json` (the small identity-only file) and re-onboards every container; without it, Claude reads `$HOME/.claude.json` (now bind-mounted from host, with `hasCompletedOnboarding: true`).

**Trade-off accepted: write-through to host CLI config.** A compromised npm package in the workspace dep tree, running inside the container, can write to `~/.claude/plugins/`, `~/.claude/agents/`, `~/.claude/memory/`, etc. on host. The next host Claude session would auto-load whatever it dropped. This is the explicit cost of the bidirectional RW bind. The alternative (read-only stage + symlinks) made `/plugin marketplace add` inside the container fail with EROFS — unacceptable. Credentials stay in the per-container named volume, so an attacker has to compromise the OAuth-bearing file specifically in container to get them; the volume isn't shared back to host.

**Refresh-token divergence between rebuilds.** Container's credentials match host's at container-create time; after that, container manages its own refresh until the next rebuild. Anthropic rotates refresh tokens on every use, so an unattended container that hasn't talked to the API in weeks can hit a silent 401 if the host has refreshed since. Re-run `claude login` inside the container, or rebuild, to recover.

### Other host bind mounts

| Container path | Host source | Mode | Why |
|---|---|---|---|
| `~/.config/git` | `$HOME/.config/git` | **read-only** | XDG-style git config / ignore / attributes |
| `~/.ssh` | `$HOME/.ssh` | **read-only** | SSH commit signing + git push over SSH |
| `~/.config/gh` | `$HOME/.config/gh` | read-write | `gh` CLI auth (PR create, issue create, checks) |
| `~/.docker` | `$HOME/.docker` | read-write | Container registry auth + buildx config (inert until you add Docker CLI via a Feature) |
| `~/.aws` | `$HOME/.aws` | **read-only** | AWS CLI / SDK credentials (forward-compat — empty by default) |
| `~/.azure` | `$HOME/.azure` | **read-only** | Azure CLI credentials (forward-compat — empty by default) |

`~/.gitconfig` is **not** bind-mounted — VS Code's Dev Containers extension auto-copies the host's gitconfig into the container at attach time (this is built-in behavior, not something this devcontainer configures). The bind-mount approach conflicts with that auto-copy mechanism, so we let VS Code own it. The end result is the same: your host's `user.name` / `user.email` are available inside the container.

If a host source dir doesn't exist when the container is first created, the `initializeCommand` (`node .devcontainer/ensure-host-config-dirs.cjs`) creates it empty — so the bind mount always has a valid source.

### Per-CLI quirks worth knowing

- **Claude Code on macOS** stores credentials in the system Keychain, not in `~/.claude/.credentials.json`. The sync silently no-ops; run `claude login` inside the container once and the named volume persists it.
- **Codex on macOS / Linux with `cli_auth_credentials_store = "keyring"`** stores auth in the OS keyring (Keychain / Secret Service), so `~/.codex/auth.json` may not exist on host. Same fallback: `codex login --device-auth` inside the container.
- **Cursor CLI inside containers** has [known upstream auth issues](https://forum.cursor.com/t/cursor-agent-authentication-issue-inside-docker/143995) — even with a correctly-synced `cli-config.json`, you may need to re-run `cursor-agent login` inside the container.
- **Stale named volumes from old rebuilds can carry forward.** If you delete and re-create the same workspace, or if a prior container left interim state with a different `userID`, deleting the named volumes before rebuild guarantees a clean sync: `docker volume rm claude-config-${devcontainerId} codex-config-${devcontainerId} cursor-config-${devcontainerId}` (look them up with `docker volume ls | grep -config-`).

### What you still don't have inside the container

These are commonly-needed CLIs that aren't installed by default — adding them would be follow-up work, not in this PR's scope:

- **Docker CLI** (for `docker push` / `docker build` from inside the container). Add via `ghcr.io/devcontainers/features/docker-outside-of-docker:1` to the `features` block — `~/.docker/` is already mounted so `docker login` state from your host will work immediately.
- **AWS CLI / Azure CLI / gcloud / kubectl** — same pattern: add the matching Feature, the host config dirs already flow through.
- **Private npm registry auth** (`~/.npmrc`) — you don't have a global one on this host. If you ever start using private packages, add `source=${localEnv:HOME}/.npmrc,target=/home/node/.npmrc,type=bind,readonly` to the mounts.

That means:

- **Authentication is shared.** If you're already logged in on the host (`claude login`, `codex login`, `cursor-agent login`, `gh auth login`), you're already logged in inside the container. No second login step.
- **Plugins, skills, agents, memory, and settings sync both ways.** Install a plugin from inside the container and it shows up on the host; add a custom agent on the host and the container sees it immediately. The auto-memory store at `~/.claude/projects/<workspace>/memory/` is the same file tree from both sides.
- **Git identity comes from the host.** Commits from inside the container use your host's `user.name` / `user.email` — VS Code's Dev Containers extension auto-copies your `~/.gitconfig` into the container at attach time. Any XDG-style config under `~/.config/git/` flows through via the read-only bind mount. To change git identity, edit `~/.gitconfig` on the host (container-side `git config --global` writes to a container-local file that's discarded on rebuild).
- **SSH keys flow through (read-only).** Push over SSH remotes and SSH commit signing work inside the container using your host keys. The mount is read-only so container code can't exfiltrate or modify private keys — agent-perspective, this means you get git operations but the keys stay vendor-side.
- **`gh` auth is shared.** `gh pr create`, `gh pr checks`, `gh issue create` work inside the container without re-authenticating.
- **No per-workspace duplication.** All your devcontainers across all your projects see the same host CLI state, just like all your host shells do.

The bind mount source directories are guaranteed to exist by the `initializeCommand` (`mkdir -p $HOME/.claude $HOME/.codex $HOME/.cursor $HOME/.config/gh`), which runs on the host shell before container create.

### Trust boundary, concretely

Host and container share a single trust boundary by design — fine for personal-dev, but the consequence is concrete. Any malicious npm package or `postinstall` script in the workspace dep tree, running inside the container, has direct **read** access to:

- **Host AI CLI state** at `/host/.claude`, `/host/.codex`, `/host/.cursor` (mounted read-only) — including `.credentials.json`, `auth.json`, `cli-config.json`, plugins, skills, agents, memory store
- The **container's own credential snapshots** at `/home/node/.claude/.credentials.json` etc. (copied from host on first run)
- `~/.claude/projects/<workspace>/memory/MEMORY.md` (which may contain user-stored secrets if you've used the `/remember` skill)
- Your **`gh` token** (`~/.config/gh`)
- Your **SSH private keys** (`~/.ssh/`)
- Docker registry tokens in **`~/.docker/config.json`** (if you've `docker login`-ed)
- AWS/Azure CLI credentials if you've populated `~/.aws/` or `~/.azure/`

What this design **does** prevent (vs. a full bidirectional bind mount): a malicious dep cannot **write back** to your host `~/.claude/plugins/`, `~/.claude/agents/`, or `~/.claude/skills/`. The read-only `/host` mount blocks the write. That matters because a host write-through would mean a single in-container compromise persists across container teardown — your next host Claude session would auto-load the malicious agent. Read-only mounts on `~/.ssh`, `~/.config/git`, `~/.aws`, `~/.azure` give the same one-way property for those credentials.

The egress firewall is deferred (see "What's not included (yet)" below) so a compromised package would still have unrestricted network to exfiltrate what it can read.

**If a workspace dep is ever found compromised**, rotate credentials at the vendor side — local file deletion is insufficient because tokens may have already left:

- Anthropic: [console.anthropic.com → Settings → Keys](https://console.anthropic.com/settings/keys), revoke the OAuth session under Account
- OpenAI / Codex: [platform.openai.com/api-keys](https://platform.openai.com/api-keys), revoke session under Profile
- Cursor: dashboard → Integrations, rotate API key + revoke CLI session
- GitHub: `gh auth refresh` or revoke the token at github.com/settings/tokens

For high-trust enterprise environments where host and container should NOT share credentials, swap the three CLI bind mounts (`~/.claude`, `~/.codex`, `~/.cursor`) in `.devcontainer/devcontainer.json` for `type=volume` named volumes (Anthropic's reference pattern). You give up host plugin/skill/memory sync in exchange for credential isolation per devcontainer.

## First-time CLI authentication

Each CLI works either way:

- **Log in on host first** → the container picks it up automatically on the next rebuild (`sync_from_host` copies the credential file into the named volume during `post-create.sh`). Host stays the source of truth.
- **Log in inside the container** → credentials write to the named volume. They persist across ordinary rebuilds (volume is keyed by `${devcontainerId}`, which is stable for a given workspace folder). The host's credentials are untouched.

You can mix and match per-CLI. A common setup is "Claude logged in on host, Codex/Cursor logged in inside container".

### Claude Code

```bash
claude login
```

Opens a browser auth flow. VS Code's port forwarding handles the OAuth callback automatically. After auth, `~/.claude/` is populated and visible from both host and container. The `DISABLE_AUTOUPDATER=1` env var prevents the in-container CLI from auto-updating — rebuild the container to pick up a newer Claude Code.

### OpenAI Codex CLI

```bash
codex login --device-auth
```

The device-code flow prints a URL and a one-time code. Visit the URL on your host browser, paste the code, and the CLI authenticates without needing a callback listener — this is the most reliable path inside containers. Credentials land in `~/.codex/auth.json` (shared with host).

`codex login` (browser-callback variant) also works but can be flaky in some headless contexts; prefer `--device-auth`.

### Cursor CLI

```bash
cursor-agent login
```

Opens a browser auth flow; VS Code's port forwarding handles the callback. Credentials persist in `~/.cursor/cli-config.json` (shared with host).

Verify any time with `cursor-agent status`.

## Alternative: API key authentication (CI / headless)

For non-interactive use (CI runners, automated scripts), all three CLIs accept API keys via env vars:

| CLI | Env var | Where to get the key |
|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` | <https://console.anthropic.com/settings/keys> |
| Codex | `OPENAI_API_KEY` | <https://platform.openai.com/api-keys> |
| Cursor | `CURSOR_API_KEY` | Cursor dashboard → Integrations |

These env vars are intentionally **not** injected into the container from the host. `${localEnv:VAR}` resolves an unset host variable to an empty string, and some CLIs (Cursor in particular) treat a set-but-empty key as "use this key" rather than "fall back to stored login" — which would silently break the login flow for everyone who hasn't pre-set the host var.

To use an API key inside the container, export it in your terminal session:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, or CURSOR_API_KEY
```

For persistence across container shells, carry the export via your VS Code [dotfiles repository](https://code.visualstudio.com/docs/devcontainers/containers#_personalizing-with-dotfile-repositories). VS Code clones the dotfiles repo into the container on attach and runs your install command, so the export lands in `~/.bashrc` / `~/.zshrc` per your own setup — and your API keys stay out of this repo's committed `devcontainer.json`.

A non-empty API key env var takes precedence over stored login credentials for each CLI.

## Port forwarding

| Port | Service | Notes |
|------|---------|-------|
| `5173` | Vite dev server (`gitnexus-web`) | Auto-forwarded with notification |
| `4747` | `gitnexus serve` HTTP API | **Must not be remapped** — `gitnexus-web` hardcodes `http://localhost:4747` as the default backend URL |
| `4173` | Static web (Vite preview) | Silently forwarded |

VS Code's Ports panel shows forwarded ports once their listener starts.

## Known gotchas

- **LadybugDB integration tests may fail in containers** (file-locking, `AGENTS.md` § Testing). Default to `npm run test:unit` inside the container; run integration tests on the host. Tracking issue: documented as a known limitation.
- **Single-writer LadybugDB constraint** (`GUARDRAILS.md` § LadybugDB lock). Don't run `gitnexus analyze` on the host and inside the container against the same `.gitnexus/` directory simultaneously — the second writer will get `database busy`.
- **Native grammar builds add ~30s to first install.** Tree-sitter Dart/Proto/Swift grammars build during `gitnexus`'s `postinstall`. To skip them (loses parsing for those three languages), set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` in your shell or add it to `remoteEnv` and rebuild.
- **`tree-sitter-kotlin` warnings on install** are expected (per `AGENTS.md`). Ignore them.
- **`.mcp.json` works inside the container**: `npx -y gitnexus@latest mcp` resolves cleanly because npm registry is reachable and the workspace bind mount exposes the same `.mcp.json` the host sees.
- **Husky pre-commit fires inside the container** without extra setup. The root `npm install` (run automatically in `postCreateCommand`) installs the hook via `package.json` `prepare`.

## Rebuild / reset

- **Rebuild Container** (Command Palette) — re-runs the Dockerfile build and `postCreateCommand` against the existing named volumes (auth + history persist).
- **Rebuild Container Without Cache** — fresh image layers, same volumes.
- **To clear a stale named volume** (e.g., force a re-login):
  ```bash
  docker volume ls | grep gitnexus   # find the per-devcontainer volume
  docker volume rm <volume-name>
  ```
  Then rebuild.

## Bumping CLI versions

Bump `CLAUDE_CODE_VERSION` and `CODEX_VERSION` in `.devcontainer/devcontainer.json` `build.args` and rebuild — both are real pins (Claude Code via `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, Codex via `npm install -g @openai/codex@${CODEX_VERSION}`). `CURSOR_VERSION` is informational only because Cursor's official installer (`cursor.com/install`) doesn't expose version pinning; rebuild to pick up whatever the installer serves. To stop Cursor from auto-updating in the running container, don't call `cursor-agent update`.

## What's not included (yet)

- **Egress firewall.** The original plan included an opt-in iptables/ipset firewall adapted from Anthropic's reference devcontainer. It was deferred to a follow-up PR — `runArgs` is static in `devcontainer.json`, so toggling NET_ADMIN/NET_RAW capabilities cleanly requires either a separate `devcontainer-firewall.json` profile or an `initializeCommand`-generated overlay. Track at the project's issue tracker if you need this.
- **Hard-pinned Cursor CLI.** Today the Dockerfile downloads `cursor.com/install` to a temp file, logs the sha256 to the build output (so drift across rebuilds is visible in CI logs), then executes — trust assumption: cursor.com's TLS chain is reliable. The full pin (download a specific `downloads.cursor.com/lab/<version>/<arch>/agent-cli-package.tar.gz` with a verified sha256, skip the install script entirely) is tracked as a follow-up because it requires per-arch handling and a SHA bump per Cursor release.
- **Codespaces tuning.** The current config works in Codespaces incidentally (no privileged capabilities, no host-mount assumptions), but isn't actively tested there.
- **Playwright e2e support.** `gitnexus-web`'s `npm run test:e2e` needs Chromium libs that the base image doesn't ship. Use the host for e2e until a Playwright layer is added.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `GitNexus devcontainer one-time Windows setup` banner from `initializeCommand` | First-time Windows-native Reopen-in-Container; `HOME` env var was missing | The script just ran `setx HOME "%USERPROFILE%"` for you. Close ALL VS Code windows (File → Exit) and reopen — see [Windows 11 setup](#windows-11-setup) |
| `bind source path does not exist: /.claude` (or similar) from Docker | Windows-native `HOME` env var is still missing even after one rebuild — `setx` may have failed or VS Code wasn't fully restarted | Run `setx HOME "%USERPROFILE%"` in a Windows shell manually, fully exit VS Code (check Task Manager that no `Code.exe` remains), reopen |
| `EACCES` / `EPERM` writing into `~/.claude`, `~/.codex`, or `~/.cursor` inside the container | Stale state from a previous container with a different effective UID | Move the affected dir aside and let the CLI rebuild it (`mv ~/.claude ~/.claude.bak` and log in again). Long-term: WSL2 setup, which doesn't hit this class of issue |
| `EPERM: operation not permitted, copyfile ... '.husky/_/h'` in `postCreateCommand` | Leftover `.husky/_/` from a previous container run on a Windows-side bind mount | `post-create.sh` already runs `rm -rf .husky/_` defensively. If you hit this on an older config, delete `.husky/_/` on the host and rebuild. Long-term: clone in WSL2 |
| Vite never hot-reloads | Repo cloned on Windows side, not WSL2 | Re-clone inside WSL2 |
| `gitnexus-web` can't reach the backend | `4747` was remapped or backend isn't running | Verify the Ports panel shows `4747` forwarded with no remap; start the backend with `cd gitnexus && npx gitnexus serve` |
| `npm install` fails on tree-sitter-swift / proto / dart | Native build toolchain missing | This shouldn't happen in the devcontainer — verify the apt layer installed `python3 make g++`. If iterating, set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` to skip the vendored grammars |
| Integration tests fail with `database busy` | LadybugDB single-writer constraint | Don't run host-side `gitnexus analyze` while the container is also analyzing the same repo; choose one writer |
| API key env vars not visible inside the container | They are intentionally not auto-propagated from the host (so an empty/stale host var can't silently break `*-login` for everyone else) | `export ANTHROPIC_API_KEY=...` / `OPENAI_API_KEY=...` / `CURSOR_API_KEY=...` inside the container shell, or carry it via your VS Code [dotfiles repo](https://code.visualstudio.com/docs/devcontainers/containers#_personalizing-with-dotfile-repositories) for persistence |
| `git commit` produces commits with empty author | `~/.gitconfig` is missing or empty on the host (VS Code's auto-copy had nothing to copy) | Set `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` from the host shell, then rebuild the container |
| `gh: not logged in` inside the container | `~/.config/gh/` source path missing on the host | Run `gh auth login` from the host shell (or inside the container once); the auth file lands in the shared mount |
