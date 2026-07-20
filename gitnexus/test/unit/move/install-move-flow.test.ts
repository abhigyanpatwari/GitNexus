import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface DownloadResponse extends PassThrough {
  statusCode?: number;
  headers: { location?: string };
}

type DownloadGet = (url: string, onResponse: (response: DownloadResponse) => void) => EventEmitter;

interface InstallerHelpers {
  downloadToFile(url: string, dest: string, get?: DownloadGet): Promise<void>;
  powershellExpandArchiveInvocation(
    archive: string,
    dest: string,
  ): {
    args: string[];
    env: NodeJS.ProcessEnv;
  };
}

const require = createRequire(import.meta.url);
const { downloadToFile, powershellExpandArchiveInvocation } =
  require('../../../scripts/install-move-flow.cjs') as InstallerHelpers;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('install-move-flow', () => {
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
