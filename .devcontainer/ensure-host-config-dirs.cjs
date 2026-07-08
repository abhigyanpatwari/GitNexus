// This runs on the HOST, not inside the container, before the dev container is
// created. devcontainer.json calls it via `initializeCommand`. Its job is to
// make sure the bind-mount source folders listed in devcontainer.json already
// exist on the host. Docker rejects a bind mount when its source is missing,
// which happens if a CLI has never been used.
//
// It works on every platform. `os.homedir()` returns the home folder ($HOME on
// Mac/Linux, %USERPROFILE% on Windows). `fs.mkdirSync({recursive: true})`
// creates folders. It is safe to run repeatedly: a path that already exists is
// left alone. We deliberately do NOT handle `~/.gitconfig` here. VS Code's Dev
// Containers extension copies the host gitconfig into the container when you
// attach, and a bind mount fights with that, so it was removed.
//
// The path-creating logic is exported (ensurePaths/DIRS/FILES) so tests can use
// it. The Windows HOME side effect only runs when this file is run directly as
// the initializeCommand. That keeps tests able to drive it against a temp dir
// without touching the real home or calling `setx`.
//
// Host prerequisite: Node.js must be on PATH. That is the only host requirement
// beyond Docker Desktop and the VS Code Dev Containers extension. Everything
// else runs inside the container.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Folders that are bind-mount sources in devcontainer.json. Docker rejects a
// bind mount whose source is missing, so we create each one.
//
// We create the TOP per-CLI folders (~/.claude, ~/.codex, ~/.cursor) and
// ~/.claude-mem. These back the /host/.<cli> and /host/.claude-mem read-only
// STAGE mounts that post-create.sh copies from on container-create. We do NOT
// create the shareable subfolders (skills/agents/plugins/memory/commands/...)
// here anymore: they used to be read-write bind sources, but they are now
// copied once out of the read-only stage into the per-container volume, so they
// are no longer bind sources and pre-creating empty ones would needlessly write
// into the host of someone who never used that CLI. post-create.sh's seed step
// simply skips any subfolder the host doesn't have. The read-only stage bind is
// the whole ~/.<cli> dir, so whatever shareable subfolders DO exist are visible
// to the seed without being listed here.
const DIRS = [
  '.claude',
  // claude-mem store ($HOME/.claude-mem). A SEPARATE top-level folder from
  // ~/.claude, holding claude-mem's SQLite DB + Chroma vector store. It is NOT
  // bind-mounted (a multi-GB SQLite/WAL store is unsafe over a 9p bind on Docker
  // Desktop Windows). post-create.sh SEEDS it once into a per-container named
  // volume from the /host/.claude-mem read-only stage. We create the source here
  // so that stage bind resolves even for a host that never ran claude-mem
  // (Docker rejects a missing bind source); the seed then finds no DB to copy
  // and the container starts with empty memory.
  '.claude-mem',
  '.codex',
  '.cursor',
  '.ssh',
  '.docker',
  '.aws',
  '.azure',
  path.join('.config', 'gh'),
  path.join('.config', 'git'),
];

// Files to pre-create. Only `~/.claude.json` is created here. It is the one
// source that is bound as a single file (read-only at /host/.claude.json). If
// that source is missing, Docker would create a FOLDER in its place, so it has
// to exist as a file first. `~/.claude/settings.json` and
// `~/.codex/config.toml` are NOT single-file binds. post-create.sh copies them
// out of the /host/.<cli> read-only folder stage, and `sync_from_host` simply
// does nothing when they are absent (the `[ -f ]` guard). Creating them here
// would needlessly write to the host of someone who never ran that CLI, so we
// don't.
const FILES = ['.claude.json'];

// Create every folder and touch every file under `home`. Safe to run again:
// an existing path is left untouched. The root is a parameter so tests can run
// it against a temp dir.
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
  // One-time setup for native Windows. VS Code fills in the bind-mount sources
  // using `${localEnv:HOME}`, which reads its own process environment. Windows
  // does not set `HOME` by default; it uses `USERPROFILE`. With no `HOME`, the
  // bind sources shrink to filesystem-root paths (`/.claude`, `/.codex`, ...)
  // and Docker rejects them with `bind source path does not exist`.
  //
  // The fix is to save `HOME=%USERPROFILE%` into the user's environment with
  // `setx`. `setx` writes to `HKCU\Environment`. Every process the user starts
  // after that inherits the new value, including VS Code once it restarts. The
  // current VS Code process can't see the change, because its environment was
  // set when it launched. So we tell the user to restart VS Code once.
  //
  // Later runs see that `HOME` is set, skip this block, and continue normally.
  // Mac, Linux, and WSL hosts already have `HOME` set by the shell, so this
  // block does nothing on those platforms.
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
