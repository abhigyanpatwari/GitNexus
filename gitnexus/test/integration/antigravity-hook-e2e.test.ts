/**
 * Integration Tests: Antigravity hook adapter end-to-end
 *
 * Runs the FULL install + execute flow: invokes the real `setupCommand()`
 * to lay down the Antigravity hook adapter + helpers + win-rm-list-json.ps1
 * into a temp HOME, then spawns the installed adapter as a real child
 * process against a temp git repo + .gitnexus/ directory.
 *
 * Why install-then-spawn rather than spawning the source adapter directly:
 * the source `hooks/antigravity/gitnexus-antigravity-hook.cjs` requires
 * sibling .cjs helpers (`./hook-lock.cjs`, `./hook-db-lock-probe.cjs`)
 * that only live in `hooks/claude/`. The adapter is designed to be COPIED
 * to its install location alongside those helpers — running it from its
 * source dir fails with MODULE_NOT_FOUND. Exercising the install pipeline
 * verifies the complete contract documented at
 * https://geminicli.com/docs/hooks/reference/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { cleanupTempDir, cleanupTempDirSync } from '../helpers/test-db.js';
import os from 'os';
import {
  runHook,
  parseHookOutput,
  createGitNexusPathEntry,
  createHookToolDir,
  hookEnv,
  envWithPath,
} from '../utils/hook-test-helpers.js';
import { setupCommand } from '../../src/cli/setup.js';

let tempHome: string;
let installedHook: string;
let tmpDir: string;
let gitNexusDir: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeAll(async () => {
  // Stage a temp HOME with the Antigravity marker dir present so
  // setupCommand installs the adapter + helpers.
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'antigravity-hook-e2e-home-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  await fsp.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true });

  // Suppress setupCommand's console.log so test output stays readable.
  const origLog = console.log;
  console.log = () => {};
  try {
    await setupCommand();
  } finally {
    console.log = origLog;
  }

  installedHook = path.join(
    tempHome,
    '.gemini',
    'config',
    'hooks',
    'gitnexus',
    'gitnexus-antigravity-hook.cjs',
  );

  // Sanity-check the install. If this fails every downstream test would
  // produce noisy MODULE_NOT_FOUND output that obscures the real cause.
  if (!fs.existsSync(installedHook)) {
    throw new Error(`Antigravity adapter was not installed at ${installedHook}`);
  }
  for (const helper of [
    'hook-lock.cjs',
    'hook-db-lock-probe.cjs',
    'win-rm-list-json.ps1',
    'resolve-analyze-cmd.cjs',
  ]) {
    const helperPath = path.join(path.dirname(installedHook), helper);
    if (!fs.existsSync(helperPath)) {
      throw new Error(`Helper not installed: ${helperPath}`);
    }
  }

  // Set up a temp git repo with .gitnexus/ for staleness tests.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-hook-e2e-repo-'));
  gitNexusDir = path.join(tmpDir, '.gitnexus');
  fs.mkdirSync(gitNexusDir, { recursive: true });
  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  if (tempHome) await cleanupTempDir(tempHome);
  if (tmpDir) cleanupTempDirSync(tmpDir);
});

describe('antigravity hook adapter e2e', () => {
  describe('AfterTool — stale-index hint after git mutations', () => {
    // #1913: by default the hint reaches the agent via additionalContext (stdout
    // JSON) but is NOT mirrored to stderr, so strict hook runners see no
    // unexpected output on this normal (non-error) path.
    it('emits the hint via additionalContext and stays silent on stderr by default', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'a'.repeat(40), stats: {} }),
      );

      const result = runHook(
        installedHook,
        {
          hook_event_name: 'AfterTool',
          tool_name: 'run_shell_command',
          tool_input: { command: 'git commit -m "test"' },
          tool_response: { llmContent: '[committed]' },
          cwd: tmpDir,
        },
        tmpDir,
        { env: { ...process.env, GITNEXUS_INVOCATION: 'npx', GITNEXUS_DEBUG: '' } },
      );

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.hookEventName).toBe('AfterTool');
      expect(output!.additionalContext).toContain('index is stale');
      expect(output!.additionalContext).toContain('npx gitnexus@latest analyze');
      // Strict-runner contract: the hint is NOT mirrored to stderr by default.
      expect(result.stderr).not.toContain('[GitNexus] index is stale');
    });

    // #1913: the terminal-mirror remains available for operators who opt in.
    it('mirrors the hint to stderr for terminal users only under GITNEXUS_DEBUG=1', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'a'.repeat(40), stats: {} }),
      );

      const result = runHook(
        installedHook,
        {
          hook_event_name: 'AfterTool',
          tool_name: 'run_shell_command',
          tool_input: { command: 'git commit -m "test"' },
          tool_response: { llmContent: '[committed]' },
          cwd: tmpDir,
        },
        tmpDir,
        { env: { ...process.env, GITNEXUS_INVOCATION: 'npx', GITNEXUS_DEBUG: '1' } },
      );

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('index is stale');
      expect(result.stderr).toContain('[GitNexus] index is stale');
    });

    it('auto-detects a PATH-installed gitnexus and suggests `gitnexus analyze` (no npx)', () => {
      // No GITNEXUS_INVOCATION forcing — exercises the installed hook's real PATH
      // probe (#1938). The installed adapter resolves the analyze command through
      // the copied resolve-analyze-cmd.cjs, so a launcher on PATH yields
      // `gitnexus analyze` rather than the npm-11 npx crash path.
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'a'.repeat(39) + 'b', stats: {} }),
      );
      const gn = createGitNexusPathEntry();
      try {
        const result = runHook(
          installedHook,
          {
            hook_event_name: 'AfterTool',
            tool_name: 'run_shell_command',
            tool_input: { command: 'git commit -m "test"' },
            tool_response: { llmContent: '[committed]' },
            cwd: tmpDir,
          },
          tmpDir,
          { env: envWithPath(gn.pathValue) },
        );

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('Run `gitnexus analyze`');
        expect(output!.additionalContext).not.toContain('npx gitnexus');
      } finally {
        gn.cleanup();
      }
    });

    it('stays silent when meta.json lastCommit matches HEAD', () => {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).stdout.trim();
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: head, stats: {} }),
      );

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "test"' },
        tool_response: { llmContent: '[committed]' },
        cwd: tmpDir,
      });

      expect(parseHookOutput(result.stdout)).toBeNull();
      expect(result.stderr).not.toContain('[GitNexus] index is stale');
    });

    it('includes --embeddings flag when the previous index had embeddings', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({
          lastCommit: 'b'.repeat(40),
          stats: { embeddings: 42 },
        }),
      );

      const result = runHook(
        installedHook,
        {
          hook_event_name: 'AfterTool',
          tool_name: 'run_shell_command',
          tool_input: { command: 'git commit -m "x"' },
          tool_response: { llmContent: '[ok]' },
          cwd: tmpDir,
        },
        tmpDir,
        { env: { ...process.env, GITNEXUS_INVOCATION: 'npx' } },
      );

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('npx gitnexus@latest analyze --embeddings');
    });

    it('treats missing meta.json as stale', () => {
      const metaPath = path.join(gitNexusDir, 'meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
    });

    it('skips augment + hint when tool_response carries an error', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'c'.repeat(40), stats: {} }),
      );

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { error: 'boom' },
        cwd: tmpDir,
      });

      expect(parseHookOutput(result.stdout)).toBeNull();
    });

    it('skips augment + hint when tool_response.exit_code !== 0', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'd'.repeat(40), stats: {} }),
      );

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '...', exit_code: 1 },
        cwd: tmpDir,
      });

      expect(parseHookOutput(result.stdout)).toBeNull();
    });

    it('detects all five documented git mutation types', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'e'.repeat(40), stats: {} }),
      );

      const mutations = [
        'git commit -m "x"',
        'git merge feature',
        'git rebase main',
        'git cherry-pick abc123',
        'git pull origin main',
      ];
      for (const cmd of mutations) {
        const result = runHook(installedHook, {
          hook_event_name: 'AfterTool',
          tool_name: 'run_shell_command',
          tool_input: { command: cmd },
          tool_response: { llmContent: '[ok]' },
          cwd: tmpDir,
        });
        const output = parseHookOutput(result.stdout);
        expect(output, `mutation: ${cmd}`).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
      }
    });

    it('ignores non-mutation git commands', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'f'.repeat(40), stats: {} }),
      );

      const nonMutations = ['git status', 'git log', 'git diff', 'git branch', 'git stash'];
      for (const cmd of nonMutations) {
        const result = runHook(installedHook, {
          hook_event_name: 'AfterTool',
          tool_name: 'run_shell_command',
          tool_input: { command: cmd },
          tool_response: { llmContent: '...' },
          cwd: tmpDir,
        });
        expect(parseHookOutput(result.stdout), `cmd: ${cmd}`).toBeNull();
      }
    });
  });

  describe('AfterTool — augment branch (silent without gitnexus CLI)', () => {
    it('does not crash on search_file_content with a real pattern', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: '1'.repeat(40), stats: {} }),
      );

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'search_file_content',
        tool_input: { pattern: 'handleRequest' },
        tool_response: { llmContent: '...' },
        cwd: tmpDir,
      });

      // Either exits cleanly (no augment found) or gets killed by the 10s
      // hook timeout when spawned gitnexus CLI hangs in CI.
      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('ignores patterns shorter than 3 chars', () => {
      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'search_file_content',
        tool_input: { pattern: 'ab' },
        tool_response: { llmContent: '...' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
    });

    it('ignores tool names not in the registered matcher', () => {
      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'read_file',
        tool_input: { path: '/some/file.ts' },
        tool_response: { llmContent: '...' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
    });
  });

  // Issue #1913: when a GitNexus MCP server owns the repo DB, runAugment() must
  // SKIP — silently by default so strict hook runners never see unexpected
  // output, and surface the reason only under GITNEXUS_DEBUG=1. The Claude/Plugin
  // copies are covered in test/unit/hooks.test.ts; the antigravity adapter shares
  // the identical gated skip and is exercised here through the install pipeline
  // (its lock/probe helpers only resolve from the install dir). A faked lsof/ps +
  // an empty `lbug` lock force hasGitNexusServerOwner() => true; a marker-writing
  // fake CLI proves augment never ran.
  //
  // #2180: skipped on Linux too — the probe's Linux backend no longer uses
  // lsof/ps, so the faked lsof/ps can't force owner=true there. This stays as the
  // macOS/other-Unix lsof-path lane; the antigravity adapter shares the identical
  // gated owner-skip with the claude/plugin copies, whose Linux owner detection
  // is covered against a fake /proc in test/unit/hook-db-lock-probe.test.ts.
  describe.skipIf(process.platform === 'win32' || process.platform === 'linux')(
    'AfterTool — augment skipped when MCP server owns the DB (#1913)',
    () => {
      const OWNER_PROBE = {
        lsofOutput: '12345\n',
        psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
      };

      it('stays SILENT by default (no augment ran, no stderr noise, exit 0)', () => {
        const markerPath = path.join(os.tmpdir(), `antigravity-skip-silent-${process.pid}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({ ...OWNER_PROBE, gitnexusMarkerPath: markerPath });
        try {
          const result = runHook(
            installedHook,
            {
              hook_event_name: 'AfterTool',
              tool_name: 'search_file_content',
              tool_input: { pattern: 'validateUser' },
              tool_response: { llmContent: '...' },
              cwd: tmpDir,
            },
            tmpDir,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '' } },
          );

          expect(result.status).toBe(0);
          // Strict-runner contract: completely silent — empty stdout AND stderr
          // (matches the unit suite's assertion strength for the claude/plugin copies).
          expect(result.stdout.trim()).toBe('');
          expect(result.stderr.trim()).toBe('');
          // Marker absent ⇒ the CLI never ran (augment short-circuited at the owner
          // check). The paired GITNEXUS_DEBUG=1 test below positively proves the skip
          // was the owner path (it asserts the owner-skip diagnostic on stderr).
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it('surfaces the skip reason on stderr only under GITNEXUS_DEBUG=1', () => {
        const markerPath = path.join(os.tmpdir(), `antigravity-skip-debug-${process.pid}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({ ...OWNER_PROBE, gitnexusMarkerPath: markerPath });
        try {
          const result = runHook(
            installedHook,
            {
              hook_event_name: 'AfterTool',
              tool_name: 'search_file_content',
              tool_input: { pattern: 'validateUser' },
              tool_response: { llmContent: '...' },
              cwd: tmpDir,
            },
            tmpDir,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );

          expect(result.status).toBe(0);
          expect(parseHookOutput(result.stdout)).toBeNull();
          expect(result.stderr).toContain('[GitNexus] augment skipped: MCP server owns DB');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });
    },
  );

  describe('cwd validation', () => {
    it('rejects relative cwd silently', () => {
      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: 'relative/path',
      });

      expect(parseHookOutput(result.stdout)).toBeNull();
    });
  });

  describe('unhappy paths', () => {
    it('handles corrupted meta.json without crashing', () => {
      fs.writeFileSync(path.join(gitNexusDir, 'meta.json'), 'THIS IS NOT JSON {{{');

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('treats meta.json without lastCommit as stale', () => {
      fs.writeFileSync(path.join(gitNexusDir, 'meta.json'), JSON.stringify({ stats: {} }));

      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
    });

    it('ignores unknown hook_event_name', () => {
      // PreToolUse is the Claude hook event; the Antigravity adapter has no
      // handler for it and should exit silently.
      const result = runHook(installedHook, {
        hook_event_name: 'PreToolUse',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
    });

    it('does not crash on empty stdin', () => {
      const result = spawnSync(process.execPath, [installedHook], {
        input: '',
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(0);
    });

    it('does not crash on missing hook_event_name', () => {
      const result = runHook(installedHook, {
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: tmpDir,
      });
      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
    });
  });

  describe('directory without .gitnexus', () => {
    // Nest the test repo deeply at the filesystem root so parent traversal
    // (5 levels) cannot accidentally pick up a .gitnexus from an ancestor.
    let noGitNexusDir: string;
    let cleanupRoot: string;

    beforeAll(() => {
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      cleanupRoot = path.join(root, `no-gitnexus-antigravity-${Date.now()}-${process.pid}`);
      noGitNexusDir = path.join(cleanupRoot, 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(noGitNexusDir, { recursive: true });
      spawnSync('git', ['init'], { cwd: noGitNexusDir, stdio: 'pipe' });
    });

    afterAll(() => {
      cleanupTempDirSync(cleanupRoot);
    });

    it('ignores AfterTool when no .gitnexus exists in cwd or any ancestor', () => {
      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_response: { llmContent: '[ok]' },
        cwd: noGitNexusDir,
      });
      expect(parseHookOutput(result.stdout)).toBeNull();
    });

    it('ignores AfterTool search_file_content when no .gitnexus exists', () => {
      const result = runHook(installedHook, {
        hook_event_name: 'AfterTool',
        tool_name: 'search_file_content',
        tool_input: { pattern: 'handleRequest' },
        tool_response: { llmContent: '...' },
        cwd: noGitNexusDir,
      });
      expect(parseHookOutput(result.stdout)).toBeNull();
    });
  });
});
