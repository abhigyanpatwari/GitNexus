/**
 * Project-local `.gitnexusrc` support for `gitnexus analyze` (#243).
 *
 * Lets a repository commit recurring `analyze` defaults — default branch for the
 * generated regression example, AI-context / skills opt-outs, embedding knobs —
 * so contributors don't re-pass the same flags on every run. Design rules:
 *
 *   - Config is repo-local (`.gitnexusrc` at the resolved repo root). It is NOT
 *     read from `.gitnexus/` because that directory is index storage and is
 *     commonly gitignored.
 *   - JSON only. No YAML, no `package.json` field, no global `~/.gitnexus` file
 *     in this pass.
 *   - CLI flags always override config (see {@link mergeAnalyzeOptions}).
 *   - Fail closed: unknown keys, wrong value types, conflicting aliases, and
 *     invalid JSON all throw {@link GitNexusRcError} so a typo never silently
 *     no-ops. Errors are actionable and surface before any expensive analysis.
 *   - Config values never reach a shell. Strings are validated against control
 *     and hidden/bidirectional characters so they cannot inject markdown,
 *     JSON, or hidden controls into generated context files.
 *
 * Both a flat shape and a nested `analyze` block are accepted:
 *
 *     { "defaultBranch": "develop", "skipContextFiles": true }
 *     { "analyze": { "defaultBranch": "develop", "skipSkills": true } }
 *
 * When both set the same option, the nested `analyze` block wins (deterministic,
 * documented precedence). Conflicting *aliases at the same level* (e.g. both
 * `defaultBranch` and `branch`) are rejected.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AnalyzeOptions } from './analyze.js';

export const GITNEXUS_RC_FILENAME = '.gitnexusrc';

/** Final fallback when no branch is configured or detectable. */
export const DEFAULT_BRANCH_FALLBACK = 'main';

/** Git refs longer than this are almost certainly a mistake / injection attempt. */
const BRANCH_MAX_LENGTH = 255;

/**
 * Thrown for any `.gitnexusrc` problem (missing-file is NOT an error — it
 * returns `undefined`). The message is user-facing and names the file so the
 * CLI can print it verbatim before starting the progress bar.
 */
export class GitNexusRcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitNexusRcError';
  }
}

type ValueKind =
  | 'boolean'
  | 'boolean-negate'
  | 'string'
  | 'string-array'
  | 'numeric-string'
  | 'embeddings'
  | 'branch';

interface KeySpec {
  /** The `AnalyzeOptions` field this config key normalizes into. */
  target: keyof AnalyzeOptions;
  kind: ValueKind;
}

/**
 * Allowed `.gitnexusrc` keys and how each maps onto `AnalyzeOptions`.
 *
 * Aliases intentionally collapse onto a shared target:
 *   - `branch` is the legacy alias for `defaultBranch` (issue-comment shape).
 *   - `skipContextFiles` / `skipAiContext` are aliases for `skipAgentsMd` — they
 *     suppress the AGENTS.md / CLAUDE.md block ONLY. They do not imply
 *     `skipSkills`, and they are weaker than `indexOnly` (which skips all
 *     file injection). This matches the existing CLI semantics exactly.
 *   - `noStats` is the negation of `stats`.
 */
const KEY_SPECS: Record<string, KeySpec> = {
  defaultBranch: { target: 'defaultBranch', kind: 'branch' },
  branch: { target: 'defaultBranch', kind: 'branch' },
  skipAgentsMd: { target: 'skipAgentsMd', kind: 'boolean' },
  skipContextFiles: { target: 'skipAgentsMd', kind: 'boolean' },
  skipAiContext: { target: 'skipAgentsMd', kind: 'boolean' },
  skipSkills: { target: 'skipSkills', kind: 'boolean' },
  pdg: { target: 'pdg', kind: 'boolean' },
  indexOnly: { target: 'indexOnly', kind: 'boolean' },
  stats: { target: 'stats', kind: 'boolean' },
  noStats: { target: 'stats', kind: 'boolean-negate' },
  embeddings: { target: 'embeddings', kind: 'embeddings' },
  dropEmbeddings: { target: 'dropEmbeddings', kind: 'boolean' },
  name: { target: 'name', kind: 'string' },
  allowDuplicateName: { target: 'allowDuplicateName', kind: 'boolean' },
  maxFileSize: { target: 'maxFileSize', kind: 'numeric-string' },
  workerTimeout: { target: 'workerTimeout', kind: 'numeric-string' },
  walCheckpointThreshold: { target: 'walCheckpointThreshold', kind: 'numeric-string' },
  workers: { target: 'workers', kind: 'numeric-string' },
  embeddingThreads: { target: 'embeddingThreads', kind: 'numeric-string' },
  embeddingBatchSize: { target: 'embeddingBatchSize', kind: 'numeric-string' },
  embeddingSubBatchSize: { target: 'embeddingSubBatchSize', kind: 'numeric-string' },
  embeddingDevice: { target: 'embeddingDevice', kind: 'string' },
  // #1589/#1852 residual — extra fetch-wrapper function names to treat as HTTP
  // consumers. The auto-detector only flags functions that call the bare global
  // `fetch()`; a wrapper built on axios / a custom client, or named outside the
  // built-in convention set, is otherwise invisible to route_map consumers.
  // Listing it here adds it to the cross-file consumer scan.
  fetchWrappers: { target: 'fetchWrappers', kind: 'string-array' },
  // Auth token AND dims are intentionally CLI/env-only — no embeddingAuthToken
  // or embeddingDims key here:
  //   - the token keeps secrets out of a committed .gitnexusrc;
  //   - dims cannot take effect from .gitnexusrc anyway — schema.ts reads
  //     GITNEXUS_EMBEDDING_DIMS at module-load (before .gitnexusrc is loaded in
  //     analyzeCommandImpl), so a config value would size nothing and silently
  //     mismatch the vector column. Use --embedding-dims or GITNEXUS_EMBEDDING_DIMS.
  // (URL/MODEL are safe as config keys: they are read lazily at runtime, not at module-load.)
  embeddingBaseUrl: { target: 'embeddingBaseUrl', kind: 'string' },
  embeddingModel: { target: 'embeddingModel', kind: 'string' },
};

/** Top-level container key for the nested form; not itself an `AnalyzeOptions` field. */
const NESTED_KEY = 'analyze';

const ALLOWED_KEYS_HINT = `Allowed keys: ${Object.keys(KEY_SPECS).join(', ')} (or a nested "${NESTED_KEY}" object).`;

/**
 * Reject control characters and hidden / bidirectional Unicode in a string
 * value. These have no legitimate place in a branch name, registry name, or
 * device string, and would otherwise let a committed config smuggle invisible
 * controls into generated AGENTS.md / CLAUDE.md content.
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
      throw new GitNexusRcError(
        `${source}: value contains control or hidden/bidirectional characters, which are not allowed.`,
      );
    }
  }
};

/**
 * Validate a user-supplied branch name (from CLI or `.gitnexusrc`). Returns the
 * trimmed name or throws {@link GitNexusRcError}. Conservative but accepts the
 * shapes real branches use (`feature/foo-bar`, `release/1.2`, `develop`).
 */
export function validateBranchName(value: string, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GitNexusRcError(`${source}: branch name must not be empty.`);
  }
  if (trimmed.length > BRANCH_MAX_LENGTH) {
    throw new GitNexusRcError(`${source}: branch name is too long (max ${BRANCH_MAX_LENGTH}).`);
  }
  assertNoHiddenChars(trimmed, source);
  if (/\s/.test(trimmed)) {
    throw new GitNexusRcError(`${source}: branch name must not contain whitespace.`);
  }
  // git ref-name rules (subset): reject characters git itself forbids in refs.
  if (/[~^:?*[\\]/.test(trimmed)) {
    throw new GitNexusRcError(
      `${source}: branch name contains characters not allowed in a git ref (~ ^ : ? * [ \\).`,
    );
  }
  if (trimmed.startsWith('-')) {
    throw new GitNexusRcError(`${source}: branch name must not start with "-".`);
  }
  if (trimmed.includes('..')) {
    throw new GitNexusRcError(`${source}: branch name must not contain "..".`);
  }
  // Git permits a backtick in a ref, but the branch is embedded inside a
  // Markdown inline-code span in the generated AGENTS.md/CLAUDE.md regression
  // example, where a backtick would close the span early and let the rest of
  // the template render as instruction text. Reject it at this single
  // chokepoint so all three tiers (CLI flag, .gitnexusrc, auto-detect via
  // sanitizeDetectedBranch) are covered (#1996 tri-review P1).
  if (trimmed.includes('`')) {
    throw new GitNexusRcError(
      `${source}: branch name must not contain a backtick (it would break the generated Markdown).`,
    );
  }
  return trimmed;
}

/**
 * Best-effort validation for an auto-detected branch (from git). Never throws —
 * returns `undefined` for anything unusable so the resolver falls back to the
 * next precedence tier.
 */
export function sanitizeDetectedBranch(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return validateBranchName(value, 'detected branch');
  } catch {
    return undefined;
  }
}

const normalizeValue = (kind: ValueKind, value: unknown, key: string): unknown => {
  const source = `${GITNEXUS_RC_FILENAME} "${key}"`;
  switch (kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new GitNexusRcError(`${source} must be a boolean (true/false).`);
      }
      return value;
    case 'boolean-negate':
      if (typeof value !== 'boolean') {
        throw new GitNexusRcError(`${source} must be a boolean (true/false).`);
      }
      return !value;
    case 'branch':
      if (typeof value !== 'string') {
        throw new GitNexusRcError(`${source} must be a string branch name.`);
      }
      return validateBranchName(value, source);
    case 'string': {
      if (typeof value !== 'string') {
        throw new GitNexusRcError(`${source} must be a string.`);
      }
      const trimmed = value.trim();
      if (!trimmed) {
        throw new GitNexusRcError(`${source} must not be empty.`);
      }
      assertNoHiddenChars(trimmed, source);
      // `name` flows into the generated AGENTS.md/CLAUDE.md as `**${name}**` and
      // inside `gitnexus://repo/${name}/…` code spans, so a Markdown-significant
      // character would break those spans or inject emphasis/links/HTML into
      // agent-instruction content (#1996 tri-review P1). `_` is intentionally
      // allowed (legitimate in repo names; intraword `_` is not emphasis).
      // embeddingDevice (the other `string`-kind option) only ever holds a
      // fixed device token, so this guard never rejects a valid value there.
      if (/[`*[\]<>]/.test(trimmed)) {
        throw new GitNexusRcError(
          `${source} must not contain Markdown-significant characters (\` * [ ] < >).`,
        );
      }
      return trimmed;
    }
    case 'string-array': {
      // Generic shared validator — `source` already names the config key, so
      // messages here stay key-agnostic (no fetch-wrapper coupling in the
      // shared normalizer; #1589/#1852 review F7).
      if (!Array.isArray(value)) {
        throw new GitNexusRcError(`${source} must be an array of strings.`);
      }
      const names: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') {
          throw new GitNexusRcError(`${source} entries must all be strings.`);
        }
        const trimmed = item.trim();
        if (!trimmed) {
          throw new GitNexusRcError(`${source} entries must not be empty.`);
        }
        assertNoHiddenChars(trimmed, source);
        // Values may be interpolated into a RegExp downstream. Restrict to
        // identifier / member-access shapes so a config value can never smuggle
        // regex metacharacters into a consumer.
        if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(trimmed)) {
          throw new GitNexusRcError(
            `${source} entry "${trimmed}" must be an identifier or member name ` +
              `(letters, digits, _, $, . — e.g. "client.get").`,
          );
        }
        names.push(trimmed);
      }
      if (names.length === 0) {
        throw new GitNexusRcError(`${source} must list at least one string.`);
      }
      // De-duplicate and cap to a sane bound so a pathological config cannot
      // blow up the consumer scan's alternation.
      return Array.from(new Set(names)).slice(0, 100);
    }
    case 'numeric-string': {
      // Mirror Commander's contract: these options reach the existing CLI
      // validation as strings. Accept a JSON number or a string; normalize to a
      // string and let the downstream per-flag validation enforce ranges so the
      // error messages stay in one place.
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new GitNexusRcError(`${source} must be a finite number.`);
        }
        return String(value);
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          throw new GitNexusRcError(`${source} must not be empty.`);
        }
        return trimmed;
      }
      throw new GitNexusRcError(`${source} must be a number or numeric string.`);
    }
    case 'embeddings': {
      // Mirror `--embeddings [limit]`: boolean toggles, a non-negative integer
      // sets the node cap (normalized to a string, as Commander would supply).
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) {
          throw new GitNexusRcError(
            `${source} must be true/false or a non-negative integer (node cap; 0 disables the cap).`,
          );
        }
        return String(value);
      }
      throw new GitNexusRcError(
        `${source} must be a boolean or a non-negative integer (node cap; 0 disables the cap).`,
      );
    }
    default:
      // Exhaustive — kept for forward-compat if a new kind is added.
      throw new GitNexusRcError(`${source}: unsupported config value kind.`);
  }
};

/**
 * Normalize one level (flat top-level or the nested `analyze` block) into a
 * partial `AnalyzeOptions`. Rejects unknown keys and two aliases that configure
 * the same option at the same level.
 */
const normalizeLevel = (
  obj: Record<string, unknown>,
  { allowNestedKey }: { allowNestedKey: boolean },
): Partial<AnalyzeOptions> => {
  const out: Partial<AnalyzeOptions> = {};
  const setBy = new Map<keyof AnalyzeOptions, string>();

  for (const [key, value] of Object.entries(obj)) {
    if (allowNestedKey && key === NESTED_KEY) continue; // handled separately
    // `Object.hasOwn`, not a truthiness check: a plain-object lookup like
    // `KEY_SPECS["__proto__"]` returns an inherited member (Object.prototype,
    // truthy) and would slip past `if (!spec)`, hitting the wrong error branch
    // instead of the documented "Unknown key" message (#1996 tri-review P3).
    if (!Object.hasOwn(KEY_SPECS, key)) {
      throw new GitNexusRcError(
        `Unknown key "${key}" in ${GITNEXUS_RC_FILENAME}. ${ALLOWED_KEYS_HINT}`,
      );
    }
    const spec = KEY_SPECS[key];
    const prev = setBy.get(spec.target);
    if (prev && prev !== key) {
      throw new GitNexusRcError(
        `${GITNEXUS_RC_FILENAME}: "${prev}" and "${key}" both configure the same option; set only one.`,
      );
    }
    setBy.set(spec.target, key);
    (out as Record<string, unknown>)[spec.target] = normalizeValue(spec.kind, value, key);
  }

  return out;
};

/**
 * Locate, read, parse, validate, and normalize `.gitnexusrc` at `repoRoot`.
 *
 * @returns the normalized config defaults, or `undefined` when no file exists
 *          (the normal case). Throws {@link GitNexusRcError} on any problem.
 */
export function loadAnalyzeConfig(repoRoot: string): Partial<AnalyzeOptions> | undefined {
  const filePath = path.join(repoRoot, GITNEXUS_RC_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new GitNexusRcError(`Could not read ${GITNEXUS_RC_FILENAME}: ${(err as Error).message}`);
  }

  // Strip a leading UTF-8 BOM: Node's 'utf-8' decode keeps it, and JSON.parse
  // then fails with a confusing "Unexpected token" on an otherwise-valid file
  // (#1996 tri-review). Only one leading BOM is stripped; in-string control
  // rejection still applies to the parsed values.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GitNexusRcError(
      `${GITNEXUS_RC_FILENAME} is not valid JSON: ${(err as Error).message}. ` +
        `Expected a JSON object such as {"defaultBranch": "develop", "skipContextFiles": true}.`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GitNexusRcError(`${GITNEXUS_RC_FILENAME} must contain a JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  const flat = normalizeLevel(obj, { allowNestedKey: true });

  let nested: Partial<AnalyzeOptions> = {};
  if (Object.prototype.hasOwnProperty.call(obj, NESTED_KEY)) {
    const nestedRaw = obj[NESTED_KEY];
    if (nestedRaw === null || typeof nestedRaw !== 'object' || Array.isArray(nestedRaw)) {
      throw new GitNexusRcError(`${GITNEXUS_RC_FILENAME} "${NESTED_KEY}" must be a JSON object.`);
    }
    nested = normalizeLevel(nestedRaw as Record<string, unknown>, { allowNestedKey: false });
  }

  // Nested `analyze` block overrides flat top-level keys for the same option.
  return { ...flat, ...nested };
}

/**
 * Merge CLI options over `.gitnexusrc` defaults. CLI wins whenever it provides a
 * value — including an explicit `false` (so an explicit CLI off-switch beats a
 * config `true`). Config fills only the genuinely-unset (`undefined`) options.
 *
 * `stats` is special: Commander always materializes it (`true` by default,
 * `false` only when `--no-stats` is passed), so plain `??` can't tell "default
 * on" from "explicitly on". The rule is: a passed `--no-stats` (`stats: false`)
 * always wins; otherwise the config value applies. There is intentionally no
 * `--stats` counter-flag, so config can only turn stats off, not force it back
 * on against a `--no-stats`.
 *
 * `defaultBranch` is NOT resolved here — see {@link resolveDefaultBranch}, which
 * applies the CLI > config > auto-detect > "main" precedence chain.
 */
export function mergeAnalyzeOptions(
  cli: AnalyzeOptions,
  config: Partial<AnalyzeOptions> | undefined,
): AnalyzeOptions {
  if (!config) return cli;

  const merged: AnalyzeOptions = { ...cli };
  for (const key of Object.keys(config) as (keyof AnalyzeOptions)[]) {
    if (key === 'stats' || key === 'defaultBranch') continue; // handled below / by resolver
    if (merged[key] === undefined) {
      (merged as Record<string, unknown>)[key] = config[key];
    }
  }

  if (config.stats !== undefined && cli.stats !== false) {
    merged.stats = config.stats;
  }

  return merged;
}

/**
 * Resolve the default branch threaded into generated context, applying the
 * precedence chain:
 *
 *   CLI `--default-branch` > `.gitnexusrc` `defaultBranch`/`branch`
 *     > auto-detected `origin/HEAD` > {@link DEFAULT_BRANCH_FALLBACK} ("main").
 *
 * User-supplied values (CLI, config) are validated strictly and throw on bad
 * input. The auto-detected value is best-effort and silently ignored if
 * unusable.
 */
export function resolveDefaultBranch(input: {
  cliBranch?: string;
  configBranch?: string;
  detectedBranch?: string | null;
}): string {
  if (input.cliBranch !== undefined) {
    return validateBranchName(input.cliBranch, '--default-branch');
  }
  if (input.configBranch !== undefined) {
    return validateBranchName(input.configBranch, `${GITNEXUS_RC_FILENAME} "defaultBranch"`);
  }
  const detected = sanitizeDetectedBranch(input.detectedBranch);
  if (detected) return detected;
  return DEFAULT_BRANCH_FALLBACK;
}
