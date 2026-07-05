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

/**
 * Hard cap on the dispatch fetch to keep CI publish steps from stalling
 * for the OS TCP timeout (~2 min) when api.github.com is unreachable.
 * Matches the pattern used in `src/core/embeddings/http-client.ts`.
 */
const DISPATCH_TIMEOUT_MS = 15_000;

export const publishCommand = async (
  inputPath?: string,
  options: PublishOptions = {},
): Promise<void> => {
  // ── 0. Token gate FIRST — guarantees true no-op without the token. ──
  // The README, CLI --help, and PR body all promise "exit 0 without
  // UNDERSTAND_QUICKLY_TOKEN". Doing the index/repo-root checks before
  // the token gate would make those promises false for users who haven't
  // run `gitnexus analyze` yet but want to verify the command is wired.
  const token = process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
  if (!token) {
    cliInfo(
      `[understand-quickly] ${UNDERSTAND_QUICKLY_TOKEN_ENV} is not set — skipping dispatch.\n` +
        `Set it to a fine-grained PAT with "Repository dispatches: write" on ` +
        `looptech-ai/understand-quickly to enable instant resync.\n` +
        `(Without the token, the registry's nightly sync still picks up your entry.)`,
      { skipped: 'no-token' },
    );
    return;
  }

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

  // ── 4. Fire the dispatch ─────────────────────────────────────────────
  const payload = buildUqDispatchPayload(id);
  let response: Response;
  try {
    response = await fetch(UNDERSTAND_QUICKLY_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'gitnexus-cli',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  } catch (err) {
    // `AbortSignal.timeout()` throws a `DOMException` with `name ===
    // 'TimeoutError'` on Node 18.14+ (and on browsers/Bun). It is NOT
    // a plain `AbortError`. Match the pattern used in
    // gitnexus/src/core/embeddings/http-client.ts so the user sees the
    // targeted "timed out" message instead of a generic "operation
    // was aborted".
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      cliError(
        `[understand-quickly] dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms. ` +
          `Check network access to api.github.com and retry.`,
        { id },
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      cliError(`[understand-quickly] dispatch network error: ${msg}`, { id });
    }
    process.exitCode = 1;
    return;
  }

  // GitHub returns 204 on success. Distinct branches for 401/403/404/422
  // so users debug without checking the docs.
  if (response.status === 204) {
    await response.body?.cancel().catch(() => {});
    // `getCurrentCommit` is only meaningful in the success path — moving
    // it inside this branch removes a wasted child-process spawn on every
    // error response (LOW 7).
    const commit = getCurrentCommit(repoPath);
    cliInfo(
      `[understand-quickly] dispatched sync-entry for ${id}` +
        (commit ? ` @ ${commit.slice(0, 7)}` : '') +
        '.\n' +
        `Note: a 204 only confirms GitHub accepted the dispatch. Whether the ` +
        `registry workflow finds an entry for "${id}" is logged at ` +
        `https://github.com/looptech-ai/understand-quickly/actions/workflows/sync.yml`,
      { id, commit, status: response.status },
    );
    return;
  }

  if (response.status === 401) {
    cliError(
      `[understand-quickly] dispatch returned 401 — the ${UNDERSTAND_QUICKLY_TOKEN_ENV} value is invalid or expired.\n` +
        `Regenerate a fine-grained PAT at https://github.com/settings/personal-access-tokens ` +
        `with Repository access scoped to looptech-ai/understand-quickly and the ` +
        `"Repository dispatches: write" permission, then retry.`,
      { id, status: response.status },
    );
    process.exitCode = 1;
    return;
  }

  if (response.status === 403) {
    cliError(
      `[understand-quickly] dispatch returned 403 — the token authenticated but ` +
        `lacks the "Repository dispatches: write" permission on ` +
        `looptech-ai/understand-quickly. Edit the PAT scopes and retry.`,
      { id, status: response.status },
    );
    process.exitCode = 1;
    return;
  }

  if (response.status === 404) {
    cliError(
      `[understand-quickly] dispatch returned 404 — the token cannot reach ` +
        `looptech-ai/understand-quickly. Verify the PAT has Repository access to ` +
        `that exact repo (not just your own org).`,
      { id, status: response.status },
    );
    process.exitCode = 1;
    return;
  }

  if (response.status === 422) {
    // Malformed event_type / client_payload — a code bug in this CLI,
    // not a user mistake. Surface so we get bug reports.
    const body422 = await response.text().catch(() => '');
    cliError(
      `[understand-quickly] dispatch returned 422 (this is a CLI bug; please report).\n` +
        `Body: ${body422 || '(empty)'}`,
      { id, status: response.status },
    );
    process.exitCode = 1;
    return;
  }

  // 5xx and anything else → bubble the body so the user has something to act on.
  const body = await response.text().catch(() => '');
  cliError(
    `[understand-quickly] dispatch failed with HTTP ${response.status}: ${body || '(empty body)'}`,
    { id, status: response.status },
  );
  process.exitCode = 1;
};
