import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('--skip-git CLI flag', () => {
  it('Commander maps --skip-git to options.skipGit (not --no-git inversion)', () => {
    // Verify the CLI defines --skip-git and --skip-agents-md in analyze help.
    const helpOutput = execSync('node dist/cli/index.js analyze --help', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(helpOutput).toContain('--skip-git');
    expect(helpOutput).toContain('--skip-agents-md');
    expect(helpOutput).not.toContain('--no-git');
  });

  it('rejects non-git folder without --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');

    try {
      execSync(`node dist/cli/index.js analyze "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 10000,
      });
      // Should not reach here
      expect.unreachable('Should have exited with non-zero');
    } catch (err: any) {
      expect(err.stdout || err.stderr || '').toContain('--skip-git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('--skip-git does not walk up to parent git repo (#1232)', () => {
    const cliPath = path.resolve(__dirname, '../../dist/cli/index.js');
    let parentDir: string;

    function testEnv() {
      return {
        ...process.env,
        HOME: parentDir,
        GITNEXUS_HOME: path.join(parentDir, '.gitnexus-home'),
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
      };
    }

    function readRegistry(): Array<{ name: string; path: string }> {
      const registryPath = path.join(parentDir, '.gitnexus-home', 'registry.json');
      expect(fs.existsSync(registryPath)).toBe(true);
      return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }

    function canonicalPath(filePath: string): string {
      return fs.realpathSync(filePath);
    }

    function expectCoolioRegistryEntry() {
      const registry = readRegistry();
      const entry = registry.find((e) => e.name === 'COOLIO');
      expect(entry).toBeTruthy();
      if (!entry) throw new Error('Expected COOLIO registry entry');
      expect(canonicalPath(entry.path)).toBe(canonicalPath(path.join(parentDir, 'COOLIO')));
      expect(
        registry.find((e) => canonicalPath(e.path) === canonicalPath(parentDir)),
      ).toBeUndefined();
      expect(
        registry.find(
          (e) => canonicalPath(e.path) === canonicalPath(path.join(parentDir, 'SubWooder')),
        ),
      ).toBeUndefined();
      return entry;
    }

    function initParentGitRepo() {
      execSync('git init', { cwd: parentDir, stdio: 'ignore' });
      execSync(
        'git -c user.name=test -c user.email=test@example.com commit --allow-empty -m init',
        {
          cwd: parentDir,
          stdio: 'ignore',
        },
      );
    }

    function createTestStructure() {
      // Create structure:
      //   parentDir/
      //     .git/           (parent is a git repo)
      //     COOLIO/
      //       package.json
      //       src/index.ts
      //     SubWooder/
      //       package.json
      //       src/index.ts
      parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-skip-git-'));
      initParentGitRepo();
      fs.mkdirSync(path.join(parentDir, 'COOLIO', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(parentDir, 'COOLIO', 'package.json'),
        JSON.stringify({ name: 'coolio' }),
      );
      fs.writeFileSync(
        path.join(parentDir, 'COOLIO', 'src', 'index.ts'),
        'export const hello = "world";',
      );
      fs.mkdirSync(path.join(parentDir, 'SubWooder', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(parentDir, 'SubWooder', 'package.json'),
        JSON.stringify({ name: 'subwooder' }),
      );
      fs.writeFileSync(
        path.join(parentDir, 'SubWooder', 'src', 'index.ts'),
        'export const bass = 42;',
      );
      return parentDir;
    }

    function cleanup() {
      if (parentDir) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    }

    it('from subdir inside parent git repo, indexes subdir not parent', () => {
      createTestStructure();
      try {
        // Run analyze from COOLIO with --skip-git
        const output = execSync(`node "${cliPath}" analyze --skip-git --skip-agents-md`, {
          cwd: path.join(parentDir, 'COOLIO'),
          encoding: 'utf8',
          timeout: 60000,
          env: testEnv(),
        });
        // Should mention COOLIO not the parent dir name
        expect(output).toContain('COOLIO');

        expectCoolioRegistryEntry();

        const siblingQuery = execSync(`node "${cliPath}" query bass --repo COOLIO`, {
          cwd: path.join(parentDir, 'COOLIO'),
          encoding: 'utf8',
          timeout: 60000,
          env: testEnv(),
        });
        expect(siblingQuery).not.toContain('SubWooder');
        expect(siblingQuery).not.toContain('bass');
      } finally {
        cleanup();
      }
    });

    it('explicit input path with --skip-git indexes subdir', () => {
      createTestStructure();
      try {
        const output = execSync(`node "${cliPath}" analyze ./COOLIO --skip-git --skip-agents-md`, {
          cwd: parentDir,
          encoding: 'utf8',
          timeout: 60000,
          env: testEnv(),
        });
        expect(output).toContain('COOLIO');

        expectCoolioRegistryEntry();
      } finally {
        cleanup();
      }
    });
  });
});
