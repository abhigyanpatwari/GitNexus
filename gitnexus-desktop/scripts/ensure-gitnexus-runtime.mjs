import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');
const sharedRoot = path.join(workspaceRoot, 'gitnexus-shared');
const gitnexusRoot = path.join(workspaceRoot, 'gitnexus');
const gitnexusWebRoot = path.join(workspaceRoot, 'gitnexus-web');
const gitnexusLockfile = JSON.parse(
  readFileSync(path.join(gitnexusRoot, 'package-lock.json'), 'utf8'),
);
const gitnexusPackageJson = JSON.parse(
  readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'),
);
const gitnexusModuleResolver = createRequire(path.join(gitnexusRoot, 'package.json'));
const gitnexusServerEntry = path.join(gitnexusRoot, 'dist', 'server', 'api.js');
const gitnexusCliEntry = path.join(gitnexusRoot, 'dist', 'cli', 'index.js');
const gitnexusServerPort = 4747;
const gitnexusWebDevPort = 5173;
const desktopRendererPort = 5174;
const shouldCleanupDevPort = process.argv.includes('--cleanup-dev-port');

const getNodeModulePackageJsonPath = (packageRoot, packageName) => {
  return path.join(packageRoot, 'node_modules', ...packageName.split('/'), 'package.json');
};

const getLockedPackageInstallSpecifier = (packageName) => {
  const lockedPackage = gitnexusLockfile.packages?.[`node_modules/${packageName}`];
  const lockedVersion = lockedPackage?.version;

  if (!lockedVersion || String(lockedVersion).startsWith('file:')) {
    return null;
  }

  return lockedVersion;
};

const getDependencySubset = (dependencyMap, packageNames, overrides = {}) => {
  return Object.fromEntries(
    packageNames.map((packageName) => {
      const versionSpecifier =
        overrides[packageName] ??
        getLockedPackageInstallSpecifier(packageName) ??
        dependencyMap?.[packageName];

      if (!versionSpecifier) {
        throw new Error(`Missing package specifier for ${packageName}.`);
      }

      return [packageName, versionSpecifier];
    }),
  );
};

const getEntryMtimeMs = (targetPath) => {
  if (!existsSync(targetPath)) {
    return 0;
  }

  return statSync(targetPath).mtimeMs;
};

const getPathMtimeMs = (targetPath) => {
  if (!existsSync(targetPath)) {
    return 0;
  }

  const stats = statSync(targetPath);

  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newestMtimeMs = stats.mtimeMs;

  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'dist' || entry.name === 'node_modules') {
      continue;
    }

    newestMtimeMs = Math.max(newestMtimeMs, getPathMtimeMs(path.join(targetPath, entry.name)));
  }

  return newestMtimeMs;
};

const getNewestMtimeMs = (paths) => {
  return paths.reduce((latestMtimeMs, targetPath) => {
    return Math.max(latestMtimeMs, getPathMtimeMs(targetPath));
  }, 0);
};

const getOldestOutputMtimeMs = (paths) => {
  let oldestMtimeMs = Number.POSITIVE_INFINITY;

  for (const targetPath of paths) {
    const mtimeMs = getPathMtimeMs(targetPath);

    if (mtimeMs === 0) {
      return 0;
    }

    oldestMtimeMs = Math.min(oldestMtimeMs, mtimeMs);
  }

  return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : 0;
};

const gitnexusSharedSourceInputs = [
  path.join(sharedRoot, 'src'),
  path.join(sharedRoot, 'package.json'),
  path.join(sharedRoot, 'package-lock.json'),
  path.join(sharedRoot, 'tsconfig.json'),
];

const gitnexusSharedInstallInputs = [
  path.join(sharedRoot, 'package.json'),
  path.join(sharedRoot, 'package-lock.json'),
  path.join(sharedRoot, 'tsconfig.json'),
];

const gitnexusSharedInstallMarkerPaths = [path.join(sharedRoot, 'node_modules', 'typescript')];

const gitnexusInstallInputs = [
  path.join(gitnexusRoot, 'package.json'),
  path.join(gitnexusRoot, 'package-lock.json'),
  path.join(sharedRoot, 'package.json'),
  path.join(sharedRoot, 'package-lock.json'),
];

const gitnexusDesktopRuntimeDependencyNames = [
  '@ladybugdb/core',
  '@modelcontextprotocol/sdk',
  'cli-progress',
  'commander',
  'cors',
  'express',
  'glob',
  'graphology',
  'graphology-indices',
  'graphology-utils',
  'ignore',
  'js-yaml',
  'jsonc-parser',
  'lru-cache',
  'mnemonist',
  'pandemonium',
  'uuid',
];
const unmanagedGitNexusRuntimeDependencyNames = Object.keys(gitnexusPackageJson.dependencies ?? {})
  .filter((packageName) => !gitnexusDesktopRuntimeDependencyNames.includes(packageName))
  .sort();

const gitnexusDesktopBuildDependencyNames = ['@types/node', 'gitnexus-shared', 'typescript'];

const gitnexusDesktopRuntimeDependencies = getDependencySubset(
  gitnexusPackageJson.dependencies ?? {},
  gitnexusDesktopRuntimeDependencyNames,
);

const gitnexusDesktopBuildDependencies = getDependencySubset(
  gitnexusPackageJson.devDependencies ?? {},
  gitnexusDesktopBuildDependencyNames,
  { 'gitnexus-shared': `file:${sharedRoot}` },
);

const gitnexusDesktopRuntimeInstallMarkerPaths = [
  ...gitnexusDesktopRuntimeDependencyNames.map((packageName) =>
    getNodeModulePackageJsonPath(gitnexusRoot, packageName),
  ),
  path.join(gitnexusRoot, 'node_modules', 'commander', 'index.js'),
  path.join(gitnexusRoot, 'node_modules', '@ladybugdb', 'core', 'lbugjs.node'),
];

const gitnexusDesktopRuntimeResolutionChecks = [
  'commander',
  '@modelcontextprotocol/sdk/server/index.js',
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  'ignore',
  'js-yaml',
];

const gitnexusDesktopBuildInstallMarkerPaths = gitnexusDesktopBuildDependencyNames.map(
  (packageName) => getNodeModulePackageJsonPath(gitnexusRoot, packageName),
);

const gitnexusRuntimeInputs = [
  path.join(gitnexusRoot, 'src'),
  path.join(gitnexusRoot, 'scripts'),
  path.join(gitnexusRoot, 'package.json'),
  path.join(gitnexusRoot, 'package-lock.json'),
  path.join(gitnexusRoot, 'tsconfig.json'),
  ...gitnexusSharedSourceInputs,
];

const gitnexusRuntimeOutputs = [gitnexusServerEntry, gitnexusCliEntry];

const isInstallStale = (inputPaths, installMarkerPaths) => {
  if (installMarkerPaths.some((targetPath) => !existsSync(targetPath))) {
    return true;
  }

  const installMarkerMtimeMs = Math.min(...installMarkerPaths.map(getEntryMtimeMs));

  return getNewestMtimeMs(inputPaths) > installMarkerMtimeMs;
};

const isGitNexusSharedInstallStale = () => {
  return isInstallStale(gitnexusSharedInstallInputs, gitnexusSharedInstallMarkerPaths);
};

const canResolveGitNexusSpecifier = (specifier) => {
  try {
    gitnexusModuleResolver.resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

const isGitNexusRuntimeInstallStale = () => {
  return (
    isInstallStale(gitnexusInstallInputs, gitnexusDesktopRuntimeInstallMarkerPaths) ||
    gitnexusDesktopRuntimeResolutionChecks.some(
      (specifier) => !canResolveGitNexusSpecifier(specifier),
    )
  );
};

const isGitNexusBuildInstallStale = () => {
  return isInstallStale(gitnexusInstallInputs, gitnexusDesktopBuildInstallMarkerPaths);
};

const isGitNexusBuildStale = () => {
  return getNewestMtimeMs(gitnexusRuntimeInputs) > getOldestOutputMtimeMs(gitnexusRuntimeOutputs);
};

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

const repairGitNexusPackages = (_dependencyMap, label) => {
  console.info(`[gitnexus-desktop] ${label}.`);
  runNpm(['ci'], gitnexusRoot);
};

const runCommand = (command, args) => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
};

const getPosixCommandLine = (pid) => {
  if (!pid) {
    return '';
  }

  const lookup = runCommand('ps', ['-p', String(pid), '-o', 'args=']);

  if (lookup.status !== 0) {
    return '';
  }

  return lookup.stdout.trim();
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

  const lookup = runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);

  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    return null;
  }

  const owner = { pid: null, name: '', commandLine: '' };

  for (const line of lookup.stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      owner.pid = Number.parseInt(line.slice(1), 10);
    } else if (line.startsWith('c')) {
      owner.name = line.slice(1);
    }
  }

  owner.commandLine = getPosixCommandLine(owner.pid);

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

  console.info(
    `Stopping stale desktop renderer process on port ${desktopRendererPort} (PID ${owner.pid}).`,
  );
  killProcessTree(owner.pid);
};

const ensureGitNexusWebDevPortAvailable = () => {
  const owner = findPortOwner(gitnexusWebDevPort);

  if (!owner) {
    return;
  }

  const signature = `${owner.name ?? ''} ${owner.commandLine ?? ''}`.toLowerCase();
  const isGitNexusWebViteProcess = signature.includes('vite') && signature.includes('gitnexus-web');

  if (!isGitNexusWebViteProcess) {
    console.error(
      `Port ${gitnexusWebDevPort} is already in use by ${owner.name ?? 'another process'} (PID ${owner.pid}). Stop that process and try again.`,
    );
    process.exit(1);
  }

  console.info(
    `Stopping stale GitNexus web dev server on port ${gitnexusWebDevPort} (PID ${owner.pid}).`,
  );
  killProcessTree(owner.pid);
};

const ensureGitNexusServerPortAvailable = () => {
  const owner = findPortOwner(gitnexusServerPort);

  if (!owner) {
    return;
  }

  const signature = `${owner.name ?? ''} ${owner.commandLine ?? ''}`.toLowerCase();
  const isGitNexusServerProcess =
    (signature.includes('dist\\cli\\index.js') || signature.includes('dist/cli/index.js')) &&
    signature.includes('serve');

  if (!isGitNexusServerProcess) {
    console.error(
      `Port ${gitnexusServerPort} is already in use by ${owner.name ?? 'another process'} (PID ${owner.pid}). Stop that process and try again.`,
    );
    process.exit(1);
  }

  console.info(`Stopping stale GitNexus backend on port ${gitnexusServerPort} (PID ${owner.pid}).`);
  killProcessTree(owner.pid);
};

if (shouldCleanupDevPort) {
  ensureGitNexusServerPortAvailable();
  ensureDesktopRendererPortAvailable();
  ensureGitNexusWebDevPortAvailable();
}

if (
  !existsSync(path.join(sharedRoot, 'node_modules', 'typescript')) ||
  isGitNexusSharedInstallStale()
) {
  console.info('[gitnexus-desktop] Refreshing gitnexus-shared dependencies.');
  runNpm(['ci'], sharedRoot);
}

if (unmanagedGitNexusRuntimeDependencyNames.length > 0) {
  console.warn(
    '[gitnexus-desktop] Runtime repair does not yet manage these direct GitNexus dependencies:\n' +
      unmanagedGitNexusRuntimeDependencyNames.map((packageName) => `  - ${packageName}`).join('\n'),
  );
}

if (isGitNexusRuntimeInstallStale()) {
  repairGitNexusPackages(gitnexusDesktopRuntimeDependencies, 'Repairing GitNexus runtime packages');
}

if (!existsSync(path.join(gitnexusWebRoot, 'node_modules', 'vite'))) {
  runNpm(['ci'], gitnexusWebRoot);
}

if (getOldestOutputMtimeMs(gitnexusRuntimeOutputs) === 0 || isGitNexusBuildStale()) {
  if (isGitNexusBuildInstallStale()) {
    repairGitNexusPackages(
      {
        ...gitnexusDesktopRuntimeDependencies,
        ...gitnexusDesktopBuildDependencies,
      },
      'Repairing GitNexus build tooling',
    );
  }

  console.info('[gitnexus-desktop] Rebuilding GitNexus runtime artifacts.');
  runNpm(['run', 'build'], gitnexusRoot);
}
