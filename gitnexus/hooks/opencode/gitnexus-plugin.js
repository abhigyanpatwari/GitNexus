/**
 * GitNexus OpenCode plugin.
 *
 * Gives OpenCode the same two graph-aware behaviors the Claude Code /
 * Antigravity hook adapters provide, through OpenCode's official plugin
 * surface (`tool.execute.after` — see https://opencode.ai/docs/plugins/):
 *
 *   - Search augmentation — after `grep` / `glob` / `bash` (rg/grep) tool
 *     calls, runs `gitnexus augment <pattern>` in the project directory and
 *     appends the `[GitNexus]` graph context to the tool result the agent
 *     reads. (Augmentation runs after the tool — rather than before it —
 *     because `tool.execute.before` can only rewrite args, not append result
 *     context; this mirrors the Antigravity AfterTool decision.)
 *   - Stale-index hint — after `bash` git mutation commands
 *     (commit/merge/rebase/cherry-pick/pull), runs `gitnexus status --json`
 *     and nudges the agent to re-run `gitnexus analyze` when the index is
 *     stale. A full reindex is never triggered from the hook: it would block
 *     the agent and risks DB contention on timeout.
 *
 * Installed by `gitnexus setup` to `~/.config/opencode/plugins/gitnexus.js`
 * (auto-loaded by OpenCode, no config edit needed). Removed by
 * `gitnexus uninstall --force`.
 *
 * Design notes:
 *   - Self-contained (node builtins only). The `hooks/claude/*.cjs` helpers
 *     are deliberately NOT reused here: files placed in OpenCode's plugin
 *     directory are auto-loaded as plugins, so co-locating helper modules
 *     risks OpenCode invoking them as plugin initializers; and the CJS/ESM
 *     boundary plus Bun/Node dual runtime makes cross-require fragile.
 *     Repo resolution, locking and DB-ownership probing are delegated to the
 *     `gitnexus` CLI itself, which already resolves the registry by cwd and
 *     fails gracefully (empty output) when there is no index.
 *   - Silent by default. Normal skip paths stay quiet unless
 *     `GITNEXUS_DEBUG=1` (strict-runner contract, same as the other
 *     adapters): a hook must never break the agent session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKER = '[GitNexus]';

function getHereDir() {
  try {
    const meta = import.meta;
    if (meta && typeof meta.dirname === 'string') return meta.dirname;
    // Bun exposes import.meta.dir instead of import.meta.dirname.
    if (meta && typeof meta.dir === 'string') return meta.dir;
  } catch {
    /* import.meta unavailable — fall through */
  }
  return '.';
}

const HERE_DIR = getHereDir();

/** Resolved at install time by `gitnexus setup` (same patch pattern as the
 * Claude/Antigravity adapters). Falls back to PATH lookup at runtime. */
let cliPath = path.resolve(HERE_DIR, '..', '..', 'dist', 'cli', 'index.js');

function isDebugEnabled() {
  return process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true';
}

function debugLog(message) {
  if (isDebugEnabled()) process.stderr.write(`[GitNexus plugin] ${message}\n`);
}

/**
 * Keep only the `[GitNexus]`-marked payload from the CLI's stderr (the CLI
 * writes diagnostics there too — see `augment.ts`). Returns '' when the
 * marker is absent.
 */
export function extractAugmentContext(stderr) {
  const output = (stderr || '').trim();
  const marker = output.indexOf(MARKER);
  if (marker === -1) return '';
  return output.slice(marker).trim();
}

/**
 * rg/grep flags whose following argv token IS the search pattern
 * (`rg -e foo file.ts`, `grep --regexp foo .`). They must not be lumped in
 * with value-consuming flags — skipping the value would augment on the
 * filename instead of the search.
 */
const PATTERN_FLAGS = new Set(['-e', '--regexp', '--expression']);

/** Flags of rg/grep that consume the following argv token as a value. */
const FLAGS_WITH_VALUES = new Set([
  '-f',
  '-m',
  '-A',
  '-B',
  '-C',
  '-g',
  '--glob',
  '-t',
  '--type',
  '--include',
  '--exclude',
]);

/**
 * Split an argv string into tokens, respecting single/double quoting so a
 * multi-word search phrase stays one token: `rg "foo bar"` → [rg, foo bar].
 * Quotes are consumed (they delimit, they are not part of the token).
 */
function tokenizeArgv(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse the first search positional out of an rg/grep argv string.
 * Returns null when the command is not a search or the token is too short.
 */
export function extractBashSearchPattern(command) {
  if (typeof command !== 'string' || !/\brg\b|\bgrep\b/.test(command)) return null;
  const tokens = tokenizeArgv(command);
  let foundCmd = false;
  // 'skip' = drop the next token (flag value); 'pattern' = take it as the search.
  let pending = null;
  for (const token of tokens) {
    if (pending === 'skip') {
      pending = null;
      continue;
    }
    if (pending === 'pattern') {
      pending = null;
      return token.length >= 3 ? token : null;
    }
    if (!foundCmd) {
      if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
      continue;
    }
    if (token.startsWith('-')) {
      if (PATTERN_FLAGS.has(token)) pending = 'pattern';
      else if (FLAGS_WITH_VALUES.has(token)) pending = 'skip';
      continue;
    }
    return token.length >= 3 ? token : null;
  }
  return null;
}

/**
 * Extract a usable search token from an OpenCode tool invocation.
 * Covers the built-in tools (see https://opencode.ai/docs/tools/):
 *   - `grep`: `pattern` (or `query`)
 *   - `glob`: file pattern — derive the leading literal token
 *   - `bash`: shell command — only rg/grep invocations
 * Returns null for anything else (incl. `read`: file reads need no
 * augmentation, matching the Claude adapter's Grep|Glob|Bash scope).
 */
export function extractOpenCodePattern(tool, args) {
  const input = args && typeof args === 'object' ? args : {};
  if (tool === 'grep') {
    const q = input.pattern ?? input.query ?? '';
    return typeof q === 'string' && q.length >= 3 ? q : null;
  }
  if (tool === 'glob') {
    const raw = typeof input.pattern === 'string' ? input.pattern : '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }
  if (tool === 'bash') {
    return extractBashSearchPattern(input.command);
  }
  return null;
}

/** True for the git commands that move HEAD (same set as the Claude adapter). */
export function isGitMutationCommand(command) {
  return (
    typeof command === 'string' &&
    /\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)
  );
}

/**
 * Resolve how to invoke the GitNexus CLI (same precedence as the Claude
 * adapter): 1) `GITNEXUS_HOOK_CLI_PATH` when it points at an existing file
 * (test/diagnostic override), 2) the install-patched absolute dist path,
 * 3) a `gitnexus` binary on PATH (shell mode on Windows). Never returns
 * null — the PATH arm is the last resort; callers still guard defensively.
 */
export function resolveCliInvocation() {
  const fromEnv = process.env.GITNEXUS_HOOK_CLI_PATH;
  if (fromEnv && String(fromEnv).trim()) {
    try {
      if (fs.existsSync(String(fromEnv))) {
        return { cmd: process.execPath, argv: [String(fromEnv)], useShell: false };
      }
    } catch {
      /* unreadable env path — fall through */
    }
  }
  try {
    if (typeof cliPath === 'string' && cliPath && fs.existsSync(cliPath)) {
      return { cmd: process.execPath, argv: [cliPath], useShell: false };
    }
  } catch {
    /* fall through to PATH lookup */
  }
  return { cmd: 'gitnexus', argv: [], useShell: process.platform === 'win32' };
}

/**
 * Shell metacharacters that would let a search pattern inject commands when
 * the CLI must be invoked through a shell (the Windows PATH fallback — the
 * only useShell arm; node+dist and non-Windows PATH arms never use a shell).
 * A pattern containing any of these is dropped: a skipped augment is always
 * safe, a successfully injected command is not.
 */
const SHELL_UNSAFE_RE = /[&|<>^"`$;()\r\n%']/;

/** True when pattern must not be forwarded through a shell invocation. */
export function isShellMetaUnsafe(pattern) {
  return typeof pattern === 'string' && SHELL_UNSAFE_RE.test(pattern);
}

/**
 * Shell-mode guard used by runAugment: refuse to spawn when the resolved
 * invocation needs a shell AND the pattern carries metacharacters.
 */
export function shouldSkipAugmentForShell(invocation, pattern) {
  return Boolean(invocation && invocation.useShell && isShellMetaUnsafe(pattern));
}

/**
 * Run `gitnexus augment <pattern>` in `cwd` and return the marked context,
 * or '' on any failure (no repo, no index, lock contention, timeout).
 */
export function runAugment(pattern, cwd) {
  const invocation = resolveCliInvocation();
  if (!invocation) return '';
  // The pattern originates from tool arguments (agent- and repo-influenced).
  // Never forward it through a shell: cmd.exe would re-parse metacharacters
  // (`rg -e foo^& del /f ...`) into extra commands.
  if (shouldSkipAugmentForShell(invocation, pattern)) return '';
  // Shell mode joins argv with bare spaces (no quoting), so a multi-word
  // phrase must be wrapped to stay one argument. Safe: the guard above has
  // already dropped any pattern containing a quote or other metacharacter.
  const forwarded = invocation.useShell ? `"${pattern}"` : pattern;
  try {
    const child = spawnSync(invocation.cmd, [...invocation.argv, 'augment', '--', forwarded], {
      encoding: 'utf-8',
      timeout: 10000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(invocation.useShell ? { shell: true } : {}),
    });
    if (child.error || child.status !== 0) return '';
    return extractAugmentContext(child.stderr || '');
  } catch {
    return '';
  }
}

/**
 * Parse `gitnexus status --json` stdout. Returns the parsed payload or null.
 */
export function parseStatusPayload(stdout) {
  try {
    const payload = JSON.parse(String(stdout || ''));
    if (payload && typeof payload === 'object') return payload;
  } catch {
    /* not JSON — no index / CLI error */
  }
  return null;
}

/**
 * Run `gitnexus status --json` in `cwd`. Returns 'stale' only on a positive
 * stale verdict; every other outcome (up-to-date, not indexed, error) is
 * null so the hook stays silent. Cheap on the stale path: when HEAD moved,
 * the metadata check already disagrees and the content scan is skipped.
 */
export function checkIndexStale(cwd) {
  const invocation = resolveCliInvocation();
  if (!invocation) return null;
  try {
    const child = spawnSync(invocation.cmd, [...invocation.argv, 'status', '--json'], {
      encoding: 'utf-8',
      timeout: 15000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(invocation.useShell ? { shell: true } : {}),
    });
    if (child.error || child.status !== 0) return null;
    const payload = parseStatusPayload(child.stdout || '');
    if (!payload || typeof payload.status !== 'string') return null;
    if (payload.status !== 'stale') return null;
    const indexed = payload?.index?.commit ? String(payload.index.commit).slice(0, 7) : '';
    return (
      `${MARKER} GitNexus index is stale` +
      (indexed ? ` (last indexed: ${indexed})` : '') +
      '. Run `gitnexus analyze` to update the knowledge graph.'
    );
  } catch {
    return null;
  }
}

function appendOutput(output, text) {
  if (!text) return;
  if (typeof output.output === 'string' && output.output.length > 0) {
    output.output += `\n\n${text}`;
  } else if (typeof output.output === 'string') {
    output.output = text;
  }
  // Non-string tool results are left untouched — never coerce agent data.
}

/**
 * `tool.execute.after` handler: augment searches, hint on stale index.
 * `directory` is the project directory captured at plugin init.
 */
export function createAfterHook(directory) {
  return async (input, output) => {
    try {
      if (!input || !output || typeof output !== 'object') return;
      const tool = String(input.tool || '').toLowerCase();
      const args = input.args && typeof input.args === 'object' ? input.args : {};
      const cwd = typeof directory === 'string' && directory ? directory : process.cwd();

      if (tool === 'grep' || tool === 'glob' || tool === 'bash') {
        const pattern = extractOpenCodePattern(tool, args);
        if (pattern) {
          const context = runAugment(pattern, cwd);
          if (context) appendOutput(output, context);
        }
        if (tool === 'bash' && isGitMutationCommand(args.command)) {
          const hint = checkIndexStale(cwd);
          if (hint) appendOutput(output, hint);
        }
      }
    } catch (err) {
      debugLog(`after-hook failed: ${(err && err.message) || err}`);
    }
  };
}

export const GitNexusPlugin = async ({ directory, worktree } = {}) => {
  const projectDir =
    (typeof directory === 'string' && directory) ||
    (typeof worktree === 'string' && worktree) ||
    process.cwd();
  debugLog(`initialized for ${projectDir}`);
  return {
    'tool.execute.after': createAfterHook(projectDir),
  };
};
