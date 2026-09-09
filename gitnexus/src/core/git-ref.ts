/**
 * Git ref-name validation used by both the CLI and the HTTP analyze route.
 *
 * Lives in `core/` so `server/api.ts` does not import `cli/analyze-config`
 * (that import closed a cli → server → cli cycle: `cli/serve.ts` already
 * imports `createServer`). The CLI keeps a thin wrapper that rethrows
 * {@link InvalidBranchError} as `GitNexusRcError`.
 */

/** Git refs longer than this are almost certainly a mistake / injection attempt. */
const BRANCH_MAX_LENGTH = 255;

/**
 * Thrown when a user-supplied branch name fails {@link validateBranchName}.
 * Callers at a product boundary map this to their own error type (CLI:
 * `GitNexusRcError`; HTTP: 400).
 */
export class InvalidBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBranchError';
  }
}

/**
 * Reject control characters and hidden / bidirectional Unicode in a string
 * value. These have no legitimate place in a branch name and would otherwise
 * let a committed config or HTTP body smuggle invisible controls into
 * generated AGENTS.md / CLAUDE.md content.
 */
const isHiddenOrControl = (codePoint: number): boolean =>
  codePoint < 0x20 ||
  codePoint === 0x7f ||
  (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width + LRM/RLM
  (codePoint >= 0x202a && codePoint <= 0x202e) || // bidi embeddings/overrides
  (codePoint >= 0x2060 && codePoint <= 0x2064) || // word-joiner + invisible math
  (codePoint >= 0x2066 && codePoint <= 0x206f) || // bidi isolates + deprecated
  codePoint === 0xfeff; // BOM / zero-width no-break space

const assertNoHiddenChars = (value: string, source: string): void => {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isHiddenOrControl(cp)) {
      throw new InvalidBranchError(
        `${source}: value contains control or hidden/bidirectional characters, which are not allowed.`,
      );
    }
  }
};

/**
 * Validate a user-supplied branch name. Returns the trimmed name or throws
 * {@link InvalidBranchError}. Conservative but accepts the shapes real
 * branches use (`feature/foo-bar`, `release/1.2`, `develop`).
 */
export function validateBranchName(value: string, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidBranchError(`${source}: branch name must not be empty.`);
  }
  if (trimmed.length > BRANCH_MAX_LENGTH) {
    throw new InvalidBranchError(`${source}: branch name is too long (max ${BRANCH_MAX_LENGTH}).`);
  }
  assertNoHiddenChars(trimmed, source);
  if (/\s/.test(trimmed)) {
    throw new InvalidBranchError(`${source}: branch name must not contain whitespace.`);
  }
  // git ref-name rules (subset): reject characters git itself forbids in refs.
  if (/[~^:?*[\\]/.test(trimmed)) {
    throw new InvalidBranchError(
      `${source}: branch name contains characters not allowed in a git ref (~ ^ : ? * [ \\).`,
    );
  }
  if (trimmed.startsWith('-')) {
    throw new InvalidBranchError(`${source}: branch name must not start with "-".`);
  }
  // Force-refspec prefix (`git fetch origin +main` / `+refs/heads/main:…`).
  // Rejected here so neither the CLI nor HTTP can pass a force-update refspec
  // through as a "branch" (#3199 review, defense in depth).
  if (trimmed.startsWith('+')) {
    throw new InvalidBranchError(`${source}: branch name must not start with "+".`);
  }
  // The symbolic ref HEAD (case-sensitive). A repo can have a branch named
  // `head`; git itself treats only `HEAD` as the current-commit alias.
  if (trimmed === 'HEAD') {
    throw new InvalidBranchError(`${source}: branch name must not be "HEAD".`);
  }
  if (trimmed.includes('..')) {
    throw new InvalidBranchError(`${source}: branch name must not contain "..".`);
  }
  // The remaining `git check-ref-format` rules. Without these the validator
  // accepted refs git itself refuses (`feature.lock`, `/feature`, `feature/`,
  // `feature//next`, `@`, `.hidden`), so the failure surfaced later from the
  // git subprocess instead of here. No real branch can violate them — git
  // could not have created one — so nothing that works today starts failing.
  if (trimmed.endsWith('.lock') || trimmed.split('/').some((part) => part.endsWith('.lock'))) {
    throw new InvalidBranchError(`${source}: branch name must not end with ".lock".`);
  }
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) {
    throw new InvalidBranchError(`${source}: branch name must not start or end with "/".`);
  }
  if (trimmed.includes('//')) {
    throw new InvalidBranchError(`${source}: branch name must not contain consecutive slashes.`);
  }
  if (trimmed === '@') {
    throw new InvalidBranchError(`${source}: branch name must not be the single character "@".`);
  }
  if (trimmed.includes('@{')) {
    throw new InvalidBranchError(`${source}: branch name must not contain "@{".`);
  }
  if (trimmed.endsWith('.') || trimmed.split('/').some((part) => part.startsWith('.'))) {
    throw new InvalidBranchError(
      `${source}: branch name must not end with "." or have a path component starting with ".".`,
    );
  }
  // Git permits a backtick in a ref, but the branch is embedded inside a
  // Markdown inline-code span in the generated AGENTS.md/CLAUDE.md regression
  // example, where a backtick would close the span early and let the rest of
  // the template render as instruction text. Reject it at this single
  // chokepoint so all three tiers (CLI flag, .gitnexusrc, auto-detect via
  // sanitizeDetectedBranch) are covered (#1996 tri-review P1).
  if (trimmed.includes('`')) {
    throw new InvalidBranchError(
      `${source}: branch name must not contain a backtick (it would break the generated Markdown).`,
    );
  }
  return trimmed;
}
