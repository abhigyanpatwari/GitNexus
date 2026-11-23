/**
 * Runs search commands through the real shells on this machine and checks the
 * hook's reading against what a fake `rg` / `grep` actually receives: whenever
 * searchCommandPattern returns a query, the real shell must have started the
 * search tool with exactly that query.
 *
 * Windows runs Git Bash, Windows PowerShell and pwsh; Linux and macOS run bash
 * and pwsh when installed. On Windows the fake tool is a real .exe, because
 * PowerShell passes arguments to .cmd and .bat files the legacy way
 * (about_Parsing, $PSNativeCommandArgumentPassing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Mode = 'bash' | 'powershell' | 'either';

const HELPER = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'search-command-pattern.cjs');
const { searchCommandPattern } = createRequire(import.meta.url)(HELPER) as {
  searchCommandPattern: (command: string, shell: Mode) => string | null;
};

const WINDOWS = process.platform === 'win32';
const NUL = String.fromCharCode(0);
const PATH_KEY = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';

function onPath(name: string): string | null {
  const found = spawnSync(WINDOWS ? 'where' : 'which', [name], { encoding: 'utf8' });
  const first = found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : '';
  return first || null;
}

// `bash` on a Windows PATH may be WSL. Git Bash is `bin/bash.exe` under the
// Git root, an ancestor of git.exe (`cmd/` or `mingw64/bin/`).
function gitBash(): string | null {
  const roots = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git')];
  const git = onPath('git');
  for (let dir = git ? path.dirname(git) : ''; dir && dir !== path.dirname(dir); ) {
    roots.push(dir);
    dir = path.dirname(dir);
  }
  return (
    roots.map((root) => path.join(root, 'bin', 'bash.exe')).find((bash) => fs.existsSync(bash)) ??
    null
  );
}

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

type Shell = {
  name: string;
  mode: Mode;
  exe: string | null;
  ext: string;
  args: (script: string) => string[];
  version: string[];
};

const SHELLS: Shell[] = [
  // Claude Code and Codex on Windows read a Bash tool command as `either`; the
  // plain bash reading only runs on Linux and macOS.
  {
    name: 'bash',
    mode: WINDOWS ? 'either' : 'bash',
    exe: WINDOWS ? gitBash() : onPath('bash'),
    ext: '.sh',
    args: (script) => [script.replaceAll('\\', '/')],
    version: ['--version'],
  },
  {
    name: 'Windows PowerShell',
    mode: 'powershell',
    exe: WINDOWS ? onPath('powershell') : null,
    ext: '.ps1',
    args: (script) => [...POWERSHELL_ARGS, '-File', script],
    version: [...POWERSHELL_ARGS, '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
  {
    name: 'pwsh',
    mode: 'powershell',
    exe: onPath('pwsh'),
    ext: '.ps1',
    args: (script) => [...POWERSHELL_ARGS, '-File', script],
    version: [...POWERSHELL_ARGS, '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
];
const AVAILABLE = SHELLS.filter((shell) => shell.exe !== null);

const CASES = [
  'rg UserService src',
  '\nrg UserService src',
  '\nNO_COLOR=1 rg UserService src',
  '& rg UserService src',
  "&'grep' UserService src",
  'grep -rn UserService src',
  "rg 'user service' src",
  'rg "user service" src',
  'rg -e LongPattern src',
  'rg --glob *.ts UserService src',
  'rg UserService src; echo done',
  'NO_COLOR=1 rg UserService src',
  'rg UserService ~/src',
  'rg ~/UserService src',
  "rg '~/UserService' src",
  'rg ~UserService src',
  'rg Foo~Bar src',
  'rg {foo,bar} src',
  'rg --glob {foo,bar} UserService src',
  'grep -rn UserService --include=*.{ts,tsx} src',
  String.raw`rg C:\Users src`,
  String.raw`rg 'path\name' src`,
  "rg 'can''t' src",
  'rg first,second src',
  'rg List<notes.md',
  'rg UserService 2>errors.txt',
  'rg /api/users src',
  "rg '/api/users' src",
  'rg //api/users src',
  'rg api/users src',
  'rg key=/api src',
  'rg --regexp=/api src',
];

// Searches every reading must keep, so the invariant below cannot pass by
// declining everything.
const PLAIN = ['rg UserService src', 'grep -rn UserService src', "rg 'user service' src"];

/** The query rg or grep received, for the options these cases use. */
function receivedPattern(argv: string[] | undefined): string | undefined {
  const takesValue = new Set(['--glob', '-g', '--include', '--max-count', '-m']);
  for (let i = 0; argv && i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-e' || arg === '--regexp' || arg === '--') return argv[i + 1];
    if (arg.startsWith('--regexp=')) return arg.slice('--regexp='.length);
    if (takesValue.has(arg)) i++;
    else if (!arg.startsWith('-') || arg === '-') return arg;
  }
  return undefined;
}

const accepted = (mode: Mode) =>
  CASES.map((command) => [command, searchCommandPattern(command, mode)] as const).filter(
    (entry): entry is readonly [string, string] => entry[1] !== null,
  );

let tmp = '';
const received = new Map<string, Map<string, string[] | undefined>>();

/** Fake rg and grep that write the arguments they received, NUL-separated. */
function installFakeTools(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  if (WINDOWS) {
    const source = [
      'public static class Program {',
      '  public static void Main(string[] args) {',
      '    System.IO.File.WriteAllText(',
      '      System.Environment.GetEnvironmentVariable("GN_ARGV_DUMP"),',
      '      string.Join(((char)0).ToString(), args));',
      '  }',
      '}',
    ].join('\n');
    const build = path.join(tmp, 'build-fake-tool.ps1');
    const exe = path.join(bin, 'rg.exe');
    fs.writeFileSync(
      build,
      `Add-Type -OutputType ConsoleApplication -OutputAssembly '${exe.replaceAll("'", "''")}' -TypeDefinition @'\n${source}\n'@\n`,
    );
    const powershell = onPath('powershell');
    const built = spawnSync(powershell ?? 'powershell', [...POWERSHELL_ARGS, '-File', build], {
      encoding: 'utf8',
    });
    if (!fs.existsSync(exe)) throw new Error(`could not build fake rg.exe: ${built.stderr}`);
    fs.copyFileSync(exe, path.join(bin, 'grep.exe'));
    return;
  }
  const dump = path.join(tmp, 'dump-argv.cjs');
  fs.writeFileSync(
    dump,
    "require('fs').writeFileSync(process.env.GN_ARGV_DUMP, process.argv.slice(2).join(String.fromCharCode(0)));\n",
  );
  for (const tool of ['rg', 'grep']) {
    const file = path.join(bin, tool);
    fs.writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${dump}' "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
}

function runInShell(shell: Shell, command: string, index: number, bin: string, work: string) {
  const shellIndex = SHELLS.indexOf(shell);
  const script = path.join(tmp, `case-${shellIndex}-${index}${shell.ext}`);
  const dump = path.join(tmp, `argv-${shellIndex}-${index}`);
  // Git's bin/bash.exe puts its own /usr/bin (with a real grep) first on PATH,
  // so a bash script puts the fake tools back in front before the command.
  const posixBin = WINDOWS ? `/${bin[0].toLowerCase()}${bin.slice(2).replaceAll('\\', '/')}` : bin;
  const prefix = shell.ext === '.sh' ? `PATH="${posixBin}:$PATH"\n` : '';
  fs.writeFileSync(script, `${prefix}${command}\n`);
  spawnSync(shell.exe as string, shell.args(script), {
    cwd: work,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      [PATH_KEY]: `${bin}${path.delimiter}${process.env[PATH_KEY] ?? ''}`,
      GN_ARGV_DUMP: dump,
    },
  });
  return fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').split(NUL) : undefined;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-real-shells-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'notes.md'), 'notes\n');
  installFakeTools(bin);

  const table: string[] = [];
  for (const shell of AVAILABLE) {
    const version = spawnSync(shell.exe as string, shell.version, { encoding: 'utf8' });
    table.push(`## ${shell.name} (${shell.exe}): ${version.stdout.split(/\r?\n/)[0]}`);
    const byCommand = new Map<string, string[] | undefined>();
    CASES.forEach((command, index) => {
      const argv = runInShell(shell, command, index, bin, work);
      byCommand.set(command, argv);
      const query = searchCommandPattern(command, shell.mode);
      table.push(
        `${JSON.stringify(command)} -> hook ${JSON.stringify(query)} | rg ${JSON.stringify(argv ?? null)}`,
      );
    });
    received.set(shell.name, byCommand);
  }
  console.log(table.join('\n'));
}, 600_000);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

for (const shell of SHELLS) {
  describe.skipIf(shell.exe === null)(`real ${shell.name} (${shell.mode} reading)`, () => {
    it.each(PLAIN)('reads %j', (command) => {
      expect(searchCommandPattern(command, shell.mode)).not.toBeNull();
    });

    it.each(accepted(shell.mode))(
      'starts the tool with the query read from %j',
      (command, query) => {
        expect(receivedPattern(received.get(shell.name)?.get(command))).toBe(query);
      },
    );
  });
}

// Claude Code and Codex on Windows cannot tell which shell runs the command,
// so a query read as `either` must be the one every real shell passes.
describe.skipIf(AVAILABLE.length === 0)('either reading', () => {
  it.each(PLAIN)('reads %j', (command) => {
    expect(searchCommandPattern(command, 'either')).not.toBeNull();
  });

  it.each(accepted('either'))(
    'every real shell starts the tool with the query read from %j',
    (command, query) => {
      const seen = AVAILABLE.map((shell) =>
        receivedPattern(received.get(shell.name)?.get(command)),
      );
      expect(seen).toEqual(AVAILABLE.map(() => query));
    },
  );
});
