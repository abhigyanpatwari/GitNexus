/**
 * Package-owned Claude-schema hook runtime. Both setup-installed launchers and
 * the standalone Claude plugin load this through the same package entrypoint.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  hasGitNexusDbLockedByGitNexusServer,
  resolveUnixGuardTimeout,
} = require('./hook-db-lock-probe.cjs');
const { formatAnalyzeCommand } = require('./resolve-analyze-cmd.cjs');
const { resolveHookRepo } = require('./registry-query.cjs');

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
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e',
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

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
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
 * `pattern` is embedded verbatim; sendHookResponse JSON-escapes it structurally.
 */
function buildMcpQueryHint(pattern) {
  return (
    `[GitNexus] Local augment was skipped because the graph DB may be held by ` +
    `another GitNexus process. If the GitNexus MCP tools are live in this session, call ` +
    `the GitNexus \`query\` MCP tool (e.g. mcp__gitnexus__query) with ` +
    `search_query "${pattern}".`
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

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input, { resolveCli, acquireHookSlot }) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const pattern = extractPattern(toolName, toolInput);
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
        result = buildMcpQueryHint(pattern);
      }
    } else {
      const target = resolveCli();
      if (!target) {
        if (isDebugEnabled()) {
          process.stderr.write('[GitNexus] augment skipped: packaged CLI is unavailable\n');
        }
        return;
      }
      const child = runGitNexusCli(target, ['augment', '--', pattern], cwd, 7000);
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
function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Bash') return;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return;

  // Only proceed if the command succeeded
  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const repo = resolveHookRepo(cwd);
  if (!repo) return;

  // Compare HEAD against last indexed commit — skip if unchanged
  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return;
  }

  if (!currentHead) return;

  let lastCommit = '';
  let hadEmbeddings = false;
  const meta = repo.metadata;
  if (meta) {
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  }

  // If HEAD matches last indexed commit, no reindex needed
  if (currentHead === lastCommit) return;

  const analyzeCmd = formatAnalyzeCommand({ embeddings: hadEmbeddings, indexOnly: true });
  sendHookResponse(
    'PostToolUse',
    `GitNexus index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
      `Run \`${analyzeCmd}\` to update the knowledge graph.`,
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
