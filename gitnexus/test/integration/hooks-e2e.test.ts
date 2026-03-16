/**
 * Integration Tests: Claude Code Hooks End-to-End
 *
 * Tests the hook scripts with real git repos and .gitnexus directories.
 * Unlike unit/hooks.test.ts which tests source code patterns and simple
 * stdin/stdout, these tests verify actual behavior with filesystem state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHook, parseHookOutput } from '../utils/hook-test-helpers.js';

// ─── Paths to both hook variants ────────────────────────────────────

const CJS_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'gitnexus-hook.cjs');
const PLUGIN_HOOK = path.resolve(__dirname, '..', '..', '..', 'gitnexus-claude-plugin', 'hooks', 'gitnexus-hook.js');

const HOOKS = [
  { name: 'CJS', path: CJS_HOOK },
  ...(fs.existsSync(PLUGIN_HOOK) ? [{ name: 'Plugin', path: PLUGIN_HOOK }] : []),
];

// ─── Temp git repo with .gitnexus ───────────────────────────────────

let tmpDir: string;
let gitNexusDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-e2e-'));
  gitNexusDir = path.join(tmpDir, '.gitnexus');
  fs.mkdirSync(gitNexusDir, { recursive: true });

  // Initialize a real git repo
  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

  // Create a file and commit so HEAD exists
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe.each(HOOKS)('hooks e2e ($name)', ({ name, path: hookPath }) => {
  describe('PostToolUse staleness detection', () => {
    it('detects stale index when meta.json lastCommit differs from HEAD', () => {
      // Write meta.json with an old commit hash
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
      expect(output!.additionalContext).toContain('npx gitnexus analyze');
    });

    it('stays silent when meta.json lastCommit matches HEAD', () => {
      // Get current HEAD
      const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const head = headResult.stdout.trim();

      // Write meta.json with matching commit
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: head, stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('includes --embeddings flag when previous index had embeddings', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', stats: { embeddings: 42 } }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('--embeddings');
    });

    it('treats missing meta.json as stale', () => {
      // Remove meta.json
      const metaPath = path.join(gitNexusDir, 'meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
    });

    it('ignores failed git commands (exit_code !== 0)', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'cccccccccccccccccccccccccccccccccccccccc', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 1 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores non-mutation git commands', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'dddddddddddddddddddddddddddddddddddddddd', stats: {} }),
      );

      const nonMutations = ['git status', 'git log', 'git diff', 'git branch', 'git stash'];
      for (const cmd of nonMutations) {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const output = parseHookOutput(result.stdout);
        expect(output).toBeNull();
      }
    });

    it('detects all 5 git mutation types', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', stats: {} }),
      );

      const mutations = ['git commit -m "x"', 'git merge feature', 'git rebase main', 'git cherry-pick abc', 'git pull origin main'];
      for (const cmd of mutations) {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
      }
    });
  });

  describe('PreToolUse — silent without gitnexus CLI', () => {
    // PreToolUse tries to spawn `gitnexus augment` which won't be available in CI.
    // Verify it fails gracefully (no output, no crash).

    it('handles Grep pattern gracefully when CLI is unavailable', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'handleRequest' },
        cwd: tmpDir,
      });

      // Should not crash — status is 0 if it exits cleanly, or null if the
      // spawned `gitnexus augment` hangs and the 10s timeout kills the process.
      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('ignores patterns shorter than 3 chars', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'ab' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores non-search tools', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('cwd validation', () => {
    it('rejects relative cwd silently for PostToolUse', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: 'relative/path',
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('rejects relative cwd silently for PreToolUse', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'testPattern' },
        cwd: 'relative/path',
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('unhappy paths', () => {
    it('handles corrupted meta.json (invalid JSON) without crashing', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        'THIS IS NOT JSON {{{',
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      // Should not crash — either treats as stale or ignores
      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('handles meta.json with missing lastCommit field', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const output = parseHookOutput(result.stdout);
      // Missing lastCommit should be treated as stale
      if (output) {
        expect(output.additionalContext).toContain('stale');
      }
    });

    it('ignores unknown hook event name', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'UnknownEvent',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('handles empty tool_input for PostToolUse without crashing', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const output = parseHookOutput(result.stdout);
      // No command means no git mutation detection — should be silent
      expect(output).toBeNull();
    });

    it('ignores non-Bash tool for PostToolUse', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        tool_output: {},
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('directory without .gitnexus', () => {
    // The hook walks up 5 parent directories looking for .gitnexus.
    // To guarantee none is found, create a deeply nested temp dir at the
    // filesystem root where no .gitnexus could exist in any ancestor.
    let noGitNexusDir: string;

    beforeAll(() => {
      // Use a root-level temp path so parent traversal can't find .gitnexus
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(root, `no-gitnexus-${Date.now()}`);
      // Nest 6 levels deep (hook walks up 5) to ensure isolation
      noGitNexusDir = path.join(base, 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(noGitNexusDir, { recursive: true });
      spawnSync('git', ['init'], { cwd: noGitNexusDir, stdio: 'pipe' });
    });

    afterAll(() => {
      // Clean up from the base directory
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(root, path.basename(path.resolve(noGitNexusDir, '..', '..', '..', '..', '..', '..')));
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('ignores PostToolUse when no .gitnexus directory exists', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: noGitNexusDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores PreToolUse when no .gitnexus directory exists', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'somePattern' },
        cwd: noGitNexusDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });
});
