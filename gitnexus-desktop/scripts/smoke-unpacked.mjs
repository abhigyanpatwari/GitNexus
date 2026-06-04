import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(packageRoot, 'release');
const latestReleasePointerPath = path.join(releaseRoot, '.latest-unpacked-release');
const productName = 'GitNexus Desktop';
const smokeTimeoutMs = 120_000;
const releaseDirectoryPattern = /^\d{4}-\d{2}-\d{2}T.*Z$/;

const listTimestampedReleaseDirs = () => {
  if (!existsSync(releaseRoot)) {
    return [];
  }

  return readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && releaseDirectoryPattern.test(entry.name))
    .map((entry) => path.join(releaseRoot, entry.name))
    .sort((leftPath, rightPath) => statSync(rightPath).mtimeMs - statSync(leftPath).mtimeMs);
};

const findFirstMatch = (rootDir, predicate) => {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);

    if (predicate(entry, entryPath)) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const nestedMatch = findFirstMatch(entryPath, predicate);

      if (nestedMatch) {
        return nestedMatch;
      }
    }
  }

  return null;
};

const resolveExecutablePath = (releaseDir) => {
  if (process.platform === 'win32') {
    return path.join(releaseDir, 'win-unpacked', `${productName}.exe`);
  }

  if (process.platform === 'darwin') {
    return findFirstMatch(releaseDir, (entry, entryPath) => {
      return (
        entry.isFile() &&
        entry.name === productName &&
        entryPath.includes(`${productName}.app${path.sep}Contents${path.sep}MacOS${path.sep}`)
      );
    });
  }

  const linuxUnpackedDir = path.join(releaseDir, 'linux-unpacked');

  if (!existsSync(linuxUnpackedDir)) {
    return null;
  }

  const candidateNames = [productName, 'gitnexus-desktop'];

  for (const candidateName of candidateNames) {
    const candidatePath = path.join(linuxUnpackedDir, candidateName);

    if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return findFirstMatch(linuxUnpackedDir, (entry, entryPath) => {
    return entry.isFile() && path.extname(entryPath) === '';
  });
};

const resolveLatestExecutable = () => {
  if (existsSync(latestReleasePointerPath)) {
    const releaseDir = readFileSync(latestReleasePointerPath, 'utf8').trim();
    const executablePath = releaseDir ? resolveExecutablePath(releaseDir) : null;

    return {
      executablePath: executablePath && existsSync(executablePath) ? executablePath : null,
      releaseDir: releaseDir || null,
    };
  }

  const releaseDirs = listTimestampedReleaseDirs();

  for (const releaseDir of releaseDirs) {
    const executablePath = resolveExecutablePath(releaseDir);

    if (executablePath && existsSync(executablePath)) {
      return { executablePath, releaseDir };
    }
  }

  return {
    executablePath: null,
    releaseDir: releaseDirs[0] ?? null,
  };
};

const prepareExecutableForSmokeTest = (executablePath) => {
  if (process.platform !== 'darwin') {
    return;
  }

  const result = spawnSync('xattr', ['-cr', executablePath], { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 0) !== 0) {
    throw new Error(`Failed to clear macOS quarantine attributes for ${executablePath}.`);
  }
};

const getSmokeTestArguments = () => {
  return process.platform === 'linux' ? ['--no-sandbox'] : [];
};

const runSmokeTest = async () => {
  const { executablePath, releaseDir: latestReleaseDir } = resolveLatestExecutable();

  if (!latestReleaseDir) {
    throw new Error(
      'No timestamped desktop release directory was found. Run npm run build:dir first.',
    );
  }

  if (!executablePath || !existsSync(executablePath)) {
    throw new Error(`Unable to locate the unpacked desktop executable under ${latestReleaseDir}.`);
  }

  prepareExecutableForSmokeTest(executablePath);
  console.info(`[gitnexus-desktop] Smoke testing unpacked app: ${executablePath}`);

  await new Promise((resolve, reject) => {
    const childProcess = spawn(executablePath, getSmokeTestArguments(), {
      cwd: path.dirname(executablePath),
      env: {
        ...process.env,
        GITNEXUS_DESKTOP_SMOKE_TEST: '1',
      },
      stdio: 'inherit',
      windowsHide: true,
    });

    const timeoutHandle = setTimeout(() => {
      childProcess.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      reject(
        new Error(`Timed out waiting for unpacked desktop smoke test after ${smokeTimeoutMs}ms.`),
      );
    }, smokeTimeoutMs);

    childProcess.once('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    childProcess.once('exit', (code, signal) => {
      clearTimeout(timeoutHandle);

      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(
        new Error(
          `Unpacked desktop smoke test exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}.`,
        ),
      );
    });
  });
};

await runSmokeTest();
