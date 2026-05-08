/**
 * Understand-Quickly registry integration helpers.
 *
 * Pure, runtime-agnostic logic for opting in to publishing a GitNexus
 * index to the [`looptech-ai/understand-quickly`](https://github.com/looptech-ai/understand-quickly)
 * registry. Lives in `gitnexus-shared` so both the Node CLI and any
 * future browser-side surface can construct identical dispatch payloads.
 *
 * Network I/O lives in the CLI command (`gitnexus/src/cli/publish.ts`)
 * to keep this module free of Node-only imports — see the comment at
 * the top of `gitnexus-shared/src/graph/types.ts`.
 *
 * The protocol contract (single dispatch event, no graph upload) is
 * documented at:
 *   https://github.com/looptech-ai/understand-quickly/blob/main/docs/integrations/protocol.md
 */

/**
 * URL of the registry repo's repository_dispatch endpoint. Hardcoded
 * because the registry is the canonical home for this integration —
 * users who want a private registry can fork and patch.
 */
export const UNDERSTAND_QUICKLY_DISPATCH_URL =
  'https://api.github.com/repos/looptech-ai/understand-quickly/dispatches';

/**
 * Event type the registry's sync workflow listens for.
 * See `looptech-ai/understand-quickly/.github/workflows/sync.yml`.
 */
export const UNDERSTAND_QUICKLY_EVENT_TYPE = 'sync-entry';

/** Environment variable that gates the dispatch. */
export const UNDERSTAND_QUICKLY_TOKEN_ENV = 'UNDERSTAND_QUICKLY_TOKEN';

export interface UqDispatchPayload {
  event_type: typeof UNDERSTAND_QUICKLY_EVENT_TYPE;
  client_payload: {
    /** `<owner>/<repo>` shape — must match the registered entry. */
    id: string;
  };
}

/**
 * Build the JSON body for the `repository_dispatch` ping. Pure — no
 * env reads, no network. Validates that `id` looks like `owner/repo`
 * (one slash, no whitespace, both halves non-empty) so a misconfigured
 * caller fails loudly before the round-trip.
 */
export function buildUqDispatchPayload(id: string): UqDispatchPayload {
  if (!isValidOwnerRepo(id)) {
    throw new Error(
      `[understand-quickly] expected id of the form "owner/repo", got "${id}". ` +
        `The registry uses this string to look up your entry in registry.json — ` +
        `it must match the GitHub owner/repo of the source code, not a local path.`,
    );
  }
  return {
    event_type: UNDERSTAND_QUICKLY_EVENT_TYPE,
    client_payload: { id },
  };
}

/**
 * `owner/repo` validation. Conservative on purpose: GitHub's actual
 * naming rules are looser, but we want to catch local paths
 * (`/Users/...`), bare slugs (`my-repo`), and accidental whitespace.
 */
export function isValidOwnerRepo(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(id);
}

/**
 * Parse `owner/repo` out of a git remote URL. Mirrors the heuristic in
 * `gitnexus/src/storage/git.ts:parseRepoNameFromUrl` but keeps both
 * halves so we can build a registry id. Returns `null` on shapes we
 * don't recognise.
 *
 * Examples:
 *   git@github.com:looptech-ai/understand-quickly.git
 *   https://github.com/looptech-ai/understand-quickly
 *   ssh://git@github.com/looptech-ai/understand-quickly.git
 */
export function parseOwnerRepoFromRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Strip a trailing `.git` (case-insensitive) and any trailing slashes
  // so https://h/o/r and https://h/o/r.git collapse to the same id.
  const stripped = trimmed.replace(/\.git\/*$/i, '').replace(/\/+$/, '');

  // SCP-form SSH (`git@host:owner/repo`).
  const ssh = stripped.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  // URL forms (https://, ssh://, git://, file://) — last two path segments.
  const url2 = stripped.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/(.+)$/);
  if (url2) {
    const segments = url2[1].split('/').filter(Boolean);
    if (segments.length >= 2) {
      const [owner, repo] = segments.slice(-2);
      return `${owner}/${repo}`;
    }
  }
  return null;
}
