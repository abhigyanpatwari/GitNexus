# GitNexus Devcontainer

A cross-platform Dev Container with Claude Code, OpenAI Codex CLI, Cursor CLI, Bun, and the native build chain. Every declared mount uses **Linux Docker volumes**. Windows bind mounts, `/workspace-host`, `SYS_ADMIN`, and automatic 9P tuning have been removed.

## Quick start

1. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux), VS Code, and the Dev Containers extension.
2. Put **Node.js 18+**, **Docker CLI**, and **tar** on the host PATH. Windows 11 includes `tar.exe`; macOS and typical Linux installations include tar.
3. Open the repository in VS Code and select **Dev Containers: Reopen in Container**.
4. The host initializer imports the checkout and selected configuration into native volumes once. Dependency installation and CLI setup follow.
5. Work in `/workspace` through the attached VS Code window. The host checkout is no longer synchronized.

Before rebuilding an existing container, follow [Source volume migration](#source-volume-migration).

## Host platforms

On Windows, the original checkout can remain at `D:\\development\\coding\\GitNexus`. The initializer uses `os.homedir()`; setting `HOME` with `setx` is no longer required. Windows tools opening that folder see the original copy, not subsequent container edits.

On WSL2, open the original folder through VS Code's WSL extension with Docker Desktop integration enabled. On macOS or Linux, open the original folder normally. All use the Docker-volume model. Linux hosts retain `updateRemoteUserUID: true`; setup repairs source ownership before dependency installation, including restrictive directories left by an older UID. A root host user keeps `node` at UID 1000, matching the Dev Containers CLI, which skips realignment for UID 0.

Keep the host folder and selected configuration path stable: moving either can change `${devcontainerId}` and select different volumes.

## Source volume migration

The default workspace is `gitnexus-source-${devcontainerId}:/workspace`. The host `initializeCommand` runs `initialize-volumes.cjs`, starts a disposable helper with volume mounts only, and streams a tar archive through [Docker's copy API](https://docs.docker.com/reference/cli/docker/container/cp/) into the staging volume `gitnexus-seed-${devcontainerId}`. The helper uses the Dockerfile's digest-pinned base image and mounts the source volume read-only. It is removed afterward; volumes and host files remain.

`initializeCommand` also runs whenever an existing container is reopened, so the host only stages. `onCreateCommand`, which runs once per container creation, commits the stage into the empty source volume, normalizes Git, writes the completion marker, empties the stage, and repairs ownership. Reopening a pre-volume container after pulling this change only refreshes the stage, so the eventual rebuild imports current work. The commit only accepts a stage whose completion marker was written after the copy finished. `initializeCommand` copies the host's `seed-workspace.cjs` into the seed volume on every start and `onCreateCommand` runs that copy, so it always matches `devcontainer.json` and works with prebuilt or custom images.

Staging and snapshot retakes are best-effort. If a host process writes a file while it is streamed, initialization warns, clears that copy and continues, so reopening an existing container never fails; the next start retries. Container creation without a complete stage stops at `onCreateCommand` with `No complete staged checkout`.

The workspace volume is declared in `mounts`, with `workspaceMount` set to an empty string to disable the automatic host mount. This lets the Dev Containers CLI substitute `${devcontainerId}` before starting Docker; affected CLI versions leave it literal when the volume is declared in `workspaceMount`. Default and generated profiles retain their existing volume names, so this placement does not trigger another source import.

The import preserves `.git`, branches, local commits, the index, stashes, uncommitted and ignored files, checkout-local indexes, and nested worktrees. Generated `node_modules`, `.venv`, `.husky/_`, `.gitnexus/parse-cache`, `.gitnexus/parse-cache.json`, and `.gitnexus/parsedfile-cache` paths are excluded at every depth, including under `.worktrees` and `.claude/worktrees`. GitNexus graph databases, embeddings, metadata, and runners are kept; parser caches regenerate on the next analysis. Git metadata is preserved except for source-volume completion markers. Reinstall dependencies inside each worktree as needed, and recreate Python environments with the evaluation project's `uv run` commands. Host files are left intact. Existing dependency, index-store, AI configuration, history, and session volume names stay unchanged.

During archive transfers, `[volumes]` reports elapsed time, entries queued, excluded paths, symlinks, and MiB streamed to Docker every five seconds, followed by a completion or failure line. Streamed bytes measure data sent to Docker, not bytes committed to disk; there is no percentage because the total is not pre-scanned. Helper startup, snapshot finalization, and cleanup also report activity every five seconds; the commit into the source volume logs to the container creation output. Output from the Linux helper is shown as it arrives.

Node writes the tar stream itself (ustar with PAX records for long and UTF-8 names), so the host needs no `tar`. Windows `tar.exe` reads file lists in the ANSI code page and macOS `tar` adds AppleDouble `._*` files; neither applies. Sockets and FIFOs are skipped. Selected snapshot roots such as `~/.config/gh` or `~/.claude.json` are followed when they link to an existing target, matching the bind mounts they replace. Every other symlink is transferred as path/target metadata and recreated by the Linux helper without following it. This also applies to configuration snapshots, so WSL-created links are never opened as files. Restoration rejects paths outside the destination, symlinked parent directories, and replacements of existing files. Ordinary source links and their targets are preserved verbatim.

`initialize-volumes.test.cjs` covers this host-side importer on Linux, macOS and Windows CI. It replaces the Docker CLI with a Node adapter through `GITNEXUS_IMPORT_DOCKER`. Tests of code that runs only inside the Linux dev container or import helper skip on other hosts.

The importer probes the destination filesystem and updates `core.ignorecase`, `core.filemode`, and `core.symlinks`, including worktree overrides. Where Windows disabled mode tracking, tracked executable bits are restored from the index. Unedited tracked symlink placeholders become symlinks; edited placeholders retain their bytes. Staged and unstaged contents are preserved. Absolute `core.worktree` overrides are removed from the copied root configuration and from each relinked nested worktree's `config.worktree`. The host Git configuration is untouched.

Before the first rebuild:

1. Save files and stop agents, Git operations, indexers, dev servers, and host claude-mem writers. The copy requires a quiet source; it is not a live filesystem snapshot. A file whose size or modification time changes while it is streamed discards that stage or snapshot without writing a completion marker.
2. Preserve worktrees and other files outside `/workspace` and existing named volumes. From a **host terminal**, save the current container's writable layer:

   ```powershell
   docker commit <current-container-id> gitnexus-before-source-volume
   ```

   Wait for success before rebuilding. [Docker commit](https://docs.docker.com/reference/cli/docker/container/commit/) excludes mounted volumes, so retain those volumes and the Windows checkout too. This local recovery image can contain private configuration; keep it private.
3. Keep opening the same host folder and `.devcontainer/devcontainer.json`, then run **Dev Containers: Rebuild Container**. Allow disk space for the source volume and the staged copy, plus configuration snapshots. The stage is emptied once the container commits it.
4. Verify inside the rebuilt container:

   ```bash
   findmnt -T /workspace -o TARGET,SOURCE,FSTYPE
   findmnt -rn -t 9p
   git status --short
   git log -1 --oneline
   git config --get core.ignorecase
   git config --get core.filemode
   git config --get core.symlinks
   ```

   Docker Desktop with WSL2 should report `ext4` for `/workspace`; the 9P query should print nothing. The Git flags should be `false`, `true`, and `true`. Confirm your branch and local edits. From the host, `docker inspect <new-container-id> --format '{{json .Mounts}}'` shows actual mounts, including any your editor adds.

After import, `.git/devcontainer-source-volume` prevents later initialization from replacing container work. The destination is checked before reading the host checkout. A partial, unmarked source volume fails closed without merging or deleting files. Inspect and back up that volume before removing only that failed volume and retrying. Never add or delete a completion marker to force migration.

Lifecycle hooks run from the branch checked out in `/workspace`, while `devcontainer.json` comes from the host folder. Rebuild from a branch that contains this volume setup; an older branch lacks `seed-workspace.cjs`, so `onCreateCommand` fails until you check out a current branch.

The importer requires a full checkout with its own object database. Linked-worktree roots, external object alternates, active Git locks, symlinked configuration, and absolute `.git/commondir` paths are rejected; `commondir` containing `.` is supported.

Nested worktrees are relinked to their copied paths, including registrations created on Windows or another host path. Worktrees outside the checkout are not copied or rewritten. Copying a registration does not save its files. Recover an external worktree from the backup image with:

```powershell
docker create --name gitnexus-source-recovery gitnexus-before-source-volume
docker cp gitnexus-source-recovery:/absolute/worktree/path ./recovered-worktree
```

Restore its original container path or repair its Git registration before using it. Store future worktrees under `/workspace/.worktrees` to retain them across container recreation.

Use Git to share committed changes or `docker cp` to export files. **VS Code still reads build configuration from the host `.devcontainer` directory**: export intentional changes there back to the host before rebuilding. Keep the original checkout and recovery image until migration is verified. Back up volume-only work before Docker volume cleanup.

This follows [VS Code's guidance to keep source in Linux-native storage](https://code.visualstudio.com/remote/advancedcontainers/improve-performance).

## Workspace and image profiles

The main configuration seeds your existing host checkout into a source volume. Additional profiles are generated from it, using host Node.js with no npm installation required:

```bash
# Clone a remote branch into a separate native filesystem volume.
node .devcontainer/profile.cjs native --ref main

# Host-seeded source volume with Chromium dependencies and browser cache.
node .devcontainer/profile.cjs ui

# Combine the native workspace and UI support.
node .devcontainer/profile.cjs native --ui --ref main

# Work on a branch pushed to your own fork (HTTPS or Git SSH).
node .devcontainer/profile.cjs native --url https://github.com/YOUR-NAME/GitNexus.git --ref your-branch

# Pull a published toolchain image instead of building locally.
node .devcontainer/profile.cjs prebuilt
node .devcontainer/profile.cjs prebuilt --ui
```

These commands overwrite the ignored `.devcontainer/generated/devcontainer.json`. Select that configuration when reopening the folder in Dev Containers, or pass `--config .devcontainer/generated/devcontainer.json` to the Dev Container CLI. Regenerate after changing the main configuration. Existing containers need recreation when switching workspace mounts.

The native profile clones the selected **remote branch** of GitNexus into its volume before dependency setup. It does not copy uncommitted host edits. Push your branch first and use `--ref your-branch` to work on it; contributors using a fork must also pass `--url` for that fork. HTTPS, `git@host:owner/repo.git`, and `ssh://git@host/owner/repo.git` URLs are supported without embedded HTTPS credentials. Fresh checkouts track their remote branch, so ordinary `git pull` and `git push` work. Reused volumes keep their current branch and local changes; the bootstrap neither resets nor automatically pulls an existing checkout. The volume is the authoritative checkout: use Git to export changes before removing it. Host configuration uses the same native snapshot volumes; this profile skips importing the host checkout.

`--ref` and `--url` apply only to `native`. `--image` selects an existing image for consumer profiles and preserves the configured Features, including GitHub CLI, so custom images need not bundle `gh`. Dev Containers applies those Features to the selected image. `image-build` accepts only `--ui`, since its build output is named by the publishing command.

UI profiles install OS dependencies during the image build using the Playwright version in `gitnexus-web/package-lock.json`. Setup installs matching Chromium binaries into a persistent browser-cache volume. They also allocate 1 GiB of private shared memory. Prebuilt UI profiles require the `main-ui` image variant; explicit images passed with `--image` must include those OS dependencies.

## Dependency reuse, storage and diagnostics

Setup records completed installations inside each dependency volume. Fingerprints cover package manifests, lockfiles, local file-dependency manifests, Node version/ABI, npm version, architecture, and tracked native grammar/build inputs. The CLI receipt also includes the effective `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` setting. A matching receipt with all direct dependencies present skips `npm ci`. Missing dependencies or changed inputs cause a clean reinstall, with lifecycle scripts enabled. Failed installs leave no valid receipt.

Husky preparation and verification **always run**, including cached setup. Shared and CLI source builds run independently of dependency reuse, so pulling source changes still refreshes compiled output. After pulling changes in a running container, run:

```bash
bash .devcontainer/install-deps.sh

# Repair nested dependency damage, new untracked native build inputs, or
# changed npm installation settings that are outside the fingerprint.
GITNEXUS_FORCE_DEPS=1 bash .devcontainer/install-deps.sh
```

The shared GitNexus store and registry persist under `GITNEXUS_HOME=/home/node/.gitnexus` in a native named volume, retaining worktree sharing. Existing checkout-local `.gitnexus` directories stay in place; a new mount does not hide or replace them. The native workspace profile also places checkout-local indexes on its native filesystem. If moving an existing container whose shared store lives only in its writable layer, export that store before deleting the old container.

Setup prints timings for ownership repair, dependency installation/reuse, builds, and browser provisioning. Inspect the environment at any time with:

```bash
node .devcontainer/doctor.cjs
node .devcontainer/dev-test.cjs core test/unit/resolve-invocation.test.ts
node .devcontainer/dev-test.cjs web
GITNEXUS_DEV_TEST_WORKERS=2 node .devcontainer/dev-test.cjs core --watch
```

The diagnostic command reports CPU/memory allowance, cgroup memory events, memory/I/O pressure, disk space/inodes, file-descriptor and watcher limits, filesystem options, and hook status. The development test runner chooses up to four workers, respecting cgroup v2 CPU/memory limits and leaving interactive headroom. Its explicit override accepts 1–99 workers. The ordinary package test commands and CI test configuration remain available. Ownership repair still checks nested entries on each setup; timings can establish whether a more aggressive cache is worthwhile.

## Prebuilt images

`.github/workflows/devcontainer-publish.yml` verifies the tooling and publishes amd64/arm64 core and UI images to GHCR on relevant `main` pushes or manual dispatch on `main`. Pull requests do not publish images. Registry build caches are separate for the two variants. Consumers supply runtime mounts and lifecycle commands; published toolchain metadata excludes those settings to avoid duplicate lifecycle execution.

The rolling tags are `ghcr.io/abhigyanpatwari/gitnexus-devcontainer:main` and `:main-ui`, available **after the first successful publication**. A fork publishes under its own repository-derived name. Each publication also records a unique `sha-COMMIT-run-RUN-ATTEMPT` tag in the workflow summary (with `-ui` for UI images). Pass that full reference or an image digest with `--image` to select a fixed build. Combine `native --image IMAGE` to use a prebuilt image with a native workspace. Local builds remain the default while the publishing workflow is reviewed and merged. New GHCR packages are [private by default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry); a maintainer must enable public visibility for anonymous pulls, or developers must authenticate to GHCR. The workflow links the package to this repository using its OCI source label.

## Configuration snapshots and CLI state

Host initialization creates these snapshots and retakes them until the source volume is committed; after that they are kept. Missing host paths produce an empty snapshot; no host files or directories are created.

| Volume prefix (each ends in `-${devcontainerId}`) | Container target | Access |
| --- | --- | --- |
| `gitnexus-host-snapshot` | `/host` | Read-only |
| `gitnexus-ssh-snapshot` | `/home/node/.ssh` | Read-only |
| `gitnexus-docker-snapshot` | `/home/node/.docker` | Read-only |
| `gitnexus-aws-snapshot` | `/home/node/.aws` | Read-only |
| `gitnexus-azure-snapshot` | `/home/node/.azure` | Read-only |
| `gitnexus-git-snapshot` | `/home/node/.config/git` | Read-only |

`/host` contains selected AI CLI credentials, settings, plugins, skills, agents, commands, rules, prompts, memory, GitHub configuration, and the claude-mem store. Host transcript directories and Cursor's top-level `hooks.json` are excluded. See `HOST_PATHS` in `initialize-volumes.cjs` for the explicit list. Symlinks are preserved without following them; absolute host links may need replacing with container-local paths.

`post-create.sh` seeds missing credentials/settings into the existing writable `claude-config`, `codex-config`, `cursor-config`, and `gh-config` volumes. Existing files are preserved, and completion markers keep refreshed logins, edits, and deliberate logouts intact on rebuild. Those markers are written only from a complete `/host` snapshot, so a snapshot skipped during initialization is still seeded by a later rebuild. Plugins and shareable directories are seeded once; Claude and Cursor plugin registry paths are translated for Linux. Claude's home-level `~/.claude.json` is regenerated from the snapshot on recreation as before.

The independent writable `claude-mem` volume is seeded once. Stop host writers before the initial snapshot so database files and WAL sidecars are consistent.

**Host and container state diverge.** Later host logins, key rotations, plugin installations, and config edits do not update snapshots. Authenticate and manage plugins inside the container for daily work. For an intentional snapshot refresh, export container-only changes, remove the old container, then remove only the relevant `gitnexus-*-snapshot-<id>` volume from the host and reopen. Refreshing `/host` does not overwrite existing CLI config: apply selected changes inside the container, or deliberately reset the corresponding config volume after backup.

Snapshots are read-only copies of host files. A partial snapshot is replaced on the next start, and all snapshots are retaken while the source volume is still uncommitted, so they match the staged checkout. If an interrupted import leaves `gitnexus-import-<id>`, inspect and remove that helper before retrying. Do not use `docker rm -v` or broad volume cleanup.

### Session resume across container recreation

Existing session names and targets are unchanged:

| CLI | Volume | Target |
| --- | --- | --- |
| Claude | `${localWorkspaceFolderBasename}-claude-sessions-${devcontainerId}` | `~/.claude/projects` |
| Codex | `${localWorkspaceFolderBasename}-codex-sessions-${devcontainerId}` | `~/.codex/sessions` |
| Cursor | `${localWorkspaceFolderBasename}-cursor-sessions-${devcontainerId}` | `~/.cursor/chats` |
| Cursor projects | `${localWorkspaceFolderBasename}-cursor-projects-${devcontainerId}` | `~/.cursor/projects` |

These overlay the config volumes. Recreation retains transcripts; resetting config leaves the separate session volumes intact, though a CLI may need to rebuild its session index. Cursor resume remains best-effort because its on-disk layout is not a stable public interface. Volumes remain tied to the host folder/configuration identity and Docker engine.

### Credentials and platform limitations

Snapshots remove the live host filesystem connection, but copied credentials remain readable inside the container. Read-only mounts prevent modification, not disclosure. No egress firewall is configured. The Docker socket is not mounted into the development container.

Host OS credential stores, Windows Docker credential helpers, and absolute host MCP command paths do not become Linux-compatible by copying configuration. Authenticate inside the container when needed and install required Linux tools. Docker, AWS, Azure, gcloud, and kubectl CLIs are not installed by this change. SSH and cloud snapshots remain read-only; use appropriate writable container configuration if a CLI needs to refresh tokens or update `known_hosts`.

VS Code can still copy `~/.gitconfig` and forward credential/SSH-agent helpers separately; these editor features are not repository bind mounts. Git's XDG configuration uses the native `.config/git` snapshot.

The legacy `tune-9p.sh` and host-directory helper remain for their existing tests and CI checks. No runtime profile invokes them.

## First-time CLI authentication

A host login present when snapshots are first created can seed the container. Otherwise log in inside it. In-container credentials persist in writable volumes and do not flow back to the host.

### Claude Code

```bash
claude login
```

Opens a browser auth flow. VS Code's port forwarding handles the OAuth callback automatically. After auth, `~/.claude/` is populated in the container volume. The `DISABLE_AUTOUPDATER=1` env var prevents the in-container CLI from auto-updating — rebuild the container to pick up a newer Claude Code.

### OpenAI Codex CLI

```bash
codex login --device-auth
```

The device-code flow prints a URL and a one-time code. Visit the URL on your host browser, paste the code, and the CLI authenticates without needing a callback listener — this is the most reliable path inside containers. Credentials land in `~/.codex/auth.json` (in the container volume).

`codex login` (browser-callback variant) also works but can be flaky in some headless contexts; prefer `--device-auth`.

### Cursor CLI

```bash
cursor-agent login
```

Opens a browser auth flow; VS Code's port forwarding handles the callback. Credentials persist in `~/.cursor/cli-config.json` (in the container volume).

Verify any time with `cursor-agent status`.

## Alternative: API key authentication (CI / headless)

For non-interactive use (CI runners, automated scripts), all three CLIs accept API keys via env vars:

| CLI         | Env var             | Where to get the key                          |
| ----------- | ------------------- | --------------------------------------------- |
| Claude Code | `ANTHROPIC_API_KEY` | <https://console.anthropic.com/settings/keys> |
| Codex       | `OPENAI_API_KEY`    | <https://platform.openai.com/api-keys>        |
| Cursor      | `CURSOR_API_KEY`    | Cursor dashboard → Integrations               |

These env vars are intentionally **not** injected into the container from the host. `${localEnv:VAR}` resolves an unset host variable to an empty string, and some CLIs (Cursor in particular) treat a set-but-empty key as "use this key" rather than "fall back to stored login" — which would silently break the login flow for everyone who hasn't pre-set the host var.

To use an API key inside the container, export it in your terminal session:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, or CURSOR_API_KEY
```

For persistence across container shells, carry the export via your VS Code [dotfiles repository](https://code.visualstudio.com/docs/devcontainers/containers#_personalizing-with-dotfile-repositories). VS Code clones the dotfiles repo into the container on attach and runs your install command, so the export lands in `~/.bashrc` / `~/.zshrc` per your own setup — and your API keys stay out of this repo's committed `devcontainer.json`.

A non-empty API key env var takes precedence over stored login credentials for each CLI.

## Port forwarding

| Port   | Service                          | Notes                                                                                                  |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `5173` | Vite dev server (`gitnexus-web`) | Auto-forwarded with notification                                                                       |
| `4747` | `gitnexus serve` HTTP API        | **Must not be remapped** — `gitnexus-web` hardcodes `http://localhost:4747` as the default backend URL |
| `4173` | Static web (Vite preview)        | Silently forwarded                                                                                     |

VS Code's Ports panel shows forwarded ports once their listener starts.

## Known gotchas

- **Warm installs reuse the npm cache.** Lifecycle installs prefer cached packages and skip audit requests and funding notices; cache misses still download normally, and native addon/prepare scripts still run. Run `npm audit` in each package when checking vulnerabilities. Volume ownership repair changes only entries whose owner or group differs from `node`.
- **VS Code skips generated indexes, build output, dependencies, and nested worktrees when watching/searching.** Open a sibling worktree as its own window when developing there. These exclusions do not change Vite or Vitest watchers.
- **Memory follows the running workload.** The image leaves `NODE_OPTIONS` unset, so Node uses its defaults and `gitnexus analyze` uses its RAM-aware sizing. For a specific indexing run, use `gitnexus analyze --memory-budget 4096` to set a 4 GiB heap budget. Docker Desktop's VM memory allocation still bounds the container.
- **LadybugDB integration tests may fail in containers** (file-locking, `AGENTS.md` § Testing). Default to `npm run test:unit` inside the container; run integration tests on the host. Tracking issue: documented as a known limitation.
- **Single-writer LadybugDB constraint** (`GUARDRAILS.md` § LadybugDB lock). Don't run `gitnexus analyze` on the host and inside the container against the same `.gitnexus/` directory simultaneously — the second writer will get `database busy`.
- **Native grammar builds add ~30s to first install.** Tree-sitter Dart/Proto/Swift/Kotlin/Zig are all vendored uniformly: `node-gyp-build` picks a committed GitNexus-built prebuilt `.node` at install time (no compile), and only falls back to compiling from the vendored source during `postinstall` if no prebuild matches the host (then a toolchain is needed). Set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` (in your shell or `remoteEnv`, then rebuild) to skip these optional grammars; each loses parsing for the affected language(s), and the install still succeeds. Changing this setting invalidates the CLI dependency receipt, including when it is removed to restore parsing.
- **`tree-sitter-kotlin`/`tree-sitter-swift` warnings on install** only appear when no prebuild matches the platform-arch (per `AGENTS.md`); they are non-fatal — parsing for that language is simply unavailable.
- **`.mcp.json` is copied into the source volume on first creation.** Later host edits are not synchronized; update the container copy when changing its MCP configuration.
- **Husky pre-commit is verified during setup.** Root preparation always installs the hook, including cached dependency runs. Only its generated `.husky/_` cache is cleared for stale Windows permissions; the tracked `.husky/pre-commit` stays intact. Setup fails if the hook is missing, Git points elsewhere, or the environment or Husky's `init.sh` disables or skips it. Verification runs the installed Husky helper against a temporary sentinel hook without running the real formatter or changing staged files. Run `npm run prepare` at the repository root to restore the hook, and keep Husky enabled in its startup configuration.

## Rebuild / reset

- **Rebuild Container** reuses source, snapshots, credentials, sessions, dependencies, and caches. An initialized source volume is never re-seeded.
- **Rebuild Container Without Cache** refreshes image layers while retaining volumes.
- For ownership errors, first rebuild: source preparation runs as root, and lifecycle hooks repair writable config and dependency volumes.
- To reset a CLI, back up its container-only configuration/plugins, then remove only its `<cli>-config-<id>` volume after removing the container. Reopening seeds from the existing snapshot. Separate session volumes remain.
- Resetting `claude-mem-<id>` restores the existing snapshot. To import a newer host store, refresh `gitnexus-host-snapshot-<id>` too, with host writers stopped.
- `gitnexus-seed-<id>` is empty after the container commits it; removing it is safe.
- Never remove the source volume to fix a credential problem. Back up volume-only work before removing volumes.

## Bumping CLI versions

Claude Code, Codex, and Cursor install the latest available release at image build time using their official shell installers. Rebuild without the Docker cache to refresh those image layers. Bun's version is pinned by `BUN_VERSION` in `.devcontainer/devcontainer.json` `build.args`; the Node base image is pinned by digest in the Dockerfile.

Codex uses the [official standalone installer](https://developers.openai.com/codex/cli/) (`curl -fsSL https://chatgpt.com/codex/install.sh | sh`) rather than npm. The build runs it non-interactively and checks `codex --version`. Its native packages normally live under `~/.codex/packages/standalone`, inside the persistent config volume. The image keeps a package seed outside that mount; `post-create.sh` restores it when Codex cannot run, including when rebuilding with a config volume created by the previous npm-based image. A working standalone release already in the volume is kept. This avoids another download during setup and leaves credentials, configuration, and sessions intact.

## Troubleshooting

If a native addon fails with `GLIBCXX_3.4.31 not found`, run **Dev Containers:
Rebuild Container** after updating this checkout. The image uses Debian 13
(Trixie) with a C++ runtime that supports the packaged tree-sitter binary, while
keeping Node 22.23.3. Reinstalling npm packages or `g++` in an older Debian 12
(Bookworm) container does not upgrade that system runtime. The default, native
workspace, and UI build profiles all use this Dockerfile. If you selected a
prebuilt image, pull an image published from this change or a later commit and
recreate the container; a pinned older image keeps its older runtime.

If `[install-deps]` prints `npm warn EBADENGINE` with Node 22.16.0, run **Dev Containers: Rebuild Container** from the Command Palette after updating this checkout. The image now pins Node 22.23.3; workspace dependencies require at least 22.22.2 on the Node 22 line. Re-running `npm install` in the old container does not update its Node runtime.

| Symptom | Check / action |
| --- | --- |
| `node` or `docker` missing during initialization | Install the host prerequisite and restart VS Code to refresh PATH. |
| Import helper already exists | Inspect `gitnexus-import-<id>`; remove it only if the import is no longer running. |
| `no space left on device` during import | Docker's Linux storage is full. Check `docker system df` and Docker Desktop's disk allocation. Allow room for both the staged copy and the source volume, plus configuration snapshots. The importer excludes regenerable parser caches at every depth. A failed transfer into the stage is replaced on the next start, so retry after resolving space. If the failure occurred while the container committed into `/workspace`, inspect and preserve the partial source volume before resetting it. Do not prune volumes containing work. |
| Uninitialized source volume | Inspect and back up that volume, then retry with it empty. Never add a completion marker manually. |
| `No complete staged checkout` during container creation | Staging was skipped; the `[volumes]` initialization output names the cause, usually a host process writing during the copy or an active Git operation. Stop host writers, then run **Rebuild Container** (or `devcontainer up --remove-existing-container`): a failed `onCreateCommand` is not retried in the same container. |
| `changed during the import` warning | A host process wrote the named file while it was streamed. That stage or snapshot is retried on the next start. Stop agents, indexers and claude-mem on the host before rebuilding. |
| 9P remains after rebuilding | Check the selected config, regenerate optional profiles, and inspect editor-added mounts and image metadata. |
| Host edits no longer appear | Work in the attached container. Export files explicitly with Git or `docker cp`. |
| SSH/cloud/Docker auth fails | Host credential helpers and absolute paths may not work on Linux. Configure the available Linux tool. |
| Vite or Git appears stale | Confirm VS Code is attached to the volume workspace, not the original host checkout. |
| Web cannot reach backend | Keep port 4747 forwarded without remapping and start `gitnexus serve`. |
| Tests report `database busy` | Stop other writers to the same LadybugDB store. |

Codespaces initialization is not validated; the host importer requires Docker CLI/daemon access. UI profiles provision Chromium only.
