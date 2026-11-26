import { describe, it } from 'node:test';
import { expect } from 'expect';
import { execSync, spawnSync } from 'node:child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { fileURLToPath } from 'node:url';
describe('--skip-git CLI flag', () => {
  const packageRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  const cliPath = path.join(packageRoot, 'dist/cli/index.js');
  it('warns when --index-only overrides --skills (PR 1485)', () => {
    // `--index-only` suppresses the post-index skill step that `--skills`
    // would otherwise trigger. Without an explicit warning, the user sees a
    // pipeline re-index complete and silently no skill files written — the
    // silent-contradiction case flagged in PR 1485 review.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-index-only-skills-'));
    const gitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-index-only-skills-home-'));
    // Make tmpDir a git repo so analyze accepts it without --skip-git.
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const a = 1;\n');

    const env = {
      ...process.env,
      HOME: gitnexusHome,
      GITNEXUS_HOME: gitnexusHome,
      // This suite tests repository-root selection, not extension installation.
      // Keep child CLI runs offline so an unavailable FTS download cannot consume
      // the child process timeout.
      GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    };

    try {
      const output = execSync(
        `node "${cliPath}" analyze "${tmpDir}" --index-only --skills --skip-agents-md`,
        {
          encoding: 'utf8',
          timeout: 60000,
          env,
        },
      );

      expect(output).toContain('--index-only overrides --skills');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(gitnexusHome, { recursive: true, force: true });
    }
  });

  it('rejects non-git folder without --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');

    try {
      const result = spawnSync(process.execPath, [cliPath, 'analyze', tmpDir], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout + result.stderr).toContain('--skip-git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still respects .gitnexusignore when run with --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-skip-git-ignore-'));
    const gitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-skip-git-ignore-home-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'customskip'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gitnexusignore'), 'customskip/\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'keep.ts'), 'export function keep() { return 1; }\n');
    fs.writeFileSync(
      path.join(tmpDir, 'customskip', 'leaked.ts'),
      'export function leaked() { return 42; }\n',
    );

    const env = {
      ...process.env,
      HOME: gitnexusHome,
      GITNEXUS_HOME: gitnexusHome,
      GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    };

    try {
      execSync(`node "${cliPath}" analyze "${tmpDir}" --skip-git --skip-agents-md`, {
        encoding: 'utf8',
        timeout: 60000,
        env,
      });

      const keepContext = execSync(
        `node "${cliPath}" context keep --repo "${path.basename(tmpDir)}"`,
        {
          encoding: 'utf8',
          timeout: 60000,
          env,
        },
      );
      expect(JSON.parse(keepContext)).toMatchObject({
        status: 'found',
        symbol: { filePath: 'src/keep.ts' },
      });

      // Since #2470 a backend error payload also exits non-zero, so capture
      // the payload from the exec failure instead of expecting exit 0.
      let leakedContext = '';
      let leakedStatus = 0;
      try {
        leakedContext = execSync(
          `node "${cliPath}" context leaked --repo "${path.basename(tmpDir)}"`,
          {
            encoding: 'utf8',
            timeout: 60000,
            env,
          },
        );
      } catch (err: unknown) {
        const execErr = err as { status?: number; stdout?: string | Buffer };
        leakedStatus = execErr.status ?? 0;
        leakedContext = String(execErr.stdout ?? '');
      }
      expect(leakedStatus).toBe(1);
      expect(JSON.parse(leakedContext).error).toBe("Symbol 'leaked' not found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(gitnexusHome, { recursive: true, force: true });
    }
  });

  describe('--skip-git does not walk up to parent git repo (#1232)', () => {
    let parentDir: string;
    let gitnexusHome: string;

    function testEnv() {
      return {
        ...process.env,
        HOME: gitnexusHome,
        GITNEXUS_HOME: gitnexusHome,
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
      };
    }

    function readRegistry(): Array<{ name: string; path: string }> {
      const registryPath = path.join(gitnexusHome, 'registry.json');
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
      gitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-skip-git-home-'));
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
      if (gitnexusHome) {
        fs.rmSync(gitnexusHome, { recursive: true, force: true });
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

    it('keeps parent git status clean for --skip-git subdir analyze (#1233)', () => {
      createTestStructure();
      try {
        fs.writeFileSync(path.join(parentDir, '.gitignore'), '.claude/\n');
        execSync('git add .gitignore COOLIO SubWooder', { cwd: parentDir, stdio: 'ignore' });
        execSync('git -c user.name=test -c user.email=test@example.com commit -m fixtures', {
          cwd: parentDir,
          stdio: 'ignore',
        });

        execSync(`node "${cliPath}" analyze --skip-git --skip-agents-md`, {
          cwd: path.join(parentDir, 'COOLIO'),
          encoding: 'utf8',
          timeout: 60000,
          env: testEnv(),
        });

        expect(
          fs.readFileSync(path.join(parentDir, 'COOLIO', '.gitnexus', '.gitignore'), 'utf8'),
        ).toBe('*\n');
        const status = execSync('git status --short', {
          cwd: parentDir,
          encoding: 'utf8',
        });
        expect(status).toBe('');
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
