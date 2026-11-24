#!/usr/bin/env node
/**
 * GitNexus Antigravity / Gemini CLI Hook Adapter
 *
 * Bridges the Gemini CLI hooks contract (also used by Antigravity 2.0 — see
 * https://geminicli.com/docs/hooks/reference/) to the same graph-aware
 * augmentation / staleness signals the Claude Code hook provides.
 *
 * Schema differences from the Claude adapter:
 *   - Events are BeforeTool / AfterTool (not PreToolUse / PostToolUse).
 *   - Tool names are snake_case (run_shell_command, search_file_content, glob).
 *   - BeforeTool cannot inject context — decision: "allow" provides no channel
 *     to surface text to the agent. Augmentation therefore runs in AfterTool,
 *     where `hookSpecificOutput.additionalContext` is appended to the tool
 *     result the agent sees.
 *   - Stale-index hints after Git mutations are
 *     surfaced via the same `additionalContext` channel (so the agent reads
 *     them, not only the user) and mirrored to stderr for terminal users.
 *   - Stdin uses `tool_name`, `tool_input`, and `tool_response`
 *     (with `llmContent`, `returnDisplay`, optional `error`).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.cjs');
const {
  hasGitNexusDbLockedByGitNexusServer,
  resolveUnixGuardTimeout,
} = require('./hook-db-lock-probe.cjs');
const { formatAnalyzeCommand } = require('./resolve-analyze-cmd.cjs');
const {
  gitMutationDirectories,
  readHead,
  canSkipMarkdownReindex,
} = require('./git-mutation-command.cjs');
const { searchCommandPatterns } = require('./search-command-pattern.cjs');
const { resolveHookRepo } = (() => {
  // Installed copies get helpers next to this adapter. The in-tree source
  // tree only ships the adapter, so fall back to the Claude helper copies.
  const local = path.join(__dirname, 'registry-query.cjs');
  return fs.existsSync(local) ? require(local) : require('../claude/registry-query.cjs');
})();

// run_shell_command goes through `powershell.exe -NoProfile -Command` on
// Windows and `bash -c` everywhere else.
const SHELL = process.platform === 'win32' ? 'powershell' : 'bash';

// Index metadata is a file in the repository: only a commit id is echoed.
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;

function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function hasGitNexusServerOwner(lbugPath) {
  return hasGitNexusDbLockedByGitNexusServer(lbugPath, process.pid);
}

/**
 * Whether opt-in diagnostics should be written to the hook's stderr. Strict
 * hook runners validate hook output, so normal, non-error skip paths must stay
 * silent unless the operator explicitly asks for diagnostics via GITNEXUS_DEBUG.
 * See issue #1913.
 */
function isDebugEnabled() {
  return process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true';
}

function extractAugmentContext(stderr) {
  const output = (stderr || '').trim();
  const marker = output.indexOf('[GitNexus]');
  const debug = isDebugEnabled();
  if (debug && output.length > 0) {
    // Emit the FULL discarded prefix (everything before the marker, or all of
    // it when no marker is present) so suppressed diagnostics — LadybugDB lock
    // warnings, parser errors, etc. — remain recoverable on the hook's own
    // stderr. Mirrors the Claude adapter's debug behavior.
    const discarded = marker === -1 ? output : output.slice(0, marker).trim();
    if (discarded.length > 0) {
      process.stderr.write(`[GitNexus hook] augment stderr discarded prefix:\n${discarded}\n`);
    }
  }
  return marker === -1 ? '' : output.slice(marker).trim();
}

/**
 * Extract the search patterns from a tool invocation.
 *   - search_file_content / glob: top-level `pattern` (sometimes `query`).
 *   - run_shell_command: up to three literal patterns from a leading rg,
 *     grep or git grep search, including supported wrappers such as npx and
 *     sudo. The shared helper reads the command using this platform's shell rules.
 * Returns an empty list when the tool is not a recognized search or the
 * pattern is too short.
 */
function extractPatterns(toolName, toolInput) {
  if (toolName === 'search_file_content') {
    const q = toolInput.pattern || toolInput.query || '';
    return typeof q === 'string' && q.length >= 3 ? [q] : [];
  }

  if (toolName === 'glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? [match[1]] : [];
  }

  if (toolName === 'run_shell_command') {
    return searchCommandPatterns(toolInput.command, SHELL);
  }

  return [];
}

function resolveCliPath() {
  const fromEnv = process.env.GITNEXUS_HOOK_CLI_PATH;
  if (fromEnv !== undefined && String(fromEnv).trim() && fs.existsSync(String(fromEnv))) {
    return String(fromEnv);
  }
  let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
  if (!fs.existsSync(cliPath)) {
    try {
      cliPath = require.resolve('gitnexus/dist/cli/index.js');
    } catch {
      cliPath = '';
    }
  }
  return cliPath;
}

// Debounce for the unguarded-CLI diagnostic below (#2163 follow-up review):
// at most one line per (short-lived) hook process, even if a future change
// runs the CLI more than once.
let unguardedCliWarned = false;

/**
 * Unix orphan containment (#2163 follow-up): the augment CLI is the
 * longest-lived hook child (inner spawnSync timeout 7s locally, 12s via
 * npx), so on Unix it gets the same SIGKILL-surviving coreutils `timeout`
 * wrapper as the probe's lsof/ps. The wrapper budget is ceil(inner/1000)+1
 * seconds — STRICTLY greater than the inner spawnSync timeout, so on the
 * supervised path Node's SIGTERM always fires first and the existing
 * error/status contract is untouched. Once the hook itself has been
 * SIGKILLed (exactly the orphan case the wrapper exists for), the guard
 * semantics differ per branch:
 *   - direct exec (the CLI is the guard's CHILD): `-k 1` TERM-first — a
 *     SIGTERM-immune CLI can hold the guard ~1s past the inner timeout
 *     before the `-k` SIGKILL escalation reaps it.
 *   - npx (the CLI is a GRANDCHILD: guard → npx → CLI): `-s KILL` — the
 *     budget expiry SIGKILLs the whole process group outright. TERM-first
 *     would kill only the obedient npx parent, making `timeout` reap it and
 *     return before the `-k` escalation ever fires, stranding a
 *     SIGTERM-immune CLI grandchild unbounded (reproduced on coreutils
 *     9.x). `-k 1` is retained alongside `-s KILL` as a harmless belt: with
 *     `-s KILL` the `-k` escalation signal is also KILL. Two residual gaps
 *     on this branch, both bounded by "no worse than pre-fix" (where the
 *     grandchild received no signal at all): the group-wide SIGKILL is
 *     coreutils semantics — a busybox `timeout` passes the self-test (it
 *     has `-k` and propagates exit status) but signals only its direct
 *     child, so a busybox guard cannot reach the grandchild; and on the
 *     SUPERVISED path (hook alive, inner spawnSync timeout SIGTERMs the
 *     guard) coreutils forwards TERM rather than the `-s` signal, npx dies,
 *     and the guard exits before any KILL fires — so a SIGTERM-immune CLI
 *     grandchild still escapes in those two cases.
 * If the sibling probe predates the resolveUnixGuardTimeout export (version
 * skew), the adapter degrades to the unwrapped invocation instead of
 * throwing. Windows is deliberately NOT wrapped — there is no coreutils
 * timeout to resolve there and the resolver's self-test spawns /bin/sh — so
 * on win32 (the npx.cmd path) and whenever the guard resolves to null (e.g.
 * macOS without Homebrew coreutils — reported once under GITNEXUS_DEBUG)
 * the argv stays byte-identical to the pre-wrap invocation.
 */
function runGitNexusCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  // Version-skew guard (#2163 follow-up review): an older sibling probe
  // without the resolveUnixGuardTimeout export must degrade to the unwrapped
  // invocation — a TypeError here would be swallowed by the caller's catch
  // and silently kill the augment.
  const guard =
    isWin || typeof resolveUnixGuardTimeout !== 'function' ? null : resolveUnixGuardTimeout();
  if (!isWin && !guard && !unguardedCliWarned && isDebugEnabled()) {
    // Diagnose the "stays unwrapped" Unix paths once per hook process: no
    // usable coreutils timeout/gtimeout (e.g. macOS without Homebrew
    // coreutils), GITNEXUS_HOOK_TIMEOUT_PATH=disabled, or probe skew above.
    unguardedCliWarned = true;
    process.stderr.write(
      '[GitNexus hook] no usable timeout/gtimeout guard; augment CLI child runs unguarded\n',
    );
  }
  if (cliPath) {
    const [cmd, cmdArgs] = guard
      ? [
          guard,
          ['-k', '1', String(Math.ceil(timeout / 1000) + 1), process.execPath, cliPath, ...args],
        ]
      : [process.execPath, [cliPath, ...args]];
    return spawnSync(cmd, cmdArgs, {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  // A non-null guard implies non-Windows, so the wrapped arm can hardcode
  // plain `npx`. The wrapped arm leads with `-s KILL` (NOT TERM-first like
  // the direct branch above): the CLI here is a grandchild behind npx — see
  // the docblock.
  const [cmd, cmdArgs] = guard
    ? [
        guard,
        [
          '-s',
          'KILL',
          '-k',
          '1',
          String(Math.ceil((timeout + 5000) / 1000) + 1),
          'npx',
          '-y',
          'gitnexus',
          ...args,
        ],
      ]
    : [isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args]];
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function writeAdditionalContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'AfterTool',
        additionalContext: text,
      },
    }),
  );
}

function toolSucceeded(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return true;
  if (toolResponse.error) return false;
  if (toolResponse.exit_code != null && Number(toolResponse.exit_code) !== 0) return false;
  return true;
}

/**
 * Compute the additionalContext for a tool result, if any.
 *   1. Graph augment for search-like tools (search_file_content, glob,
 *      run_shell_command-with-rg/grep) that completed successfully.
 *   2. Stale-index hint after a successful Git mutation.
 * Returns null when nothing is to be appended.
 */
function buildAfterToolContext(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return null;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response || {};
  const succeeded = toolSucceeded(toolResponse);
  const patterns = succeeded ? extractPatterns(toolName, toolInput) : [];
  const pattern = patterns[0] ?? null;
  const command = toolName === 'run_shell_command' ? toolInput.command || '' : '';
  // Where each git mutation ran: the directory of the command, or the one
  // `git -C` names. `dir_path` is relative to the workspace root.
  const shellCwd =
    typeof toolInput.dir_path === 'string' ? path.resolve(cwd, toolInput.dir_path) : cwd;
  const gitCwds = succeeded ? gitMutationDirectories(command, shellCwd, SHELL) : [];
  // Cheap tool-result guards first. Registry I/O is only for search augment
  // or a git mutation that might need a stale-index hint.
  if (!pattern && gitCwds.length === 0) return null;

  const repo = pattern || gitCwds.includes(cwd) ? resolveHookRepo(cwd) : null;
  const parts = [];

  if (pattern && repo) {
    const augmentText = runAugment(repo.storagePath, repo.lbugPath, cwd, patterns);
    if (augmentText) parts.push(augmentText);
  }

  for (const gitCwd of gitCwds) {
    // The index to check belongs to the repository git ran in.
    const gitRepo = gitCwd === cwd ? repo : resolveHookRepo(gitCwd, cwd);
    const hint = gitRepo ? buildStaleIndexHint(gitRepo, gitCwd, cwd) : '';
    if (hint && !parts.includes(hint)) {
      // The hint always reaches the agent via additionalContext (parts). Mirror
      // it to stderr (for terminal users) only under GITNEXUS_DEBUG, so strict
      // hook runners see no unexpected output on this normal path (#1913). The
      // claude hook never mirrored this to stderr — this aligns the two adapters.
      parts.push(hint);
      if (isDebugEnabled()) {
        process.stderr.write(`${hint}\n`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Fallback augmentation for the #2396 path: when a GitNexus process holds the
 * lbug DB write lock the CLI `augment` can't run, so point the agent at the MCP
 * `query` tool instead. Phrased conditionally ("if the MCP tools are live") so it
 * stays truthful on every owner path — a confirmed MCP owner, a `serve` owner, or
 * a fail-closed probe where no server is actually confirmed. Every search pattern
 * is embedded verbatim; the caller (writeAdditionalContext) JSON-escapes them
 * structurally.
 */
function buildMcpQueryHint(patterns) {
  const queries = patterns.map((pattern) => `search_query "${pattern}"`).join(', then ');
  return (
    `[GitNexus] Local augment was skipped because the graph DB may be held by ` +
    `another GitNexus process. If the GitNexus MCP tools are live in this session, call ` +
    `the GitNexus \`query\` MCP tool (e.g. mcp__gitnexus__query) with ` +
    `${queries}.`
  );
}

/**
 * #2396 throttle: emit the MCP-query hint at most once per repo per window, so an
 * owner-locked session isn't nudged on every search. Window (ms) via
 * GITNEXUS_MCP_HINT_THROTTLE_MS (default 10min; 0/invalid disables). Best-effort —
 * any fs error falls back to emitting.
 * ponytail: per-repo mtime marker, shared across concurrent sessions on the same
 * repo; add per-session dedup only if that sharing becomes a problem.
 */
function shouldEmitMcpHint(storagePath) {
  const raw = process.env.GITNEXUS_MCP_HINT_THROTTLE_MS;
  const windowMs = raw === undefined || raw === '' ? 600000 : Number(raw);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return true;
  const marker = path.join(storagePath, '.mcp-hint-shown');
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < windowMs) return false;
  } catch {
    /* marker missing/unreadable → emit */
  }
  try {
    fs.writeFileSync(marker, '');
  } catch {
    /* best-effort; still emit */
  }
  return true;
}

function runAugment(storagePath, lbugPath, cwd, patterns) {
  // Acquire the per-repo slot BEFORE the DB-owner probe (#2163): the probe
  // itself spawns lsof/ps, so it must be bounded by the same ≤3-per-repo cap
  // as the augment, or concurrent sessions fan out unbounded probe
  // subprocesses. The cheap guards (extractPatterns, registry lookup) run in
  // buildAfterToolContext before this — moving the acquire any earlier would
  // churn slot files on tool calls that never probe.
  const release = acquireHookSlot(storagePath);
  if (!release) {
    // Normal skip path: all per-repo hook slots are held by concurrent
    // sessions. Stay silent for strict hook runners (issue #1913); surface
    // the reason only under GITNEXUS_DEBUG.
    if (isDebugEnabled()) {
      process.stderr.write('[GitNexus] augment skipped: hook slots saturated\n');
    }
    return '';
  }
  try {
    if (hasGitNexusServerOwner(lbugPath)) {
      // #2396: the MCP server holds the DB write lock, so a competing CLI
      // `augment` would only contend on it (LadybugDB is single-writer). The
      // session has the GitNexus MCP tools live — route the augmentation to the
      // agent via additionalContext instead of dropping it. Mirror the skip
      // reason to stderr only under GITNEXUS_DEBUG (strict-runner contract,
      // #1913); the hint itself rides the sanctioned additionalContext channel.
      if (isDebugEnabled()) {
        process.stderr.write('[GitNexus] augment skipped: MCP server owns DB\n');
      }
      return shouldEmitMcpHint(storagePath) ? buildMcpQueryHint(patterns) : '';
    }
    const cliPath = resolveCliPath();
    const child = runGitNexusCli(cliPath, ['augment', '--', ...patterns], cwd, 7000);
    if (!child.error && child.status === 0) {
      return extractAugmentContext(child.stderr || '');
    }
  } catch {
    /* graceful failure */
  } finally {
    release();
  }
  return '';
}

function buildStaleIndexHint(repo, gitCwd, cwd) {
  const meta = repo.metadata;
  const { head: currentHead, checkout } = readHead(gitCwd, cwd);
  if (!currentHead) return '';

  let lastCommit = '';
  let hadEmbeddings = false;
  if (meta) {
    lastCommit = typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  }

  if (
    currentHead === lastCommit ||
    canSkipMarkdownReindex(gitCwd, cwd, lastCommit, currentHead, resolveCliPath)
  )
    return '';

  const analyzeCmd = formatAnalyzeCommand({ embeddings: hadEmbeddings, indexOnly: true });
  const indexed = !lastCommit
    ? 'never'
    : COMMIT_ID.test(lastCommit)
      ? lastCommit.slice(0, 7)
      : 'unknown';
  // Name the checkout git ran in when the agent works in another one.
  const where = checkout ? ` in ${checkout}` : '';
  return (
    `[GitNexus] index is stale (last indexed: ${indexed}). ` +
    `Run \`${analyzeCmd}\`${where} to refresh the knowledge graph.`
  );
}

function handleAfterTool(input) {
  const context = buildAfterToolContext(input);
  if (context) writeAdditionalContext(context);
}

const handlers = {
  AfterTool: handleAfterTool,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error('GitNexus antigravity hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
