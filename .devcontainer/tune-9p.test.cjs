'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-tune-9p-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'mount-args');
  fs.writeFileSync(
    path.join(root, 'findmnt'),
    `#!/bin/bash
printf '%s\\n' "$@" >> "$TUNE_TEST_ROOT/findmnt-args"
[ "$MOCK_FINDMNT_FAIL" = 0 ] || exit 1
case "$*" in
  *FSTYPE) printf '%s\\n' "$MOCK_FSTYPE" ;;
  *OPTIONS)
    [ "$MOCK_OPTIONS_FAIL" = 0 ] || exit 1
    if [ -f "$TUNE_TEST_ROOT/remounted" ]; then
      printf '%s\\n' "$MOCK_AFTER_OPTIONS"
    else
      printf '%s\\n' "$MOCK_OPTIONS"
    fi ;;
esac
`,
    { mode: 0o755 },
  );
  // Never execute mount: record argv and simulate its result, even if tests
  // happen to run with SYS_ADMIN on a developer's machine.
  fs.writeFileSync(
    path.join(root, 'sudo'),
    `#!/bin/bash
printf '%s\\n' "$@" > "$TUNE_TEST_ROOT/mount-args"
if [ "$MOCK_HANG" = 1 ]; then sleep 30; fi
[ "$MOCK_REMOUNT_EXIT" = 0 ] || exit "$MOCK_REMOUNT_EXIT"
touch "$TUNE_TEST_ROOT/remounted"
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    TUNE_TEST_ROOT: root,
    WORKSPACE_9P_TUNE: '1',
    WORKSPACE_9P_MSIZE: '1048576',
    MOCK_FSTYPE: '9p',
    MOCK_OPTIONS: 'rw,relatime,msize=65536,trans=virtio',
    MOCK_AFTER_OPTIONS: 'rw,msize=1048576,trans=virtio',
    MOCK_REMOUNT_EXIT: '0',
    MOCK_FINDMNT_FAIL: '0',
    MOCK_OPTIONS_FAIL: '0',
    MOCK_HANG: '0',
    ...overrides,
  };
  const run = (...args) => {
    const result = spawnSync('/bin/bash', [path.join(__dirname, 'tune-9p.sh'), ...args], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { root, log, run };
}

test('disabled tuning does not inspect or remount anything', (t) => {
  const f = fixture(t, { WORKSPACE_9P_TUNE: '0' });
  assert.equal(f.run(), '');
  assert.equal(fs.existsSync(path.join(f.root, 'findmnt-args')), false);
  assert.equal(fs.existsSync(f.log), false);
});

for (const fstype of ['ext4', 'virtiofs', 'overlay']) {
  test(`skips a ${fstype} workspace without remounting`, (t) => {
    const f = fixture(t, { MOCK_FSTYPE: fstype });
    assert.match(f.run(), /not 9p/);
    assert.equal(fs.existsSync(f.log), false);
  });
}

test('failed mount lookup does not block startup or remount a containing filesystem', (t) => {
  const f = fixture(t, { MOCK_FINDMNT_FAIL: '1' });
  assert.match(f.run('/workspace/subdirectory'), /unknown/);
  assert.equal(fs.existsSync(f.log), false);
  const args = fs.readFileSync(path.join(f.root, 'findmnt-args'), 'utf8');
  assert.match(args, /--mountpoint\n\/workspace\/subdirectory\n/);
});

for (const msize of ['1048576', '2097152']) {
  test(`keeps an existing msize of ${msize}`, (t) => {
    const f = fixture(t, { MOCK_OPTIONS: `rw,msize=${msize}` });
    assert.match(f.run(), /already at or above target/);
    assert.equal(fs.existsSync(f.log), false);
  });
}

test('uses non-interactive sudo, honors custom size/path and verifies the result', (t) => {
  const f = fixture(t, {
    WORKSPACE_9P_MSIZE: '2097152',
    MOCK_AFTER_OPTIONS: 'rw,msize=2097152',
  });
  assert.match(f.run('/workspace/project with spaces'), /verified at or above target/);
  assert.deepEqual(fs.readFileSync(f.log, 'utf8').trimEnd().split('\n'), [
    '-n',
    'mount',
    '-o',
    'remount,msize=2097152',
    '/workspace/project with spaces',
  ]);
});

test('a denied remount is non-fatal and explains capability/recreation requirements', (t) => {
  const f = fixture(t, { MOCK_REMOUNT_EXIT: '1' });
  const output = f.run();
  assert.match(output, /remount failed/);
  assert.match(output, /SYS_ADMIN/);
  assert.match(output, /rebuild the devcontainer/);
});

test('successful remount with unchanged msize does not claim a verified increase', (t) => {
  const f = fixture(t, { MOCK_AFTER_OPTIONS: 'rw,msize=65536' });
  const output = f.run();
  assert.match(output, /no increase to the target was verified/);
  assert.doesNotMatch(output, /verified at or above target/);
});

test('unreadable mount options skip remounting', (t) => {
  const f = fixture(t, { MOCK_OPTIONS_FAIL: '1' });
  assert.match(f.run(), /cannot read mount options/);
  assert.equal(fs.existsSync(f.log), false);
});

test('missing msize is reported as unknown without breaking startup', (t) => {
  const f = fixture(t, { MOCK_OPTIONS: 'rw', MOCK_AFTER_OPTIONS: 'rw' });
  assert.match(f.run(), /after remount msize=unknown/);
});

for (const msize of ['0', '-1', 'abc', '1;exit 1', '999999999999999999999999']) {
  test(`invalid msize ${JSON.stringify(msize)} is non-fatal and never reaches mount`, (t) => {
    const f = fixture(t, { WORKSPACE_9P_MSIZE: msize });
    assert.match(f.run(), /invalid WORKSPACE_9P_MSIZE/);
    assert.equal(fs.existsSync(f.log), false);
  });
}

test('a hanging remount times out without blocking startup', (t) => {
  const f = fixture(t, { MOCK_HANG: '1' });
  const start = Date.now();
  assert.match(f.run(), /remount failed or timed out/);
  assert.ok(Date.now() - start < 9000, 'remount should be bounded by timeout');
});
