'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  cleanClaudeMcpServers,
  cleanCodexConfig,
  withGuardHook,
  withPluginDir,
  withSandboxDefaults,
} = require('./agent-setup.cjs');

const SEEDED = String.raw`model="gpt-6-astra"
model_reasoning_effort = "xhigh"
notify = [ "C:\\Users\\dev\\AppData\\Local\\OpenAI\\Codex\\bin\\notify.exe", "turn-ended" ]

[projects."/workspace"]
trust_level = "trusted"

[mcp_servers.headroom]
command = 'C:\Users\dev\.local\bin\headroom.CMD'
args = ["mcp", "serve"]

[mcp_servers.headroom.env]
HEADROOM_PROXY_URL = "http://127.0.0.1:18787"

[mcp_servers.memory]
command = "C:/Users/dev/tools/python.exe"

[mcp_servers.gitnexus]
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]

[mcp_servers.docs]
url = "https://developers.openai.com/mcp"

[marketplaces.openai-bundled]
source_type = "local"
source = '\\?\C:\Users\dev\.codex\.tmp\bundled-marketplaces\openai-bundled'

[marketplaces.mattpocock]
source_type = "git"
source = "https://github.com/mattpocock/skills.git"

[plugins."browser@openai-bundled"]
enabled = true
`;

test('a config seeded from Windows loses its host-only entries and nothing else', () => {
  const { text, removed } = cleanCodexConfig(SEEDED);

  assert.deepEqual(removed, [
    'notify',
    'mcp_servers.headroom',
    'mcp_servers.memory',
    'marketplaces.openai-bundled',
  ]);
  assert.equal(
    text,
    String.raw`model="gpt-6-astra"
model_reasoning_effort = "xhigh"

[projects."/workspace"]
trust_level = "trusted"

[mcp_servers.gitnexus]
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]

[mcp_servers.docs]
url = "https://developers.openai.com/mcp"

[marketplaces.mattpocock]
source_type = "git"
source = "https://github.com/mattpocock/skills.git"

[plugins."browser@openai-bundled"]
enabled = true
`,
  );
});

test('a Linux config is returned byte for byte, and cleaning twice changes nothing more', () => {
  const linux =
    'model = "x"\nnotify = ["/usr/bin/notify-send", "done"]\n\n[mcp_servers.gitnexus]\ncommand = "npx"\n';
  assert.deepEqual(cleanCodexConfig(linux), { text: linux, removed: [] });

  const once = cleanCodexConfig(SEEDED).text;
  assert.deepEqual(cleanCodexConfig(once), { text: once, removed: [] });
});

test('a bracket inside a notify string does not end a multi-line array early', () => {
  const text = 'notify = [\n  "C:\\\\tools\\\\notify.exe",\n  "[done]",\n  "x",\n]\nmodel = "x"\n';
  assert.deepEqual(cleanCodexConfig(text), { text: 'model = "x"\n', removed: ['notify'] });
});

test('a notify array spread over several lines is removed whole', () => {
  const text = 'notify = [\n  "C:\\\\tools\\\\notify.exe",\n  "done",\n]\nmodel = "x"\n';
  assert.deepEqual(cleanCodexConfig(text), { text: 'model = "x"\n', removed: ['notify'] });
});

test('a comment after a table header or a value does not hide a host-only entry', () => {
  const text = [
    'model = "x"',
    '',
    '[mcp_servers.memory] # local tool',
    `command = 'C:\\tools\\memory.exe' # the host build`,
    '',
    '[mcp_servers.gitnexus] # note',
    'command = "npx" # stays',
    '',
  ].join('\n');

  assert.deepEqual(cleanCodexConfig(text), {
    text: ['model = "x"', '', '[mcp_servers.gitnexus] # note', 'command = "npx" # stays', ''].join(
      '\n',
    ),
    removed: ['mcp_servers.memory'],
  });
});

test('a line that opens with a bracket but is no table header stays where it is', () => {
  const text = 'args = [\n  ["a", "b"],\n]\n\n[tui]\nx = 1\n';
  assert.deepEqual(cleanCodexConfig(text), { text, removed: [] });
});

test('sandbox defaults are added only where the sandbox cannot start and none is chosen', () => {
  const config = 'model = "x"\n\n[projects."/workspace"]\ntrust_level = "trusted"\n';

  assert.equal(withSandboxDefaults(config, true), config);

  const added = withSandboxDefaults(config, false);
  assert.match(added, /^model = "x"\n\n# Set by \.devcontainer\/agent-setup\.cjs/);
  assert.match(
    added,
    /\nsandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n\n\[projects/,
  );
  assert.equal(withSandboxDefaults(added, false), added);

  const chosen = 'sandbox_mode = "workspace-write"\n\n[tui]\nx = 1\n';
  assert.equal(withSandboxDefaults(chosen, false), chosen);
});

test('an approval policy the config already sets is kept, not written twice', () => {
  const config = 'approval_policy = "never"\n\n[tui]\nx = 1\n';
  const added = withSandboxDefaults(config, false);

  assert.equal(added.match(/^approval_policy\s*=/gm).length, 1);
  assert.match(added, /^approval_policy = "never"$/m);
  assert.match(added, /^sandbox_mode = "danger-full-access"$/m);
  assert.equal(withSandboxDefaults(added, false), added);
});

test('a missing config still gets the sandbox default', () => {
  const added = withSandboxDefaults(cleanCodexConfig('').text, false);

  assert.match(added, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(added, /^approval_policy = "on-request"$/m);
  assert.equal(withSandboxDefaults('', true), '');
});

test('a quoted table name with dots in it is one entry', () => {
  const text = [
    '[mcp_servers."win.tool"]',
    "command = 'C:\\tools\\win.exe'",
    '',
    '[mcp_servers."win.tool".env]',
    'A = "1"',
    '',
    '[mcp_servers."linux.tool"]',
    'command = "npx"',
    '',
  ].join('\n');

  assert.deepEqual(cleanCodexConfig(text), {
    text: ['[mcp_servers."linux.tool"]', 'command = "npx"', ''].join('\n'),
    removed: ['mcp_servers.win.tool'],
  });
});

test('sandbox defaults land before the first table even in a config with no top-level keys', () => {
  const added = withSandboxDefaults('[tui]\nx = 1\n', false);
  assert.ok(added.indexOf('sandbox_mode') < added.indexOf('[tui]'));
});

test('the guard is registered once, after the hooks already there', () => {
  const existing = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Grep|Glob|Bash',
          hooks: [{ type: 'command', command: 'node gitnexus-hook.cjs' }],
        },
      ],
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node gitnexus-hook.cjs' }] },
      ],
    },
  };
  const next = withGuardHook(existing, '/home/node/.codex/hooks/guard/deny-destructive.cjs');

  assert.equal(next.hooks.PreToolUse.length, 2);
  assert.deepEqual(next.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  assert.equal(next.hooks.PreToolUse[1].matcher, 'Bash');
  assert.equal(
    next.hooks.PreToolUse[1].hooks[0].command,
    "node '/home/node/.codex/hooks/guard/deny-destructive.cjs'",
  );
  assert.deepEqual(next.hooks.PostToolUse, existing.hooks.PostToolUse);
  assert.equal(withGuardHook(next, '/home/node/.codex/hooks/guard/deny-destructive.cjs'), next);
});

test('the guard is registered in a hooks file that does not exist yet', () => {
  const next = withGuardHook({}, '/g.cjs');
  assert.equal(next.hooks.PreToolUse.length, 1);
});

test('Claude MCP servers started by a Windows executable are removed, others kept', () => {
  const config = {
    userID: 'u',
    mcpServers: {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      headroom: { command: 'C:\\Users\\dev\\.local\\bin\\headroom.CMD' },
      local: { command: 'npx', args: ['-y', 'x'] },
    },
    projects: {
      '/workspace': { mcpServers: { tool: { command: 'D:/tools/tool.exe' } }, history: [1] },
      '/other': { history: [] },
    },
  };
  const { config: next, removed } = cleanClaudeMcpServers(config);

  assert.deepEqual(removed, ['headroom', 'tool']);
  assert.deepEqual(Object.keys(next.mcpServers), ['context7', 'local']);
  assert.deepEqual(next.projects['/workspace'], { mcpServers: {}, history: [1] });
  assert.equal(next.userID, 'u');

  const clean = cleanClaudeMcpServers(next);
  assert.equal(clean.config, next);
  assert.deepEqual(clean.removed, []);
});

test('the mod folder joins the plugin folders once and keeps the ones already there', () => {
  const dir = '/home/node/.claude/mods/side-panels';
  assert.equal(withPluginDir({ model: 'm' }, dir).env.CLAUDE_CODE_PLUGIN_DIRS, dir);

  const other = { env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/mine', DEBUG: '1' } };
  const next = withPluginDir(other, dir);
  assert.equal(next.env.CLAUDE_CODE_PLUGIN_DIRS, ['/opt/mine', dir].join(path.delimiter));
  assert.equal(next.env.DEBUG, '1');
  assert.equal(withPluginDir(next, dir), next);

  const tilde = { env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/side-panels' } };
  assert.equal(withPluginDir(tilde, dir, '/home/node'), tilde);
});
