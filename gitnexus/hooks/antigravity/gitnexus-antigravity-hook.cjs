#!/usr/bin/env node
/**
 * GitNexus Antigravity Hook Adapter
 *
 * Bridges Antigravity's JSON Hooks (https://antigravity.google/docs/features)
 * to the same graph-aware augmentation / staleness signals that the Claude
 * Code hook provides. Antigravity differs from Claude Code in two ways that
 * matter here:
 *
 *   1. Tool names are snake_case (`grep_search`, `run_command`) instead of
 *      Pascal-case (`Grep`, `Glob`, `Bash`).
 *   2. PostToolUse stdout MUST be `{}` (no `hookSpecificOutput.additionalContext`
 *      injection like Claude). Hints must go to stderr instead.
 *
 * PreToolUse — grep_search and run_command (rg/grep) → runs `gitnexus
 *              augment` and emits `{ decision: "allow", reason: "<graph
 *              context>" }` on stdout when context is found. The
 *              `decision: "allow"` form is the documented way to surface
 *              extra context to Antigravity without blocking the tool call.
 *
 * PostToolUse — run_command after `git commit/merge/rebase/cherry-pick/pull`
 *              → emits a stale-index hint to stderr; stdout is `{}`.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.cjs');
const { hasGitNexusDbLockedByGitNexusServer } = require('./hook-db-lock-probe.cjs');

function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function isGlobalRegistryDir(candidate) {
  if (fs.existsSync(path.join(candidate, 'meta.json'))) return false;
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

function walkForGitNexusDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) {
      if (!isGlobalRegistryDir(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findCanonicalRepoRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 2000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    const commonDir = (result.stdout || '').trim();
    if (!commonDir || !path.isAbsolute(commonDir)) return null;
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

function findGitNexusDir(startDir) {
  const cwd = startDir || process.cwd();
  const fromCwd = walkForGitNexusDir(cwd);
  if (fromCwd) return fromCwd;
  const canonicalRoot = findCanonicalRepoRoot(cwd);
  if (canonicalRoot && canonicalRoot !== cwd) {
    return walkForGitNexusDir(canonicalRoot);
  }
  return null;
}

function hasGitNexusServerOwner(gitNexusDir) {
  return hasGitNexusDbLockedByGitNexusServer(path.join(gitNexusDir, 'lbug'), process.pid);
}

function extractAugmentContext(stderr) {
  const output = (stderr || '').trim();
  const marker = output.indexOf('[GitNexus]');
  return marker === -1 ? '' : output.slice(marker).trim();
}

/**
 * Extract a usable search token from an Antigravity tool invocation.
 * - grep_search: top-level `query` (occasionally `pattern`)
 * - run_command: parse rg/grep argv similar to Bash, returning the first
 *   non-flag positional ≥ 3 chars
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'grep_search') {
    const q = toolInput.query || toolInput.pattern || '';
    return typeof q === 'string' && q.length >= 3 ? q : null;
  }

  if (toolName === 'run_command') {
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

function runGitNexusCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  const toolName = input.tool_name || '';
  if (toolName !== 'grep_search' && toolName !== 'run_command') return;

  const pattern = extractPattern(toolName, input.tool_input || {});
  if (!pattern || pattern.length < 3) return;

  if (hasGitNexusServerOwner(gitNexusDir)) {
    process.stderr.write('[GitNexus] augment skipped: MCP server owns DB\n');
    return;
  }

  const release = acquireHookSlot(gitNexusDir);
  if (!release) return;

  const cliPath = resolveCliPath();
  let context = '';
  try {
    const child = runGitNexusCli(cliPath, ['augment', '--', pattern], cwd, 7000);
    if (!child.error && child.status === 0) {
      context = extractAugmentContext(child.stderr || '');
    }
  } catch {
    /* graceful failure */
  } finally {
    release();
  }

  if (context) {
    // Antigravity surfaces hook context to the agent via { decision: "allow",
    // reason }. The decision is "allow" so the tool still runs — we're
    // augmenting, not blocking.
    process.stdout.write(JSON.stringify({ decision: 'allow', reason: context }));
  }
}

function handlePostToolUse(input) {
  // Antigravity contract: PostToolUse stdout MUST be `{}` (or empty). Hints
  // go to stderr instead so they surface in the agent's tool feedback.
  const writeEmpty = () => process.stdout.write('{}');

  const toolName = input.tool_name || '';
  if (toolName !== 'run_command') {
    writeEmpty();
    return;
  }

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) {
    writeEmpty();
    return;
  }

  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) {
    writeEmpty();
    return;
  }

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) {
    writeEmpty();
    return;
  }

  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) {
    writeEmpty();
    return;
  }

  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    writeEmpty();
    return;
  }

  if (!currentHead) {
    writeEmpty();
    return;
  }

  let lastCommit = '';
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gitNexusDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  } catch {
    /* no meta — treat as stale */
  }

  if (currentHead === lastCommit) {
    writeEmpty();
    return;
  }

  const analyzeCmd = `npx gitnexus analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  process.stderr.write(
    `[GitNexus] index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
      `Run \`${analyzeCmd}\` to refresh the knowledge graph.\n`,
  );
  writeEmpty();
}

const handlers = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus antigravity hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
