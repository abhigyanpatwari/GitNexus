/**
 * Find the directories in which a shell command runs a git subcommand that
 * moves HEAD (commit, merge, rebase, cherry-pick, pull). The Claude-schema and
 * Antigravity adapters check the index of each directory's repository for
 * staleness after such a command.
 *
 * Git accepts global options between `git` and the subcommand:
 * `git -c user.name=x commit`, `git -C ../other commit`, `git --no-pager pull`.
 * Each option is skipped together with its value, so the word after `-C` or
 * `-c` is never read as the subcommand: `git -C commit status` runs `status`.
 *
 * `-C <path>` moves the git call, so the directory returned is that path,
 * resolved against the caller's cwd. A call is left out when its repository
 * cannot be read from the command: a hint would then describe a repository
 * the command did not touch. That is the case when
 *   - the shell computes the path (`-C "$DIR"`, `-C ~/x`),
 *   - `--git-dir` or `--work-tree` point git at another repository,
 *   - a call with options depends on the shell directory after a `cd`,
 *   - the caller cannot tell how its shell reads a backslash in the path.
 * The other git calls of the command are still read.
 *
 * Everything around a git call is left alone on purpose. An environment
 * prefix, a wrapper such as `timeout 60`, a subshell or a heredoc all still
 * match, and so does `git commit` inside quoted text. A false positive costs
 * the caller one `git rev-parse HEAD`: the hint is shown only when HEAD differs
 * from the indexed commit.
 *
 * The OpenCode plugin has its own, stricter recognizer: it has to stay a single
 * self-contained file, and each match there costs a `gitnexus status` call.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// One shell word: bare characters and quoted runs. In bash a backslash escapes
// the next character, inside double quotes too.
const BASH_WORD = String.raw`(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+`;
// In PowerShell a backslash is an ordinary character.
const POWERSHELL_WORD = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;

const SWITCHES = [
  'paginate',
  'no-pager',
  'no-replace-objects',
  'no-lazy-fetch',
  'no-optional-locks',
  'no-advice',
  'bare',
  'literal-pathspecs',
  'no-literal-pathspecs',
  'glob-pathspecs',
  'noglob-pathspecs',
  'icase-pathspecs',
];

const OTHER_REPO = String.raw`--(?:git-dir|work-tree)`;

// Each `git` word reads at most this many options before giving up.
const MAX_GLOBAL_OPTIONS = 32;

// The subcommand ends at a space or at the shell operator that follows it.
const SUBCOMMAND = String.raw`\s+(?:commit|merge|rebase|cherry-pick|pull)(?=[\s;&|)]|$)`;

function grammar(word) {
  // One global option. `changeDir` matches the path given to -C and `otherRepo`
  // the name of an option that points git at another repository; the caller
  // decides whether they capture. Git wants a space after -C and -c.
  const option = (changeDir, otherRepo) =>
    [
      String.raw`-C\s+${changeDir}`,
      String.raw`-c\s+${word}`,
      String.raw`${otherRepo}(?:=|\s+)${word}`,
      String.raw`--(?:namespace|config-env|attr-source)(?:=|\s+)${word}`,
      String.raw`--exec-path=${word}`,
      String.raw`-[pP]`,
      String.raw`--(?:${SWITCHES.join('|')})`,
    ].join('|');

  return {
    // Group 1 is the run of global options.
    mutation: new RegExp(
      String.raw`\bgit((?:\s+(?:${option(word, OTHER_REPO)})){0,${MAX_GLOBAL_OPTIONS}})${SUBCOMMAND}`,
      'g',
    ),
    nextOption: new RegExp(
      String.raw`\s+(?:${option(`(?<changeDir>${word})`, `(?<otherRepo>${OTHER_REPO})`)})`,
      'y',
    ),
  };
}

const BASH = grammar(BASH_WORD);

// The shell that ran the command. `either` is for a caller that knows it is
// bash or PowerShell but not which: the command is read as bash, and a path is
// placed only when PowerShell would read it the same way.
const GRAMMARS = { bash: BASH, powershell: grammar(POWERSHELL_WORD), either: BASH };

// A value is one long word in some inputs, and every `git` word then reads to
// the end of the command before it fails. A longer command is only matched
// against the expression without options, which reads it once.
const MAX_COMMAND_LENGTH = 16 * 1024;
const PLAIN_MUTATION = new RegExp(String.raw`\bgit${SUBCOMMAND}`);

// Each directory costs the caller a few git calls.
const MAX_DIRECTORIES = 4;

const CHANGES_DIRECTORY = /\b(?:cd|pushd|popd)\b/;

// `\\server\share`, `\\?\C:\` and `//server/share`: resolving one of these on
// Windows opens a connection to a host that was only named in a command.
const NETWORK_PATH = /^[\\/]{2}/;

// A quote that closes a string and is followed by the same quote. PowerShell
// reads the pair as one quote character inside the string, bash as two strings
// side by side.
function doubledQuote(word, closing, shell) {
  return shell !== 'bash' && word[closing + 1] === word[closing];
}

/** The value `shell` passes for `word`, or null when it cannot be read from the text. */
function literalWord(word, shell) {
  if (word.startsWith('~')) return null;
  const escapes = shell !== 'powershell';
  let value = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      if (end === -1 || doubledQuote(word, end, shell)) return null;
      value += word.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      for (i++; i < word.length && word[i] !== '"'; i++) {
        if (word[i] === '$' || word[i] === '`') return null;
        // Inside double quotes bash only escapes these four characters.
        if (escapes && word[i] === '\\' && '"\\$`'.includes(word[i + 1])) {
          if (shell === 'either') return null;
          i++;
        }
        value += word[i];
      }
      if (i >= word.length || doubledQuote(word, i, shell)) return null;
    } else if (ch === '$' || ch === '`') {
      return null;
    } else if (escapes && ch === '\\') {
      // bash drops the backslash and keeps the character after it.
      if (shell === 'either' || i + 1 >= word.length) return null;
      value += word[++i];
    } else {
      value += ch;
    }
  }
  return value;
}

/**
 * Where `git -C target` goes from `from`. Git changes directory through the
 * filesystem, so `link/..` is the parent of the link's target, not the parent
 * of the link. A path that cannot be walked is resolved by its text.
 */
function changeDirectory(from, target) {
  try {
    return fs.realpathSync.native(path.isAbsolute(target) ? target : from + path.sep + target);
  } catch {
    return path.resolve(from, target);
  }
}

/**
 * Where one git call runs: `cwd`, moved by each `-C` of `options`. Null when
 * that cannot be read from the command.
 */
function placeMutation(options, cwd, shell, shellMoved) {
  const { nextOption } = GRAMMARS[shell];
  let directory = cwd;
  // Whether `directory` still depends on where the shell is.
  let relative = true;
  nextOption.lastIndex = 0;
  for (let option; (option = nextOption.exec(options)); ) {
    if (option.groups.otherRepo) return null;
    if (option.groups.changeDir === undefined) continue;
    const target = literalWord(option.groups.changeDir, shell);
    if (target === null) return null;
    if (process.platform === 'win32' && NETWORK_PATH.test(target)) return null;
    if (path.isAbsolute(target)) relative = false;
    else if (relative && shellMoved()) return null;
    // Like git, read each -C relative to the one before it.
    directory = changeDirectory(directory, target);
  }
  // Preserve the historical cwd hint for plain mutations. An option-bearing
  // call can use cwd only while the shell is still there.
  if (options && relative && shellMoved()) return null;
  return directory;
}

/**
 * The directories in which the git mutations of `command` run, in the order of
 * the command and without repeats: `cwd`, or the directory `-C` names. Empty
 * when the command has no git mutation that can be placed.
 *
 * `shell` is `bash`, `powershell`, or `either` when the caller cannot tell.
 */
function gitMutationDirectories(command, cwd, shell) {
  if (typeof command !== 'string') return [];
  if (command.length > MAX_COMMAND_LENGTH) return PLAIN_MUTATION.test(command) ? [cwd] : [];

  const { mutation } = GRAMMARS[shell];
  const directories = [];
  let firstMove;
  mutation.lastIndex = 0;
  for (let match; (match = mutation.exec(command)); ) {
    const { index } = match;
    const shellMoved = () => {
      firstMove ??= command.search(CHANGES_DIRECTORY);
      return firstMove !== -1 && firstMove < index;
    };
    const directory = placeMutation(match[1], cwd, shell, shellMoved);
    if (directory === null || directories.includes(directory)) continue;
    // `cwd` always has a place: a plain `git commit` is never crowded out.
    if (directory === cwd || directories.length < MAX_DIRECTORIES) directories.push(directory);
  }
  return directories;
}

function gitLines(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * HEAD of the checkout git reaches from `directory`, and the root of that
 * checkout when `cwd` is in another one (null otherwise). The root comes from
 * git: a linked worktree or a nested clone is its own checkout, whatever
 * folder it sits in.
 *
 * Git always starts in `cwd` and reads `directory` through -C. Windows looks
 * for `git.exe` in the working directory of the child before PATH, and
 * `directory` may only have been named in a command.
 */
function readHead(directory, cwd) {
  if (directory === cwd) {
    return { head: gitLines(['rev-parse', 'HEAD'], cwd)[0] || '', checkout: null };
  }
  const [root, head] = gitLines(['-C', directory, 'rev-parse', '--show-toplevel', 'HEAD'], cwd);
  if (!head) return { head: '', checkout: null };
  const [here] = gitLines(['rev-parse', '--show-toplevel'], cwd);
  return { head, checkout: root === here ? null : path.resolve(root) };
}

// Compare the entire gap, including both paths of a rename. Unknown bases and
// failed comparisons must leave the stale hint enabled.
function onlyMarkdownChanged(directory, cwd, base, head) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) return false;
  const paths = [
    '--',
    ':(top,glob)**',
    ':(top,exclude,icase,glob)**/*.md',
    ':(top,exclude,icase,glob)**/*.mdx',
    ':(top,exclude,icase,glob)**/*.markdown',
  ];
  const deadline = Date.now() + 3000;
  const result = spawnSync(
    'git',
    [
      '--no-literal-pathspecs',
      '-C',
      directory,
      'diff',
      '--quiet',
      '--no-ext-diff',
      '--no-renames',
      '--no-relative',
      '--ignore-submodules=none',
      base,
      head,
      ...paths,
    ],
    { cwd, timeout: 3000, windowsHide: true, stdio: 'ignore' },
  );
  if (result.status !== 0) return false;
  const dirty = spawnSync(
    'git',
    [
      '--no-literal-pathspecs',
      '--no-optional-locks',
      '-C',
      directory,
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--ignore-submodules=none',
      ...paths,
    ],
    { cwd, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 256, windowsHide: true },
  );
  return dirty.status === 0 && dirty.stdout.length === 0;
}

function canSkipMarkdownReindex(directory, cwd, base, head, resolveCliPath) {
  if (!onlyMarkdownChanged(directory, cwd, base, head)) return false;
  const cli = resolveCliPath();
  if (!cli || !path.isAbsolute(cli)) return false;
  try {
    const result = spawnSync(process.execPath, [cli, 'status', '--json'], {
      cwd: directory,
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 65536,
    });
    if (result.status !== 0) return false;
    const status = JSON.parse(result.stdout);
    return (
      status.index?.commit === base &&
      status.current?.commit === head &&
      !status.workspaceIndexBranch &&
      status.index.runnerIdentityStatus === 'current' &&
      Array.isArray(status.index.incompleteReasons) &&
      status.index.incompleteReasons.length === 0
    );
  } catch {
    return false;
  }
}

module.exports = { gitMutationDirectories, readHead, onlyMarkdownChanged, canSkipMarkdownReindex };
