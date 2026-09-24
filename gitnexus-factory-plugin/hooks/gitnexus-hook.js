#!/usr/bin/env node
/**
 * GitNexus Factory AI (Droid) plugin hook.
 *
 * PostToolUse — augments Grep/Glob/Execute searches with graph context and
 * returns it via hookSpecificOutput.additionalContext.
 *
 * Reuses the Claude adapter's guards, bundled byte-identical: acquireHookSlot
 * caps concurrent augment children per repo (#1486), and the LadybugDB owner
 * probe skips the CLI augment when an MCP/serve process already holds the
 * single-writer lock (#2396). The repo and its index storage are resolved via
 * the same bundled registry lookup (registry-query.cjs), so external and
 * branch-slot indexes work (#3060). On Unix the augment child runs under the
 * probe's self-tested coreutils `timeout` guard, as in the Claude adapter
 * (#2163), so a hook the runner kills cannot strand the CLI (see runAugment).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.js');
const {
  hasGitNexusDbLockedByGitNexusServer,
  resolveUnixGuardTimeout,
} = require('./hook-db-lock-probe.cjs');
const { resolveHookRepo } = require('./registry-query.cjs');

// Pin the CLI instead of tracking `latest`: npm versions are immutable, so only
// a plugin revision can change what the fallback below executes. The release
// stamps this manifest (gitnexus/scripts/sync-plugin-manifests.mjs).
const { version: PINNED_VERSION } = require('../.factory-plugin/plugin.json');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Split a command the way a POSIX shell would, so quoted and backslash-escaped
 * patterns survive as one token. Kept identical to the Cursor adapter's
 * tokenizer (#2938) so the two can collapse into a shared module later.
 */
function tokenizeShellWords(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      hasToken = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\') {
        const next = command[index + 1];
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          escaped = true;
        } else {
          current += '\\';
        }
      } else {
        current += char;
      }
      hasToken = true;
      continue;
    }

    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined || /\s/.test(next) || next === "'" || next === '"' || next === '\\') {
        escaped = true;
      } else {
        current += '\\' + next;
        index += 1;
      }
      hasToken = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
    } else if (char === ';' || char === '|' || char === '&') {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      const next = command[index + 1];
      if ((char === '|' || char === '&') && next === char) {
        tokens.push(char + char);
        index += 1;
      } else {
        tokens.push(char);
      }
    } else {
      current += char;
      hasToken = true;
    }
  }

  if (escaped) current += '\\';
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Recover the search pattern from an `rg`/`grep` command line. */
function parseRgGrepPattern(cmd) {
  const tokens = tokenizeShellWords(cmd);
  let foundCmd = false;
  let skipNext = false;
  let skipNextAsPattern = false;
  let endOfOptions = false;
  let explicitPatternSeen = false;
  let patternFileSeen = false;
  const flagsWithValues = new Set([
    '-e',
    '-f',
    '--file',
    '-m',
    '--max-count',
    '-A',
    '-B',
    '-C',
    '-g',
    '--glob',
    '--iglob',
    '-t',
    '--type',
    '--include',
    '--exclude',
    '--encoding',
    '--path',
  ]);
  const rgValueFlags = new Set(['-r', '--replace']);
  const patternFlags = new Set(['-e', '--regexp']);
  const connectors = new Set(['&&', '||', ';', '|', '&']);
  const wrappers = new Set([
    'npx',
    'bunx',
    'pnpm',
    'yarn',
    'npm',
    'sudo',
    'env',
    'command',
    'time',
    'nice',
    'xargs',
    'dlx',
    'exec',
    'run',
    'git',
  ]);
  const wrapperFlagsWithValues = new Set([
    '--package',
    '-p',
    '--call',
    '--prefix',
    '--shell',
    '--filter',
    '--workspace',
    '--dir',
    '--cwd',
  ]);
  const basename = (token) =>
    token
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, '');

  let previousToken;
  let seenWrapper = false;
  let searchCommand = null;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      if (skipNextAsPattern) {
        skipNextAsPattern = false;
        if (token.length >= 3) return token;
      }
      previousToken = token;
      continue;
    }
    if (!foundCmd) {
      if (connectors.has(token)) {
        seenWrapper = false;
        previousToken = token;
        continue;
      }
      const commandName = basename(token);
      if (wrappers.has(commandName)) {
        seenWrapper = true;
        previousToken = token;
        continue;
      }
      if (seenWrapper && token.startsWith('-')) {
        const flagName = token.split('=', 1)[0];
        if (!token.includes('=') && wrapperFlagsWithValues.has(flagName)) skipNext = true;
        previousToken = token;
        continue;
      }
      if (seenWrapper && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        previousToken = token;
        continue;
      }
      const atCommandPosition =
        previousToken === undefined ||
        connectors.has(previousToken) ||
        wrappers.has(basename(previousToken)) ||
        seenWrapper;
      if (atCommandPosition && (commandName === 'rg' || commandName === 'grep')) {
        foundCmd = true;
        searchCommand = commandName;
      } else if (seenWrapper) {
        seenWrapper = false;
      }
      previousToken = token;
      continue;
    }
    previousToken = token;
    if (endOfOptions) {
      if (explicitPatternSeen || patternFileSeen) continue;
      return token.length >= 3 ? token : null;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('-')) {
      if (token === '-f' || token === '--file') {
        skipNext = true;
        patternFileSeen = true;
        continue;
      }
      if (token.startsWith('--file=')) {
        patternFileSeen = true;
        continue;
      }
      if (token.startsWith('--regexp=')) {
        explicitPatternSeen = true;
        const value = token.slice('--regexp='.length);
        if (value.length >= 3) return value;
        continue;
      }
      const attachedPattern = token.match(/^-e(.+)$/);
      if (attachedPattern) {
        explicitPatternSeen = true;
        if (attachedPattern[1].length >= 3) return attachedPattern[1];
        continue;
      }
      if (
        flagsWithValues.has(token) ||
        patternFlags.has(token) ||
        (searchCommand === 'rg' && rgValueFlags.has(token))
      ) {
        skipNext = true;
        skipNextAsPattern = patternFlags.has(token);
        if (skipNextAsPattern) explicitPatternSeen = true;
      }
      continue;
    }
    if (explicitPatternSeen || patternFileSeen) continue;
    return token.length >= 3 ? token : null;
  }
  return null;
}

/** Factory's shell tool is `Execute` (Claude's is `Bash`); Grep/Glob match Claude's. */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Execute') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;
    return parseRgGrepPattern(cmd);
  }

  return null;
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

/**
 * Keep only the augment block: stderr from the first `[GitNexus]` marker on, or
 * '' when there is none, so npm/Node/LadybugDB warnings never reach the agent.
 * Kept identical to the Claude adapter's copy so the two can be shared later.
 */
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
 * Absolute path of a runnable (regular file, X_OK) `command` on PATH, or null.
 * POSIX-only: used where the timeout guard would otherwise mask a missing
 * launcher as the guard's own exit 127 instead of a spawn ENOENT.
 */
function findOnPath(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not a runnable file here */
    }
  }
  return null;
}

/**
 * Run `gitnexus augment` for `pattern` and return its `[GitNexus]` block — the
 * augment CLI writes results to stderr because LadybugDB's native module
 * captures stdout at the OS fd level. Launcher noise is filtered out by
 * extractAugmentContext, so noise-only stderr yields ''.
 *
 * GITNEXUS_HOOK_CLI_PATH is tried first and run as `node <path>`, the only form
 * that works on Windows, where Node refuses to spawn the `.cmd` shims without a
 * shell (CVE-2024-27980). Otherwise a PATH binary, and a version-pinned npx
 * only when no PATH binary exists. Exactly one tier runs, so a no-match search
 * (exit 0, empty stderr) or a timeout never spends a second 8s budget on npx
 * past the 10s hook timeout in hooks.json.
 *
 * Orphan guard (#2163, ported from the Claude adapter's runGitNexusCli): on
 * Unix every tier runs under the probe's self-tested coreutils `timeout`, so a
 * hook killed by the runner cannot strand the CLI. The direct tiers (the CLI is
 * the guard's child) use `-k 1` TERM-first; npx (guard → npx → CLI grandchild)
 * uses `-s KILL`, which group-kills at budget — TERM-first would only kill the
 * obedient npx parent and let `timeout` exit before its `-k` escalation, leaving
 * a SIGTERM-immune CLI running. Residual gaps are the Claude adapter's: a
 * busybox guard signals only its direct child, and when the hook itself is
 * alive the inner spawnSync timeout SIGTERMs the guard, which forwards TERM, not
 * KILL, to the npx group. Because the guard reports a missing command as its
 * own exit 127 rather than ENOENT, the guarded PATH tier decides presence with
 * findOnPath first. Windows (no coreutils; the self-test spawns /bin/sh) and an
 * unresolved guard (e.g. macOS without Homebrew coreutils, or
 * GITNEXUS_HOOK_TIMEOUT_PATH=disabled) keep the plain spawn and the ENOENT
 * fallthrough.
 *
 * SECURITY: `pattern` follows the `--` end-of-options marker and never reaches a
 * shell (the Windows fallback invokes `npx.cmd` directly rather than
 * `shell: true`), so `-rf` or `$(...)` is inert.
 */
function runAugment(pattern, cwd) {
  const isWin = process.platform === 'win32';
  const args = ['augment', '--', pattern];
  const timeoutMs = 8000;
  const spawnOpts = {
    encoding: 'utf-8',
    timeout: timeoutMs,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  // An older bundled probe without the export degrades to the unwrapped spawn.
  const guard =
    isWin || typeof resolveUnixGuardTimeout !== 'function' ? null : resolveUnixGuardTimeout();
  if (!isWin && !guard && isDebugEnabled()) {
    process.stderr.write(
      '[GitNexus hook] no usable timeout/gtimeout guard; augment CLI child runs unguarded\n',
    );
  }
  const guardSecs = String(Math.ceil(timeoutMs / 1000) + 1);
  // Only a clean exit 0 yields context; a spawn error, throw or non-zero exit is ''.
  // `groupKill` selects the npx arm's `-s KILL` (see the docblock).
  const spawnAugment = (cmd, argv, groupKill = false) => {
    const [file, fileArgs] = guard
      ? [guard, [...(groupKill ? ['-s', 'KILL'] : []), '-k', '1', guardSecs, cmd, ...argv]]
      : [cmd, argv];
    try {
      const child = spawnSync(file, fileArgs, spawnOpts);
      if (!child.error && child.status === 0) return extractAugmentContext(child.stderr);
    } catch {
      /* graceful failure */
    }
    return '';
  };

  const hookCli = process.env.GITNEXUS_HOOK_CLI_PATH;
  if (hookCli && String(hookCli).trim() && fs.existsSync(String(hookCli))) {
    return spawnAugment(process.execPath, [String(hookCli), ...args]);
  }

  if (guard) {
    // Guarded (Unix): only a missing launcher falls through to npx.
    const launcher = findOnPath('gitnexus');
    if (launcher) return spawnAugment(launcher, args);
  } else {
    // Only ENOENT (no launcher on PATH) falls through to npx. Windows EINVAL for
    // `gitnexus.cmd` does not: `npx.cmd` would fail the same way without a shell.
    try {
      const child = spawnSync(isWin ? 'gitnexus.cmd' : 'gitnexus', args, spawnOpts);
      if (!child.error || child.error.code !== 'ENOENT') {
        return !child.error && child.status === 0 ? extractAugmentContext(child.stderr) : '';
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return '';
    }
  }

  return spawnAugment(
    isWin ? 'npx.cmd' : 'npx',
    ['-y', `gitnexus@${PINNED_VERSION}`, ...args],
    true,
  );
}

function main() {
  try {
    const input = readInput();
    if ((input.hook_event_name || '') !== 'PostToolUse') return;

    const cwd = input.cwd || process.cwd();
    if (!path.isAbsolute(cwd)) return;

    const toolName = input.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Execute') return;

    const pattern = extractPattern(toolName, input.tool_input || {});
    if (!pattern || pattern.length < 3) return;

    // Registry row first (persisted external storagePath wins); a local owned
    // `.gitnexus` is the fallback — same lookup as the Claude/Cursor hooks.
    const repo = resolveHookRepo(cwd);
    if (!repo) return;

    const release = acquireHookSlot(repo.storagePath);
    if (!release) return; // all per-repo augment slots held by concurrent sessions

    let result = '';
    try {
      if (hasGitNexusDbLockedByGitNexusServer(repo.lbugPath, process.pid)) {
        // #2396: an MCP/serve process owns the single-writer DB, so a competing
        // CLI augment would only contend on the lock. Its MCP tools cover
        // augmentation instead — skip silently.
        return;
      }
      result = runAugment(pattern, cwd);
    } catch {
      /* graceful failure */
    } finally {
      release();
    }

    if (result && result.trim()) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: result.trim(),
          },
        }),
      );
    }
  } catch {
    /* never let the hook break the tool call */
  }
}

if (require.main === module) main();

module.exports = { parseRgGrepPattern, tokenizeShellWords };
