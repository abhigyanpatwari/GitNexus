# Contributing to GitNexus

How to propose changes, run checks locally, and open pull requests.

## License

This project uses the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/). By contributing, you agree your contributions are licensed under the same terms unless stated otherwise.

## Where to discuss

- **Issues & feature ideas:** use [GitHub Issues](https://github.com/abhigyanpatwari/GitNexus/issues) for the upstream repo, or your fork’s tracker if you work from a fork.
- **Community:** see the Discord link in the root [README.md](README.md).

## Development setup

1. Clone the repository.
2. **CLI / MCP package:** `cd gitnexus && npm install && npm run build`
3. **Web UI (if needed):** `cd gitnexus-web && npm install`
4. Run tests as described in [TESTING.md](TESTING.md).

## Branch and pull requests

- Use short-lived branches off the default branch of the repo you are targeting.
- **PR titles MUST follow the conventional-commit format** — `pr-labeler.yml` enforces this on every PR and auto-applies the matching label so release notes group the change correctly.
- **PR description:** what changed, why, how to verify (commands), and any risk or rollback notes.

### Pull request titles

Format: `<type>[(scope)][!]: <subject>`

Allowed types and the release-notes section each one lands in (defined in `.github/release.yml`):

| Type | Label applied | Release-notes section |
|------|---------------|-----------------------|
| `feat` | `enhancement` | 🚀 Features |
| `fix` | `bug` | 🐛 Bug Fixes |
| `perf` | `performance` | 🏎️ Performance |
| `refactor` | `refactor` | 🔄 Refactoring |
| `test` | `test` | 🧪 Tests |
| `ci` | `ci` | 👷 CI/CD |
| `build` / `deps` | `dependencies` | 📦 Dependencies |
| `docs` | `documentation` | (grouped under Other Changes unless a Docs section is added) |
| `chore` / `revert` | `chore` | (excluded from release notes) |

Append `!` to the type (e.g. `feat(api)!: drop /v1 endpoint`) or include `BREAKING CHANGE:` in the PR body to flag a breaking change — the labeler then adds the `breaking` label and the 💥 Breaking Changes section is rendered first.

Examples:

```text
feat(web): add smart chat scroll
fix(extractors): resolve silent contract mis-resolution
perf: avoid O(n²) traversal in heritage walker
chore(deps): bump vitest to 3.0.0
ci: standardize workflow concurrency
```

Commits within a PR may use any style — only the **merged PR title** shows up in release notes, so that's the one the convention applies to.

## Before you open a PR

- [ ] Tests pass for the packages you touched (`gitnexus` and/or `gitnexus-web`).
- [ ] Typecheck passes: `npx tsc --noEmit` in `gitnexus/` and `npx tsc -b --noEmit` in `gitnexus-web/`.
- [ ] No secrets, tokens, or machine-specific paths committed.
- [ ] Documentation updated if behavior or public CLI/MCP contract changes.
- [ ] Pre-commit hook runs clean (`.husky/pre-commit` — formatting via lint-staged + typecheck for staged packages; tests run in CI only).

## Code review

Maintainers may request changes for correctness, tests, performance, or consistency with existing patterns. Keeping diffs focused makes review faster.

## GitHub Actions — Concurrency Convention

Every workflow under `.github/workflows/` MUST declare a top-level `concurrency:` block using this convention:

- **Group key** starts with `${{ github.workflow }}` so no two workflows can collide on the same group name. The discriminator that follows is chosen per event shape:
  - Branch/tag scope: `${{ github.workflow }}-${{ github.ref }}`
  - Per-PR scope (for `issue_comment`, `pull_request_review*`, `pull_request` meta events): `${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number }}`
  - `workflow_run` scope (e.g. `ci-report.yml`): `${{ github.workflow }}-${{ github.event.workflow_run.pull_requests[0].number || format('{0}/{1}', github.event.workflow_run.head_repository.full_name, github.event.workflow_run.head_branch) }}` — the fork fallback must be stable across reruns (never `workflow_run.id`, which is per-run-unique and defeats serialization).
  - Global single-slot (manual dispatch utilities): `${{ github.workflow }}`
  - **Reusable workflows invoked via `workflow_call`:** do NOT use `${{ github.workflow }}` in the group key — in called-workflow context its evaluation is ambiguous and can resolve to the caller's name, which would deadlock against the caller's own group. Use a hardcoded literal prefix and a `github.event_name`-aware expression that falls through to `github.run_id` for reusable invocations (see `ci.yml` for the canonical form). Approved literal prefixes: `CI-` (`ci.yml`) and `docker-build-push-` (`docker.yml`). The `check-workflow-concurrency.py` validation script must be updated whenever a new approved literal prefix is added.
  - **Merge queue (`merge_group`)**: when this event is added, use `${{ github.workflow }}-${{ github.event.merge_group.head_ref }}` with `cancel-in-progress: false` (every queue entry is a distinct ref; never cancel).
- **`cancel-in-progress` policy:**

  | Event | `cancel-in-progress` | Why |
  |-------|----------------------|-----|
  | `pull_request` CI run | `true` | New push supersedes old run |
  | `push` to `main` | `false` | Every main commit gets validated |
  | Tag push (`v*` publish) | `false` | Never cancel mid-publish |
  | `push` to `main` for release-candidate | `false` | Never cancel mid-RC publish |
  | `workflow_dispatch` (release/publish) | `false` | Manual runs are intentional |
  | `workflow_run` (sticky-comment reports) | `false` | Serialize, don't race |
  | Per-PR bot workflows (`@claude`, review) | `false` | Serialize comments per PR |
  | PR-meta re-checks (pr-description-check) | `true` | Cheap, latest wins |
  | Single-slot utilities (triage sweep) | `true` | Latest dispatch supersedes |

- For workflows that serve multiple events at once (e.g. `ci.yml` handles `pull_request`, `push`, and `workflow_call`), make `cancel-in-progress` event-aware:

  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

- When adding a new workflow, copy the concurrency block from an existing workflow of the same event shape.

## AI-assisted contributions

If you use coding agents, follow project context files (e.g. `AGENTS.md`, `CLAUDE.md`) and avoid drive-by refactors unrelated to the issue. Prefer incremental, test-backed changes.

## Releases

Two publish workflows ship `gitnexus` to npm:

- **Stable** (`.github/workflows/publish.yml`) — triggered by pushing any `v*`
  tag. Publishes to the `latest` dist-tag with a changelog-backed GitHub
  release. Maintainers are expected to tag from `main` as a convention; the
  workflow itself does not enforce branch reachability.
- **Release Candidate** (`.github/workflows/release-candidate.yml`) — runs on
  every push to `main` (typically a merged PR) plus manual dispatch. Docs-only
  changes are skipped via `paths-ignore`. Publishes to the `rc` dist-tag with
  version `X.Y.Z-rc.N` and a GitHub prerelease, where:
  - `X.Y.Z` is selected automatically. On push (and on dispatch with
    `bump: auto`, the default) the workflow **continues the active rc cycle**:
    if the registry already has `X.Y.Z-rc.*` versions with `X.Y.Z` > current
    `latest`, it reuses the highest such base; otherwise it patch-bumps
    from `latest`. Dispatching with `bump: patch|minor|major` **resets**
    the cycle from `latest`.
  - `N` is auto-incremented against existing `X.Y.Z-rc.*` entries on the
    registry. First rc for a given base is `rc.1`.
  - After the npm publish succeeds, the workflow calls `docker.yml` as a
    reusable workflow to build and push the corresponding RC Docker images
    (e.g. `ghcr.io/abhigyanpatwari/gitnexus:1.7.0-rc.1`). The images are
    signed with Cosign; the OIDC identity is `docker.yml@refs/heads/main`
    (the caller's ref — see README.md § Docker for the verify command).

  Idempotency: the workflow pushes an `rc/<HEAD_SHA>` marker tag and a
  `v<RC>` release tag **atomically, before** calling `npm publish`. The guard
  refuses to re-run once the marker exists, so a post-publish failure will
  not mint a duplicate rc for the same commit. The `v<RC>` tag points at a
  detached release commit whose `package.json` matches the npm tarball
  exactly (traceable releases). Recovery after a partial failure:

  ```bash
  git push --delete origin rc/<HEAD_SHA> v<RC>
  # then redispatch the workflow with force: true
  ```

  **Docker-only partial failure:** if `publish` succeeds (npm tarball + tags
  are live) but the `docker` job subsequently fails (e.g. GHCR flakiness),
  the npm RC is already published and the `rc/<HEAD_SHA>` marker is in place.
  Re-running `release-candidate.yml` with `force: true` will abort at the
  "Version already exists on npm" guard. To recover without cutting a new RC:

  ```bash
  # 1. Manually trigger only the docker workflow, passing the existing RC tag:
  gh workflow run docker.yml --ref main -f tag=v<RC_VERSION>
  # (requires a workflow_dispatch trigger on docker.yml — see note below)
  ```

  Because `docker.yml` intentionally has no `workflow_dispatch` (images are
  tag-driven by design), the practical recovery options are:
  - Wait for the next commit on `main`, which will cut a new RC that includes
    the Docker build.
  - Manually run `docker build` + `docker push` locally and sign with Cosign
    against the same digest.
  - Delete `rc/<HEAD_SHA>` and `v<RC>` tags, then redispatch with `force:
    true` to re-run the full RC pipeline (cuts a new RC number).

The rc workflow never moves `latest`. To verify after a change, inspect dist-tags:

```bash
npm view gitnexus dist-tags
```
