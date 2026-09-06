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
 * single-writer lock (#2396).
 *
 * The augment child is not wrapped in the coreutils `timeout` orphan guard the
 * full Claude adapter uses (#2163) — same scope as the Cursor integration.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.js');
const { hasGitNexusDbLockedByGitNexusServer } = require('./hook-db-lock-probe.cjs');

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
 * A `.gitnexus/` holding `registry.json`/`repos` (and no per-repo index
 * metadata) is the global registry, not a repo index — never augment against it.
 */
function isGlobalRegistryDir(candidate) {
  if (
    fs.existsSync(path.join(candidate, 'gitnexus.json')) ||
    fs.existsSync(path.join(candidate, 'meta.json'))
  ) {
    return false;
  }
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

/** Walk up from startDir for a non-registry `.gitnexus/`, at most 5 levels. */
function findGitNexusDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate) && !isGlobalRegistryDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
        // Inside double quotes a backslash only escapes these four; otherwise
        // it is a literal character (so Windows paths survive intact).
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
      escaped = true;
      hasToken = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
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
  const patternFlags = new Set(['-e', '--regexp']);

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      if (skipNextAsPattern) {
        return token.length >= 3 ? token : null;
      }
      continue;
    }
    if (!foundCmd) {
      // Match on the basename so absolute paths (`/usr/bin/rg`) and Windows
      // `rg.exe` count as the command.
      const commandName = token
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.exe$/i, '');
      if (commandName === 'rg' || commandName === 'grep') foundCmd = true;
      continue;
    }
    if (endOfOptions) {
      return token.length >= 3 ? token : null;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('-')) {
      const attachedPattern = token.match(/^--regexp=(.+)$/) || token.match(/^-e(.+)$/);
      if (attachedPattern) {
        return attachedPattern[1].length >= 3 ? attachedPattern[1] : null;
      }
      if (flagsWithValues.has(token) || patternFlags.has(token)) {
        skipNext = true;
        skipNextAsPattern = patternFlags.has(token);
      }
      continue;
    }
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
    const gitNexusDir = findGitNexusDir(cwd);
    if (!gitNexusDir) return;

    const toolName = input.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Execute') return;

    const pattern = extractPattern(toolName, input.tool_input || {});
    if (!pattern || pattern.length < 3) return;

    const release = acquireHookSlot(gitNexusDir);
    if (!release) return; // all per-repo augment slots held by concurrent sessions

    let result = '';
    try {
      if (hasGitNexusDbLockedByGitNexusServer(path.join(gitNexusDir, 'lbug'), process.pid)) {
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
