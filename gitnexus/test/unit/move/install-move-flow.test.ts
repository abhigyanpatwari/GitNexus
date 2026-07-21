import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface DownloadResponse extends PassThrough {
  statusCode?: number;
  headers: { location?: string };
}

type DownloadGet = (url: string, onResponse: (response: DownloadResponse) => void) => EventEmitter;

type ChecksumVerification =
  | { status: 'match'; expected: string; actual: string }
  | { status: 'mismatch'; expected: string; actual: string }
  | { status: 'missing' };

interface InstallerHelpers {
  downloadToFile(url: string, dest: string, get?: DownloadGet): Promise<void>;
  expectedSha(sumsText: string, assetName: string): string | null;
  sha256(file: string): string;
  verifyArchiveChecksum(sumsText: string, assetName: string, archive: string): ChecksumVerification;
  powershellExpandArchiveInvocation(
    archive: string,
    dest: string,
  ): {
    args: string[];
    env: NodeJS.ProcessEnv;
  };
}

const require = createRequire(import.meta.url);
const {
  downloadToFile,
  expectedSha,
  sha256,
  verifyArchiveChecksum,
  powershellExpandArchiveInvocation,
} = require('../../../scripts/install-move-flow.cjs') as InstallerHelpers;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('install-move-flow', () => {
  const assetName = 'move-flow-v2.0.0-x86_64-unknown-linux-gnu.zip';

  function writeArchive(contents = 'verified move-flow archive'): string {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-checksum-'));
    tempRoots.push(root);
    const archive = path.join(root, assetName);
    writeFileSync(archive, contents);
    return archive;
  }

  it('accepts an exact asset entry whose checksum matches the downloaded archive', () => {
    const archive = writeArchive();
    const digest = sha256(archive);
    const sums = `${digest.toUpperCase()}  ${assetName}\n`;

    expect(expectedSha(sums, assetName)).toBe(digest);
    expect(verifyArchiveChecksum(sums, assetName, archive)).toEqual({
      status: 'match',
      expected: digest,
      actual: digest,
    });
    // Preserve the release parser's supported BSD checksum format too.
    expect(expectedSha(`SHA256 (${assetName}) = ${digest.toUpperCase()}`, assetName)).toBe(digest);
  });

  it('reports a checksum mismatch instead of authorizing the archive', () => {
    const archive = writeArchive('tampered archive');
    const expected = '0'.repeat(64);
    const actual = sha256(archive);

    expect(verifyArchiveChecksum(`${expected}  ${assetName}`, assetName, archive)).toEqual({
      status: 'mismatch',
      expected,
      actual,
    });
  });

  it('treats a suffix-collision entry as an omitted asset', () => {
    const archive = writeArchive();
    const digest = sha256(archive);
    const sums = `${digest}  prefixed-${assetName}`;

    expect(expectedSha(sums, assetName)).toBeNull();
    expect(expectedSha(`SHA256 (prefixed-${assetName}) = ${digest}`, assetName)).toBeNull();
    expect(verifyArchiveChecksum(sums, assetName, archive)).toEqual({ status: 'missing' });
  });

  it('rejects a mid-download response error and removes the partial file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-'));
    tempRoots.push(root);
    const dest = path.join(root, 'move-flow.zip');
    const get = vi.fn<DownloadGet>((_url, onResponse) => {
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = new PassThrough() as DownloadResponse;
        response.statusCode = 200;
        response.headers = {};
        onResponse(response);
        response.write('partial archive');
        response.destroy(new Error('connection reset during download'));
      });
      return request;
    });

    await expect(downloadToFile('https://example.test/move-flow.zip', dest, get)).rejects.toThrow(
      'connection reset during download',
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('passes PowerShell paths as environment data instead of command source', () => {
    const archive = `C:\\temp\\move flow's "archive".zip`;
    const dest = `C:\\temp\\destination's folder`;
    const invocation = powershellExpandArchiveInvocation(archive, dest);
    const command = invocation.args.join(' ');

    expect(command).toContain('$env:GITNEXUS_MOVE_FLOW_ARCHIVE_PATH');
    expect(command).toContain('$env:GITNEXUS_MOVE_FLOW_DESTINATION_PATH');
    expect(command).not.toContain(archive);
    expect(command).not.toContain(dest);
    expect(invocation.env.GITNEXUS_MOVE_FLOW_ARCHIVE_PATH).toBe(archive);
    expect(invocation.env.GITNEXUS_MOVE_FLOW_DESTINATION_PATH).toBe(dest);
  });
});
