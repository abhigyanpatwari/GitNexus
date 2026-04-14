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
- Prefer **conventional commits** (short prefix + description), for example:

  ```text
  feat: add graph export option
  fix: correct MCP tool schema for query
  test: cover cluster merge edge case
  docs: clarify analyze flags
  ```

- **PR title:** `[area] Short description` (e.g. `[cli] Fix index refresh race`).
- **PR description:** what changed, why, how to verify (commands), and any risk or rollback notes.

## Before you open a PR

- [ ] Tests pass for the packages you touched (`gitnexus` and/or `gitnexus-web`).
- [ ] Typecheck passes: `npx tsc --noEmit` in `gitnexus/` and `npx tsc -b --noEmit` in `gitnexus-web/`.
- [ ] No secrets, tokens, or machine-specific paths committed.
- [ ] Documentation updated if behavior or public CLI/MCP contract changes.
- [ ] Pre-commit hook runs clean (`.husky/pre-commit` — typecheck + unit tests for staged packages).

## Code review

Maintainers may request changes for correctness, tests, performance, or consistency with existing patterns. Keeping diffs focused makes review faster.

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

The rc workflow never moves `latest`. To verify after a change, inspect dist-tags:

```bash
npm view gitnexus dist-tags
```
