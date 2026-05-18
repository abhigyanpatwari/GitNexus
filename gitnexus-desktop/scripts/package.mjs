import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const gitnexusRoot = path.join(workspaceRoot, 'gitnexus');
const gitnexusWebRoot = path.join(workspaceRoot, 'gitnexus-web');
const releaseRoot = path.join(packageRoot, 'release');
const gitnexusPackageJson = JSON.parse(
  fs.readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'),
);
const gitnexusPackageLock = JSON.parse(
  fs.readFileSync(path.join(gitnexusRoot, 'package-lock.json'), 'utf8'),
);
const desktopPackageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
const desktopPackageLock = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package-lock.json'), 'utf8'),
);
const electronVersion =
  desktopPackageJson.devDependencies?.electron?.replace(/^[^\d]*/, '') ?? '41.2.1';
const electronBuilderVersion =
  desktopPackageJson.devDependencies?.['electron-builder']?.replace(/^[^\d]*/, '') ?? '26.8.1';
const electronBuilderCliPath = path.join(packageRoot, 'node_modules', 'electron-builder', 'cli.js');
const builderUtilRequire = createRequire(
  path.join(packageRoot, 'node_modules', 'builder-util', 'out', 'util.js'),
);
const requiredBuilderRuntimeModules = ['app-builder-bin'];
const appBuilderLibVersion =
  desktopPackageLock.packages?.['node_modules/app-builder-lib']?.version ??
  electronBuilderVersion.replace(/^[^\d]*/, '');
// Validate version is safe semver before embedding in a CLI argument.
if (!/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9._-]*)?$/.test(appBuilderLibVersion)) {
  throw new Error(
    `Invalid app-builder-lib version in lockfile: ${JSON.stringify(appBuilderLibVersion)}`,
  );
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(releaseRoot, stamp);
const latestReleasePointerPath = path.join(releaseRoot, '.latest-unpacked-release');
const electronBuilderConfigPath = path.join(packageRoot, 'electron-builder.yml');
const requiredNsisTemplateFiles = [
  path.join(packageRoot, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'messages.yml'),
  path.join(
    packageRoot,
    'node_modules',
    'app-builder-lib',
    'templates',
    'nsis',
    'assistedMessages.yml',
  ),
];
const supportedTargetHosts = {
  '--linux': 'linux',
  '--mac': 'darwin',
  '--win': 'win32',
};
const allowedBuilderArgs = new Set([
  '--dir',
  '--linux',
  '--mac',
  '--win',
  'AppImage',
  'dmg',
  'nsis',
]);
const artifactFileExtensions = new Set(['.AppImage', '.dmg', '.exe', '.msi', '.zip']);
const gitnexusRuntimeDependencyNames = Object.keys(gitnexusPackageJson.dependencies ?? {});
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packagedResourceEntries = [
  {
    from: path.join(gitnexusWebRoot, 'dist'),
    to: 'gitnexus-web',
  },
  {
    from: path.join(gitnexusRoot, 'dist'),
    to: path.join('gitnexus', 'dist'),
  },
  {
    from: path.join(gitnexusRoot, 'hooks'),
    to: path.join('gitnexus', 'hooks'),
  },
  {
    from: path.join(gitnexusRoot, 'skills'),
    to: path.join('gitnexus', 'skills'),
  },
  {
    from: path.join(gitnexusRoot, 'vendor'),
    to: path.join('gitnexus', 'vendor'),
  },
  {
    from: path.join(gitnexusRoot, 'package.json'),
    to: path.join('gitnexus', 'package.json'),
  },
];

const toBuilderRelativePath = (targetPath) => {
  return path.relative(packageRoot, targetPath) || '.';
};

const getNodeModulePath = (packageName) => {
  return path.join(gitnexusRoot, 'node_modules', ...packageName.split('/'));
};

const getRuntimeDependencyClosure = () => {
  const visited = new Set();
  const queue = [...gitnexusRuntimeDependencyNames];

  while (queue.length > 0) {
    const packageName = queue.shift();

    if (!packageName || visited.has(packageName)) {
      continue;
    }

    visited.add(packageName);

    const lockEntry = gitnexusPackageLock.packages?.[`node_modules/${packageName}`];
    const dependencyNames = Object.keys({
      ...(lockEntry?.dependencies ?? {}),
      ...(lockEntry?.optionalDependencies ?? {}),
    });

    for (const dependencyName of dependencyNames) {
      if (!visited.has(dependencyName)) {
        queue.push(dependencyName);
      }
    }
  }

  return [...visited].filter((packageName) => fs.existsSync(getNodeModulePath(packageName))).sort();
};

const packagedRuntimeNodeModules = getRuntimeDependencyClosure();

const builderArgs = process.argv.slice(2);
const unsupportedBuilderArgs = builderArgs.filter((argument) => !allowedBuilderArgs.has(argument));

if (unsupportedBuilderArgs.length > 0) {
  throw new Error(`Unsupported electron-builder arguments: ${unsupportedBuilderArgs.join(', ')}`);
}

const requestedTargets = builderArgs.filter((argument) => argument in supportedTargetHosts);

const builderEnvironment = {
  GITNEXUS_DESKTOP_GITNEXUS_DIST: toBuilderRelativePath(path.join(gitnexusRoot, 'dist')),
  GITNEXUS_DESKTOP_GITNEXUS_HOOKS: toBuilderRelativePath(path.join(gitnexusRoot, 'hooks')),
  GITNEXUS_DESKTOP_GITNEXUS_NODE_MODULES: toBuilderRelativePath(
    path.join(gitnexusRoot, 'node_modules'),
  ),
  GITNEXUS_DESKTOP_GITNEXUS_PACKAGE_JSON: toBuilderRelativePath(
    path.join(gitnexusRoot, 'package.json'),
  ),
  GITNEXUS_DESKTOP_GITNEXUS_SKILLS: toBuilderRelativePath(path.join(gitnexusRoot, 'skills')),
  GITNEXUS_DESKTOP_GITNEXUS_VENDOR: toBuilderRelativePath(path.join(gitnexusRoot, 'vendor')),
  GITNEXUS_DESKTOP_WEB_DIST: toBuilderRelativePath(path.join(gitnexusWebRoot, 'dist')),
};

const builderCliArgs = [
  electronBuilderCliPath,
  '--config',
  electronBuilderConfigPath,
  `-c.electronVersion=${electronVersion}`,
  `-c.directories.output=${outputDir}`,
  '--publish',
  'never',
  ...builderArgs,
];

const runCommand = (command, args, cwd, extraEnv = {}) => {
  // On Windows, only .cmd files (e.g. npm.cmd) require shell:true to execute.
  // Using shell:true for all commands causes spaces in paths to be misinterpreted
  // by cmd.exe when it joins the args array into a raw command string.
  const needsShell = process.platform === 'win32' && command.endsWith('.cmd');
  execFileSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: 'inherit',
    windowsHide: true,
    shell: needsShell,
  });
};

const mirrorDirectory = (sourceDirectory, destinationDirectory) => {
  if (process.platform === 'win32') {
    fs.mkdirSync(destinationDirectory, { recursive: true });

    try {
      execFileSync(
        'robocopy',
        [sourceDirectory, destinationDirectory, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
        {
          cwd: packageRoot,
          stdio: 'inherit',
          windowsHide: true,
        },
      );
    } catch (error) {
      const exitCode = error.status ?? 16;

      if (exitCode > 7) {
        throw error;
      }
    }

    return;
  }

  fs.rmSync(destinationDirectory, { force: true, recursive: true });
  fs.cpSync(sourceDirectory, destinationDirectory, { force: true, recursive: true });
};

const canResolveBuilderRuntimeModule = (moduleName) => {
  try {
    builderUtilRequire.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
};

const overlayDirectoryContents = (sourceDirectory, destinationDirectory) => {
  fs.mkdirSync(destinationDirectory, { recursive: true });

  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    fs.cpSync(path.join(sourceDirectory, entry.name), path.join(destinationDirectory, entry.name), {
      force: true,
      recursive: true,
    });
  }
};

const resolvePackagedResourceRoots = () => {
  const candidateRoots = [
    path.join(outputDir, 'win-unpacked', 'resources'),
    path.join(outputDir, 'linux-unpacked', 'resources'),
    path.join(
      outputDir,
      `${desktopPackageJson.productName ?? 'GitNexus Desktop'}.app`,
      'Contents',
      'Resources',
    ),
  ];

  return candidateRoots.filter((candidateRoot) => fs.existsSync(candidateRoot));
};

const syncPackagedRuntimeResources = () => {
  const resourceRoots = resolvePackagedResourceRoots();

  if (resourceRoots.length === 0) {
    return;
  }

  for (const resourceRoot of resourceRoots) {
    const packagedNodeModulesRoot = path.join(resourceRoot, 'gitnexus', 'node_modules');

    fs.rmSync(packagedNodeModulesRoot, { force: true, recursive: true });
    fs.mkdirSync(packagedNodeModulesRoot, { recursive: true });

    const sourceNodeModulesLock = path.join(gitnexusRoot, 'node_modules', '.package-lock.json');
    const destinationNodeModulesLock = path.join(packagedNodeModulesRoot, '.package-lock.json');

    if (fs.existsSync(sourceNodeModulesLock)) {
      fs.cpSync(sourceNodeModulesLock, destinationNodeModulesLock, { force: true });
    }

    for (const packageName of packagedRuntimeNodeModules) {
      const sourcePackagePath = getNodeModulePath(packageName);
      const destinationPackagePath = path.join(packagedNodeModulesRoot, ...packageName.split('/'));

      mirrorDirectory(sourcePackagePath, destinationPackagePath);
    }

    for (const entry of packagedResourceEntries) {
      const destinationPath = path.join(resourceRoot, entry.to);

      let isDirectory;
      try {
        isDirectory = fs.statSync(entry.from).isDirectory();
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        continue;
      }
      if (isDirectory) {
        mirrorDirectory(entry.from, destinationPath);
        continue;
      }

      fs.rmSync(destinationPath, { force: true, recursive: true });
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.cpSync(entry.from, destinationPath, { force: true });
    }
  }
};

const repairAppBuilderLibPackage = () => {
  const repairDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gitnexus-desktop-app-builder-lib-'),
  );

  try {
    const tarballName = `app-builder-lib-${appBuilderLibVersion}.tgz`;
    const tarballPath = path.join(repairDirectory, tarballName);
    const extractedPackageRoot = path.join(repairDirectory, 'package');
    const installedPackageRoot = path.join(packageRoot, 'node_modules', 'app-builder-lib');

    runCommand(
      npmCommand,
      ['pack', `app-builder-lib@${appBuilderLibVersion}`, '--pack-destination', repairDirectory],
      packageRoot,
    );
    runCommand('tar', ['-xzf', tarballPath, '-C', repairDirectory], packageRoot);
    overlayDirectoryContents(extractedPackageRoot, installedPackageRoot);
  } finally {
    fs.rmSync(repairDirectory, { force: true, recursive: true });
  }
};

const assertSupportedHostForRequestedTargets = () => {
  const unsupportedTargets = requestedTargets.filter(
    (target) => supportedTargetHosts[target] !== process.platform,
  );

  if (unsupportedTargets.length === 0) {
    return;
  }

  const messages = unsupportedTargets.map((target) => {
    if (target === '--mac') {
      return 'macOS DMG builds must run on a macOS host. Use the Desktop Packaging GitHub Actions workflow for .dmg artifacts.';
    }

    if (target === '--linux') {
      return 'Linux AppImage builds should run on a Linux host. Use the Desktop Packaging GitHub Actions workflow for Linux installers.';
    }

    return 'Windows NSIS builds must run on a Windows host.';
  });

  throw new Error(messages.join('\n'));
};

const ensureDesktopToolchainHealthy = () => {
  const missingBuilderRuntimeModules = requiredBuilderRuntimeModules.filter(
    (moduleName) => !canResolveBuilderRuntimeModule(moduleName),
  );
  const missingNsisTemplates = requestedTargets.includes('--win')
    ? requiredNsisTemplateFiles.filter((filePath) => !fs.existsSync(filePath))
    : [];

  if (missingBuilderRuntimeModules.length === 0 && missingNsisTemplates.length === 0) {
    return;
  }

  if (missingNsisTemplates.length > 0) {
    console.warn(
      '[build] electron-builder NSIS templates are missing. Restoring app-builder-lib package contents first...',
    );

    try {
      repairAppBuilderLibPackage();
    } catch {
      // Fall through to install-based repair paths below.
    }
  }

  const remainingMissingBuilderRuntimeModules = requiredBuilderRuntimeModules.filter(
    (moduleName) => !canResolveBuilderRuntimeModule(moduleName),
  );
  const remainingMissingNsisTemplates = requestedTargets.includes('--win')
    ? requiredNsisTemplateFiles.filter((filePath) => !fs.existsSync(filePath))
    : [];

  if (
    remainingMissingBuilderRuntimeModules.length === 0 &&
    remainingMissingNsisTemplates.length === 0
  ) {
    return;
  }

  console.warn(
    '[build] electron-builder installation is incomplete. Restoring desktop dependencies with npm ci...',
  );
  runCommand(npmCommand, ['ci'], packageRoot);

  const unresolvedBuilderRuntimeModules = requiredBuilderRuntimeModules.filter(
    (moduleName) => !canResolveBuilderRuntimeModule(moduleName),
  );
  const unresolvedTemplates = requiredNsisTemplateFiles.filter(
    (filePath) => !fs.existsSync(filePath),
  );

  if (unresolvedBuilderRuntimeModules.length > 0 || unresolvedTemplates.length > 0) {
    throw new Error(
      [
        'electron-builder is missing required runtime modules after reinstall:',
        ...unresolvedBuilderRuntimeModules,
        ...unresolvedTemplates,
      ].join('\n'),
    );
  }
};

const listArtifacts = (directoryPath) => {
  const results = [];
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'win-unpacked') {
        results.push(fullPath);
        continue;
      }

      results.push(...listArtifacts(fullPath));
      continue;
    }

    if (artifactFileExtensions.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(latestReleasePointerPath, `${outputDir}\n`);

assertSupportedHostForRequestedTargets();
ensureDesktopToolchainHealthy();

runCommand(process.execPath, ['scripts/ensure-gitnexus-runtime.mjs'], packageRoot);

runCommand(npmCommand, ['run', 'bundle'], packageRoot);

const gitnexusSharedRoot = path.join(workspaceRoot, 'gitnexus-shared');
if (!fs.existsSync(path.join(gitnexusSharedRoot, 'dist'))) {
  if (!fs.existsSync(path.join(gitnexusSharedRoot, 'node_modules'))) {
    runCommand(npmCommand, ['ci'], gitnexusSharedRoot);
  }
  runCommand(npmCommand, ['run', 'build'], gitnexusSharedRoot);
}
if (!fs.existsSync(path.join(gitnexusWebRoot, 'node_modules'))) {
  runCommand(npmCommand, ['ci'], gitnexusWebRoot);
}
runCommand(npmCommand, ['run', 'build'], gitnexusWebRoot);

runCommand(process.execPath, builderCliArgs, packageRoot, builderEnvironment);
syncPackagedRuntimeResources();

const artifacts = listArtifacts(outputDir);

console.log(`[build] artifacts written to release/${stamp}`);

if (artifacts.length > 0) {
  console.log('[build] artifacts:');
  for (const artifact of artifacts) {
    console.log(`  - ${artifact}`);
  }
}
