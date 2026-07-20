#!/usr/bin/env node
/**
 * Optional native dependency probe: download a pinned `move-flow` release
 * into `gitnexus/vendor/move-flow/<platform>/`.
 *
 * Same shape as `build-tree-sitter-grammars.cjs`: an opt-out env var, a soft-fail
 * contract that always exits 0 (the gitnexus install must succeed even when
 * the binary can't be provisioned), idempotency (skip when the on-disk
 * version already matches), and an offline platform detect that warns and
 * exits cleanly on unsupported targets.
 *
 * The runtime side (`tryCreateMoveFlowClient`) resolves the binary in this
 * order: $MOVE_FLOW → bundled `vendor/move-flow/<platform>/move-flow[.exe]`
 * → $PATH. When this probe fails, the Move ingest phase no-ops for non-Move
 * repos and the analyze CLI emits a one-line stderr notice for Move repos.
 *
 * Supported env:
 *   GITNEXUS_SKIP_MOVE_FLOW=1        skip this probe
 *   GITNEXUS_MOVE_FLOW_VERSION=x.y.z override the pinned version
 *   GITNEXUS_MOVE_FLOW_REPO=owner/repo override the release repository
 *   GITNEXUS_MOVE_FLOW_TAG=tag       override the release tag
 *   GITNEXUS_MOVE_FLOW_COMPAT=1      force Linux compat artifact
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { pipeline } = require('node:stream');

/** Pinned move-flow release from https://github.com/aptos-labs/aptos-ai. */
const MOVE_FLOW_VERSION = process.env.GITNEXUS_MOVE_FLOW_VERSION || '2.0.0';
const RELEASE_REPO = process.env.GITNEXUS_MOVE_FLOW_REPO || 'aptos-labs/aptos-ai';
const RELEASE_TAG = process.env.GITNEXUS_MOVE_FLOW_TAG || `move-flow-v${MOVE_FLOW_VERSION}`;
const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}`;
const BIN_NAME = process.platform === 'win32' ? 'move-flow.exe' : 'move-flow';

const SKIP_FLAGS = ['GITNEXUS_SKIP_MOVE_FLOW', 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS'];

const vendorRoot = path.join(__dirname, '..', 'vendor', 'move-flow');

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

function targetBinaryPath(key) {
  const dir = path.join(vendorRoot, key);
  return { dir, file: path.join(dir, BIN_NAME) };
}

function versionMatches(file) {
  try {
    const out = execFileSync(file, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes(MOVE_FLOW_VERSION);
  } catch {
    return false;
  }
}

function linuxNeedsCompatBuild() {
  if (process.platform !== 'linux') return false;
  if (process.env.GITNEXUS_MOVE_FLOW_COMPAT === '1') return true;
  if (process.arch === 'x64') {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      if (!/(^|\s)avx2(\s|$)/m.test(cpuinfo)) return true;
    } catch {
      return true;
    }
  }
  try {
    const out = execFileSync('ldd', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+)\.(\d+)/.exec(out.split('\n')[0] ?? '');
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major < 2 || (major === 2 && minor < 34);
  } catch {
    return false;
  }
}

function releaseTargetForPlatform(key) {
  switch (key) {
    case 'darwin-arm64':
      return 'aarch64-apple-darwin';
    case 'darwin-x64':
      return 'x86_64-apple-darwin';
    case 'linux-arm64':
      return `aarch64-unknown-linux-gnu${linuxNeedsCompatBuild() ? '-compat' : ''}`;
    case 'linux-x64':
      return `x86_64-unknown-linux-gnu${linuxNeedsCompatBuild() ? '-compat' : ''}`;
    case 'win32-x64':
      return 'x86_64-pc-windows-msvc';
    default:
      return null;
  }
}

function downloadToFile(url, dest, get = https.get) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.partial`;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the caller's temp-directory cleanup gets a second chance */
      }
      reject(err);
    };

    const followRedirect = (target, hops) => {
      if (hops > 5) {
        fail(new Error('too many redirects'));
        return;
      }
      const req = get(target, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.on('error', fail);
          res.resume();
          followRedirect(new URL(res.headers.location, target).toString(), hops + 1);
          return;
        }
        if (status !== 200) {
          res.on('error', fail);
          res.resume();
          fail(new Error(`HTTP ${status} for ${target}`));
          return;
        }

        // pipeline owns both streams and reports source (mid-download) and
        // destination errors through one callback instead of allowing an
        // unhandled stream 'error' event to escape the postinstall soft-fail.
        pipeline(res, fs.createWriteStream(tmp), (err) => {
          if (settled) return;
          if (err) {
            fail(err);
            return;
          }
          try {
            fs.renameSync(tmp, dest);
            settled = true;
            resolve();
          } catch (renameErr) {
            fail(renameErr);
          }
        });
      });
      req.on('error', fail);
    };
    followRedirect(url, 0);
  });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function powershellExpandArchiveInvocation(archive, dest) {
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
      [destinationEnv]: dest,
    },
  };
}

function extractZip(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    if (process.platform === 'win32') {
      const ps = process.env.ComSpec ? 'powershell.exe' : 'powershell';
      const invocation = powershellExpandArchiveInvocation(archive, dest);
      execFileSync(ps, invocation.args, {
        stdio: 'ignore',
        timeout: 30000,
        env: invocation.env,
      });
      return;
    }
    execFileSync('unzip', ['-q', archive, '-d', dest], { stdio: 'ignore', timeout: 30000 });
  } catch (err) {
    throw new Error(
      `could not extract ${path.basename(archive)} (${err instanceof Error ? err.message : err}). ` +
        'Install unzip, or set MOVE_FLOW to an existing move-flow binary.',
    );
  }
}

function findExtractedBinary(root) {
  const stack = [root];
  const names = new Set([BIN_NAME, 'move-flow']);
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (names.has(entry.name)) {
        return full;
      }
    }
  }
  return null;
}

function expectedSha(sumsText, assetName) {
  for (const raw of sumsText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Format: "<sha256>  <filename>" (BSD-style "SHA256 (file) = <hex>" also tolerated).
    const m = /^([0-9a-f]{64})[ \t*]+(\S.*)$/i.exec(line);
    if (m && m[2].endsWith(assetName)) return m[1].toLowerCase();
    const bsd = /^SHA256\s*\((.*)\)\s*=\s*([0-9a-f]{64})$/i.exec(line);
    if (bsd && bsd[1].endsWith(assetName)) return bsd[2].toLowerCase();
  }
  return null;
}

async function main() {
  for (const flag of SKIP_FLAGS) {
    if (process.env[flag] === '1') {
      console.warn(`[move-flow] Skipping install (${flag}=1).`);
      process.exit(0);
    }
  }

  const key = platformKey();
  if (!key) {
    console.warn(
      `[move-flow] Unsupported platform ${process.platform}-${process.arch} — skipping. ` +
        'Set $MOVE_FLOW to provide a binary, or set GITNEXUS_SKIP_MOVE_FLOW=1 to silence this notice.',
    );
    process.exit(0);
  }

  const releaseTarget = releaseTargetForPlatform(key);

  const { dir, file } = targetBinaryPath(key);

  if (fs.existsSync(file) && versionMatches(file)) {
    // Idempotent: already provisioned at the right version.
    process.exit(0);
  }

  const assetName = `${RELEASE_TAG}-${releaseTarget}.zip`;
  const sumsName = 'SHA256SUMS';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-flow-'));
  const tmpArchive = path.join(tmpDir, assetName);
  const extractDir = path.join(tmpDir, 'extract');
  const tmpSums = path.join(tmpDir, sumsName);

  try {
    await downloadToFile(`${RELEASE_BASE}/${sumsName}`, tmpSums);
    await downloadToFile(`${RELEASE_BASE}/${assetName}`, tmpArchive);

    const sums = fs.readFileSync(tmpSums, 'utf8');
    const expected = expectedSha(sums, assetName);
    if (!expected) {
      console.warn(
        `[move-flow] ${sumsName} does not list ${assetName} — refusing to install. ` +
          'Move ingestion will be unavailable. Non-Move functionality is unaffected.',
      );
      process.exit(0);
    }

    const actual = sha256(tmpArchive);
    if (actual !== expected) {
      console.warn(
        `[move-flow] Checksum mismatch for ${assetName} (expected ${expected}, got ${actual}) — refusing to install. ` +
          'Move ingestion will be unavailable. Non-Move functionality is unaffected.',
      );
      process.exit(0);
    }

    extractZip(tmpArchive, extractDir);
    const extracted = findExtractedBinary(extractDir);
    if (!extracted) {
      console.warn(
        `[move-flow] ${assetName} did not contain ${BIN_NAME} — refusing to install. ` +
          'Move ingestion will be unavailable. Non-Move functionality is unaffected.',
      );
      process.exit(0);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(extracted, file);
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* no-op on Windows */
    }
    if (!versionMatches(file)) {
      fs.rmSync(file, { force: true });
      console.warn(
        `[move-flow] Installed binary did not report version ${MOVE_FLOW_VERSION} — refusing to keep it. ` +
          'Move ingestion will be unavailable. Non-Move functionality is unaffected.',
      );
    }
  } catch (err) {
    console.warn(`[move-flow] Download failed: ${err instanceof Error ? err.message : err}`);
    console.warn(
      '[move-flow] Move ingestion will be unavailable. Set $MOVE_FLOW to a local binary, ' +
        'or set GITNEXUS_SKIP_MOVE_FLOW=1 to silence this notice. Non-Move functionality is unaffected.',
    );
    process.exit(0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { downloadToFile, powershellExpandArchiveInvocation };

if (require.main === module) {
  main().catch((err) => {
    // Never hard-fail the gitnexus install.
    console.warn(`[move-flow] Unexpected error during install probe: ${err?.message ?? err}`);
    process.exit(0);
  });
}
