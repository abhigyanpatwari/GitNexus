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

const { searchCommandPattern, searchCommandPatterns } = createRequire(import.meta.url)(HELPER) as {
  searchCommandPattern: (command: unknown, shell?: Shell) => string | null;
  searchCommandPatterns: (command: unknown, shell?: Shell) => string[];
};

describe('searchCommandPattern', () => {
  it.each(['bash', 'powershell', 'either'] as const)(
    'reads a search that starts the line in %s',
    (shell) => {
      expect(searchCommandPattern('rg UserService src', shell)).toBe('UserService');
      expect(searchCommandPattern('\n \t\nrg UserService src', shell)).toBe('UserService');
      expect(searchCommandPattern('grep -rn UserService src | head', shell)).toBe('UserService');
      expect(searchCommandPattern('rg UserService src; echo done', shell)).toBe('UserService');
      expect(searchCommandPattern("rg 'user service' src", shell)).toBe('user service');
    },
  );

  // #3899: a search after an operator may read a file the command names, the
  // output of the command before it, or another directory after `cd`; the line
  // alone does not say which, so none of them is read.
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

  it('reads past variable assignments before the command in bash', () => {
    expect(searchCommandPattern('NO_COLOR=1 rg UserService src')).toBe('UserService');
    expect(searchCommandPattern('\nNO_COLOR=1 rg UserService src')).toBe('UserService');
    expect(searchCommandPattern(`LC_ALL=C GREP_COLORS='mt=1;31' grep -rn UserService src`)).toBe(
      'UserService',
    );
    expect(searchCommandPattern(String.raw`DIR=a\ b rg UserService src`)).toBe('UserService');
    expect(searchCommandPattern('P=$HOME rg UserService src')).toBe('UserService');
    expect(searchCommandPattern('PATH="$PATH:/opt/bin" rg UserService src')).toBe('UserService');
    // A quoted word is a command name, and a newline ends the command.
    expect(searchCommandPattern("'NO_COLOR=1' rg UserService src")).toBeNull();
    expect(searchCommandPattern('"NO_COLOR"=1 rg UserService src')).toBeNull();
    expect(searchCommandPattern('NO_COLOR=1\nrg UserService src')).toBeNull();
    expect(searchCommandPattern('\nNO_COLOR=1 \nrg UserService src')).toBeNull();
  });

  // A value the shell computes would end the strip at a blank inside it and
  // leave the rest of the substitution or array as the command.
  it.each([
    'COUNT=$( grep -c TODO notes.md ) echo done',
    'ARGS=( rg foobar src )',
    'MSG=$(echo rg foobar)',
    'A=${X:- grep -rn foo src} rg UserService src',
  ])('reads no query when an assignment value is computed: %j', (command) => {
    expect(searchCommandPattern(command)).toBeNull();
  });

  // bash expands an unquoted `{a,b}` or `{1..3}` into several words, so a query
  // written that way is not the one rg or grep receives.
  it.each([
    'rg {foo,bar} src',
    'rg foo{1..3} src',
    'rg -e {a,b} src',
    // --glob takes `foo`, and `bar` becomes the query.
    'rg --glob {foo,bar} UserService src',
  ])('reads no query from the brace expansion in %j', (command) => {
    expect(searchCommandPattern(command)).toBeNull();
  });

  // A leading unquoted `~` is the home folder. bash expands `~`, `~/x` and
  // `~user`. PowerShell 7.6 and later expand `~`, `~/x` and `~\x` for native
  // commands on Windows and earlier versions do not, so no reading is sure.
  it.each(['bash', 'powershell', 'either'] as const)(
    'reads no query from a leading tilde in %s',
    (shell) => {
      expect(searchCommandPattern('rg ~/UserService src', shell)).toBeNull();
      expect(searchCommandPattern(String.raw`rg ~\UserService src`, shell)).toBeNull();
      expect(searchCommandPattern('rg -e ~/UserService src', shell)).toBeNull();
    },
  );

  it.each(['bash', 'powershell', 'either'] as const)(
    'reads a quoted tilde or one outside the query in %s',
    (shell) => {
      expect(searchCommandPattern("rg '~/UserService' src", shell)).toBe('~/UserService');
      expect(searchCommandPattern('rg UserService ~/src', shell)).toBe('UserService');
      expect(searchCommandPattern('rg Foo~Bar src', shell)).toBe('Foo~Bar');
    },
  );

  it('reads `~user` as a home folder in bash only', () => {
    expect(searchCommandPattern('rg ~UserService src', 'bash')).toBeNull();
    expect(searchCommandPattern('rg ~UserService src', 'powershell')).toBe('~UserService');
  });

  it('reads a query when the brace expansion is elsewhere or quoted', () => {
    expect(searchCommandPattern('grep -rn UserService --include=*.{ts,tsx} src')).toBe(
      'UserService',
    );
    expect(searchCommandPattern('rg UserService src/{a,b}')).toBe('UserService');
    expect(searchCommandPattern("rg '{foo,bar}' src")).toBe('{foo,bar}');
    expect(searchCommandPattern('rg foo{2} src')).toBe('foo{2}');
  });

  // PowerShell has no assignment prefix: it would run `NO_COLOR=1` itself.
  it.each(['powershell', 'either'] as const)('reads no assignment prefix in %s', (shell) => {
    expect(searchCommandPattern('NO_COLOR=1 rg UserService src', shell)).toBeNull();
  });

  it('defaults to bash', () => {
    expect(searchCommandPattern(String.raw`rg user\ service src`)).toBe('user service');
  });

  it.each([undefined, null, 42, {}])('reads no search from %j', (command) => {
    expect(searchCommandPattern(command)).toBeNull();
  });

  describe('in PowerShell', () => {
    const inPowerShell = (command: string) => searchCommandPattern(command, 'powershell');

    it('reads a literal search invoked by the call operator', () => {
      expect(inPowerShell('  & rg UserService src')).toBe('UserService');
      expect(inPowerShell(String.raw`&'C:\Program Files\rg.exe' UserService src`)).toBe(
        'UserService',
      );
      expect(inPowerShell('& $tool UserService src')).toBeNull();
      expect(inPowerShell('echo done; & rg UserService src')).toBeNull();
      expect(inPowerShell('&& rg UserService src')).toBeNull();
      expect(searchCommandPattern('& rg UserService src', 'bash')).toBeNull();
      expect(searchCommandPattern('& rg UserService src', 'either')).toBeNull();
    });

    it('keeps a backslash as an ordinary character', () => {
      expect(inPowerShell(String.raw`rg C:\Users\me src`)).toBe(String.raw`C:\Users\me`);
      expect(inPowerShell(String.raw`rg "path\name" src`)).toBe(String.raw`path\name`);
      expect(inPowerShell("rg 'trailing\\' src")).toBe('trailing\\');
    });

    it('reads a doubled quote inside quotes as one quote', () => {
      expect(inPowerShell("rg 'can''t connect' src")).toBe("can't connect");
      expect(inPowerShell('rg "say ""hello""" src')).toBe('say "hello"');
    });

    it('preserves angle brackets inside a native argument', () => {
      expect(inPowerShell('rg List<User> src')).toBe('List<User>');
      expect(inPowerShell('rg --regexp=Foo>Bar src')).toBe('Foo>Bar');
      expect(inPowerShell('rg UserService 2>errors.txt')).toBe('UserService');
      expect(inPowerShell('rg *>errors.txt UserService')).toBeNull();
      expect(searchCommandPattern('rg List<User> src', 'either')).toBeNull();
    });

    it.each([
      'rg (Get-Pattern) src',
      'rg {UserService} src',
      'rg @arguments',
      'rg "partial $QUERY" src',
    ])('reads no query from %j, which the shell computes', (command) => {
      expect(inPowerShell(command)).toBeNull();
    });

    // A backtick escapes the next character, so this passes the literal
    // `partial$`. The helper does not read escapes and declines the line.
    it('declines a backtick escape', () => {
      expect(inPowerShell('rg partial`$ src')).toBeNull();
    });
  });

  describe('when the shell is unknown', () => {
    const inEither = (command: string) => searchCommandPattern(command, 'either');

    it('reads a query both shells read the same way', () => {
      expect(inEither('rg -n "user service" src')).toBe('user service');
      expect(inEither("grep -e 'explicit phrase' src")).toBe('explicit phrase');
      // Only the path reads differently (bash: .src); the query does not.
      expect(inEither(String.raw`rg UserService .\src`)).toBe('UserService');
    });

    it.each([
      // bash: C:Users; PowerShell: C:\Users
      String.raw`rg C:\Users src`,
      // bash: cant; PowerShell: can't
      "rg 'can''t' src",
    ])('reads no query from %j, which the two shells read differently', (command) => {
      expect(inEither(command)).toBeNull();
    });

    // Git Bash converts an argument that looks like a Unix path, quoted or not,
    // to a Windows path before it starts rg.exe (`/api/users` reaches rg as
    // `C:/Program Files/Git/api/users`).
    it.each([
      'rg /api/users src',
      "rg '/api/users' src",
      'rg --regexp=/api src',
      'rg key=/api src',
    ])('reads no query from %j, which Git Bash converts to a Windows path', (command) => {
      expect(inEither(command)).toBeNull();
    });

    it('keeps a query with a slash that Git Bash does not convert', () => {
      expect(inEither('rg api/users src')).toBe('api/users');
    });
  });

  it.each(['bash', 'powershell'] as const)('reads a Unix-looking query in %s', (shell) => {
    expect(searchCommandPattern('rg /api/users src', shell)).toBe('/api/users');
  });

  it.each(['powershell', 'either'] as const)('skips bare commas in %s', (shell) => {
    expect(searchCommandPattern('rg first,second src', shell)).toBeNull();
  });
});

describe('searchCommandPatterns', () => {
  // Every `-e` / `--regexp` is a pattern the search looks for.
  it.each(['bash', 'powershell', 'either'] as const)(
    'reads every pattern of a search in %s',
    (shell) => {
      expect(searchCommandPatterns('rg -e FooService -e BarService src', shell)).toEqual([
        'FooService',
        'BarService',
      ]);
      expect(
        searchCommandPatterns('grep --regexp=FooService --regexp=BarService src', shell),
      ).toEqual(['FooService', 'BarService']);
      expect(searchCommandPatterns('rg UserService src', shell)).toEqual(['UserService']);
    },
  );

  it('reads at most three patterns and skips short ones', () => {
    expect(searchCommandPatterns('rg -e x -e LongPattern src')).toEqual(['LongPattern']);
    expect(searchCommandPatterns('rg -e Alpha -e Bravo -e Charlie -e Delta src')).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
  });

  it('reads none when one pattern cannot be read reliably', () => {
    expect(searchCommandPatterns('rg -e FooService -e {a,b} src')).toEqual([]);
    expect(searchCommandPatterns('rg --regexp=FooService --regexp=/api src', 'either')).toEqual([]);
    expect(searchCommandPatterns('cd src && rg -e FooService -e BarService')).toEqual([]);
  });

  it('gives searchCommandPattern the first pattern', () => {
    expect(searchCommandPattern('rg -e FooService -e BarService src')).toBe('FooService');
  });
});
