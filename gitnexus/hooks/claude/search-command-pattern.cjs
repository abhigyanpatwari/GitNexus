/**
 * The query of a shell command that runs `rg` or `grep`, read without running
 * a shell. The Claude-schema and Antigravity adapters search the graph for it.
 *
 * Only the first simple command of the line is read. A search later in the
 * line may read a file the command names (`sed -i x notes.md && grep -c word
 * notes.md`), the output of the command before it (`git log | grep fix`), or
 * another directory (`cd src && rg x`), and the line alone does not say which,
 * so none of them is taken as a code search. In bash, variable assignments
 * before the command (`NO_COLOR=1 rg x`) belong to it. A query that cannot be
 * read reliably (a shell expansion, an unknown option, a pattern file) gives
 * none.
 *
 * The Cursor and Factory adapters ship as single files with their own parser,
 * and the OpenCode plugin has its own too; all three apply the same
 * first-command rule.
 */

// Read literal argv from the first simple command without executing a shell.
// Quotes group words; expansions and malformed input have no reliable query.
// In bash a backslash escapes the next character outside single quotes. In
// PowerShell it is an ordinary character, a doubled quote inside quotes is one
// literal quote, and a bare comma, parenthesis, brace or leading `@` builds a
// value the shell computes, so the command has no reliable query.
function tokenizeShellCommand(command, shell) {
  const powershell = shell === 'powershell';
  const tokens = [];
  let word = '';
  let quote = null;
  let started = false;
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
    } else if (/[;&|<>\n\r]/.test(ch) || (ch === '#' && !started)) {
      break;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  if (started) tokens.push(word);
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

/**
 * The query of one tokenized `rg` / `grep` command line, or null when it has
 * none that can be read reliably. A token is never taken as the query while an
 * earlier option may still claim it as its value: an option this tool does not
 * have, written without an attached `=value`, declines the whole command.
 */
function extractSearchCommandPattern(tokens) {
  const tool = /(?:^|[/\\])(rg|grep)(?:\.exe)?$/.exec(tokens[0] || '');
  if (!tool) return null;
  const options = SEARCH_TOOL_OPTIONS[tool[1]];
  let pending = null;
  let endOptions = false;
  let pattern = null;
  let explicitPattern = null;

  for (const token of tokens.slice(1)) {
    if (pending) {
      if (pending === 'pattern') explicitPattern ??= token;
      pending = null;
      continue;
    }
    if (!endOptions && token === '--') {
      endOptions = true;
      continue;
    }
    // A lone `-` is the standard-input operand, not an option.
    if (endOptions || !token.startsWith('-') || token === '-') {
      pattern ??= token;
      continue;
    }
    if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      const attached = separator !== -1;
      const kind = longSearchOptionKind(options, token.slice(2, attached ? separator : undefined));
      if (kind === 'pattern') {
        if (attached) explicitPattern ??= token.slice(separator + 1);
        else pending = 'pattern';
      } else if (kind === 'file' || kind === 'exit') {
        // File-backed queries are unavailable without reading user files, and
        // an informational option runs no search.
        return null;
      } else if (attached) {
        // `--name=value` carries its own value and cannot consume the next token.
      } else if (kind === 'value') {
        pending = 'skip';
      } else if (kind !== 'boolean') {
        // An unknown option may consume the next token. Do not guess a pattern.
        return null;
      }
      continue;
    }
    // A bundle of short options: every letter before the last is a switch, and
    // a letter that takes a value reads the rest of the token or the next one.
    for (let i = 1; i < token.length; i++) {
      const kind = options.short.get(token[i]);
      if (kind === 'boolean') continue;
      if (kind !== 'pattern' && kind !== 'value') return null;
      const rest = token.slice(i + 1);
      if (rest === '') pending = kind === 'pattern' ? 'pattern' : 'skip';
      else if (kind === 'pattern')
        explicitPattern ??= options.shortEquals && rest.startsWith('=') ? rest.slice(1) : rest;
      break;
    }
  }
  const result = explicitPattern ?? pattern;
  return !pending && result?.length >= 3 ? result : null;
}

// bash runs `NAME=value rg x` as `rg x` with NAME set in its environment. The
// name must be bare: a quoted `'NAME=value'` is a command name. PowerShell has
// no such prefix and would run `NAME=value` itself.
const BASH_ASSIGNMENTS =
  /^[ \t]*(?:[A-Za-z_]\w*=(?:[^\s"'\\;&|<>]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')*[ \t]+)+/;

/**
 * The query of a command line, or null when it runs no search whose query can
 * be read. `shell` is the shell that reads the line: `bash`, `powershell`, or
 * `either` when the caller cannot tell; then the two readings must agree.
 */
function searchCommandPattern(command, shell = 'bash') {
  if (typeof command !== 'string' || !/\brg\b|\bgrep\b/.test(command)) return null;
  const tokens =
    shell === 'powershell'
      ? tokenizeShellCommand(command, 'powershell')
      : tokenizeShellCommand(command.replace(BASH_ASSIGNMENTS, ''), 'bash');
  if (shell === 'either') {
    const other = tokenizeShellCommand(command, 'powershell');
    if (other.length !== tokens.length || other.some((token, i) => token !== tokens[i])) {
      return null;
    }
  }
  return extractSearchCommandPattern(tokens);
}

module.exports = { searchCommandPattern };
