#!/usr/bin/env node
/** Launch the npm package's hook. Hook behavior and helpers live only there. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOOK_PATH = 'hooks/claude/gitnexus-hook.cjs';

function runtimeAtRoot(root) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const entry = path.join(root, HOOK_PATH);
    return metadata.name === 'gitnexus' && fs.statSync(entry).isFile() ? entry : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function runtimeForCli(cli) {
  try {
    const real = fs.realpathSync(cli);
    const root = path.resolve(path.dirname(real), '..', '..');
    return real === path.join(root, 'dist', 'cli', 'index.js') ? runtimeAtRoot(root) : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function findOnPath(name) {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const searchPath = process.env.PATH || process.env.Path || process.env.path || '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, name + suffix);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* try the next launcher */
      }
    }
  }
  return null;
}

function runtimeOnPath() {
  const launcher = findOnPath('gitnexus');
  if (!launcher) return null;
  // npm's Unix symlinks and Windows prefix/local .bin layouts.
  return (
    runtimeForCli(launcher) ||
    runtimeAtRoot(path.join(path.dirname(launcher), 'node_modules', 'gitnexus')) ||
    runtimeAtRoot(path.resolve(path.dirname(launcher), '..', 'gitnexus'))
  );
}

function launcherConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, 'gitnexus-hook.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const config = JSON.parse(raw);
  if (!config || typeof config.cliPath !== 'string' || !path.isAbsolute(config.cliPath)) {
    throw new Error('Invalid GitNexus hook launcher configuration');
  }
  return config;
}

function resolveRuntime(config) {
  const cli = config ? config.cliPath : process.env.GITNEXUS_HOOK_CLI_PATH;
  const configured = cli && runtimeForCli(cli);
  if (configured) return configured;
  try {
    return require.resolve(`gitnexus/${HOOK_PATH}`);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
  }
  return runtimeOnPath();
}

function pinnedPackage(config) {
  const { version } = config || require('../.claude-plugin/plugin.json');
  const numeric = '(?:0|[1-9][0-9]*)';
  const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  );
  if (typeof version !== 'string' || version.trim() !== version || !semver.test(version)) {
    throw new Error('GitNexus hook launcher must contain an exact package version');
  }
  return `gitnexus@${version}`;
}

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'taskkill.exe',
      );
      spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
        timeout: 5000,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    /* already exited */
  }
}

/** Cold install gets bounded process-tree cleanup on timeout and catchable signals. */
function runPackage(command, args, env) {
  const input = fs.readFileSync(0);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let failure;
    let finished = false;
    let deadline;
    let escalation;

    function finish(error) {
      if (finished) return;
      finished = true;
      if (failure) killTree(child, 'SIGKILL');
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('SIGINT', onTerminate);
      if (failure || error) reject(failure || error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    }

    function stop(error) {
      if (failure || finished) return;
      failure = error;
      killTree(child, 'SIGTERM');
      escalation = setTimeout(() => {
        killTree(child, 'SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(failure);
      }, 2000);
    }

    function onTerminate() {
      stop(new Error('GitNexus package launch cancelled'));
    }

    function collect(chunks, chunk) {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) stop(new Error('GitNexus package output exceeded 1 MiB'));
      else chunks.push(chunk);
    }
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', finish);
    child.once('close', (status) =>
      finish(
        status === 0
          ? null
          : new Error(String(Buffer.concat(stderr)) || 'GitNexus package launch failed'),
      ),
    );
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    process.once('SIGTERM', onTerminate);
    process.once('SIGINT', onTerminate);
    // The host allows 150s, leaving headroom for tree cleanup after a cold install.
    deadline = setTimeout(() => stop(new Error('GitNexus package launch timed out')), 120000);
    child.stdin.end(input);
  });
}

async function launchPinnedPackage(config) {
  const packageName = pinnedPackage(config);
  const release = acquireInstallSlot(packageName);
  if (!release) {
    if (isDebugEnabled())
      process.stderr.write('GitNexus hook launcher: package installation already in progress\n');
    return;
  }
  try {
    // A completed concurrent install may have made a normal installation visible.
    const runtime = resolveRuntime(config);
    if (runtime) {
      require(runtime);
      return;
    }
    await downloadAndRun(packageName);
  } finally {
    release();
  }
}

function acquireInstallSlot(packageName) {
  const key = createHash('sha256')
    .update(`${os.homedir()}\0${packageName}`)
    .digest('hex')
    .slice(0, 24);
  const lock = path.join(os.tmpdir(), `gitnexus-hook-install-${key}.lock`);
  const owner = `${process.pid}-${randomUUID()}.owner`;
  const prepared = fs.mkdtempSync(lock + '-');
  try {
    fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Publish a NONEMPTY directory atomically. Unlike mkdir + owner write,
        // there is no empty window in which reclamation could remove a live lock.
        fs.renameSync(prepared, lock);
        return () => {
          try {
            fs.unlinkSync(path.join(lock, owner));
            fs.rmdirSync(lock);
          } catch {
            /* replaced or already removed */
          }
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      }
      try {
        const stat = fs.lstatSync(lock);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        const entries = fs.readdirSync(lock);
        if (entries.length > 1) return null;
        if (entries.length === 1) {
          const previousOwner = entries[0];
          const match = /^(\d+)-[0-9a-f-]+\.owner$/.exec(previousOwner);
          const pid = match && Number(match[1]);
          if (!Number.isSafeInteger(pid) || pid <= 0) return null;
          try {
            process.kill(pid, 0);
            return null;
          } catch (error) {
            if (error.code !== 'ESRCH') return null;
          }
          // Only one reclaimer can unlink this owner's unique name. A delayed
          // contender cannot unlink the different name of a replacement owner.
          fs.unlinkSync(path.join(lock, previousOwner));
        }
        // Also recovers a reclaimer interrupted after removing the dead owner.
        // Any replacement is already nonempty, so rmdir cannot remove it.
        fs.rmdirSync(lock);
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}

async function downloadAndRun(packageName) {
  // Published versions already expose gitnexus and this canonical hook path.
  // Re-enter this bootstrap in npm's PATH instead of requiring a new npm bin.
  const args = [
    '--yes',
    `--package=${packageName}`,
    '--',
    process.execPath,
    __filename,
    '--package-runtime',
  ];
  const npx = findOnPath('npx');
  let command = npx || 'npx';
  let commandArgs = args;
  const env = { ...process.env, npm_config_loglevel: 'silent' };
  if (process.platform === 'win32') {
    const npxJs = npx && path.join(path.dirname(npx), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (npxJs && fs.existsSync(npxJs)) {
      command = process.execPath;
      commandArgs = [npxJs, ...args];
    } else {
      command =
        process.env.ComSpec ||
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      // Internal transport only: arbitrary bootstrap paths never enter cmd syntax.
      env.__GITNEXUS_HOOK_BOOTSTRAP = __filename;
      commandArgs = [
        '/d',
        '/s',
        '/c',
        `npx.cmd --yes --package=${packageName} -- node -e "require(process.env.__GITNEXUS_HOOK_BOOTSTRAP)" -- --package-runtime`,
      ];
    }
  }
  const child = await runPackage(command, commandArgs, env);
  if (child.stdout.length) process.stdout.write(child.stdout);
  if (isDebugEnabled() && child.stderr.length) process.stderr.write(child.stderr);
}

function isDebugEnabled() {
  return process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true';
}

async function main() {
  if (process.argv.includes('--package-runtime')) {
    // Only npm's first gitnexus PATH entry is eligible. Never rediscover an
    // unrelated module/override or recursively start another package download.
    const runtime = runtimeOnPath();
    if (!runtime) throw new Error('The pinned package does not contain the GitNexus hook');
    require(runtime);
    return;
  }
  const config = launcherConfig();
  const runtime = resolveRuntime(config);
  if (runtime) require(runtime);
  else await launchPinnedPackage(config);
}

main().catch((error) => {
  if (isDebugEnabled()) {
    process.stderr.write(
      `GitNexus hook launcher: ${String(error.message || error).slice(0, 200)}\n`,
    );
  }
});
