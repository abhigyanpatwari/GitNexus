import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, type Dirent } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  downloadToFile,
  MAX_ARCHIVE_BYTES,
  sha256File,
  verifyArchiveChecksum,
} from './artifact-download.js';
import { acquireInstallLock, moveFlowInstallLockWaitMs } from './install-lock.js';
import type { MoveFlowReleaseSelection } from './constants.js';
import { isCompatibleMoveFlowVersion, MOVE_FLOW_RELEASE } from './release.js';

export interface VerifiedMoveFlowBinary {
  binaryPath: string;
  version: string;
  fingerprint: string;
}

export type MoveFlowInstallStatus =
  | 'available'
  | 'installed'
  | 'skipped'
  | 'unsupported'
  | 'failed';

export interface MoveFlowInstallResult {
  status: MoveFlowInstallStatus;
  message?: string;
  /** Verified runtime descriptor, set on 'available' and 'installed'. */
  binary?: VerifiedMoveFlowBinary;
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
  schemaVersion: 1;
  version: string;
  repository: string;
  tag: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
}

interface PowerShellInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const validateReleaseCoordinates = (version: string, repository: string, tag: string): void => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid move-flow version '${version}'; expected X.Y.Z`);
  }
  if (!isCompatibleMoveFlowVersion(version)) {
    throw new Error(`unsupported move-flow major version '${version}'`);
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
  execFileAsync(file, args, {
    timeout: options.timeout,
    env: options.env,
    encoding: options.encoding ?? 'utf8',
  }).then(({ stdout }) => String(stdout));

let detectedLinuxCompatibility: Promise<boolean> | undefined;

const detectLinuxCompatibility = async (): Promise<boolean> => {
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
    if (!match) return true;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major < 2 || (major === 2 && minor < 34);
  } catch {
    return true;
  }
};

const linuxNeedsCompatBuild = (env: NodeJS.ProcessEnv): Promise<boolean> => {
  if (process.platform !== 'linux') return Promise.resolve(false);
  if (env.GITNEXUS_MOVE_FLOW_COMPAT === '1') return Promise.resolve(true);
  detectedLinuxCompatibility ??= detectLinuxCompatibility();
  return detectedLinuxCompatibility;
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

/** Resolve the configured release without downloading or starting move-flow. */
export async function getMoveFlowReleaseSelection(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MoveFlowReleaseSelection | undefined> {
  const config = await getMoveFlowInstallConfig(env);
  return config
    ? {
        version: config.version,
        repository: config.repository,
        tag: config.tag,
        assetName: config.assetName,
      }
    : undefined;
}

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

const verifiedBinary = (
  config: MoveFlowInstallConfig,
  metadata: MoveFlowCacheMetadata,
): VerifiedMoveFlowBinary => ({
  binaryPath: config.binaryPath,
  version: metadata.version,
  fingerprint: createHash('sha256')
    .update(
      `${metadata.repository}\0${metadata.tag}\0${metadata.assetName}\0${metadata.binarySha256}`,
    )
    .digest('hex'),
});

const validCachedInstall = async (
  config: MoveFlowInstallConfig,
): Promise<VerifiedMoveFlowBinary | null> => {
  let metadataHandle: FileHandle | undefined;
  try {
    // Single open, then every check reads through the handle, so the type/size
    // gates and the JSON read cannot race a concurrent swap of the file
    // (CodeQL js/file-system-race). O_NOFOLLOW makes the kernel reject a
    // symlinked final component atomically on POSIX; Windows has no such flag
    // (0 fallback) — there the fstat isFile() gate plus the downstream
    // metadata/binary-hash validation carry the (home-dir, local-writer)
    // threat model.
    metadataHandle = await open(
      config.metadataPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadataStat = await metadataHandle.stat();
    if (
      !metadataStat.isFile() ||
      metadataStat.size <= 0 ||
      metadataStat.size > MAX_METADATA_BYTES
    ) {
      return null;
    }
    const metadata = JSON.parse(
      await metadataHandle.readFile({ encoding: 'utf8' }),
    ) as MoveFlowCacheMetadata;
    const expected = expectedMetadata(config);
    const binaryStat = await lstat(config.binaryPath);
    if (!binaryStat.isFile() || binaryStat.size <= 0 || binaryStat.size > MAX_BINARY_BYTES) {
      return null;
    }
    await access(
      config.binaryPath,
      process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
    );
    if (
      metadata.schemaVersion !== 1 ||
      metadata.version !== expected.version ||
      metadata.repository !== expected.repository ||
      metadata.tag !== expected.tag ||
      metadata.assetName !== expected.assetName ||
      metadata.binarySha256 !== (await sha256File(config.binaryPath))
    ) {
      return null;
    }
    if (!(await exactVersionMatches(config.binaryPath, config.version))) {
      return null;
    }
    return verifiedBinary(config, metadata);
  } catch {
    return null;
  } finally {
    await metadataHandle?.close().catch(() => {});
  }
};

export async function findCachedMoveFlowBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedMoveFlowBinary | null> {
  try {
    const config = await getMoveFlowInstallConfig(env);
    if (!config) return null;
    return validCachedInstall(config);
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
  const candidates: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries: Dirent[] = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && names.has(entry.name)) candidates.push(full);
    }
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const binaryStat = await lstat(candidate);
  return binaryStat.isFile() && binaryStat.size > 0 && binaryStat.size <= MAX_BINARY_BYTES
    ? candidate
    : null;
};

const isConcurrentPublishRecoveryError = (error: unknown): boolean => {
  if (
    error instanceof Error &&
    error.message.includes('timed out waiting for another move-flow installation')
  ) {
    return true;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
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
  const cached = await validCachedInstall(config);
  if (cached) {
    return { status: 'available', binary: cached };
  }

  let releaseLock: (() => Promise<void>) | undefined;
  let tempDir: string | undefined;
  let stagedDir: string | undefined;
  try {
    releaseLock = await acquireInstallLock(config.lockPath, {
      waitTimeoutMs: moveFlowInstallLockWaitMs(config.httpTimeoutMs),
    });
    const published = await validCachedInstall(config);
    if (published) {
      return { status: 'available', binary: published };
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'move-flow-'));
    const archivePath = path.join(tempDir, config.assetName);
    const sumsPath = path.join(tempDir, 'SHA256SUMS');
    const extractDir = path.join(tempDir, 'extract');
    await downloadToFile(
      `${config.releaseBase}/SHA256SUMS`,
      sumsPath,
      config.httpTimeoutMs,
      httpsGet,
      MAX_CHECKSUM_BYTES,
    );
    await downloadToFile(
      `${config.releaseBase}/${config.assetName}`,
      archivePath,
      config.httpTimeoutMs,
      httpsGet,
      MAX_ARCHIVE_BYTES,
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
      schemaVersion: 1,
      ...expectedMetadata(config),
      archiveSha256: verification.actual,
      binarySha256: await sha256File(stagedBinary),
    };
    await writeFile(path.join(stagedDir, 'release.json'), JSON.stringify(metadata, null, 2));

    await rm(config.installDir, { recursive: true, force: true });
    await rename(stagedDir, config.installDir);
    stagedDir = undefined;
    return { status: 'installed', binary: verifiedBinary(config, metadata) };
  } catch (error) {
    // A concurrent installer may have published a valid cache while this
    // attempt was waiting on the lock or downloading (e.g. a stolen lease
    // after host sleep makes our publish rename collide). Only recover for
    // those concurrency-specific errors and only in the default single-user
    // cache. A shared GITNEXUS_MOVE_FLOW_DIR is a trust boundary: its
    // binarySha256 metadata is self-describing, so a post-failure publication
    // must not be accepted without a release anchor.
    if (!env.GITNEXUS_MOVE_FLOW_DIR?.trim() && isConcurrentPublishRecoveryError(error)) {
      const published = await validCachedInstall(config);
      if (published) {
        return { status: 'available', binary: published };
      }
    }
    return {
      status: 'failed',
      message: `installation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await Promise.allSettled([
      tempDir && rm(tempDir, { recursive: true, force: true }),
      stagedDir && rm(stagedDir, { recursive: true, force: true }),
      releaseLock?.(),
    ]);
  }
}
