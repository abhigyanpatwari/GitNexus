import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');
const sharedRoot = path.join(workspaceRoot, 'gitnexus-shared');
const gitnexusRoot = path.join(workspaceRoot, 'gitnexus');
const gitnexusWebRoot = path.join(workspaceRoot, 'gitnexus-web');
const gitnexusServerEntry = path.join(gitnexusRoot, 'dist', 'server', 'api.js');
const desktopRendererPort = 5174;
const shouldCleanupDevPort = process.argv.includes('--cleanup-dev-port');

const runNpmAttempt = (args, cwd) => {
  const result = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
};

const runNpm = (args, cwd) => {
  const status = runNpmAttempt(args, cwd);

  if (status !== 0) {
    process.exit(status);
  }
};

const runCommand = (command, args) => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
};

const findPortOwner = (port) => {
  if (process.platform === 'win32') {
    const lookup = runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      [
        `$connection = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' } | Select-Object -First 1;`,
        'if (-not $connection) { return }',
        `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = $($connection.OwningProcess)\";`,
        '$payload = [PSCustomObject]@{',
        '  pid = $connection.OwningProcess;',
        '  name = $process.Name;',
        '  executablePath = $process.ExecutablePath;',
        '  commandLine = $process.CommandLine',
        '};',
        '$payload | ConvertTo-Json -Compress',
      ].join(' '),
    ]);

    if (lookup.status !== 0 || !lookup.stdout.trim()) {
      return null;
    }

    return JSON.parse(lookup.stdout.trim());
  }

  const lookup = runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn']);

  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    return null;
  }

  const owner = { pid: null, name: '', commandLine: '' };

  for (const line of lookup.stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      owner.pid = Number.parseInt(line.slice(1), 10);
    } else if (line.startsWith('c')) {
      owner.name = line.slice(1);
    } else if (line.startsWith('n')) {
      owner.commandLine = line.slice(1);
    }
  }

  return owner.pid ? owner : null;
};

const killProcessTree = (pid) => {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'inherit',
      windowsHide: true,
    });

    if ((result.status ?? 1) !== 0) {
      process.exit(result.status ?? 1);
    }

    return;
  }

  process.kill(pid, 'SIGTERM');
};

const ensureDesktopRendererPortAvailable = () => {
  const owner = findPortOwner(desktopRendererPort);

  if (!owner) {
    return;
  }

  const signature = `${owner.name ?? ''} ${owner.commandLine ?? ''}`.toLowerCase();
  const isStaleElectronViteProcess = signature.includes('electron-vite');

  if (!isStaleElectronViteProcess) {
    console.error(
      `Port ${desktopRendererPort} is already in use by ${owner.name ?? 'another process'} (PID ${owner.pid}). Stop that process and try again.`,
    );
    process.exit(1);
  }

  console.info(`Stopping stale desktop renderer process on port ${desktopRendererPort} (PID ${owner.pid}).`);
  killProcessTree(owner.pid);
};

if (shouldCleanupDevPort) {
  ensureDesktopRendererPortAvailable();
}

if (!existsSync(path.join(sharedRoot, 'node_modules', 'typescript'))) {
  runNpm(['ci'], sharedRoot);
}

if (!existsSync(path.join(gitnexusRoot, 'node_modules', 'tsx'))) {
  runNpm(['ci'], gitnexusRoot);
}

if (!existsSync(path.join(gitnexusWebRoot, 'node_modules', 'vite'))) {
  runNpm(['ci'], gitnexusWebRoot);
}

if (!existsSync(gitnexusServerEntry)) {
  runNpm(['run', 'build'], gitnexusRoot);
}
