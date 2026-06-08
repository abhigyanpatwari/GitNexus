// Unit tests for the devcontainer host->container config transforms.
//
// This code used to live inside post-create.sh heredocs, where lint could not
// see it and tests could not reach it. We test three things:
//   - plugin-registry path translation (buildRe + rewriteDeep + the real
//     filesystem translate() driver). Path handling here has had bugs before.
//   - the strip of machine-specific fields from $HOME/.claude.json
//     (sanitizeClaudeConfig + readHostConfig + the seed-claude-config main()
//     entry point)
//   - the host bind-source bootstrap (ensurePaths). One test guards against a
//     regression: ensurePaths must NOT pre-create settings.json / config.toml
//     on the host.
//
// We test both pure functions and code that touches the filesystem. The
// filesystem tests use throwaway directories under os.tmpdir() and delete them
// when done. So they run in CI with no mounts and never touch the real home dir.
//
// Run with the built-in Node test runner (no extra dependencies):
//   node --test .devcontainer/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildRe,
  rewriteDeep,
  translate,
  selectRegistries,
} = require('./translate-plugin-registries.cjs');
const { sanitizeClaudeConfig, readHostConfig } = require('./seed-claude-config.cjs');
const { ensurePaths, DIRS, FILES } = require('./ensure-host-config-dirs.cjs');

const CLAUDE = '/home/node/.claude/plugins';
const CURSOR = '/home/node/.cursor/plugins';

// Make a fresh throwaway directory under the OS temp root. mkdtemp picks a
// unique name on every call, so we don't need Date.now() or random names.
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dc-'));
}

function rw(value, cli, ctr) {
  return rewriteDeep(value, buildRe(cli), ctr);
}

test('claude: Windows backslash absolute path -> container path', () => {
  assert.equal(
    rw('C:\\Users\\gergo\\.claude\\plugins\\cache\\x\\1.0', 'claude', CLAUDE),
    '/home/node/.claude/plugins/cache/x/1.0',
  );
});

test('claude: Windows forward-slash absolute path -> container path', () => {
  assert.equal(
    rw('C:/Users/gergo/.claude/plugins/marketplaces/m', 'claude', CLAUDE),
    '/home/node/.claude/plugins/marketplaces/m',
  );
});

test('claude: macOS POSIX path -> container path', () => {
  assert.equal(
    rw('/Users/alice/.claude/plugins/marketplaces/m', 'claude', CLAUDE),
    '/home/node/.claude/plugins/marketplaces/m',
  );
});

test('claude: Linux POSIX path -> container path', () => {
  assert.equal(
    rw('/home/bob/.claude/plugins/cache/foo', 'claude', CLAUDE),
    '/home/node/.claude/plugins/cache/foo',
  );
});

test('cursor: Windows path -> container cursor path', () => {
  assert.equal(
    rw('C:\\Users\\gergo\\.cursor\\plugins\\local\\myplug', 'cursor', CURSOR),
    '/home/node/.cursor/plugins/local/myplug',
  );
});

test('cross-CLI isolation: claude regex leaves a .cursor path untouched', () => {
  const input = 'C:\\Users\\g\\.cursor\\plugins\\x';
  assert.equal(rw(input, 'claude', CLAUDE), input);
});

test('non-path strings pass through unchanged', () => {
  assert.equal(rw('not-a-path', 'claude', CLAUDE), 'not-a-path');
  assert.equal(
    rw('https://github.com/EveryInc/x.git', 'claude', CLAUDE),
    'https://github.com/EveryInc/x.git',
  );
});

test('non-string scalars pass through unchanged', () => {
  assert.equal(rw(42, 'claude', CLAUDE), 42);
  assert.equal(rw(null, 'claude', CLAUDE), null);
  assert.equal(rw(true, 'claude', CLAUDE), true);
});

test('nested objects/arrays are rewritten deeply', () => {
  const input = {
    'compound-engineering@m': [
      { installPath: 'C:\\Users\\g\\.claude\\plugins\\cache\\ce\\3.9.2', version: '3.9.2' },
    ],
    nested: { installLocation: '/Users/g/.claude/plugins/marketplaces/m' },
  };
  const out = rw(input, 'claude', CLAUDE);
  assert.equal(
    out['compound-engineering@m'][0].installPath,
    '/home/node/.claude/plugins/cache/ce/3.9.2',
  );
  assert.equal(out['compound-engineering@m'][0].version, '3.9.2');
  assert.equal(out.nested.installLocation, '/home/node/.claude/plugins/marketplaces/m');
});

test('sanitizeClaudeConfig: strips machine fields, forces hasCompletedOnboarding', () => {
  const out = sanitizeClaudeConfig({
    installMethod: 'native',
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
    shiftEnterKeyBindingInstalled: true,
    userID: 'abc',
    oauthAccount: { emailAddress: 'x@y.z' },
  });
  assert.equal(out.installMethod, undefined);
  assert.equal(out.autoUpdates, undefined);
  assert.equal(out.autoUpdatesProtectedForNative, undefined);
  assert.equal(out.shiftEnterKeyBindingInstalled, undefined);
  assert.equal(out.userID, 'abc');
  assert.equal(out.oauthAccount.emailAddress, 'x@y.z');
  assert.equal(out.hasCompletedOnboarding, true);
});

test('sanitizeClaudeConfig: non-object inputs become a valid onboarding-bearing object', () => {
  for (const bad of [42, 'x', null, ['a'], true]) {
    const out = sanitizeClaudeConfig(bad);
    assert.equal(typeof out, 'object');
    assert.equal(Array.isArray(out), false);
    assert.equal(out.hasCompletedOnboarding, true);
  }
});

test('sanitizeClaudeConfig: empty object still gets hasCompletedOnboarding', () => {
  assert.deepEqual(sanitizeClaudeConfig({}), { hasCompletedOnboarding: true });
});

// --- readHostConfig: reading the file, and the fallbacks when it fails ------

test('readHostConfig: missing file -> {}', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readHostConfig(path.join(dir, 'nope.json')), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHostConfig: empty (zero-byte) file -> {}', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'empty.json');
    fs.writeFileSync(f, '');
    assert.deepEqual(readHostConfig(f), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHostConfig: malformed JSON -> {}', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{ not valid json');
    assert.deepEqual(readHostConfig(f), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHostConfig: valid object is parsed through', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'ok.json');
    fs.writeFileSync(f, JSON.stringify({ userID: 'u', hasCompletedOnboarding: false }));
    const out = readHostConfig(f);
    assert.equal(out.userID, 'u');
    assert.equal(out.hasCompletedOnboarding, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- translate(): runs against real registry files on disk ------------------

test('translate: rewrites host absolute paths and writes into the ctr dir', () => {
  const hostDir = tmp();
  const ctrParent = tmp();
  const ctrDir = path.join(ctrParent, 'plugins'); // need not exist yet; translate creates it
  try {
    const reg = [{ cli: 'claude', host: hostDir, ctr: ctrDir, files: ['installed_plugins.json'] }];
    fs.writeFileSync(
      path.join(hostDir, 'installed_plugins.json'),
      JSON.stringify({ 'p@m': [{ installPath: 'C:\\Users\\g\\.claude\\plugins\\cache\\p\\1.0' }] }),
    );
    translate(reg);
    const out = JSON.parse(fs.readFileSync(path.join(ctrDir, 'installed_plugins.json'), 'utf8'));
    assert.equal(out['p@m'][0].installPath, `${ctrDir}/cache/p/1.0`);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(ctrParent, { recursive: true, force: true });
  }
});

test('translate: idempotent — a second run reproduces byte-identical output', () => {
  const hostDir = tmp();
  const ctrParent = tmp();
  const ctrDir = path.join(ctrParent, 'plugins');
  try {
    const reg = [{ cli: 'claude', host: hostDir, ctr: ctrDir, files: ['installed_plugins.json'] }];
    fs.writeFileSync(
      path.join(hostDir, 'installed_plugins.json'),
      JSON.stringify({ 'p@m': [{ installPath: 'C:\\Users\\g\\.claude\\plugins\\cache\\p\\1.0' }] }),
    );
    translate(reg);
    const first = fs.readFileSync(path.join(ctrDir, 'installed_plugins.json'), 'utf8');
    translate(reg);
    const second = fs.readFileSync(path.join(ctrDir, 'installed_plugins.json'), 'utf8');
    assert.equal(first, second);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(ctrParent, { recursive: true, force: true });
  }
});

test('translate: malformed host registry is skipped, dst not written', () => {
  const hostDir = tmp();
  const ctrParent = tmp();
  const ctrDir = path.join(ctrParent, 'plugins');
  try {
    const reg = [{ cli: 'claude', host: hostDir, ctr: ctrDir, files: ['installed_plugins.json'] }];
    fs.writeFileSync(path.join(hostDir, 'installed_plugins.json'), '{ broken');
    translate(reg);
    assert.equal(fs.existsSync(path.join(ctrDir, 'installed_plugins.json')), false);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(ctrParent, { recursive: true, force: true });
  }
});

test('translate: empty and missing host registries are skipped without error', () => {
  const hostDir = tmp();
  const ctrParent = tmp();
  const ctrDir = path.join(ctrParent, 'plugins');
  try {
    const reg = [
      { cli: 'claude', host: hostDir, ctr: ctrDir, files: ['empty.json', 'missing.json'] },
    ];
    fs.writeFileSync(path.join(hostDir, 'empty.json'), ''); // we never create missing.json
    translate(reg);
    assert.equal(fs.existsSync(path.join(ctrDir, 'empty.json')), false);
    assert.equal(fs.existsSync(path.join(ctrDir, 'missing.json')), false);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(ctrParent, { recursive: true, force: true });
  }
});

// --- selectRegistries: the per-CLI filter post-create.sh drives translate with

test('selectRegistries: no filter -> all registries (original behavior)', () => {
  const regs = [{ cli: 'claude' }, { cli: 'cursor' }];
  assert.deepEqual(selectRegistries(regs, []), regs);
  assert.deepEqual(selectRegistries(regs, undefined), regs);
});

test('selectRegistries: filter keeps only the named CLIs', () => {
  const regs = [{ cli: 'claude' }, { cli: 'cursor' }];
  assert.deepEqual(selectRegistries(regs, ['claude']), [{ cli: 'claude' }]);
  assert.deepEqual(selectRegistries(regs, ['cursor']), [{ cli: 'cursor' }]);
  assert.deepEqual(selectRegistries(regs, ['claude', 'cursor']), regs);
});

test('selectRegistries: an unknown CLI name selects nothing', () => {
  const regs = [{ cli: 'claude' }, { cli: 'cursor' }];
  assert.deepEqual(selectRegistries(regs, ['codex']), []);
});

test('selectRegistries: empty registry table stays empty under any filter', () => {
  assert.deepEqual(selectRegistries([], ['claude']), []);
  assert.deepEqual(selectRegistries([], []), []);
});

// --- seed-claude-config main(): end-to-end, through the real CLI entry point

const SEED_SCRIPT = path.join(__dirname, 'seed-claude-config.cjs');

test('seed main: strips machine fields, keeps account, sets onboarding, chmod 644', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'host.claude.json');
    const dst = path.join(dir, 'out.claude.json');
    fs.writeFileSync(
      src,
      JSON.stringify({
        installMethod: 'native',
        userID: 'abc',
        oauthAccount: { emailAddress: 'x@y.z' },
      }),
    );
    execFileSync(process.execPath, [SEED_SCRIPT, src, dst]);
    const out = JSON.parse(fs.readFileSync(dst, 'utf8'));
    assert.equal(out.installMethod, undefined);
    assert.equal(out.userID, 'abc');
    assert.equal(out.oauthAccount.emailAddress, 'x@y.z');
    assert.equal(out.hasCompletedOnboarding, true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dst).mode & 0o777, 0o644);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seed main: missing host file still writes a valid onboarding-bearing file', () => {
  const dir = tmp();
  try {
    const dst = path.join(dir, 'out.claude.json');
    execFileSync(process.execPath, [SEED_SCRIPT, path.join(dir, 'nope.json'), dst]);
    assert.deepEqual(JSON.parse(fs.readFileSync(dst, 'utf8')), { hasCompletedOnboarding: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seed main: chmodSync widens a pre-existing restrictive dst to 0o644', () => {
  // This checks the file's permission bits, which only exist on POSIX systems.
  //
  // The catch: CI's default umask is 022, so a plain writeFileSync already
  // creates files at mode 0o644. Asserting 0o644 right after a fresh write
  // would therefore NOT prove the explicit chmodSync did anything.
  //
  // So we pre-create dst at the stricter mode 0o600. Opening a file in 'w'
  // mode replaces its contents but KEEPS the mode of a file that already
  // exists. That means the only way dst can end up at 0o644 is the chmodSync
  // inside seed-claude-config.cjs. This pins the test to the chmod and not to
  // the umask: delete the chmodSync line and this test fails, while the other
  // seed test still passes.
  if (process.platform === 'win32') return;
  const dir = tmp();
  try {
    const src = path.join(dir, 'host.claude.json');
    const dst = path.join(dir, 'out.claude.json');
    fs.writeFileSync(src, JSON.stringify({ userID: 'u' }));
    fs.writeFileSync(dst, '{}');
    fs.chmodSync(dst, 0o600);
    execFileSync(process.execPath, [SEED_SCRIPT, src, dst]);
    assert.equal(fs.statSync(dst).mode & 0o777, 0o644);
    assert.equal(JSON.parse(fs.readFileSync(dst, 'utf8')).userID, 'u');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- ensurePaths: sets up the host paths the bind mounts point at -----------

test('ensurePaths: creates every DIR and FILE under a temp home, idempotently', () => {
  const home = tmp();
  try {
    ensurePaths(home);
    for (const d of DIRS) {
      assert.equal(fs.statSync(path.join(home, d)).isDirectory(), true, `not a dir: ${d}`);
    }
    for (const f of FILES) {
      assert.equal(fs.statSync(path.join(home, f)).isFile(), true, `not a file: ${f}`);
    }
    // Running it again must not throw and must not overwrite existing content.
    fs.writeFileSync(path.join(home, '.claude.json'), '{"keep":true}');
    ensurePaths(home);
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"keep":true}');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensurePaths: does NOT pre-create settings.json / config.toml (no gratuitous host mutation)', () => {
  const home = tmp();
  try {
    ensurePaths(home);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensurePaths: does NOT pre-create the shareable subdirs (now copied, not bound)', () => {
  // The shareable dirs are seeded into the per-container volume from the
  // read-only /host stage, so they are no longer bind-mount sources. Pre-creating
  // empty ones would needlessly write into the host of someone who never used a
  // CLI. This pins the DIRS trim: re-adding any of these would fail the test.
  const home = tmp();
  const mustNotExist = [
    path.join('.claude', 'skills'),
    path.join('.claude', 'agents'),
    path.join('.claude', 'memory'),
    path.join('.claude', 'commands'),
    path.join('.claude', 'plugins'),
    path.join('.codex', 'plugins'),
    path.join('.codex', 'prompts'),
    path.join('.codex', 'memories'),
    path.join('.codex', 'skills'),
    path.join('.cursor', 'rules'),
    path.join('.cursor', 'commands'),
    path.join('.cursor', 'agents'),
    path.join('.cursor', 'skills'),
    path.join('.cursor', 'plugins'),
  ];
  try {
    ensurePaths(home);
    for (const sub of mustNotExist) {
      assert.equal(fs.existsSync(path.join(home, sub)), false, `should not pre-create: ${sub}`);
    }
    // The top-level stage roots that ARE still bind sources must exist.
    for (const top of ['.claude', '.codex', '.cursor', '.claude-mem']) {
      assert.equal(fs.statSync(path.join(home, top)).isDirectory(), true, `missing root: ${top}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
