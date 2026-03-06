#!/usr/bin/env node
/**
 * GitNexus Factory AI Plugin Hook
 *
 * PostToolUse handler — augments Grep/Glob/Execute searches
 * and augments with graph context from the GitNexus index.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

  if (toolName === 'Execute') {
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

    if (hookEvent !== 'PostToolUse') return;

    const cwd = input.cwd || process.cwd();
    if (!findGitNexusIndex(cwd)) return;

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Execute') return;

    const pattern = extractPattern(toolName, toolInput);
    if (!pattern || pattern.length < 3) return;

    // augment CLI writes result to stderr (KuzuDB's native module captures
    // stdout fd at OS level, making it unusable in subprocess contexts).
    let result = '';

    const isWin = process.platform === 'win32';

    // Try direct gitnexus binary first (faster if globally installed)
    try {
      const child = spawnSync(
        'gitnexus',
        ['augment', pattern],
        { encoding: 'utf-8', timeout: 8000, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: isWin }
      );
      if (child.status === 0 && child.stderr && child.stderr.trim()) {
        result = child.stderr;
      }
    } catch { /* not on PATH */ }

    // Fallback to npx if direct binary didn't produce output
    if (!result || !result.trim()) {
      try {
        const child = spawnSync(
          'npx',
          ['-y', 'gitnexus', 'augment', pattern],
          { encoding: 'utf-8', timeout: 15000, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: isWin }
        );
        if (child.status === 0 && child.stderr && child.stderr.trim()) {
          result = child.stderr;
        }
      } catch { /* graceful failure */ }
    }

    if (result && result.trim()) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: result.trim()
        }
      }));
    }
  } catch {
    // Graceful failure
  }
}

main();
