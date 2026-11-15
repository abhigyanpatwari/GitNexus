#!/usr/bin/env node
// Codex PreToolUse hook: refuses the common shell commands that destroy work or
// publish irreversibly. In this dev container Codex runs without its sandbox
// (the container cannot create user namespaces) and `codex exec` never asks.
//
// It is a best-effort check on the command text, not a boundary. It reads
// literal commands and literal targets. It cannot see a target or a command
// built from a variable or a substitution (`rm -rf "$DIR"`,
// `rm -rf "$(printf /workspace)"`), and a tool that deletes by other means
// (`find -delete`, a script) passes. Refusing every such form would refuse
// routine cleanup, so the limit is stated here instead.
//
// agent-setup.cjs copies this file to ~/.codex/hooks/guard/deny-destructive.cjs
// and registers it in ~/.codex/hooks.json. It must stay self-contained: no
// requires beyond Node's own.
//
// Contract (Codex hooks): the call arrives as JSON on stdin with the command at
// tool_input.command; exit 2 with the reason on stderr blocks it; exit 0 lets it
// run. CODEX_GUARD=off in the environment Codex was started with turns it off.
'use strict';

const path = require('node:path');

// Deleting any of these recursively is never what a task needs.
const PROTECTED = [
  /^\/\*?$/, // / and /*
  /^~\/?\*?$/, // ~ ~/ ~/*
  /^\$\{?HOME\}?\/?\*?$/,
  /^\/home(\/\*|\/node\/?\*?)?\/?$/,
  /^\/workspace\/?\*?$/,
  /^\/(etc|usr|var|bin|lib|opt|root)(\/.*)?$/,
  /^\.\.?(\/\*?)?$/, // . .. ./ ../ ../*
  /^\*$/, // a bare * deletes whatever the current folder happens to be
  /(^|\/)\.\*$/, // a hidden-file glob reaches .git and the tool folders, wherever it stands
  /(^|\/)\.git\/?$/,
  /(^|\/)\.(claude|codex|claude-mem)(\/\*?)?$/,
];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// git options that take a value, so the word after them is not the subcommand.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// Tools whose own `rm` subcommand is not the shell's rm (`git rm -r --cached .`).
const HAVE_RM_SUBCOMMAND = new Set([
  'git',
  'docker',
  'podman',
  'npm',
  'pnpm',
  'yarn',
  'gh',
  'kubectl',
  'helm',
]);

/**
 * Splits a command line into simple commands, each a list of words, honouring
 * quotes: `git commit -m "rm -rf /"` is one command whose last word is text.
 * Grouping and substitution marks end a command too, so what stands inside
 * `( ... )`, `{ ...; }`, `$( ... )` and backticks is read as commands of its own.
 * ponytail: no variable expansion. A command built from variables (`$X -rf /`)
 * is not seen; a real shell parser is the upgrade if that matters.
 */
function simpleCommands(line) {
  const commands = [];
  let words = [];
  let word = '';
  let hasWord = false;
  let quote = '';
  const endWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote === "'") {
      if (char === quote) quote = '';
      else word += char;
    } else if (quote === '"') {
      // A substitution inside double quotes still runs. Its text is read as
      // commands from there on; losing track of the closing quote only splits
      // the rest into more words, which fails closed.
      if (char === quote) quote = '';
      else if (char === '`' || (char === '$' && line[at + 1] === '(')) {
        endCommand();
        quote = '';
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && at + 1 < line.length) {
      word += line[(at += 1)];
      hasWord = true;
    } else if (/\s/.test(char) && char !== '\n') {
      endWord();
    } else if (';|&\n(){}`'.includes(char)) {
      endCommand();
    } else {
      word += char;
      hasWord = true;
    }
  }
  endCommand();

  return commands;
}

/**
 * Drops redirections, which may stand anywhere in a command, before its name
 * included: `2>/dev/null rm -rf /` runs rm. An operator written apart from its
 * target (`> out.txt`) takes the next word with it.
 */
function withoutRedirections(words) {
  const kept = [];
  for (let at = 0; at < words.length; at += 1) {
    const redirection = /^\d*(?:>>?|<<?<?)(.*)$/.exec(words[at]);
    if (redirection === null) kept.push(words[at]);
    else if (redirection[1] === '') at += 1;
  }
  return kept;
}

/** A command word without its folder: `/usr/bin/rm` is `rm`. A missing word is ''. */
const nameOf = (word) => (word ?? '').split('/').pop();

/** Why `name args...` is refused, when `name` is a command this guard watches. */
function judge(name, args, before, depth) {
  if (SHELLS.has(name) || name === 'eval') {
    // `sh -c '<script>'` and `eval <words>` run their argument as a command line.
    // Past a few levels the script is refused unread: any fixed depth can be out-nested.
    if (depth >= 3) return 'a shell nested too deep to check';
    const flag = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
    const script = name === 'eval' ? args.join(' ') : flag === -1 ? '' : (args[flag + 1] ?? '');
    return refusal(script, depth + 1);
  }

  if (name === 'rm' && !HAVE_RM_SUBCOMMAND.has(before)) {
    const flags = args.filter((arg) => arg.startsWith('-')).join(' ');
    // An empty word is what is left of a quoted substitution: a computed target, not `.`.
    const targets = args.filter((arg) => arg !== '' && !arg.startsWith('-'));
    const isRecursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
    // `.` and `..` segments are resolved before matching: `./*` is `*`, `././.git`
    // is `.git`, and `/workspace/../*` is `/*`.
    const hit = targets.find((target) => {
      const plain = path.posix.normalize(target);
      return PROTECTED.some((root) => root.test(plain));
    });
    if (isRecursive && hit !== undefined) return `rm -r on ${hit}`;
    const memory = targets.find((target) => /\.claude-mem(\/|$)|claude-mem\.db/.test(target));
    if (memory !== undefined) return `rm on the claude-mem store (${memory})`;
  }

  if (name === 'git') {
    let at = 0;
    while (at < args.length && args[at].startsWith('-')) {
      at += GIT_VALUE_OPTIONS.has(args[at]) ? 2 : 1;
    }
    const verb = args[at];
    const rest = args.slice(at + 1);
    if (verb === 'push') {
      // `-f` may be clustered with other short options: `git push -fu origin x`.
      const isForce = (arg) => arg === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg);
      if (rest.some((arg) => isForce(arg) || /^\+/.test(arg))) {
        return 'git push --force (use --force-with-lease on your own branch)';
      }
      // --mirror overwrites and deletes remote refs without any force flag.
      if (rest.includes('--mirror'))
        return 'git push --mirror (it overwrites and deletes remote refs)';
      const refs = rest.filter((arg) => !arg.startsWith('-')).slice(1);
      if (refs.some((ref) => /(^|:)(refs\/heads\/)?(main|master)$/.test(ref))) {
        return 'git push to main (work goes through a pull request)';
      }
    }
    if (verb === 'clean' && rest.some((arg) => /^-[a-zA-Z]*[xX]/.test(arg))) {
      return 'git clean -x (it deletes ignored files: local skills, indexes, node_modules)';
    }
  }

  if (name === 'dd' && args.some((arg) => /^of=\/dev\//.test(arg))) return 'dd onto a device';
  if (/^mkfs(\.\w+)?$/.test(name)) return 'a disk format command';
  if (name === 'chmod' || name === 'chown') {
    const isRecursive = args.some((arg) => /^-[a-zA-Z]*R|--recursive/.test(arg));
    const hit = args.find((arg) => /^(\/|~\/?|\$\{?HOME\}?\/?|\/home\/?)$/.test(arg));
    if (isRecursive && hit !== undefined) return `${name} -R on ${hit}`;
  }
  if (name === 'npm' && args[0] === 'publish') return 'npm publish';
  if (name === 'gh' && /^(repo|release)$/.test(args[0] ?? '') && args[1] === 'delete') {
    return `gh ${args[0]} delete`;
  }

  return undefined;
}

/**
 * Why the command line is refused, or undefined when it may run.
 *
 * A watched command is judged wherever it stands in a simple command, not only
 * as its first word. What may precede a command is open-ended (`timeout 10`,
 * `stdbuf -o0`, `!`, `then`, a redirection in any spelling), so a list of
 * allowed prefixes is a list of bypasses. The price is that an unquoted
 * mention is refused too (`echo rm -rf /`): the guard fails closed.
 */
function refusal(line, depth = 0) {
  if (/:\(\)\s*\{[^}]*\|\s*:\s*&/.test(line)) return 'a fork bomb';
  for (const all of simpleCommands(line)) {
    const words = withoutRedirections(all);
    for (let at = 0; at < words.length; at += 1) {
      const why = judge(nameOf(words[at]), words.slice(at + 1), nameOf(words[at - 1]), depth);
      if (why !== undefined) return why;
    }
  }

  return undefined;
}

function main() {
  if (process.env.CODEX_GUARD === 'off') process.exit(0);
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let command = '';
    try {
      const call = JSON.parse(input);
      if (call.tool_name === 'Bash' && typeof call.tool_input?.command === 'string') {
        command = call.tool_input.command;
      }
    } catch {
      // An unreadable payload is not a shell command this guard can judge: let Codex go on.
    }
    const why = refusal(command);
    if (why === undefined) process.exit(0);
    console.error(
      `Blocked by the destructive-command guard: ${why}. ` +
        'If the person asked for exactly this, tell them; they can run it themselves ' +
        'or start Codex with CODEX_GUARD=off.',
    );
    process.exit(2);
  });
}

module.exports = { refusal };

if (require.main === module) main();
