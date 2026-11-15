'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-codex-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, 'image-seed');
  const config = path.join(root, 'config-volume');
  const standalone = path.join(config, 'packages/standalone');
  const command = path.join(root, 'codex');
  const release = 'image-release';
  const bin = path.join(seed, 'releases', release, 'bin/codex');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\necho codex-image\n', { mode: 0o755 });
  fs.writeFileSync(path.join(seed, 'auto-update-version'), release);
  // Match the official installer's absolute symlinks, including the launcher
  // that becomes dangling when Docker mounts an existing config volume.
  fs.symlinkSync(path.join(standalone, 'releases', release), path.join(seed, 'current'));
  fs.symlinkSync(path.join(standalone, 'current/bin/codex'), command);
  const run = () =>
    spawnSync('bash', [path.join(__dirname, 'seed-codex.sh'), seed, standalone, command], {
      encoding: 'utf8',
    });
  return { root, seed, config, standalone, command, bin, run };
}

test('restores native Codex into an empty mounted config volume', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-image/);
  assert.equal(fs.statSync(f.command).mode & 0o111, 0o111);
  assert.equal(
    fs.readFileSync(path.join(f.standalone, 'auto-update-version'), 'utf8'),
    'image-release',
  );
});

test('migrates a reused config volume without changing its state', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.config, 'sessions'), { recursive: true });
  for (const file of ['auth.json', 'config.toml', 'sessions/rollout.jsonl'])
    fs.writeFileSync(path.join(f.config, file), `fixture-${file}`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['auth.json', 'config.toml', 'sessions/rollout.jsonl'])
    assert.equal(fs.readFileSync(path.join(f.config, file), 'utf8'), `fixture-${file}`);
});

test('keeps a working container-managed release without reading the image seed', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const custom = path.join(f.standalone, 'releases/custom/bin');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'codex'), '#!/bin/sh\necho codex-custom\n', { mode: 0o755 });
  fs.unlinkSync(path.join(f.standalone, 'current'));
  fs.symlinkSync(path.dirname(custom), path.join(f.standalone, 'current'));
  fs.rmSync(f.seed, { recursive: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(path.join(f.standalone, 'current')), path.dirname(custom));
  assert.equal(result.stdout, '');
});

test('repairs an installed release that fails its version check', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  fs.writeFileSync(path.join(f.standalone, 'current/bin/codex'), '#!/bin/sh\nexit 1\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-image/);
});

test('fails for an incomplete seed and succeeds after it is repaired', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.bin);
  assert.notEqual(f.run().status, 0);
  fs.writeFileSync(f.bin, '#!/bin/sh\necho codex-image\n', { mode: 0o755 });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-image/);
});
