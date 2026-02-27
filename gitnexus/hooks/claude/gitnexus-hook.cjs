#!/usr/bin/env node
/**
 * GitNexus Claude Code Hook
 *
 * PreToolUse handler — intercepts Grep/Glob/Bash searches
 * and augments with graph context from the GitNexus index.
 *
 * NOTE: SessionStart hooks are broken on Windows (Claude Code bug).
 * Session context is injected via CLAUDE.md / skills instead.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
 * Check if a directory (or ancestor) has a .gitnexus index.
 */
function findGitNexusIndex(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.gitnexus'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
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
    const flagsWithValues = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '--glob', '-t', '--type', '--include', '--exclude']);

    for (const token of tokens) {
      if (skipNext) { skipNext = false; continue; }
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

function main() {
  try {
    const input = readInput();
    const hookEvent = input.hook_event_name || '';

    if (hookEvent !== 'PreToolUse') return;

    const cwd = input.cwd || process.cwd();
    if (!findGitNexusIndex(cwd)) return;

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

    const pattern = extractPattern(toolName, toolInput);
    if (!pattern || pattern.length < 3) return;

    // Resolve CLI path: try relative first (running from inside the package),
    // then fall back to dynamic discovery (running from ~/.claude/hooks/ after setup).
    let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');

    if (!fs.existsSync(cliPath)) {
      // Hook was copied outside the package (e.g. by `gitnexus setup`).
      // Resolve from the system-installed gitnexus binary.
      const { execFileSync: efs } = require('child_process');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      try {
        const binPath = efs(whichCmd, ['gitnexus'], { encoding: 'utf-8' }).trim().split('\n')[0];
        cliPath = fs.realpathSync(binPath);
      } catch {
        try {
          const globalRoot = efs('npm', ['root', '-g'], { encoding: 'utf-8' }).trim();
          cliPath = path.join(globalRoot, 'gitnexus', 'dist', 'cli', 'index.js');
        } catch {
          return; // Cannot locate gitnexus CLI — skip silently
        }
      }
      if (!fs.existsSync(cliPath)) return;
    }

    // augment CLI writes result to stderr (KuzuDB's native module captures
    // stdout fd at OS level, making it unusable in subprocess contexts).
    const { spawnSync } = require('child_process');
    let result = '';
    try {
      const child = spawnSync(
        process.execPath,
        [cliPath, 'augment', pattern],
        { encoding: 'utf-8', timeout: 8000, cwd, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      result = child.stderr || '';
    } catch { /* graceful failure */ }

    if (result && result.trim()) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: result.trim()
        }
      }));
    }
  } catch (err) {
    // Graceful failure — log to stderr for debugging
    console.error('GitNexus hook error:', err.message);
  }
}

main();
