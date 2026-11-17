/**
 * Find the directory in which a shell command runs a git subcommand that moves
 * HEAD (commit, merge, rebase, cherry-pick, pull). The Claude-schema and
 * Antigravity adapters check the index of that directory's repository for
 * staleness after such a command.
 *
 * Git accepts global options between `git` and the subcommand:
 * `git -c user.name=x commit`, `git -C ../other commit`, `git --no-pager pull`.
 * Each option is skipped together with its value, so the word after `-C` or
 * `-c` is never read as the subcommand: `git -C commit status` runs `status`.
 *
 * `-C <path>` moves the git call, so the directory returned is that path,
 * resolved against the caller's cwd. No directory is returned when the path is
 * computed by the shell (`-C "$DIR"`), or when `--git-dir` / `--work-tree`
 * point git at a repository that cannot be told from the directory: a hint
 * would then describe a repository the command did not touch.
 *
 * Everything around the git call is left alone on purpose. An environment
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

// One shell word: bare characters, backslash escapes, and quoted runs.
const WORD = String.raw`(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+`;

const SWITCHES = [
  'paginate',
  'no-pager',
  'no-replace-objects',
  'no-lazy-fetch',
  'no-optional-locks',
  'no-advice',
  'bare',
  'literal-pathspecs',
  'glob-pathspecs',
  'noglob-pathspecs',
  'icase-pathspecs',
];

// One global option. `changeDir` matches the path given to -C and `otherRepo`
// the name of an option that points git at another repository; the caller
// decides whether they capture.
const globalOption = (changeDir, otherRepo) =>
  [
    // The value of -C and -c may be attached to the option or follow it.
    String.raw`-C\s*${changeDir}`,
    String.raw`-c\s*${WORD}`,
    String.raw`${otherRepo}(?:=|\s+)${WORD}`,
    String.raw`--(?:namespace|super-prefix|config-env|attr-source)(?:=|\s+)${WORD}`,
    String.raw`--exec-path=${WORD}`,
    String.raw`-[pP]`,
    String.raw`--(?:${SWITCHES.join('|')})`,
  ].join('|');

const OTHER_REPO = String.raw`--(?:git-dir|work-tree)`;

// The option run is bounded so that a long command stays linear to scan: each
// `git` word reads at most this many options before giving up.
const MAX_GLOBAL_OPTIONS = 32;

// Group 1 is the run of global options.
const GIT_MUTATION = new RegExp(
  String.raw`\bgit((?:\s+(?:${globalOption(WORD, OTHER_REPO)})){0,${MAX_GLOBAL_OPTIONS}})\s+(?:commit|merge|rebase|cherry-pick|pull)(?:\s|$)`,
);

const NEXT_OPTION = new RegExp(
  String.raw`\s+(?:${globalOption(`(?<changeDir>${WORD})`, `(?<otherRepo>${OTHER_REPO})`)})`,
  'y',
);

// cmd and PowerShell do not escape with a backslash: on Windows a bare one is
// a path separator.
const BACKSLASH_ESCAPES = process.platform !== 'win32';

/** The value the shell passes for `word`, or null when it would expand it first. */
function literalWord(word) {
  if (word.startsWith('~')) return null;
  let value = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      value += word.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      for (i++; word[i] !== '"'; i++) {
        if (word[i] === '$' || word[i] === '`') return null;
        // Inside double quotes a backslash only escapes these four characters.
        if (word[i] === '\\' && '"\\$`'.includes(word[i + 1])) i++;
        value += word[i];
      }
    } else if (ch === '$' || ch === '`') {
      return null;
    } else {
      if (ch === '\\' && BACKSLASH_ESCAPES) i++;
      value += word[i];
    }
  }
  return value;
}

/**
 * The directory in which the first git mutation of `command` runs: `cwd`,
 * moved by any `-C` option. Null when the command has no git mutation, or when
 * the repository it changes cannot be read from the command.
 */
function gitMutationDirectory(command, cwd) {
  if (typeof command !== 'string') return null;
  const mutation = GIT_MUTATION.exec(command);
  if (!mutation) return null;

  let directory = cwd;
  NEXT_OPTION.lastIndex = 0;
  for (let option; (option = NEXT_OPTION.exec(mutation[1])); ) {
    if (option.groups.otherRepo) return null;
    if (option.groups.changeDir === undefined) continue;
    const target = literalWord(option.groups.changeDir);
    if (target === null) return null;
    // Like git, read each -C relative to the one before it.
    directory = path.resolve(directory, target);
  }
  return directory;
}

function realPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** Whether `directory` lies outside `root`, whichever way each one is spelled. */
function isOutside(directory, root) {
  const relative = path.relative(realPath(root), realPath(directory));
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

module.exports = { gitMutationDirectory, isOutside };
