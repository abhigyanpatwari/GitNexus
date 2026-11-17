/**
 * Recognize a shell command that runs a git subcommand which moves HEAD
 * (commit, merge, rebase, cherry-pick, pull). The Claude-schema and Antigravity
 * adapters show their stale-index hint after such a command.
 *
 * Git accepts global options between `git` and the subcommand:
 * `git -c user.name=x commit`, `git -C ../other commit`, `git --no-pager pull`.
 * Each option is skipped together with its value, so the word after `-C` or
 * `-c` is never read as the subcommand: `git -C commit status` runs `status`.
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

// One shell word: bare characters, backslash escapes, and quoted runs.
const WORD = String.raw`(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+`;

// Global options whose value may follow as a separate word.
const OPTIONS_WITH_VALUE = [
  'git-dir',
  'work-tree',
  'namespace',
  'super-prefix',
  'config-env',
  'attr-source',
];

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

const GLOBAL_OPTION = [
  // -C <path> and -c <name>=<value>, with the value attached or not.
  String.raw`-[Cc]\s*${WORD}`,
  String.raw`--(?:${OPTIONS_WITH_VALUE.join('|')})(?:=|\s+)${WORD}`,
  String.raw`--exec-path=${WORD}`,
  String.raw`-[pP]`,
  String.raw`--(?:${SWITCHES.join('|')})`,
].join('|');

// The option run is bounded so that a long command stays linear to scan: each
// `git` word reads at most this many options before giving up.
const MAX_GLOBAL_OPTIONS = 32;

const GIT_MUTATION = new RegExp(
  String.raw`\bgit(?:\s+(?:${GLOBAL_OPTION})){0,${MAX_GLOBAL_OPTIONS}}\s+(?:commit|merge|rebase|cherry-pick|pull)(?:\s|$)`,
);

function isGitMutationCommand(command) {
  return typeof command === 'string' && GIT_MUTATION.test(command);
}

module.exports = { isGitMutationCommand };
