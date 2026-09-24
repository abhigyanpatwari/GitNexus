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
 * branch-slot indexes work (#3060).
 *
 * The augment child is not wrapped in the coreutils `timeout` orphan guard the
 * full Claude adapter uses (#2163) — same scope as the Cursor integration.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.js');
const { hasGitNexusDbLockedByGitNexusServer } = require('./hook-db-lock-probe.cjs');
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
 * Run `gitnexus augment` for `pattern` and return its stderr — the augment CLI
 * writes results there because LadybugDB's native module captures stdout at the
 * OS fd level.
 *
 * GITNEXUS_HOOK_CLI_PATH is tried first and run as `node <path>`, the only form
 * that works on Windows, where Node refuses to spawn the `.cmd` shims without a
 * shell (CVE-2024-27980). Then a PATH binary, then a version-pinned npx.
 *
 * SECURITY: `pattern` follows the `--` end-of-options marker and never reaches a
 * shell (the Windows fallback invokes `npx.cmd` directly rather than
 * `shell: true`), so `-rf` or `$(...)` is inert.
 */
function runAugment(pattern, cwd) {
  const isWin = process.platform === 'win32';
  const args = ['augment', '--', pattern];
  const spawnOpts = {
    encoding: 'utf-8',
    timeout: 8000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  const hookCli = process.env.GITNEXUS_HOOK_CLI_PATH;
  if (hookCli && String(hookCli).trim() && fs.existsSync(String(hookCli))) {
    try {
      const child = spawnSync(process.execPath, [String(hookCli), ...args], spawnOpts);
      if (!child.error && child.status === 0 && child.stderr && child.stderr.trim()) {
        return child.stderr;
      }
    } catch {
      /* graceful failure */
    }
    return '';
  }

  try {
    const child = spawnSync(isWin ? 'gitnexus.cmd' : 'gitnexus', args, spawnOpts);
    if (!child.error && child.status === 0 && child.stderr && child.stderr.trim()) {
      return child.stderr;
    }
  } catch {
    /* not on PATH — fall through to npx */
  }

  try {
    const child = spawnSync(
      isWin ? 'npx.cmd' : 'npx',
      ['-y', `gitnexus@${PINNED_VERSION}`, ...args],
      spawnOpts,
    );
    if (!child.error && child.status === 0 && child.stderr && child.stderr.trim()) {
      return child.stderr;
    }
  } catch {
    /* graceful failure */
  }

  return '';
}

function main() {
  try {
    const input = readInput();
    if ((input.hook_event_name || '') !== 'PostToolUse') return;

    const cwd = input.cwd || process.cwd();
    if (!path.isAbsolute(cwd)) return;
    // Registry row first (persisted external storagePath wins); a local owned
    // `.gitnexus` is the fallback — same lookup as the Claude/Cursor hooks.
    const repo = resolveHookRepo(cwd);
    if (!repo) return;

    const toolName = input.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Execute') return;

    const pattern = extractPattern(toolName, input.tool_input || {});
    if (!pattern || pattern.length < 3) return;

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
