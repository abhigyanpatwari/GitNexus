#!/usr/bin/env node
/** Launch the npm package's hook. Hook behavior and helpers live only there. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOOK_PATH = 'hooks/claude/gitnexus-hook.cjs';
const RECOVERY_TIMEOUT = 120000;
const LOCK_MAX_AGE = 130000; // Deadline plus process-tree cleanup; never signal a stale PID.
const FAILURE_COOLDOWN = 5 * 60 * 1000;

function exactVersion(version) {
  const numeric = '(?:0|[1-9][0-9]*)';
  const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  );
  if (typeof version !== 'string' || version.trim() !== version || !semver.test(version)) {
    throw new Error('GitNexus hook launcher must contain an exact package version');
  }
  return version;
}

function runtimeAtRoot(root, version) {
  try {
    root = fs.realpathSync(root);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const entry = path.join(root, HOOK_PATH);
    const cli = path.join(root, 'dist', 'cli', 'index.js');
    if (metadata.name !== 'gitnexus') return null;
    exactVersion(metadata.version);
    if (version && metadata.version !== version) return null;
    // Both entrypoints must belong to this package, including symlinked installs.
    return fs.statSync(cli).isFile() &&
      fs.realpathSync(cli) === cli &&
      fs.statSync(entry).isFile() &&
      fs.realpathSync(entry) === entry
      ? entry
      : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function runtimeForCli(cli, version) {
  try {
    const real = fs.realpathSync(cli);
    const root = path.resolve(path.dirname(real), '..', '..');
    return real === path.join(root, 'dist', 'cli', 'index.js')
      ? runtimeAtRoot(root, version)
      : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function runtimeForHook(hook, version) {
  try {
    const real = fs.realpathSync(hook);
    const root = path.resolve(path.dirname(real), '..', '..');
    return real === path.join(root, HOOK_PATH) ? runtimeAtRoot(root, version) : null;
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
      const candidate = path.resolve(directory, name + suffix);
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

function runtimeOnPath(version) {
  const launcher = findOnPath('gitnexus');
  if (!launcher) return null;
  // npm's Unix symlinks and Windows prefix/local .bin layouts.
  return (
    runtimeForCli(launcher, version) ||
    runtimeAtRoot(path.join(path.dirname(launcher), 'node_modules', 'gitnexus'), version) ||
    runtimeAtRoot(path.resolve(path.dirname(launcher), '..', 'gitnexus'), version)
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
  exactVersion(config.version);
  return config;
}

function resolveRuntime(config) {
  for (const cli of [process.env.GITNEXUS_HOOK_CLI_PATH, config && config.cliPath]) {
    const runtime = cli && runtimeForCli(cli);
    if (runtime) return runtime;
  }
  try {
    const runtime = runtimeForHook(require.resolve(`gitnexus/${HOOK_PATH}`));
    if (runtime) return runtime;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
  }
  return runtimeOnPath();
}

function pinnedPackage(config) {
  return `gitnexus@${exactVersion((config || require('../.claude-plugin/plugin.json')).version)}`;
}

function recoveryDirectory(version) {
  const key = createHash('sha256').update(version).digest('hex').slice(0, 24);
  const base = path.join(os.homedir(), '.gitnexus', 'hook-launcher');
  const directory = path.join(base, key);
  for (const location of [base, directory]) {
    fs.mkdirSync(location, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid hook recovery directory');
    fs.chmodSync(location, 0o700);
  }
  return directory;
}

function readRecovery(directory, version) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    if (state.version !== version) return null;
    if (typeof state.runtime === 'string' && path.isAbsolute(state.runtime)) {
      const runtime = runtimeForHook(state.runtime, version);
      return runtime ? { runtime } : null;
    }
    if (
      Number.isFinite(state.failedAt) &&
      state.failedAt <= Date.now() &&
      Date.now() - state.failedAt < FAILURE_COOLDOWN
    ) {
      return { error: String(state.error || 'Package recovery is cooling down').slice(0, 200) };
    }
  } catch {
    /* Missing, deleted, or invalid cache entries require fresh discovery. */
  }
  return null;
}

function writeRecovery(directory, state) {
  const temporary = path.join(directory, `${randomUUID()}.json`);
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, 'runtime.json'));
}

function acquireInstallSlot(directory) {
  const lock = path.join(directory, 'install.lock');
  const owner = `${process.pid}-${randomUUID()}.owner`;
  const prepared = fs.mkdtempSync(lock + '-');
  try {
    fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Atomically publish a nonempty directory: reclamation cannot see an empty live lock.
        fs.renameSync(prepared, lock);
        return () => {
          try {
            fs.unlinkSync(path.join(lock, owner));
            fs.rmdirSync(lock);
          } catch {
            /* A delayed owner cannot remove its replacement's unique owner file. */
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
          const age = Date.now() - fs.statSync(path.join(lock, previousOwner)).mtimeMs;
          if (age < LOCK_MAX_AGE) {
            try {
              process.kill(pid, 0);
              return null;
            } catch (error) {
              if (error.code !== 'ESRCH') return null;
            }
          }
          // Do not signal this PID: after the bounded deadline it may have been reused.
          fs.unlinkSync(path.join(lock, previousOwner));
        }
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
        timeout: 2000,
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

/** Discovery never reads the hook's stdin and never forwards npm output. */
function runPackage(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    let outputBytes = 0;
    let failure;
    let finished = false;
    let deadline;
    let escalation;
    function finish(error, treeCleaned = false) {
      if (finished) return;
      finished = true;
      if (failure && !treeCleaned) killTree(child, 'SIGKILL');
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('SIGINT', onTerminate);
      if (failure || error) reject(failure || error);
      else resolve();
    }
    function stop(error) {
      if (failure || finished) return;
      failure = error;
      killTree(child, 'SIGTERM');
      escalation = setTimeout(() => {
        killTree(child, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(failure, true);
      }, 2000);
    }
    function onTerminate() {
      stop(new Error('GitNexus package recovery cancelled'));
    }
    function collect(chunk, diagnostic) {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) stop(new Error('GitNexus package output exceeded 1 MiB'));
      else if (diagnostic) stderr.push(chunk);
    }
    child.stdout.on('data', (chunk) => collect(chunk, false));
    child.stderr.on('data', (chunk) => collect(chunk, true));
    child.once('error', finish);
    child.once('close', (status) =>
      finish(
        status === 0
          ? null
          : new Error(
              String(Buffer.concat(stderr)).slice(0, 200) || 'GitNexus package recovery failed',
            ),
      ),
    );
    process.once('SIGTERM', onTerminate);
    process.once('SIGINT', onTerminate);
    deadline = setTimeout(
      () => stop(new Error('GitNexus package recovery timed out')),
      RECOVERY_TIMEOUT,
    );
  });
}

function nodeEnvironment() {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
  return env;
}

async function downloadAndRun(packageName, directory) {
  const receipt = path.join(directory, `${randomUUID()}.discovery.json`);
  const env = {
    ...nodeEnvironment(),
    npm_config_loglevel: 'silent',
    npm_config_foreground_scripts: 'false',
    __GITNEXUS_HOOK_BOOTSTRAP: __filename,
    __GITNEXUS_HOOK_MODE: 'discover',
    __GITNEXUS_HOOK_VERSION: packageName.slice('gitnexus@'.length),
    __GITNEXUS_HOOK_RECEIPT: receipt,
  };
  // npm executes this through a shell. Only fixed source enters its command string;
  // paths (including the node interpreter directory) travel in the environment.
  const args = [
    '--yes',
    '--prefer-offline',
    `--package=${packageName}`,
    '--',
    'node',
    '-e',
    'require(process.env.__GITNEXUS_HOOK_BOOTSTRAP)',
  ];
  const npx = findOnPath('npx');
  let command = npx || 'npx';
  let commandArgs = args;
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32') {
    const npxJs = npx && path.join(path.dirname(npx), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (npxJs && fs.existsSync(npxJs)) {
      command = process.execPath;
      commandArgs = [npxJs, ...args];
    } else if (!npx || /\.(cmd|bat)$/i.test(npx)) {
      env.__GITNEXUS_HOOK_NPX = npx || 'npx.cmd';
      command =
        process.env.ComSpec ||
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      commandArgs = [
        '/d',
        '/s',
        '/c',
        `""%__GITNEXUS_HOOK_NPX%" ${args.slice(0, -1).join(' ')} \"${args.at(-1)}\""`,
      ];
      windowsVerbatimArguments = true;
    }
  }
  try {
    await runPackage(command, commandArgs, { env, cwd: directory, windowsVerbatimArguments });
    const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const runtime =
      typeof result.runtime === 'string' &&
      runtimeForHook(result.runtime, env.__GITNEXUS_HOOK_VERSION);
    if (!runtime) throw new Error('The pinned package does not contain the GitNexus hook');
    return runtime;
  } finally {
    fs.rmSync(receipt, { force: true });
  }
}

async function recoverPackage(version) {
  exactVersion(version);
  const directory = recoveryDirectory(version);
  const release = acquireInstallSlot(directory);
  if (!release) return;
  try {
    if (readRecovery(directory, version)) return;
    try {
      const runtime = await downloadAndRun(`gitnexus@${version}`, directory);
      writeRecovery(directory, { version, runtime });
    } catch (error) {
      writeRecovery(directory, {
        version,
        failedAt: Date.now(),
        error: String(error.message || error).slice(0, 200),
      });
    }
  } finally {
    release();
  }
}

async function launchPinnedPackage(config) {
  const version = pinnedPackage(config).slice('gitnexus@'.length);
  const directory = recoveryDirectory(version);
  let state = readRecovery(directory, version);
  if (!state) {
    // The independent helper owns both lock and deadline, even if this caller is SIGKILLed.
    const helper = spawn(process.execPath, [__filename, '--recover-package', version], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: directory,
      env: { ...process.env, __GITNEXUS_HOOK_MODE: '' },
    });
    let startError;
    let helperExited = false;
    let helperStatus;
    helper.once('error', (error) => {
      startError = error;
    });
    helper.once('exit', (status) => {
      helperExited = true;
      helperStatus = status;
    });
    helper.unref();
    const deadline = Date.now() + LOCK_MAX_AGE + 5000;
    while (!state && Date.now() < deadline) {
      if (startError) throw startError;
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = readRecovery(directory, version);
      if (
        !state &&
        helperExited &&
        (helperStatus !== 0 || !fs.existsSync(path.join(directory, 'install.lock')))
      ) {
        // The owner may publish and release between our first read and lock check.
        state = readRecovery(directory, version);
        if (!state) throw new Error('GitNexus package recovery exited without a result');
      }
    }
  }
  if (!state) throw new Error('Timed out waiting for GitNexus package recovery');
  if (state.error) throw new Error(`Package recovery cooling down: ${state.error}`);
  require(state.runtime);
}

function runShim(shim) {
  let command = shim;
  let args = [];
  const env = nodeEnvironment();
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(shim)) {
    env.__GITNEXUS_HOOK_SHIM = shim;
    command =
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    args = ['/d', '/s', '/c', '""%__GITNEXUS_HOOK_SHIM%""'];
    windowsVerbatimArguments = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments,
    });
    child.once('error', reject);
    child.once('close', (status) =>
      status === 0 ? resolve() : reject(new Error('Installed GitNexus hook failed')),
    );
  });
}

function isDebugEnabled() {
  return process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true';
}

async function main() {
  if (process.env.__GITNEXUS_HOOK_MODE === 'discover') {
    const version = exactVersion(process.env.__GITNEXUS_HOOK_VERSION);
    const runtime = runtimeOnPath(version);
    if (!runtime) throw new Error('The pinned package does not contain the GitNexus hook');
    fs.writeFileSync(process.env.__GITNEXUS_HOOK_RECEIPT, JSON.stringify({ runtime }), {
      mode: 0o600,
    });
    return;
  }
  if (process.argv[2] === '--recover-package') {
    await recoverPackage(process.argv[3]);
    return;
  }
  const config = launcherConfig();
  const runtime = resolveRuntime(config);
  if (runtime) require(runtime);
  else {
    const shim = findOnPath('gitnexus-hook');
    if (shim) await runShim(shim);
    else await launchPinnedPackage(config);
  }
}

main().catch((error) => {
  if (process.argv[2] === '--recover-package' || process.env.__GITNEXUS_HOOK_MODE === 'discover') {
    process.exitCode = 1;
  }
  if (isDebugEnabled()) {
    process.stderr.write(
      `GitNexus hook launcher: ${String(error.message || error).slice(0, 200)}\n`,
    );
  }
});
