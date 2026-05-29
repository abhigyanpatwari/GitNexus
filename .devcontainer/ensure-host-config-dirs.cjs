// Runs on the HOST (not inside the container) before the dev container is
// created, via devcontainer.json `initializeCommand`. Guarantees the bind
// mount sources declared in devcontainer.json exist on the host so Docker
// doesn't reject the mount when a CLI has never been used.
//
// Cross-platform via Node's `os.homedir()` (which reads $HOME on POSIX and
// %USERPROFILE% on Windows) and `fs.mkdirSync({recursive: true})`. Idempotent
// — each path is skipped if it already exists. `~/.gitconfig` is intentionally
// not handled here: VS Code's Dev Containers extension auto-copies the host
// gitconfig into the container at attach time, so a bind mount conflicts with
// that mechanism and was removed.
//
// The pure path-ensuring logic is exported (ensurePaths/DIRS/FILES) and the
// Windows HOME side effect only runs when this file is executed directly as
// the initializeCommand — so it can be unit-tested against a temp dir without
// touching the real home or invoking `setx`.
//
// Host prerequisite: Node.js on PATH. This is the only documented host
// requirement beyond Docker Desktop and the VS Code Dev Containers
// extension — everything else runs inside the container.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Directory bind-mount sources. devcontainer.json declares RW binds for
// shareable subdirs (plugins/skills/agents/memory/commands for Claude;
// memories/skills for Codex) so reads/writes go directly host<->container.
// Docker rejects bind mounts whose source doesn't exist — mkdir -p each
// one. Per-CLI directories themselves (~/.claude, ~/.codex, ~/.cursor)
// are also created for the /host/.<cli> read-only stage mounts that
// post-create.sh reads credentials from.
const DIRS = [
  '.claude',
  path.join('.claude', 'plugins'),
  // Claude plugin SOURCE dirs — content is path-independent so these get
  // RW bind-mounted bidirectionally. The path-DEPENDENT registry JSONs
  // (known_marketplaces.json, installed_plugins.json,
  // plugin-catalog-cache.json) stay in the container's named volume,
  // translated by post-create.sh.
  path.join('.claude', 'plugins', 'marketplaces'),
  path.join('.claude', 'plugins', 'cache'),
  path.join('.claude', 'skills'),
  path.join('.claude', 'agents'),
  path.join('.claude', 'memory'),
  path.join('.claude', 'commands'),
  // Codex shareable surface. The whole plugins/ dir is bound (no
  // path-bearing registry inside it — enablement is in config.toml at the
  // root), plus prompts/ (saved prompt library), memories/, skills/.
  '.codex',
  path.join('.codex', 'plugins'),
  path.join('.codex', 'prompts'),
  path.join('.codex', 'memories'),
  path.join('.codex', 'skills'),
  // Cursor shareable surface (cursor-agent CLI shares the Cursor 2.5
  // plugin/rules/commands/agents/skills dirs). plugins/ sub-dirs are
  // bound individually because plugins/installed_plugins.json carries
  // absolute paths and is translated (not bound) by post-create.sh.
  '.cursor',
  path.join('.cursor', 'plugins', 'marketplaces'),
  path.join('.cursor', 'plugins', 'local'),
  path.join('.cursor', 'rules'),
  path.join('.cursor', 'commands'),
  path.join('.cursor', 'agents'),
  path.join('.cursor', 'skills'),
  '.ssh',
  '.docker',
  '.aws',
  '.azure',
  path.join('.config', 'gh'),
  path.join('.config', 'git'),
];

// Single-file sources. Only `~/.claude.json` is pre-created: it is the one
// SINGLE-FILE bind (read-only at /host/.claude.json), and Docker would create
// a DIRECTORY in its place if the source were absent — so it must exist as a
// file. `~/.claude/settings.json` and `~/.codex/config.toml` are NOT
// single-file binds; post-create.sh copies them out of the /host/.<cli>
// read-only DIR stage and `sync_from_host` no-ops gracefully when they're
// absent (the `[ -f ]` guard). Pre-creating them would be gratuitous host
// mutation on a machine that never ran that CLI, so we don't.
const FILES = ['.claude.json'];

// Create every dir and touch every file under `home`. Idempotent — an
// existing path is left untouched. Parameterized on the filesystem root so
// tests can drive it against a temp dir.
function ensurePaths(home, dirs = DIRS, files = FILES) {
  for (const dir of dirs) {
    const full = path.join(home, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }
  for (const file of files) {
    const full = path.join(home, file);
    if (!fs.existsSync(full)) {
      fs.closeSync(fs.openSync(full, 'a'));
    }
  }
}

module.exports = { ensurePaths, DIRS, FILES };

if (require.main === module) {
  // Windows-native auto-setup. VS Code resolves the bind-mount sources via
  // `${localEnv:HOME}` reading its own process env, and Windows doesn't set
  // `HOME` by default (it uses `USERPROFILE`). Without `HOME`, the bind
  // sources collapse to filesystem-root paths (`/.claude`, `/.codex`, ...)
  // and Docker rejects them with `bind source path does not exist`.
  //
  // Fix: persist `HOME=%USERPROFILE%` to the user's environment via `setx`.
  // `setx` writes to `HKCU\Environment` and the new value is inherited by
  // every process the user launches after — including VS Code after a
  // restart. The current VS Code process can't see the update (its env was
  // fixed at launch), so we instruct the user to restart VS Code once.
  //
  // Subsequent runs detect `HOME` is set, skip this block, and proceed
  // normally. Mac/Linux/WSL hosts have `HOME` set by the shell, so this
  // block is a no-op on those platforms.
  if (process.platform === 'win32' && !process.env.HOME) {
    const userprofile = process.env.USERPROFILE;
    if (userprofile) {
      try {
        require('child_process').execFileSync('setx', ['HOME', userprofile], {
          stdio: 'ignore',
        });
        console.error('');
        console.error('='.repeat(70));
        console.error(' GitNexus devcontainer one-time Windows setup');
        console.error('='.repeat(70));
        console.error('');
        console.error(`HOME has been set to %USERPROFILE% (${userprofile}).`);
        console.error("VS Code reads this at startup, so the current session can't pick it up.");
        console.error('');
        console.error(' 1. Close ALL VS Code windows (File > Exit, not just the window).');
        console.error(' 2. Reopen VS Code, open this folder, and re-run Reopen in Container.');
        console.error('');
        console.error('This is a one-time setup. Subsequent rebuilds work normally.');
        console.error('='.repeat(70));
        process.exit(1);
      } catch (err) {
        console.error('ERROR: failed to set HOME automatically: ' + err.message);
        console.error('');
        console.error('Run this in a Windows shell, then restart VS Code:');
        console.error('  setx HOME "%USERPROFILE%"');
        process.exit(1);
      }
    } else {
      console.error('ERROR: neither HOME nor USERPROFILE is set on this host.');
      console.error('');
      console.error('Set HOME to your user profile directory and restart VS Code:');
      console.error('  setx HOME "%USERPROFILE%"');
      process.exit(1);
    }
  }

  ensurePaths(os.homedir());
}
