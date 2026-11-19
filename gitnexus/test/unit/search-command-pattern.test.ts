/**
 * The query the Claude-schema and Antigravity adapters read from a shell
 * command before they search the graph. Option handling is covered through the
 * Claude runtime in claude-hook-runtime.test.ts.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const HELPER = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'search-command-pattern.cjs');

type Shell = 'bash' | 'powershell' | 'either';

const { searchCommandPattern } = createRequire(import.meta.url)(HELPER) as {
  searchCommandPattern: (command: unknown, shell?: Shell) => string | null;
};

describe('searchCommandPattern', () => {
  it.each(['bash', 'powershell', 'either'] as const)(
    'reads a search that starts the line in %s',
    (shell) => {
      expect(searchCommandPattern('rg UserService src', shell)).toBe('UserService');
      expect(searchCommandPattern('grep -rn UserService src | head', shell)).toBe('UserService');
      expect(searchCommandPattern('rg UserService src; echo done', shell)).toBe('UserService');
      expect(searchCommandPattern("rg 'user service' src", shell)).toBe('user service');
    },
  );

  // #3899: a search after an operator reads a file the command names or the
  // output of the command before it, not the repository.
  it.each(['bash', 'powershell', 'either'] as const)(
    'reads no search after a shell operator in %s',
    (shell) => {
      for (const command of [
        "sed -i '' 's/old text/new text/' notes.md && grep -c 'direct tool' notes.md",
        'git log --oneline | grep UserService',
        'cat notes.md; grep UserService src',
        'ls src || rg UserService src',
        'cd src && rg UserService',
        'echo rg UserService',
      ]) {
        expect(searchCommandPattern(command, shell)).toBeNull();
      }
    },
  );

  it('defaults to bash', () => {
    expect(searchCommandPattern(String.raw`rg user\ service src`)).toBe('user service');
  });

  it.each([undefined, null, 42, {}])('reads no search from %j', (command) => {
    expect(searchCommandPattern(command)).toBeNull();
  });

  describe('in PowerShell', () => {
    const inPowerShell = (command: string) => searchCommandPattern(command, 'powershell');

    it('keeps a backslash as an ordinary character', () => {
      expect(inPowerShell(String.raw`rg C:\Users\me src`)).toBe(String.raw`C:\Users\me`);
      expect(inPowerShell(String.raw`rg "path\name" src`)).toBe(String.raw`path\name`);
      expect(inPowerShell("rg 'trailing\\' src")).toBe('trailing\\');
    });

    it('reads a doubled quote inside quotes as one quote', () => {
      expect(inPowerShell("rg 'can''t connect' src")).toBe("can't connect");
      expect(inPowerShell('rg "say ""hello""" src')).toBe('say "hello"');
    });

    it.each([
      'rg first,second src',
      'rg (Get-Pattern) src',
      'rg {UserService} src',
      'rg @arguments',
      'rg "partial $QUERY" src',
      'rg partial`$ src',
    ])('reads no query from %j, which the shell computes', (command) => {
      expect(inPowerShell(command)).toBeNull();
    });
  });

  describe('when the shell is unknown', () => {
    const inEither = (command: string) => searchCommandPattern(command, 'either');

    it('reads a query both shells read the same way', () => {
      expect(inEither('rg -n "user service" src')).toBe('user service');
      expect(inEither("grep -e 'explicit phrase' src")).toBe('explicit phrase');
    });

    it.each([
      // bash: C:Users; PowerShell: C:\Users
      String.raw`rg C:\Users src`,
      // bash: cant; PowerShell: can't
      "rg 'can''t' src",
      // bash: one word; PowerShell: an array
      'rg first,second src',
    ])('reads no query from %j, which the two shells read differently', (command) => {
      expect(inEither(command)).toBeNull();
    });
  });
});
