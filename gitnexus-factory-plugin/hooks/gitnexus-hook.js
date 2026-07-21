#!/usr/bin/env node
/**
 * GitNexus Factory AI (Droid) Plugin Hook
 *
 * PostToolUse — augments Grep/Glob/Execute searches with graph context from
 * the GitNexus index and returns it via hookSpecificOutput.additionalContext.
 *
 * Reuses the same guards as the Claude/Codex adapter (bundled byte-identical,
 * kept in lockstep by test/unit/factory-plugin.test.ts):
 *   - acquireHookSlot  — per-repo cap on concurrent augment children so
 *     parallel sessions can't fan out unbounded `gitnexus augment` spawns
 *     (#1486).
 *   - LadybugDB owner probe — skips the CLI augment when a GitNexus MCP/serve
 *     process already holds the single-writer DB lock, avoiding contention
 *     (#2396); the in-session MCP tools cover augmentation instead.
 *
 * The augment CLI child is NOT wrapped in the coreutils `timeout`
 * orphan-containment guard the full Claude adapter uses (#2163) — same scope
 * as the Cursor integration. Add it (resolveUnixGuardTimeout is exported by
 * the bundled probe) if orphaned augment children become a problem here.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.js');
const { hasGitNexusDbLockedByGitNexusServer } = require('./hook-db-lock-probe.cjs');

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

/**
 * A `.gitnexus/` that holds `registry.json`/`repos` (and no per-repo index
 * metadata) is the global registry, not a repo index — never augment against
 * it. Mirrors the Claude adapter's guard.
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

/**
 * Walk up from startDir looking for a non-registry `.gitnexus/` folder. Returns
 * the path to `.gitnexus/` or null if not found within 5 levels.
 */
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
 * Extract a search pattern from a Factory tool payload. Factory's shell tool is
 * `Execute` (Claude's is `Bash`); Grep/Glob match Claude's.
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

  if (toolName === 'Execute') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    // NOTE: split(/\s+/) cannot handle shell quoting, same as the Cursor
    // integration. `rg "User Service" src/` yields "User" (first token after
    // rg/grep, quotes stripped) rather than the full phrase — BM25 is already
    // token-tolerant, so the multi-word pattern is deliberately not
    // reconstructed. Worst case is augment context for a narrower term than
    // the agent searched. Quoted single tokens (`rg "validateUser"`) are exact.
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
        if (/\brg\b|\bgrep\b/.test(token)) foundCmd = true;
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

/**
 * Run `gitnexus augment` for `pattern` and return its stderr (the augment CLI
 * writes results to stderr; LadybugDB's native module captures stdout at the OS
 * fd level, making it unusable in subprocess contexts). Tries a PATH-installed
 * binary first, then falls back to npx.
 *
 * Honors GITNEXUS_HOOK_CLI_PATH first, same as the Claude adapter: it runs the
 * CLI as `node <path>`, which is the only branch that works on Windows, where
 * Node refuses to spawn the `.cmd` launcher shims below without a shell
 * (CVE-2024-27980). Falls back to a PATH binary, then npx.
 *
 * SECURITY: `pattern` is passed after the `--` end-of-options marker and never
 * through a shell — the Windows npx fallback invokes `npx.cmd` directly rather
 * than `shell: true`, so a pattern like `-rf` or `$(...)` is inert.
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
    const child = spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], spawnOpts);
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
        // #2396: a GitNexus MCP/serve process owns the single-writer DB, so a
        // competing CLI augment would only contend on the lock. The session's
        // MCP tools cover augmentation instead — skip silently.
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

main();
