/**
 * `gitnexus publish` — opt-in ping to the understand-quickly registry.
 *
 * Fires a single `repository_dispatch` event at
 * `looptech-ai/understand-quickly` so the registry knows to refresh its
 * entry for the current repo. Does NOT upload anything: per the
 * understand-quickly protocol, the registry pulls the graph from a
 * raw-GitHub URL the user controls.
 *
 *   https://github.com/looptech-ai/understand-quickly/blob/main/docs/integrations/protocol.md
 *
 * Defaults:
 *   - Without `UNDERSTAND_QUICKLY_TOKEN` in the env, this is a no-op
 *     (prints one informational line, exit 0). Same shape as the
 *     `--publish` patterns in sibling tools.
 *   - With the token, fires the dispatch and reports the response code.
 *
 * The `id` is derived from the repo's `origin` remote unless the caller
 * passes `--id <owner/repo>` explicitly. We deliberately do NOT auto-add
 * the repo to the registry — registration is one-time and uses the
 * `npx @understand-quickly/cli add` path documented in the protocol.
 */

import path from 'path';
import {
  UNDERSTAND_QUICKLY_DISPATCH_URL,
  UNDERSTAND_QUICKLY_TOKEN_ENV,
  buildUqDispatchPayload,
  isValidOwnerRepo,
  parseOwnerRepoFromRemote,
} from 'gitnexus-shared';
import { getGitRoot, getRemoteOriginUrl, getCurrentCommit } from '../storage/git.js';
import { hasIndex } from '../storage/repo-manager.js';
import { cliInfo, cliError } from './cli-message.js';

export interface PublishOptions {
  /** Override the auto-derived `owner/repo` id. */
  id?: string;
  /** Treat the cwd as the repo root (skip git-root walk). */
  skipGit?: boolean;
}

const REGISTER_HINT =
  'Register your repo once with: npx @understand-quickly/cli add\n' +
  'Or use the wizard: https://looptech-ai.github.io/understand-quickly/add.html';

export const publishCommand = async (
  inputPath?: string,
  options: PublishOptions = {},
): Promise<void> => {
  // ── 1. Resolve the repo root (same precedence as `analyze`) ──────────
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else if (options.skipGit) {
    repoPath = path.resolve(process.cwd());
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      cliError(
        '[understand-quickly] not inside a git repository.\n' +
          'Run from a repo, or pass --skip-git to publish from the current directory.',
      );
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  // ── 2. Confirm a GitNexus index exists ───────────────────────────────
  // Publishing without an index is almost always a mistake — the
  // registry's nightly sync would fetch a stale or missing graph file
  // and mark the entry `missing`. Refuse loudly with a fix-it hint.
  if (!(await hasIndex(repoPath))) {
    cliError(
      `[understand-quickly] no GitNexus index found at ${repoPath}/.gitnexus.\n` +
        'Run `gitnexus analyze` first, then re-run `gitnexus publish`.',
    );
    process.exitCode = 1;
    return;
  }

  // ── 3. Derive the registry id ─────────────────────────────────────────
  const id =
    options.id ?? parseOwnerRepoFromRemote(getRemoteOriginUrl(repoPath) ?? undefined) ?? null;
  if (!id || !isValidOwnerRepo(id)) {
    cliError(
      `[understand-quickly] could not derive a registry id from this repo.\n` +
        `Pass --id <owner/repo> explicitly (e.g. --id looptech-ai/${path.basename(repoPath)}).\n` +
        REGISTER_HINT,
    );
    process.exitCode = 1;
    return;
  }

  // ── 4. Token gate: no token → informational no-op (exit 0) ───────────
  const token = process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
  if (!token) {
    cliInfo(
      `[understand-quickly] ${UNDERSTAND_QUICKLY_TOKEN_ENV} is not set — skipping dispatch.\n` +
        `Set it to a fine-grained PAT with "Repository dispatches: write" on ` +
        `looptech-ai/understand-quickly to enable instant resync.\n` +
        `(Without the token, the registry's nightly sync still picks up ${id}.)`,
      { id, skipped: 'no-token' },
    );
    return;
  }

  // ── 5. Fire the dispatch ─────────────────────────────────────────────
  const payload = buildUqDispatchPayload(id);
  const commit = getCurrentCommit(repoPath);
  let response: Response;
  try {
    response = await fetch(UNDERSTAND_QUICKLY_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`[understand-quickly] dispatch network error: ${msg}`, { id });
    process.exitCode = 1;
    return;
  }

  // GitHub returns 204 on success, 404 when the token can't reach the
  // registry repo, 401 when the token is invalid. Surface these
  // distinctly so users debug without checking the docs.
  if (response.status === 204) {
    cliInfo(
      `[understand-quickly] dispatched sync-entry for ${id}` +
        (commit ? ` @ ${commit.slice(0, 7)}` : '') +
        '.\n' +
        `View the workflow run: ` +
        `https://github.com/looptech-ai/understand-quickly/actions/workflows/sync.yml`,
      { id, commit, status: response.status },
    );
    return;
  }

  if (response.status === 404) {
    cliError(
      `[understand-quickly] dispatch returned 404 — the token cannot reach ` +
        `looptech-ai/understand-quickly. Verify the PAT has Repository access ` +
        `to that repo and the "Repository dispatches: write" permission.`,
      { id, status: response.status },
    );
    process.exitCode = 1;
    return;
  }

  // 401, 403, 422, 5xx → bubble up the body so the user can act.
  const body = await response.text().catch(() => '');
  cliError(
    `[understand-quickly] dispatch failed with HTTP ${response.status}: ${body || '(empty body)'}`,
    { id, status: response.status },
  );
  process.exitCode = 1;
};
