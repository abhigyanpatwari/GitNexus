// Unit tests for the devcontainer host->container config transforms.
// Coverage for the logic that used to live inline in post-create.sh heredocs
// (invisible to lint and untestable):
//   - plugin-registry path translation (buildRe + rewriteDeep + the real
//     filesystem translate() driver), which has had path-handling bugs before
//   - the $HOME/.claude.json machine-field strip (sanitizeClaudeConfig +
//     readHostConfig + the seed-claude-config main() entry point)
//   - the host bind-source bootstrap (ensurePaths), incl. a regression guard
//     that it does NOT pre-create settings.json / config.toml on the host
//
// Both pure-function and filesystem-I/O paths are exercised; the I/O tests use
// throwaway os.tmpdir() trees and clean up after themselves, so they run in CI
// with no mounts and never touch the real home dir.
//
// Run with the built-in Node test runner (no deps):
//   node --test .devcontainer/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildRe, rewriteDeep, translate } = require('./translate-plugin-registries.cjs');
const { sanitizeClaudeConfig, readHostConfig } = require('./seed-claude-config.cjs');
const { ensurePaths, DIRS, FILES } = require('./ensure-host-config-dirs.cjs');

const CLAUDE = '/home/node/.claude/plugins';
const CURSOR = '/home/node/.cursor/plugins';

// Fresh throwaway directory under the OS temp root. mkdtemp avoids Date.now()/
// random naming and guarantees uniqueness per call.
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

// --- readHostConfig: filesystem read + fallback paths -----------------------

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

// --- translate(): real registry files on disk -------------------------------

test('translate: rewrites host absolute paths and writes into the ctr dir', () => {
  const hostDir = tmp();
  const ctrParent = tmp();
  const ctrDir = path.join(ctrParent, 'plugins'); // need not pre-exist; translate mkdirs it
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
    fs.writeFileSync(path.join(hostDir, 'empty.json'), ''); // missing.json never created
    translate(reg);
    assert.equal(fs.existsSync(path.join(ctrDir, 'empty.json')), false);
    assert.equal(fs.existsSync(path.join(ctrDir, 'missing.json')), false);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(ctrParent, { recursive: true, force: true });
  }
});

// --- seed-claude-config main(): end-to-end via the real CLI entry point -----

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

// --- ensurePaths: host bind-source bootstrap --------------------------------

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
    // Rerun must not throw and must not clobber existing content.
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
