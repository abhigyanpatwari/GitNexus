import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, type Dirent, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet, type RequestOptions } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MOVE_FLOW_RELEASE } from './release.js';

export type MoveFlowInstallStatus =
  | 'available'
  | 'installed'
  | 'skipped'
  | 'unsupported'
  | 'failed';

export interface MoveFlowInstallResult {
  status: MoveFlowInstallStatus;
  binaryPath?: string;
  message?: string;
}

export interface MoveFlowInstallConfig {
  version: string;
  repository: string;
  tag: string;
  releaseTarget: string;
  assetName: string;
  releaseBase: string;
  binaryName: string;
  installDir: string;
  binaryPath: string;
  metadataPath: string;
  lockPath: string;
  httpTimeoutMs: number;
}

interface MoveFlowCacheMetadata {
  version: string;
  repository: string;
  tag: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface LockOptions {
  waitTimeoutMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
}

export interface InstallLockIo {
  openLock(lockPath: string): Promise<FileHandle>;
  removeLock(lockPath: string): Promise<void>;
}

interface PowerShellInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

type HttpsGet = (
  url: string | URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 60_000;
const INSTALL_COMPLETION_GRACE_MS = 60_000;
const DEFAULT_LOCK_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 100;

const defaultLockIo: InstallLockIo = {
  openLock: (lockPath) => open(lockPath, 'wx'),
  removeLock: async (lockPath) => {
    await rm(lockPath, { force: true });
  },
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * A waiter must outlive a healthy cold install: two sequential downloads plus
 * checksum, extraction, copy, and the executable version probe.
 */
export const moveFlowInstallLockWaitMs = (httpTimeoutMs: number): number =>
  Math.max(DEFAULT_LOCK_WAIT_MS, httpTimeoutMs * 2 + INSTALL_COMPLETION_GRACE_MS);

const validateReleaseCoordinates = (version: string, repository: string, tag: string): void => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid move-flow version '${version}'; expected X.Y.Z`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid move-flow repository '${repository}'; expected owner/name`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`invalid move-flow release tag '${tag}'`);
  }
};

const platformKey = (platform = process.platform, arch = process.arch): string | null => {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
};

const execFileOutput = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding },
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout,
        env: options.env,
        encoding: options.encoding ?? 'utf8',
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });

const linuxNeedsCompatBuild = async (env: NodeJS.ProcessEnv): Promise<boolean> => {
  if (process.platform !== 'linux') return false;
  if (env.GITNEXUS_MOVE_FLOW_COMPAT === '1') return true;

  if (process.arch === 'x64') {
    try {
      const cpuinfo = await readFile('/proc/cpuinfo', 'utf8');
      if (!/(^|\s)avx2(\s|$)/m.test(cpuinfo)) return true;
    } catch {
      return true;
    }
  }

  try {
    const output = await execFileOutput('ldd', ['--version'], { timeout: 3_000 });
    const match = /(\d+)\.(\d+)/.exec(output.split('\n')[0] ?? '');
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major < 2 || (major === 2 && minor < 34);
  } catch {
    return false;
  }
};

const releaseTargetForPlatform = async (
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> => {
  switch (key) {
    case 'darwin-arm64':
      return 'aarch64-apple-darwin';
    case 'darwin-x64':
      return 'x86_64-apple-darwin';
    case 'linux-arm64':
      return `aarch64-unknown-linux-gnu${(await linuxNeedsCompatBuild(env)) ? '-compat' : ''}`;
    case 'linux-x64':
      return `x86_64-unknown-linux-gnu${(await linuxNeedsCompatBuild(env)) ? '-compat' : ''}`;
    case 'win32-x64':
      return 'x86_64-pc-windows-msvc';
    default:
      return null;
  }
};

export async function getMoveFlowInstallConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MoveFlowInstallConfig | null> {
  const key = platformKey();
  if (!key) return null;

  const version = env.GITNEXUS_MOVE_FLOW_VERSION?.trim() || MOVE_FLOW_RELEASE.version;
  const repository = env.GITNEXUS_MOVE_FLOW_REPO?.trim() || MOVE_FLOW_RELEASE.repository;
  const tag = env.GITNEXUS_MOVE_FLOW_TAG?.trim() || `${MOVE_FLOW_RELEASE.tagPrefix}${version}`;
  validateReleaseCoordinates(version, repository, tag);
  const releaseTarget = await releaseTargetForPlatform(key, env);
  if (!releaseTarget) return null;

  const assetName = `${tag}-${releaseTarget}.zip`;
  if (path.basename(assetName) !== assetName) throw new Error('invalid move-flow asset name');
  const identity = createHash('sha256')
    .update(`${repository}\0${tag}\0${assetName}`)
    .digest('hex')
    .slice(0, 12);
  const cacheRoot = env.GITNEXUS_MOVE_FLOW_DIR?.trim()
    ? path.resolve(env.GITNEXUS_MOVE_FLOW_DIR)
    : path.join(
        env.GITNEXUS_HOME?.trim() || path.join(os.homedir(), '.gitnexus'),
        'tools',
        'move-flow',
      );
  const installDir = path.join(cacheRoot, version, `${key}-${identity}`);
  const binaryName = process.platform === 'win32' ? 'move-flow.exe' : 'move-flow';

  return {
    version,
    repository,
    tag,
    releaseTarget,
    assetName,
    releaseBase: `https://github.com/${repository}/releases/download/${tag}`,
    binaryName,
    installDir,
    binaryPath: path.join(installDir, binaryName),
    metadataPath: path.join(installDir, 'release.json'),
    lockPath: `${installDir}.install.lock`,
    httpTimeoutMs: parsePositiveInteger(
      env.GITNEXUS_MOVE_FLOW_HTTP_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUT_MS,
    ),
  };
}

export const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export const expectedSha = (sumsText: string, assetName: string): string | null => {
  for (const raw of sumsText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const standard = /^([0-9a-f]{64})[ \t*]+(\S.*)$/i.exec(line);
    if (standard && standard[2] === assetName) return standard[1].toLowerCase();
    const bsd = /^SHA256\s*\((.*)\)\s*=\s*([0-9a-f]{64})$/i.exec(line);
    if (bsd && bsd[1] === assetName) return bsd[2].toLowerCase();
  }
  return null;
};

export type ChecksumVerification =
  | { status: 'match'; expected: string; actual: string }
  | { status: 'mismatch'; expected: string; actual: string }
  | { status: 'missing' };

export const verifyArchiveChecksum = async (
  sumsText: string,
  assetName: string,
  archivePath: string,
): Promise<ChecksumVerification> => {
  const expected = expectedSha(sumsText, assetName);
  if (!expected) return { status: 'missing' };
  const actual = await sha256File(archivePath);
  return actual === expected
    ? { status: 'match', expected, actual }
    : { status: 'mismatch', expected, actual };
};

export const powershellExpandArchiveInvocation = (
  archive: string,
  destination: string,
): PowerShellInvocation => {
  const archiveEnv = 'GITNEXUS_MOVE_FLOW_ARCHIVE_PATH';
  const destinationEnv = 'GITNEXUS_MOVE_FLOW_DESTINATION_PATH';
  return {
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath $env:${archiveEnv} -DestinationPath $env:${destinationEnv} -Force`,
    ],
    env: {
      ...process.env,
      [archiveEnv]: archive,
      [destinationEnv]: destination,
    },
  };
};

export const downloadToFile = async (
  url: string,
  destination: string,
  timeoutMs: number,
  get: HttpsGet = httpsGet,
): Promise<void> => {
  const partial = `${destination}.partial`;
  const deadline = Date.now() + timeoutMs;

  const request = (target: string, redirects: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (redirects > 5) {
        reject(new Error('too many redirects'));
        return;
      }

      const req = get(target, {}, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.once('error', reject);
          response.resume();
          request(new URL(response.headers.location, target).toString(), redirects + 1).then(
            resolve,
            reject,
          );
          return;
        }
        if (status !== 200) {
          response.once('error', reject);
          response.resume();
          reject(new Error(`HTTP ${status} for ${target}`));
          return;
        }

        pipeline(response, createWriteStream(partial))
          .then(() => rename(partial, destination))
          .then(resolve, reject);
      });
      const timeout = setTimeout(
        () => req.destroy(new Error('download timed out')),
        Math.max(1, deadline - Date.now()),
      );
      req.once('close', () => clearTimeout(timeout));
      req.on('error', reject);
    });

  try {
    await request(url, 0);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
};

const readLock = async (lockPath: string): Promise<string | null> => {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
};

const statOrNull = async (file: string): Promise<Stats | null> => {
  try {
    return await stat(file);
  } catch {
    return null;
  }
};

const removeStaleLock = async (lockPath: string, leaseMs: number): Promise<void> => {
  const first = await statOrNull(lockPath);
  if (!first || Date.now() - first.mtimeMs <= leaseMs) return;
  const token = await readLock(lockPath);

  await wait(25);
  const second = await statOrNull(lockPath);
  if (
    !second ||
    second.mtimeMs !== first.mtimeMs ||
    Date.now() - second.mtimeMs <= leaseMs ||
    (await readLock(lockPath)) !== token
  ) {
    return;
  }
  await rm(lockPath, { force: true });
};

export async function acquireInstallLock(
  lockPath: string,
  options: LockOptions = {},
  io: InstallLockIo = defaultLockIo,
): Promise<() => Promise<void>> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + waitTimeoutMs;
  const token = randomUUID();

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    let created = false;
    try {
      const handle = await io.openLock(lockPath);
      created = true;
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
      } finally {
        await handle.close();
      }

      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void (async () => {
          if ((await readLock(lockPath)) !== token) return;
          const now = new Date();
          await utimes(lockPath, now, now);
        })()
          .catch(() => {})
          .finally(() => {
            heartbeatRunning = false;
          });
      }, heartbeatMs);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        if ((await readLock(lockPath)) === token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (created) {
        await io.removeLock(lockPath).catch(() => {});
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await removeStaleLock(lockPath, leaseMs);
      await wait(retryMs);
    }
  }

  throw new Error('timed out waiting for another move-flow installation');
}

export async function settleMoveFlowCleanup(
  ...tasks: Array<(() => Promise<unknown>) | undefined>
): Promise<void> {
  const active = tasks.filter((task): task is () => Promise<unknown> => task !== undefined);
  await Promise.allSettled(active.map((task) => Promise.resolve().then(task)));
}

export const reportedMoveFlowVersion = (output: string): string | null =>
  /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1] ?? null;

const exactVersionMatches = async (binaryPath: string, version: string): Promise<boolean> => {
  try {
    const output = await execFileOutput(binaryPath, ['--version'], { timeout: 5_000 });
    return reportedMoveFlowVersion(output) === version;
  } catch {
    return false;
  }
};

const expectedMetadata = (
  config: MoveFlowInstallConfig,
): Pick<MoveFlowCacheMetadata, 'version' | 'repository' | 'tag' | 'assetName'> => ({
  version: config.version,
  repository: config.repository,
  tag: config.tag,
  assetName: config.assetName,
});

const validCachedInstall = async (config: MoveFlowInstallConfig): Promise<boolean> => {
  try {
    const metadata = JSON.parse(
      await readFile(config.metadataPath, 'utf8'),
    ) as MoveFlowCacheMetadata;
    const expected = expectedMetadata(config);
    if (
      metadata.version !== expected.version ||
      metadata.repository !== expected.repository ||
      metadata.tag !== expected.tag ||
      metadata.assetName !== expected.assetName ||
      metadata.binarySha256 !== (await sha256File(config.binaryPath))
    ) {
      return false;
    }
    return exactVersionMatches(config.binaryPath, config.version);
  } catch {
    return false;
  }
};

export async function findCachedMoveFlow(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const config = await getMoveFlowInstallConfig(env);
    return config && (await validCachedInstall(config)) ? config.binaryPath : null;
  } catch {
    return null;
  }
}

const extractZip = async (archive: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  try {
    if (process.platform === 'win32') {
      const shell = process.env.ComSpec ? 'powershell.exe' : 'powershell';
      const invocation = powershellExpandArchiveInvocation(archive, destination);
      await execFileOutput(shell, invocation.args, { timeout: 30_000, env: invocation.env });
      return;
    }
    await execFileOutput('unzip', ['-q', archive, '-d', destination], { timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `could not extract ${path.basename(archive)} (${error instanceof Error ? error.message : String(error)}). ` +
        'Install unzip, or set MOVE_FLOW to an existing move-flow binary.',
    );
  }
};

const findExtractedBinary = async (root: string, binaryName: string): Promise<string | null> => {
  const stack = [root];
  const names = new Set([binaryName, 'move-flow']);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries: Dirent[] = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (names.has(entry.name)) return full;
    }
  }
  return null;
};

export async function installMoveFlow(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MoveFlowInstallResult> {
  // GITNEXUS_SKIP_OPTIONAL_GRAMMARS is the umbrella opt-out for all optional
  // binary downloads (honored by the retired postinstall probe too).
  for (const flag of ['GITNEXUS_SKIP_MOVE_FLOW', 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS'] as const) {
    if (env[flag] === '1') {
      return { status: 'skipped', message: `installation disabled by ${flag}=1` };
    }
  }

  let config: MoveFlowInstallConfig | null;
  try {
    config = await getMoveFlowInstallConfig(env);
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!config) {
    return {
      status: 'unsupported',
      message: `unsupported platform ${process.platform}-${process.arch}; set MOVE_FLOW to provide a binary`,
    };
  }
  if (await validCachedInstall(config)) {
    return { status: 'available', binaryPath: config.binaryPath };
  }

  let releaseLock: (() => Promise<void>) | undefined;
  let tempDir: string | undefined;
  let stagedDir: string | undefined;
  try {
    releaseLock = await acquireInstallLock(config.lockPath, {
      waitTimeoutMs: moveFlowInstallLockWaitMs(config.httpTimeoutMs),
    });
    if (await validCachedInstall(config)) {
      return { status: 'available', binaryPath: config.binaryPath };
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'move-flow-'));
    const archivePath = path.join(tempDir, config.assetName);
    const sumsPath = path.join(tempDir, 'SHA256SUMS');
    const extractDir = path.join(tempDir, 'extract');
    await downloadToFile(`${config.releaseBase}/SHA256SUMS`, sumsPath, config.httpTimeoutMs);
    await downloadToFile(
      `${config.releaseBase}/${config.assetName}`,
      archivePath,
      config.httpTimeoutMs,
    );

    const verification = await verifyArchiveChecksum(
      await readFile(sumsPath, 'utf8'),
      config.assetName,
      archivePath,
    );
    if (verification.status === 'missing') {
      return {
        status: 'failed',
        message: `SHA256SUMS does not list ${config.assetName}; refusing to install`,
      };
    }
    if (verification.status === 'mismatch') {
      return {
        status: 'failed',
        message: `checksum mismatch for ${config.assetName}; refusing to install`,
      };
    }

    await extractZip(archivePath, extractDir);
    const extracted = await findExtractedBinary(extractDir, config.binaryName);
    if (!extracted) {
      return {
        status: 'failed',
        message: `${config.assetName} did not contain ${config.binaryName}; refusing to install`,
      };
    }

    await mkdir(path.dirname(config.installDir), { recursive: true });
    stagedDir = await mkdtemp(`${config.installDir}.partial-`);
    const stagedBinary = path.join(stagedDir, config.binaryName);
    await copyFile(extracted, stagedBinary);
    if (process.platform !== 'win32') await chmod(stagedBinary, 0o755);
    if (!(await exactVersionMatches(stagedBinary, config.version))) {
      return {
        status: 'failed',
        message: `installed binary did not report exact version ${config.version}; refusing to keep it`,
      };
    }

    const metadata: MoveFlowCacheMetadata = {
      ...expectedMetadata(config),
      archiveSha256: verification.actual,
      binarySha256: await sha256File(stagedBinary),
    };
    await writeFile(path.join(stagedDir, 'release.json'), JSON.stringify(metadata, null, 2));

    await rm(config.installDir, { recursive: true, force: true });
    await rename(stagedDir, config.installDir);
    stagedDir = undefined;
    return { status: 'installed', binaryPath: config.binaryPath };
  } catch (error) {
    return {
      status: 'failed',
      message: `installation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await settleMoveFlowCleanup(
      tempDir ? () => rm(tempDir, { recursive: true, force: true }) : undefined,
      stagedDir ? () => rm(stagedDir, { recursive: true, force: true }) : undefined,
      releaseLock,
    );
  }
}
