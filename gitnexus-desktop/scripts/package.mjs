import { execSync } from 'node:child_process';
import fs from 'node:fs';
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
const appBuilderLibVersion =
  desktopPackageLock.packages?.['node_modules/app-builder-lib']?.version ??
  electronBuilderVersion.replace(/^[^\d]*/, '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(releaseRoot, stamp);
const generatedBuilderConfigPath = path.join(outputDir, 'electron-builder.generated.json');
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
const artifactFileExtensions = new Set(['.AppImage', '.dmg', '.exe', '.msi', '.zip']);

const builderArgs = process.argv.slice(2);
const requestedTargets = builderArgs.filter((argument) => argument in supportedTargetHosts);

const createBuilderConfig = () => ({
  appId: 'io.github.abhigyanpatwari.gitnexus.desktop',
  electronVersion,
  productName: 'GitNexus Desktop',
  directories: {
    output: outputDir,
    buildResources: path.join(packageRoot, 'build'),
  },
  files: ['dist/**/*', 'package.json'],
  extraResources: [
    {
      from: path.join(gitnexusWebRoot, 'dist'),
      to: 'gitnexus-web',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'dist'),
      to: 'gitnexus/dist',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'node_modules'),
      to: 'gitnexus/node_modules',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'hooks'),
      to: 'gitnexus/hooks',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'skills'),
      to: 'gitnexus/skills',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'vendor'),
      to: 'gitnexus/vendor',
      filter: ['**/*'],
    },
    {
      from: path.join(gitnexusRoot, 'package.json'),
      to: 'gitnexus/package.json',
    },
  ],
  asar: false,
  npmRebuild: false,
  win: {
    signAndEditExecutable: false,
    icon: path.join(packageRoot, 'build', 'icon.png'),
    target: ['nsis'],
  },
  mac: {
    category: 'public.app-category.developer-tools',
    icon: path.join(packageRoot, 'build', 'icon.png'),
    target: ['dmg'],
  },
  linux: {
    category: 'Development',
    icon: path.join(packageRoot, 'build', 'icon.png'),
    target: ['AppImage'],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
});

const builderCommand = [
  `npx --yes -p electron@${electronVersion} -p electron-builder@${electronBuilderVersion} electron-builder`,
  `--config "${generatedBuilderConfigPath}"`,
  `-c.electronVersion=${electronVersion}`,
  '--publish never',
  ...builderArgs,
].join(' ');

const runCommand = (command, cwd, extraEnv = {}) => {
  execSync(command, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: 'inherit',
  });
};

const tryRunCommand = (command, cwd, extraEnv = {}) => {
  try {
    runCommand(command, cwd, extraEnv);
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
      `npm pack app-builder-lib@${appBuilderLibVersion} --pack-destination "${repairDirectory}"`,
      packageRoot,
    );
    runCommand(`tar -xzf "${tarballPath}" -C "${repairDirectory}"`, packageRoot);
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
  if (!requestedTargets.includes('--win')) {
    return;
  }

  const missingNsisTemplates = requiredNsisTemplateFiles.filter(
    (filePath) => !fs.existsSync(filePath),
  );

  if (missingNsisTemplates.length === 0) {
    return;
  }

  console.warn(
    '[build] electron-builder NSIS templates are missing. Restoring app-builder-lib package contents first...',
  );

  try {
    repairAppBuilderLibPackage();
  } catch {
    // Fall through to install-based repair paths below.
  }

  if (requiredNsisTemplateFiles.every((filePath) => fs.existsSync(filePath))) {
    return;
  }

  console.warn(
    '[build] Package overlay repair was not enough. Reinstalling electron-builder next...',
  );

  const targetedRepairWorked = tryRunCommand(
    `npm install --no-save --package-lock=false electron-builder@${electronBuilderVersion}`,
    packageRoot,
  );

  const targetedRepairResolvedTemplates =
    targetedRepairWorked && requiredNsisTemplateFiles.every((filePath) => fs.existsSync(filePath));

  if (!targetedRepairResolvedTemplates) {
    console.warn('[build] Targeted repair was not enough. Falling back to npm ci...');
    runCommand('npm ci', packageRoot);
  }

  const unresolvedTemplates = requiredNsisTemplateFiles.filter(
    (filePath) => !fs.existsSync(filePath),
  );

  if (unresolvedTemplates.length > 0) {
    throw new Error(
      `electron-builder is missing required NSIS templates after reinstall:\n${unresolvedTemplates.join('\n')}`,
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
fs.writeFileSync(generatedBuilderConfigPath, JSON.stringify(createBuilderConfig(), null, 2));

assertSupportedHostForRequestedTargets();
ensureDesktopToolchainHealthy();

runCommand('node scripts/ensure-gitnexus-runtime.mjs', packageRoot);

runCommand('npm run bundle', packageRoot);

runCommand('npm run build', gitnexusWebRoot);

runCommand(builderCommand, packageRoot);

const artifacts = listArtifacts(outputDir);

console.log(`[build] artifacts written to release/${stamp}`);

if (artifacts.length > 0) {
  console.log('[build] artifacts:');
  for (const artifact of artifacts) {
    console.log(`  - ${artifact}`);
  }
}
