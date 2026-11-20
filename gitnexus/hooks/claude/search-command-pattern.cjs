/**
 * The query of a shell command that runs `rg` or `grep`, read without running
 * a shell. The Claude-schema and Antigravity adapters search the graph for it.
 *
 * Only the first simple command of the line is read. A search later in the
 * line may read a file the command names (`sed -i x notes.md && grep -c word
 * notes.md`), the output of the command before it (`git log | grep fix`), or
 * another directory (`cd src && rg x`), and the line alone does not say which,
 * so none of them is taken as a code search. In bash, variable assignments
 * before the command (`NO_COLOR=1 rg x`) belong to it. A wrapper that runs the
 * search (`npx rg x`, `sudo grep x`, `git grep x`) is read past. A query that
 * cannot be read reliably (an expansion the shell always performs, such as
 * `$x`, `{a,b}` or a leading `~`; an unknown option; a pattern file) gives
 * none. An unquoted glob (`*`, `?`, `[...]`) is read as written: bash leaves it
 * unchanged unless a file in the working directory matches, and declining it
 * would also drop regex searches such as `rg handle.*Request src`. The reading
 * is best effort: it never changes the command, it only decides whether to add
 * graph context.
 *
 * The Cursor and Factory adapters keep their own parser in their hook file,
 * since their installs do not carry the Claude helpers, and the OpenCode
 * plugin has its own too. All of them read no search after
 * `&&`, `;`, `||` or `|`. They differ in the wrappers they read past: Cursor
 * and Factory also read `pnpm`, `yarn`, `npm` and some wrapper options, and
 * OpenCode reads none.
 */

// Read literal argv from the first simple command without executing a shell.
// Quotes group words; expansions and malformed input have no reliable query.
// In bash a backslash escapes the next character outside single quotes. In
// PowerShell it is an ordinary character, a doubled quote inside quotes is one
// literal quote. Parentheses, braces and a leading `@` can compute values.
// Bare commas are skipped, including literal commas passed to native tools.
// A word the shell rewrites before invocation has its index added to `expanded`
// when the caller passes a Set: in bash an unquoted `{a,b}` or `{1..3}` (several
// words) or a leading `~` (`~`, `~/x`, `~user`); in PowerShell a leading `~`,
// `~/x` or `~\x`, which 7.6 and later expand on Windows and earlier versions do not.
function tokenizeShellCommand(command, shell, expanded) {
  const powershell = shell === 'powershell';
  const tokens = [];
  let word = '';
  let quote = null;
  let started = false;
  let brace = 0; // 1: inside an unquoted `{`, 2: and it holds `,` or `..`
  let expands = false;
  const push = () => {
    if (expands && expanded) expanded.add(tokens.length);
    tokens.push(word);
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'" && !powershell) {
      const next = command[++i];
      if (next === undefined) return [];
      if (next === '\n') continue;
      if (quote === '"' && !['"', '\\', '$', '`'].includes(next)) word += '\\';
      word += next;
      started = true;
    } else if (
      quote !== "'" &&
      (ch === '`' ||
        (ch === '$' &&
          (/[\w{([*@#?$!-]/.test(command[i + 1] || '') ||
            (!quote && ['"', "'"].includes(command[i + 1])))))
    ) {
      return [];
    } else if (quote) {
      if (ch !== quote) word += ch;
      else if (powershell && command[i + 1] === quote) word += command[++i];
      else quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (powershell && (/[,(){}]/.test(ch) || (ch === '@' && !started))) {
      return [];
    } else if (powershell && !started && /[1-6*]/.test(ch) && command[i + 1] === '>') {
      // PowerShell stream redirection starts with the descriptor (2> or *>).
      break;
    } else if (powershell && started && (ch === '<' || ch === '>')) {
      // Inside an argument, PowerShell passes angle brackets to the native tool.
      word += ch;
    } else if (/[;&|<>\n\r]/.test(ch) || (ch === '#' && !started)) {
      break;
    } else if (/\s/.test(ch)) {
      if (started) push();
      word = '';
      started = false;
      brace = 0;
      expands = false;
    } else {
      const next = command[i + 1];
      if (ch === '~' && !started && (!powershell || next === undefined || /[/\\\s]/.test(next))) {
        expands = true;
      }
      if (ch === '{') brace = 1;
      else if (brace && (ch === ',' || (ch === '.' && next === '.'))) brace = 2;
      else if (brace === 2 && ch === '}') expands = true;
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  if (started) push();
  return tokens;
}

// How each option of the two supported search tools reads its argument,
// classified against ripgrep 14.1.1 and GNU grep 3.11 (`--help` plus one run of
// each option against the binary). `value` consumes the next token unless the
// value is attached; `boolean` never does; `pattern` carries the query;
// `file` reads queries from a file; `exit` prints information and searches
// nothing. The tools disagree on single letters (-E, -r, -T, -d, -h, -I, -L).
const optionNames = (text) => text.trim().split(/\s+/);

function searchOptionTable(kinds) {
  const table = new Map();
  for (const [kind, names] of Object.entries(kinds)) {
    // A string lists one-letter options; an array lists long names.
    for (const name of names) table.set(name, kind);
  }
  return table;
}

const SEARCH_TOOL_OPTIONS = {
  rg: {
    // ripgrep matches long names exactly and drops a `=` after a short option.
    abbreviations: false,
    shortEquals: true,
    short: searchOptionTable({
      pattern: 'e',
      file: 'f',
      exit: 'hV',
      value: 'ABCEMTdgjmrt',
      boolean: '.0FHILNPSUabcilnopqsuvwxz',
    }),
    long: searchOptionTable({
      pattern: ['regexp'],
      file: ['file'],
      exit: ['files', 'generate', 'help', 'pcre2-version', 'type-list', 'version'],
      value: optionNames(`
        after-context before-context color colors context context-separator dfa-size-limit encoding
        engine field-context-separator field-match-separator glob hostname-bin hyperlink-format
        iglob ignore-file max-columns max-count max-depth max-filesize path-separator pre pre-glob
        regex-size-limit replace sort sortr threads type type-add type-clear type-not
      `),
      boolean: optionNames(`
        auto-hybrid-regex binary block-buffered byte-offset case-sensitive column count
        count-matches crlf debug files-with-matches files-without-match fixed-strings follow
        glob-case-insensitive heading hidden ignore ignore-case ignore-dot ignore-exclude
        ignore-file-case-insensitive ignore-files ignore-global ignore-messages ignore-parent
        ignore-vcs include-zero invert-match json line-buffered line-number line-regexp
        max-columns-preview messages mmap multiline multiline-dotall no-auto-hybrid-regex no-binary
        no-block-buffered no-byte-offset no-column no-config no-context-separator no-crlf
        no-encoding no-filename no-fixed-strings no-follow no-glob-case-insensitive no-heading
        no-hidden no-ignore no-ignore-dot no-ignore-exclude no-ignore-file-case-insensitive
        no-ignore-files no-ignore-global no-ignore-messages no-ignore-parent no-ignore-vcs
        no-include-zero no-invert-match no-json no-line-buffered no-line-number
        no-max-columns-preview no-messages no-mmap no-multiline no-multiline-dotall
        no-one-file-system no-pcre2 no-pcre2-unicode no-pre no-require-git no-search-zip
        no-sort-files no-stats no-text no-trim no-unicode null null-data one-file-system
        only-matching passthru pcre2 pcre2-unicode pretty quiet require-git search-zip smart-case
        sort-files stats stop-on-nonmatch text trace trim unicode unrestricted vimgrep with-filename
        word-regexp
      `),
    }),
  },
  grep: {
    // GNU grep accepts a prefix of a long name only when it names ONE option
    // (`--no` is rejected as ambiguous), where two spellings of one option
    // count as one (`--col` is --color). It reads the value of --color only
    // when it is attached with `=`.
    abbreviations: true,
    aliases: { colour: 'color' },
    shortEquals: false,
    short: searchOptionTable({
      pattern: 'e',
      file: 'f',
      exit: 'V',
      value: 'ABCDXdm',
      boolean: '0123456789EFGHILPRTUZabchilnoqrsuvwxyz',
    }),
    long: searchOptionTable({
      pattern: ['regexp'],
      file: ['file'],
      exit: ['help', 'version'],
      value: optionNames(`
        after-context before-context binary-files context devices directories exclude exclude-dir
        exclude-from group-separator include label max-count
      `),
      boolean: optionNames(`
        basic-regexp binary byte-offset color colour count dereference-recursive extended-regexp
        files-with-matches files-without-match fixed-strings ignore-case initial-tab invert-match
        line-buffered line-number line-regexp no-filename no-group-separator no-ignore-case
        no-messages null null-data only-matching perl-regexp quiet recursive silent text
        with-filename word-regexp
      `),
    }),
  },
  // Exact options shared by Git and GNU grep. Git has its own abbreviation
  // rules (--col is ambiguous) and accepts only the short spelling of -e.
  gitGrep: {
    short: searchOptionTable({
      pattern: 'e',
      file: 'f',
      value: 'ABCm',
      boolean: '0123456789EFGHILPachilnoqrvwz',
    }),
    long: searchOptionTable({
      value: optionNames('after-context before-context context max-count'),
      boolean: optionNames(`
        basic-regexp count extended-regexp files-with-matches files-without-match fixed-strings
        ignore-case invert-match line-number null only-matching perl-regexp quiet recursive
        text word-regexp
      `),
      optional: ['color'],
    }),
  },
};

// The kind of a long option name, or undefined when the tool does not have it.
function longSearchOptionKind(options, name) {
  const exact = options.long.get(name);
  if (exact || !options.abbreviations || name === '') return exact;
  const matched = new Set();
  let kind;
  for (const [candidate, candidateKind] of options.long) {
    if (!candidate.startsWith(name)) continue;
    matched.add((options.aliases && options.aliases[candidate]) || candidate);
    kind = candidateKind;
  }
  return matched.size === 1 ? kind : undefined;
}

// The most patterns one search passes on (`rg -e A -e B -e C`); `gitnexus
// augment` reads the same number.
const MAX_PATTERNS = 3;

/**
 * The queries of the `rg` / `grep` command at `tokens[start]` (every `-e`
 * pattern, else the first positional one), or none when they cannot be read
 * reliably. A token is never taken as the query while an earlier option may
 * still claim it as its value: an option this tool does not have, written
 * without an attached `=value`, declines the whole command.
 */
function extractSearchCommandPatterns(tokens, expanded, { start, options }) {
  const gitGrep = options === SEARCH_TOOL_OPTIONS.gitGrep;
  let pending = null;
  let endOptions = false;
  let pattern = null;
  let patternAt = -1;
  // Every `-e` / `--regexp` is a pattern rg or grep searches for.
  const explicitPatterns = [];
  const explicit = (value, at) => explicitPatterns.push({ value, at });

  for (let at = start + 1; at < tokens.length; at++) {
    const token = tokens[at];
    if (pending) {
      // An expanded option value (`--glob {a,b}`) may be several words, so the
      // words after it shift and the query is not the one written.
      if (expanded.has(at)) return [];
      if (pending === 'pattern') explicit(token, at);
      pending = null;
      continue;
    }
    if (!endOptions && token === '--') {
      endOptions = true;
      continue;
    }
    // A lone `-` is the standard-input operand, not an option.
    if (endOptions || !token.startsWith('-') || token === '-') {
      if (pattern === null) {
        pattern = token;
        patternAt = at;
      }
      continue;
    }
    // Git stops parsing options at the first pattern or revision. A later
    // dash-prefixed path must follow -- to be unambiguous.
    if (gitGrep && pattern !== null) return [];
    if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      const attached = separator !== -1;
      const kind = longSearchOptionKind(options, token.slice(2, attached ? separator : undefined));
      if (gitGrep && (!kind || (attached && kind === 'boolean'))) return [];
      if (kind === 'pattern') {
        if (attached) explicit(token.slice(separator + 1), at);
        else pending = 'pattern';
      } else if (kind === 'file' || kind === 'exit') {
        // File-backed queries are unavailable without reading user files, and
        // an informational option runs no search.
        return [];
      } else if (attached) {
        // `--name=value` carries its own value and cannot consume the next token.
      } else if (kind === 'value') {
        pending = 'skip';
      } else if (kind !== 'boolean' && kind !== 'optional') {
        // An unknown option may consume the next token. Do not guess a pattern.
        return [];
      }
      continue;
    }
    // A bundle of short options: every letter before the last is a switch, and
    // a letter that takes a value reads the rest of the token or the next one.
    for (let i = 1; i < token.length; i++) {
      const kind = options.short.get(token[i]);
      if (kind === 'boolean') continue;
      if (kind !== 'pattern' && kind !== 'value') return [];
      const rest = token.slice(i + 1);
      if (rest === '') pending = kind === 'pattern' ? 'pattern' : 'skip';
      else if (kind === 'pattern')
        explicit(options.shortEquals && rest.startsWith('=') ? rest.slice(1) : rest, at);
      break;
    }
  }
  const positional = pattern === null ? [] : [{ value: pattern, at: patternAt }];
  const found = explicitPatterns.length > 0 ? explicitPatterns : positional;
  // The shell rewrites an expanded word, so rg or grep does not receive the
  // query as written.
  if (pending || found.some(({ at }) => expanded.has(at))) return [];
  return found
    .map(({ value }) => value)
    .filter((value) => value.length >= 3)
    .slice(0, MAX_PATTERNS);
}

// Commands that run the word after them, with its own arguments. `npx` and
// `bunx` run a package binary, so `npx rg` is the ripgrep a project installs,
// and Windows has a `sudo` too. The others are bash keywords, builtins or Unix
// tools that PowerShell does not have. `git` counts only before `grep`, with
// `--no-pager` as the one global option read past.
const WRAPPERS = {
  bash: new Set(['bunx', 'command', 'env', 'exec', 'nice', 'npx', 'sudo', 'time', 'xargs']),
  powershell: new Set(['bunx', 'npx', 'sudo']),
};

/**
 * Locate the search executable and select its option grammar. Only env and
 * sudo consume assignment arguments. Wrapper options can consume arguments
 * or select another operation entirely (for example, `command -v`).
 */
function searchCommandStart(tokens, shell, expanded) {
  const wrappers = WRAPPERS[shell];
  let assigns = false;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    // Brace expansion can insert a second command word. A leading tilde in
    // an executable path still expands to one path with the same basename.
    if ((expanded.has(at) && token.includes('{')) || token.startsWith('-')) return null;
    if (/^[A-Za-z_]\w*=/.test(token)) {
      if (!assigns || /[()]/.test(token)) return null;
      continue;
    }
    const basename = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
    const tool = /^(rg|grep)(?:\.exe)?$/.exec(basename);
    if (tool) return { start: at, options: SEARCH_TOOL_OPTIONS[tool[1]] };
    const command = basename.replace(/\.(exe|cmd)$/i, '');
    if (command === 'git') {
      let next = at + 1;
      if (tokens[next] === '--no-pager') next++;
      return tokens[next] === 'grep' ? { start: next, options: SEARCH_TOOL_OPTIONS.gitGrep } : null;
    }
    if (!wrappers.has(command)) return null;
    assigns = shell === 'bash' && (command === 'env' || command === 'sudo');
  }
  return null;
}

// bash runs `NAME=value rg x` as `rg x` with NAME set in its environment. The
// name must be bare: a quoted `'NAME=value'` is a command name. PowerShell has
// no such prefix and would run `NAME=value` itself. A value may hold `$NAME`,
// but not a substitution or an array (`$(...)`, `${...}`, a backtick,
// `(...)`): the strip would end at a blank inside it and read the rest as the
// command, so such a line keeps its prefix and has no query.
// Leading blank lines precede the first command. After an assignment, only
// horizontal whitespace can join it to the command on the same line.
const BASH_ASSIGNMENTS =
  /^[ \t\n]*(?:[A-Za-z_]\w*=(?:[^\s"'\\;&|<>$`()]|\$(?=[A-Za-z_])|\\.|"(?:[^"\\$`]|\$(?=[A-Za-z_])|\\.)*"|'[^']*')*[ \t]+)*/;

/**
 * The queries of a command line: every pattern of the search, at most
 * MAX_PATTERNS, or none when it runs no search whose queries can be read.
 * `shell` is the shell that reads the line: `bash`, `powershell`, or `either`
 * when the caller cannot tell; then both readings must give the same queries
 * (other words, such as a path, may differ).
 */
function searchCommandPatterns(command, shell = 'bash') {
  if (typeof command !== 'string' || !/\brg\b|\bgrep\b/.test(command)) return [];
  const read = (line, lineShell) => {
    const expanded = new Set();
    const tokens = tokenizeShellCommand(line, lineShell, expanded);
    const search = searchCommandStart(tokens, lineShell, expanded);
    return search ? extractSearchCommandPatterns(tokens, expanded, search) : [];
  };
  const inBash = () => read(command.replace(BASH_ASSIGNMENTS, ''), 'bash');
  // A leading PowerShell call operator invokes the command word that follows.
  const inPowerShell = () => read(command.trimStart().replace(/^&(?!&)/, ''), 'powershell');
  if (shell === 'powershell') return inPowerShell();
  if (shell !== 'either') return inBash();
  const queries = inBash();
  // `either` is the Windows case. Git Bash converts an argument that looks like
  // a Unix path (`/api/x`, `--x=/y`, `/a:/b`), quoted or not, to a Windows path
  // before it starts a native rg.exe, so such a query is not what rg receives.
  if (queries.length === 0 || queries.some((query) => /(^|[=:])\//.test(query))) return [];
  const other = inPowerShell();
  const agree = other.length === queries.length && other.every((query, i) => query === queries[i]);
  return agree ? queries : [];
}

/** The first query of a command line, or null; see searchCommandPatterns. */
function searchCommandPattern(command, shell = 'bash') {
  return searchCommandPatterns(command, shell)[0] ?? null;
}

module.exports = { searchCommandPattern, searchCommandPatterns };
