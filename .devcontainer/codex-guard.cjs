#!/usr/bin/env node
// Codex PreToolUse hook: refuses shell commands that destroy work or publish
// irreversibly. In this dev container Codex runs without its sandbox (the
// container cannot create user namespaces) and `codex exec` never asks, so this
// is the one check between a bad command and the disk.
//
// agent-setup.cjs copies this file to ~/.codex/hooks/guard/deny-destructive.cjs
// and registers it in ~/.codex/hooks.json. It must stay self-contained: no
// requires beyond Node's own.
//
// Contract (Codex hooks): the call arrives as JSON on stdin with the command at
// tool_input.command; exit 2 with the reason on stderr blocks it; exit 0 lets it
// run. CODEX_GUARD=off in the environment Codex was started with turns it off.
'use strict';

// Deleting any of these recursively is never what a task needs.
const PROTECTED = [
  /^\/\*?$/, // / and /*
  /^~\/?\*?$/, // ~ ~/ ~/*
  /^\$\{?HOME\}?\/?\*?$/,
  /^\/home(\/\*|\/node\/?\*?)?\/?$/,
  /^\/workspace\/?\*?$/,
  /^\/(etc|usr|var|bin|lib|opt|root)(\/.*)?$/,
  /^\.{1,2}\/?$/, // . and ..
  /^\*$/, // a bare * deletes whatever the current folder happens to be
  /(^|\/)\.git\/?$/,
  /(^|\/)\.(claude|codex|claude-mem)(\/\*?)?$/,
];

// Words a command may stand behind: `sudo rm`, `env A=b rm`, `xargs rm`.
const PREFIXES = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'xargs', 'nice']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// git options that take a value, so the word after them is not the subcommand.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/**
 * Splits a command line into simple commands, each a list of words, honouring
 * quotes: `git commit -m "rm -rf /"` is one command whose last word is text.
 * ponytail: no $(...) or backtick parsing, and no variable expansion. A command
 * hidden in a substitution or built from variables is not seen; a real shell
 * parser (or denying substitutions outright) is the upgrade if that matters.
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
    if (quote !== '') {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && at + 1 < line.length) {
      word += line[(at += 1)];
      hasWord = true;
    } else if (/\s/.test(char) && char !== '\n') {
      endWord();
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      endCommand();
    } else {
      word += char;
      hasWord = true;
    }
  }
  endCommand();

  return commands;
}

/** @returns {string | undefined} why the command is refused */
function refusal(line, depth = 0) {
  if (/:\(\)\s*\{[^}]*\|\s*:\s*&/.test(line)) return 'a fork bomb';
  for (const all of simpleCommands(line)) {
    let words = all;
    while (
      words.length > 1 &&
      (PREFIXES.has(words[0].split('/').pop()) ||
        /^[A-Za-z_]\w*=/.test(words[0]) ||
        words[0].startsWith('-'))
    ) {
      words = words.slice(1);
    }
    const name = (words[0] ?? '').split('/').pop();
    const args = words.slice(1);

    if (SHELLS.has(name) && depth < 3) {
      const flag = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
      const why = flag === -1 ? undefined : refusal(args[flag + 1] ?? '', depth + 1);
      if (why !== undefined) return why;
    }

    if (name === 'rm') {
      const flags = args.filter((arg) => arg.startsWith('-')).join(' ');
      const targets = args.filter((arg) => !arg.startsWith('-'));
      const isRecursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
      const hit = targets.find((target) => PROTECTED.some((path) => path.test(target)));
      if (isRecursive && hit !== undefined) return `rm -r on ${hit}`;
      const memory = targets.find((target) => /\.claude-mem(\/|$)|claude-mem\.db/.test(target));
      if (memory !== undefined) return `rm on the claude-mem store (${memory})`;
    }

    if (name === 'git') {
      let at = 0;
      while (at < args.length && args[at].startsWith('-'))
        at += GIT_VALUE_OPTIONS.has(args[at]) ? 2 : 1;
      const verb = args[at];
      const rest = args.slice(at + 1);
      if (verb === 'push') {
        if (rest.some((arg) => arg === '-f' || arg === '--force' || /^\+/.test(arg))) {
          return 'git push --force (use --force-with-lease on your own branch)';
        }
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
    if (/^(mkfs(\.\w+)?|shutdown|reboot|halt|poweroff)$/.test(name))
      return 'a disk or power command';
    if (name === 'chmod' || name === 'chown') {
      const isRecursive = args.some((arg) => /^-[a-zA-Z]*R|--recursive/.test(arg));
      const hit = args.find((arg) => /^(\/|~\/?|\$\{?HOME\}?\/?|\/home\/?)$/.test(arg));
      if (isRecursive && hit !== undefined) return `${name} -R on ${hit}`;
    }
    if (name === 'npm' && args[0] === 'publish') return 'npm publish';
    if (name === 'gh' && /^(repo|release)$/.test(args[0] ?? '') && args[1] === 'delete') {
      return `gh ${args[0]} delete`;
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
