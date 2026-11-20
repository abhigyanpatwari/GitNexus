/**
 * Package-owned Claude-schema hook runtime. Both setup-installed launchers and
 * the standalone Claude plugin load this through the same package entrypoint.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const {
  hasGitNexusDbLockedByGitNexusServer,
  resolveUnixGuardTimeout,
} = require('./hook-db-lock-probe.cjs');
const { formatAnalyzeCommand } = require('./resolve-analyze-cmd.cjs');
const { resolveHookRepo } = require('./registry-query.cjs');
const {
  gitMutationDirectories,
  readHead,
  canSkipMarkdownReindex,
} = require('./git-mutation-command.cjs');
const { searchCommandPatterns } = require('./search-command-pattern.cjs');

// Claude Code runs the Bash tool in bash on every platform, Git Bash included.
// Codex reports its shell tool as `Bash` too and runs PowerShell on Windows, so
// there the input does not say which of the two read the command.
const BASH_TOOL_SHELL = process.platform === 'win32' ? 'either' : 'bash';

// Index metadata is a file in the repository: only a commit id is echoed.
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;

/**
 * Read JSON input from stdin synchronously.
 */
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
 * hook runners (e.g. Codex `PreToolUse`) validate hook output, so normal,
 * non-error skip paths must stay silent unless the operator explicitly asks
 * for diagnostics via GITNEXUS_DEBUG. See issue #1913.
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
    // stderr. The untruncated payload lets operators see exactly what was
    // filtered out instead of a 180-char JSON-quoted preview.
    const discarded = marker === -1 ? output : output.slice(0, marker).trim();
    if (discarded.length > 0) {
      process.stderr.write(`[GitNexus hook] augment stderr discarded prefix:\n${discarded}\n`);
    }
  }
  return marker === -1 ? '' : output.slice(marker).trim();
}

/**
 * Extract the search patterns from tool input. A Bash search may carry several
 * (`rg -e FooService -e BarService`); `gitnexus augment` reads them together.
 */
function extractPatterns(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern ? [toolInput.pattern] : [];
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? [match[1]] : [];
  }

  if (toolName === 'Bash') {
    return searchCommandPatterns(toolInput.command, BASH_TOOL_SHELL);
  }

  return [];
}

// Warn once per short-lived hook process when orphan containment is unavailable.
let unguardedCliWarned = false;

/**
 * Execute a CLI target chosen by the installation adapter. A target carries
 * its command and prefix arguments; npx targets need an extra installation
 * budget and process-group KILL because the CLI is a grandchild of the guard.
 * Direct children use TERM followed by KILL. The guard always outlives Node's
 * inner timeout by at least one second, preserving supervised exit behavior.
 *
 * The npx group kill relies on coreutils semantics: busybox guards only signal
 * their direct child. On the supervised path, Node's timeout can also stop the
 * guard before escalation. These existing limitations remain unchanged.
 */
function runGitNexusCli(target, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  const guard = isWin ? null : resolveUnixGuardTimeout();
  if (!isWin && !guard && !unguardedCliWarned && isDebugEnabled()) {
    unguardedCliWarned = true;
    process.stderr.write(
      '[GitNexus hook] no usable timeout/gtimeout guard; augment CLI child runs unguarded\n',
    );
  }
  const effectiveTimeout = timeout + (target.npx ? 5000 : 0);
  const commandArgs = [...target.args, ...args];
  const guardArgs = target.npx ? ['-s', 'KILL', '-k', '1'] : ['-k', '1'];
  return spawnSync(
    guard || target.command,
    guard
      ? [
          ...guardArgs,
          String(Math.ceil(effectiveTimeout / 1000) + 1),
          target.command,
          ...commandArgs,
        ]
      : commandArgs,
    {
      encoding: 'utf-8',
      timeout: effectiveTimeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

/**
 * Fallback augmentation for the #2396 path: the owner probe either found a
 * GitNexus process holding the DB or could not rule one out. Point the agent at
 * the MCP `query` tool conditionally, since an MCP server may not be available.
 * Every search pattern is embedded verbatim; sendHookResponse JSON-escapes them
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

// A prepared, nonempty directory makes publication atomic. Unique owner names
// prevent delayed cleanup from unlinking a successor's claim. Orphans expire
// beyond the 150s host lifetime; a suspended process must still own its claim
// before publishing a hint. Filesystem failures remain best-effort.
function acquireMcpHintClaim(storagePath) {
  const lock = path.join(storagePath, '.mcp-hint-shown.lock');
  const prepared = fs.mkdtempSync(`${lock}-`);
  const owner = `${randomUUID()}.owner`;
  try {
    fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.renameSync(prepared, lock);
        return {
          owned: () => fs.existsSync(path.join(lock, owner)),
          release: () => {
            try {
              fs.unlinkSync(path.join(lock, owner));
              fs.rmdirSync(lock);
            } catch {
              /* A successor owns a different filename; leave its claim alone. */
            }
          },
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      }
      try {
        const stat = fs.lstatSync(lock);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        const entries = fs.readdirSync(lock);
        if (entries.length === 0) {
          // A crash during release can leave an empty directory. rmdir cannot
          // remove a successor's atomically published nonempty claim.
          fs.rmdirSync(lock);
          continue;
        }
        if (entries.length !== 1 || !/^[0-9a-f-]{36}\.owner$/.test(entries[0])) return null;
        const previous = path.join(lock, entries[0]);
        if (Date.now() - fs.lstatSync(previous).mtimeMs < 180000) return null;
        fs.unlinkSync(previous);
        fs.rmdirSync(lock);
      } catch (error) {
        // Windows can deny access while another process removes the directory.
        // Losing that race is contention, not a reason to emit without a claim.
        if (['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code))
          return null;
        throw error;
      }
    }
    return null;
  } finally {
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}

/**
 * Serialize the rolling-window marker check/update across hook processes.
 * GITNEXUS_MCP_HINT_THROTTLE_MS defaults to 10min; 0/invalid disables it.
 * Unexpected filesystem failures retain the best-effort hint fallback.
 */
function shouldEmitMcpHint(storagePath) {
  const raw = process.env.GITNEXUS_MCP_HINT_THROTTLE_MS;
  const windowMs = raw === undefined || raw === '' ? 600000 : Number(raw);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return true;
  const marker = path.join(storagePath, '.mcp-hint-shown');
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < windowMs) return false;
  } catch {
    /* Missing/unreadable marker: acquire the claim before checking again. */
  }
  let claim;
  try {
    claim = acquireMcpHintClaim(storagePath);
    if (!claim) return false;
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < windowMs) return false;
    } catch {
      /* marker missing/unreadable → emit */
    }
    if (!claim.owned()) return false;
    fs.writeFileSync(marker, '');
    return true;
  } catch {
    return true;
  } finally {
    if (claim) claim.release();
  }
}

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input, { resolveCli, acquireHookSlot }) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const patterns = extractPatterns(toolName, toolInput);
  const pattern = patterns[0];
  if (!pattern || pattern.length < 3) return;

  // Registry row first (persisted external storagePath wins). Local owned
  // `.gitnexus` is only the fallback when no matching registry row exists.
  const repo = resolveHookRepo(cwd);
  if (!repo) return;
  const storagePath = repo.storagePath;

  // Acquire the per-repo slot BEFORE the DB-owner probe (#2163): the probe
  // itself spawns lsof/ps, so it must be bounded by the same ≤3-per-repo cap
  // as the augment, or concurrent sessions fan out unbounded probe
  // subprocesses. Keep the acquire right after the cheap guards above —
  // moving it earlier would churn slot files on tool calls that never probe.
  const release = acquireHookSlot(storagePath);
  if (!release) {
    // Normal skip path: all per-repo hook slots are held by concurrent
    // sessions. Stay silent for strict hook runners (issue #1913); surface
    // the reason only when diagnostics are explicitly requested.
    if (isDebugEnabled()) {
      process.stderr.write('[GitNexus] augment skipped: hook slots saturated\n');
    }
    return;
  }

  let result = '';
  try {
    if (hasGitNexusServerOwner(repo.lbugPath)) {
      // #2396: skip a competing CLI when a GitNexus DB owner is confirmed or
      // the probe is inconclusive. Suggest MCP conditionally via the sanctioned
      // additionalContext channel; mirror the skip reason to stderr only under
      // GITNEXUS_DEBUG (strict-runner contract, #1913).
      if (isDebugEnabled()) {
        process.stderr.write(
          '[GitNexus] augment skipped: graph DB may be held by another GitNexus process\n',
        );
      }
      if (shouldEmitMcpHint(storagePath)) {
        result = buildMcpQueryHint(patterns);
      }
    } else {
      const target = resolveCli();
      if (!target) {
        if (isDebugEnabled()) {
          process.stderr.write('[GitNexus] augment skipped: packaged CLI is unavailable\n');
        }
        return;
      }
      const child = runGitNexusCli(target, ['augment', '--', ...patterns], cwd, 7000);
      if (!child.error && child.status === 0) {
        result = extractAugmentContext(child.stderr || '');
      }
    }
  } catch {
    /* graceful failure */
  } finally {
    release();
  }

  if (result) {
    sendHookResponse('PreToolUse', result);
  }
}

/**
 * Emit a PostToolUse hook response with additional context for the agent.
 */
function sendHookResponse(hookEventName, message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: message },
    }),
  );
}

/**
 * PostToolUse handler — detect index staleness after git mutations.
 *
 * Instead of spawning a full `gitnexus analyze` synchronously (which blocks
 * the agent for up to 120s and risks KuzuDB corruption on timeout), we do a
 * lightweight staleness check: compare `git rev-parse HEAD` against the
 * lastCommit stored in the registered index metadata. If they differ, notify the
 * agent so it can decide when to reindex.
 */
function handlePostToolUse(input, { resolveCli }) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Bash') return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;

  // Only proceed if the command succeeded
  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  // `git -C <dir>` runs elsewhere: the index to check is that directory's.
  const command = (input.tool_input || {}).command || '';
  const hints = [];
  for (const gitCwd of gitMutationDirectories(command, cwd, BASH_TOOL_SHELL)) {
    const hint = staleIndexHint(gitCwd, cwd, () => {
      const target = resolveCli();
      return target?.command === process.execPath ? target.args[0] : null;
    });
    if (hint && !hints.includes(hint)) hints.push(hint);
  }
  if (hints.length > 0) sendHookResponse('PostToolUse', hints.join('\n'));
}

/**
 * The hint for the repository a git mutation ran in, from `gitCwd`. Empty when
 * that repository has no index or its index is at HEAD.
 */
function staleIndexHint(gitCwd, cwd, resolveCliPath) {
  const repo = resolveHookRepo(gitCwd, cwd);
  if (!repo) return '';

  // Compare HEAD against last indexed commit — skip if unchanged
  const { head: currentHead, checkout } = readHead(gitCwd, cwd);
  if (!currentHead) return '';

  let lastCommit = '';
  let hadEmbeddings = false;
  const meta = repo.metadata;
  if (meta) {
    lastCommit = typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  }

  // If HEAD matches last indexed commit, no reindex needed
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
    `GitNexus index is stale (last indexed: ${indexed}). ` +
    `Run \`${analyzeCmd}\`${where} to update the knowledge graph.`
  );
}

// Dispatch map for hook events
const handlers = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
};

function main(options) {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input, options);
  } catch (err) {
    if (isDebugEnabled()) {
      console.error('GitNexus hook error:', (err.message || '').slice(0, 200));
    }
  }
}

module.exports = { runClaudeHook: main, runGitNexusCli };
