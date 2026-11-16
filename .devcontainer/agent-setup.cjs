#!/usr/bin/env node
// Makes the Claude Code and Codex setup of this dev container reproducible.
//
// post-create.sh runs it once the host snapshot is seeded; it is also safe to run
// by hand at any time (`node .devcontainer/agent-setup.cjs`): every step checks
// what is already there and changes nothing that is already right. A step that
// fails is reported and the rest still run, so a missing network or CLI never
// fails container creation. GITNEXUS_AGENT_SETUP=off skips all of it.
//
// What it does, and why:
//   1. Drops host-only entries from the seeded Codex and Claude config. A config
//      copied from a Windows host names MCP servers, a notify program and plugin
//      marketplaces by C:\ paths, which fail on every start in this Linux
//      container.
//   2. Gives Codex a working default when the container cannot create user
//      namespaces (the usual case under Docker): its bubblewrap sandbox cannot
//      start, so every sandboxed command fails. The container is the boundary.
//   3. Installs the destructive-command guard as a Codex hook (codex-guard.cjs).
//   4. Installs the side-panels mod for Claude Code and points Claude at it.
//   5. Fetches the plugin marketplaces the seeded Codex config names, and gives
//      Codex the plugins the person already uses in Claude Code where the same
//      plugin ships a Codex build (compound-engineering, claude-mem).
//   6. Gives Codex an entry skill for pr-tri-review that points at the shared one.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOWS_PATH = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]|^\\\\/;

/**
 * The text of the TOML basic or literal string a value starts with, or
 * undefined for anything else. What follows the string (a comment) is ignored.
 */
function tomlString(raw) {
  const value = raw.trim();
  const literal = /^'([^']*)'/.exec(value);
  if (literal) return literal[1];
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) return basic[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  return undefined;
}

/** The keys of a dotted TOML table name; a quoted key may hold dots of its own. */
const tomlKeys = (name) =>
  [...name.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+)/g)].map(
    (key) => key[1] ?? key[2] ?? key[3],
  );

// A table header, alone on its line or followed by a comment.
const TABLE_HEADER = /^\[+([^\]]+)\]+\s*(?:#.*)?$/;

const isWindowsValue = (raw) => WINDOWS_PATH.test(tomlString(raw) ?? '');

/** Splits TOML into the lines before the first table and the tables after it. */
function tomlParts(text) {
  const preamble = [];
  const tables = [];
  for (const line of text.split('\n')) {
    const header = TABLE_HEADER.exec(line);
    if (header) tables.push({ name: header[1].trim(), lines: [line] });
    else (tables.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, tables };
}

const tomlJoin = ({ preamble, tables }) =>
  [...preamble, ...tables.flatMap((table) => table.lines)].join('\n');

const valueOf = (table, key) =>
  table.lines
    .map((line) => new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line)?.[1])
    .find((value) => value !== undefined);

/**
 * The index of the line that ends the value assigned on `lines[at]`. An array
 * may run over several lines; a bracket inside one of its strings does not close it.
 * ponytail: multi-line strings (three quotes) are not read; a real TOML parser is the upgrade.
 */
function valueEnd(lines, at) {
  let depth = 0;
  for (let end = at; end < lines.length; end += 1) {
    const line = lines[end];
    let quote = '';
    for (let i = end === at ? line.indexOf('=') + 1 : 0; i < line.length; i += 1) {
      const char = line[i];
      if (quote !== '') {
        if (char === '\\' && quote === '"') i += 1;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '#') break;
      else if (char === '[') depth += 1;
      else if (char === ']') depth -= 1;
    }
    if (depth <= 0) return end;
  }

  return lines.length - 1;
}

/**
 * Removes what only works on the host the config was copied from: MCP servers
 * started by a Windows executable, plugin marketplaces at a Windows path, and a
 * Windows `notify` program. Everything else is kept byte for byte.
 */
function cleanCodexConfig(text) {
  const parts = tomlParts(text);
  const removed = [];

  const preamble = [];
  for (let at = 0; at < parts.preamble.length; at += 1) {
    const line = parts.preamble[at];
    if (!/^notify\s*=/.test(line)) {
      preamble.push(line);
      continue;
    }
    const end = valueEnd(parts.preamble, at);
    const value = parts.preamble.slice(at, end + 1).join('\n');
    const program = /=\s*\[\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(value)?.[1] ?? '';
    if (isWindowsValue(program)) {
      removed.push('notify');
      at = end;
    } else {
      preamble.push(line);
    }
  }

  // A table belongs to an entry when its name starts with the entry's two keys:
  // `[mcp_servers.x]` and `[mcp_servers.x.env]`, `[mcp_servers."win.tool"]` too.
  const dead = [];
  for (const table of parts.tables) {
    const keys = tomlKeys(table.name);
    if (keys.length !== 2) continue;
    const isDeadServer =
      keys[0] === 'mcp_servers' && isWindowsValue(valueOf(table, 'command') ?? '');
    const isDeadMarketplace =
      keys[0] === 'marketplaces' && isWindowsValue(valueOf(table, 'source') ?? '');
    if (isDeadServer || isDeadMarketplace) dead.push(keys);
  }
  removed.push(...dead.map((keys) => keys.join('.')));
  const tables = parts.tables.filter((table) => {
    const keys = tomlKeys(table.name);
    return !dead.some((entry) => entry[0] === keys[0] && entry[1] === keys[1]);
  });

  return { text: tomlJoin({ preamble, tables }), removed };
}

const SANDBOX_NOTE = [
  '# Set by .devcontainer/agent-setup.cjs: this container cannot create user',
  "# namespaces, so Codex's bubblewrap sandbox cannot start. The container is the",
  '# boundary. Remove these lines to return to the Codex defaults.',
];

/**
 * Adds the container defaults unless the config already chooses a sandbox mode.
 * An approval policy the config already sets is kept: TOML refuses a key twice.
 */
function withSandboxDefaults(text, canSandbox) {
  const parts = tomlParts(text);
  const has = (key) => parts.preamble.some((line) => new RegExp(`^${key}\\s*=`).test(line));
  if (canSandbox || has('sandbox_mode')) return text;
  const preamble = [...parts.preamble];
  while (preamble.length > 0 && preamble.at(-1).trim() === '') preamble.pop();
  const gap = preamble.length > 0 ? [''] : [];
  const policy = has('approval_policy') ? [] : ['approval_policy = "on-request"'];
  return tomlJoin({
    preamble: [
      ...preamble,
      ...gap,
      ...SANDBOX_NOTE,
      'sandbox_mode = "danger-full-access"',
      ...policy,
      '',
    ],
    tables: parts.tables,
  });
}

/** Registers the guard as a PreToolUse hook on Bash, after any hook already there. */
function withGuardHook(hooks, guardPath) {
  const command = `node '${guardPath}'`;
  const entries = hooks?.hooks?.PreToolUse ?? [];
  const isRegistered = entries.some((entry) =>
    (entry.hooks ?? []).some((hook) => hook.command === command),
  );
  if (isRegistered) return hooks;
  return {
    ...hooks,
    hooks: {
      ...hooks?.hooks,
      PreToolUse: [
        ...entries,
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 10,
              statusMessage: 'Checking for destructive commands...',
            },
          ],
        },
      ],
    },
  };
}

/** Removes MCP servers started by a Windows executable, user-level and per project. */
function cleanClaudeMcpServers(config) {
  const removed = [];
  const clean = (servers) =>
    Object.fromEntries(
      Object.entries(servers ?? {}).filter(([name, server]) => {
        const isDead = WINDOWS_PATH.test(String(server?.command ?? ''));
        if (isDead) removed.push(name);
        return !isDead;
      }),
    );
  const next = { ...config };
  if (config.mcpServers) next.mcpServers = clean(config.mcpServers);
  if (config.projects) {
    next.projects = Object.fromEntries(
      Object.entries(config.projects).map(([name, project]) => [
        name,
        project?.mcpServers ? { ...project, mcpServers: clean(project.mcpServers) } : project,
      ]),
    );
  }
  return { config: removed.length > 0 ? next : config, removed };
}

/** Adds a mod folder to the folders Claude Code loads plugins from, once. */
function withPluginDir(settings, dir, home = os.homedir()) {
  const current = String(settings?.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  // Claude Code accepts `~/...` here, so a folder written that way is the same folder.
  const absolute = (entry) => (entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry);
  if (current.map(absolute).includes(dir)) return settings;
  return {
    ...settings,
    env: { ...settings?.env, CLAUDE_CODE_PLUGIN_DIRS: [...current, dir].join(path.delimiter) },
  };
}

// --- everything below touches the machine ---------------------------------

const log = (message) => console.log(`[agent-setup] ${message}`);

/** Codex's own folder: CODEX_HOME when the container sets it, else ~/.codex. */
const codexHome = (home) => process.env.CODEX_HOME || path.join(home, '.codex');

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

/** Writes only when the content differs, keeping one copy of the first original. */
function writeIfChanged(file, text) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (before !== undefined && before !== text && !fs.existsSync(`${file}.before-agent-setup`)) {
    fs.writeFileSync(`${file}.before-agent-setup`, before);
  }
  return writeText(file, text);
}

/** Writes the file when its content differs, creating its folder; says whether it wrote. */
function writeText(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

const writeJsonIfChanged = (file, before, after) =>
  after !== before && writeIfChanged(file, `${JSON.stringify(after, null, 2)}\n`);

function run(command, args, timeoutMs = 180_000) {
  // stdin is closed on purpose: `codex` waits forever on an open one.
  const ran = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  return { ok: ran.status === 0, output: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
}

function setUpCodexConfig(home) {
  const file = path.join(codexHome(home), 'config.toml');
  // No config yet (a host that never ran Codex): the sandbox default is still needed,
  // so the file is created with it.
  const cleaned = cleanCodexConfig(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const canSandbox = run('unshare', ['-U', 'true'], 10_000).ok;
  const changed = writeIfChanged(file, withSandboxDefaults(cleaned.text, canSandbox));
  log(
    `codex config: ${changed ? 'updated' : 'already right'}` +
      (cleaned.removed.length > 0 ? `, removed host-only ${cleaned.removed.join(', ')}` : '') +
      (canSandbox ? '' : ', sandbox unavailable here so full access with ask-on-request'),
  );
}

function setUpCodexGuard(home) {
  const guard = path.join(codexHome(home), 'hooks', 'guard', 'deny-destructive.cjs');
  const source = fs.readFileSync(path.join(__dirname, 'codex-guard.cjs'), 'utf8');
  const copied = writeIfChanged(guard, source);
  const file = path.join(codexHome(home), 'hooks.json');
  const before = readJson(file);
  const registered = writeJsonIfChanged(file, before, withGuardHook(before, guard));
  log(
    `codex guard: ${copied || registered ? 'installed' : 'already installed'}` +
      ' (Codex runs a new hook only after you trust it: run /hooks in codex once)',
  );
}

function setUpClaudeMcp(home) {
  const file = path.join(home, '.claude.json');
  if (!fs.existsSync(file)) return log('claude mcp: no ~/.claude.json yet');
  const before = readJson(file);
  const cleaned = cleanClaudeMcpServers(before);
  writeJsonIfChanged(file, before, cleaned.config);
  log(
    cleaned.removed.length > 0
      ? `claude mcp: removed host-only ${cleaned.removed.join(', ')}`
      : 'claude mcp: already right',
  );
}

function setUpSidePanels(home) {
  const target = path.join(home, '.claude', 'mods', 'side-panels');
  const source = path.join(__dirname, 'agent-assets', 'side-panels');
  let copied = 0;
  for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(entry.parentPath, entry.name);
    const to = path.join(target, path.relative(source, from));
    // A repository asset: no backup copy is kept beside what it replaces.
    if (writeText(to, fs.readFileSync(from, 'utf8'))) copied += 1;
  }
  const file = path.join(home, '.claude', 'settings.json');
  const before = readJson(file);
  const pointed = writeJsonIfChanged(file, before, withPluginDir(before, target));
  log(
    `side-panels mod: ${copied > 0 ? `${copied} file(s) installed` : 'already installed'}` +
      `${pointed ? ', added to CLAUDE_CODE_PLUGIN_DIRS' : ''} (open it with /panels)`,
  );
}

function setUpCodexPlugins(home) {
  if (!run('codex', ['--version'], 20_000).ok) return log('codex plugins: codex is not installed');
  // The seeded config names Git marketplaces whose snapshots were not copied with
  // it. Until they are fetched again `codex plugin list` fails and no plugin loads.
  let listed = run('codex', ['plugin', 'list']);
  if (!listed.ok && /failed to load configured marketplace snapshot/.test(listed.output)) {
    run('codex', ['plugin', 'marketplace', 'upgrade']);
    listed = run('codex', ['plugin', 'list']);
    log(`codex plugins: marketplace snapshots ${listed.ok ? 'fetched again' : 'still missing'}`);
  }
  const enabled = Object.entries(
    readJson(path.join(home, '.claude', 'settings.json')).enabledPlugins ?? {},
  )
    .filter(([, isOn]) => isOn === true)
    .map(([id]) => id);
  const claudeMem = path.join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack');
  const wanted = [
    {
      inClaude: 'compound-engineering@',
      source: 'EveryInc/compound-engineering-plugin',
      marketplace: 'compound-engineering-plugin',
      plugin: 'compound-engineering@compound-engineering-plugin',
    },
    {
      inClaude: 'claude-mem@',
      // The checkout Claude Code already runs, so both tools share one version,
      // one worker and one database. `npx claude-mem install` would also re-copy
      // Claude's plugin and restart that worker.
      source: claudeMem,
      marketplace: 'claude-mem-local',
      plugin: 'claude-mem@claude-mem-local',
      needs: path.join(claudeMem, '.agents', 'plugins', 'marketplace.json'),
    },
  ].filter(
    (one) =>
      enabled.some((id) => id.startsWith(one.inClaude)) &&
      (one.needs === undefined || fs.existsSync(one.needs)),
  );
  if (wanted.length === 0)
    return log('codex plugins: none of your Claude plugins has a Codex build');

  for (const one of wanted) {
    if (new RegExp(`^${one.plugin}\\s+installed`, 'm').test(listed.output)) {
      log(`codex plugins: ${one.plugin} already installed`);
      continue;
    }
    let added = run('codex', ['plugin', 'marketplace', 'add', one.source]);
    if (!added.ok && /already added from a different source/.test(added.output)) {
      // A stale snapshot of the marketplace is in the way: replace it.
      run('codex', ['plugin', 'marketplace', 'remove', one.marketplace]);
      added = run('codex', ['plugin', 'marketplace', 'add', one.source]);
    }
    const installed = run('codex', ['plugin', 'add', one.plugin]);
    log(
      installed.ok
        ? `codex plugins: installed ${one.plugin}`
        : `codex plugins: could not install ${one.plugin}: ${(installed.output || added.output).trim().split('\n').at(-1)}`,
    );
  }
}

function setUpCodexSkillEntry() {
  const workspace = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(workspace, '.claude', 'skills', 'pr-tri-review', 'SKILL.md')))
    return;
  const entry = path.join(workspace, '.agents', 'skills', 'pr-tri-review', 'SKILL.md');
  const text = fs.readFileSync(
    path.join(__dirname, 'agent-assets', 'codex-pr-tri-review.SKILL.md'),
    'utf8',
  );
  const written = writeText(entry, text);
  log(`codex skill entry: pr-tri-review ${written ? 'written' : 'already there'}`);
}

function main() {
  if (process.env.GITNEXUS_AGENT_SETUP === 'off') return log('skipped (GITNEXUS_AGENT_SETUP=off)');
  const home = os.homedir();
  const steps = [
    setUpCodexConfig,
    setUpCodexGuard,
    setUpClaudeMcp,
    setUpSidePanels,
    setUpCodexPlugins,
    setUpCodexSkillEntry,
  ];
  let failed = 0;
  for (const step of steps) {
    try {
      step(home);
    } catch (error) {
      failed += 1;
      log(
        `WARNING: ${step.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  log(failed === 0 ? 'done' : `done, ${failed} step(s) failed (see above); re-run when fixed`);
}

module.exports = {
  cleanClaudeMcpServers,
  cleanCodexConfig,
  withGuardHook,
  withPluginDir,
  withSandboxDefaults,
};

if (require.main === module) main();
