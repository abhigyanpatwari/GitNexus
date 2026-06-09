import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createAnalyzeUploadHandler } from '../../src/server/analyze-upload.js';
import { requireLocalhostOrigin } from '../../src/server/middleware.js';

const BOUNDARY = '----gitnexusuploadtest';

function multipart(
  parts: Array<{ name: string; value?: string; filename?: string; data?: Buffer }>,
): { body: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`,
        ),
      );
      chunks.push(p.data ?? Buffer.alloc(0));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(p.value ?? ''));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

function mockReq(parts: Parameters<typeof multipart>[0]): IncomingMessage {
  const { body, headers } = multipart(parts);
  const r = Readable.from([body]) as unknown as IncomingMessage & { headers: typeof headers };
  r.headers = headers;
  return r;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function mockRes(): MockRes {
  const res = { statusCode: 0, body: undefined as unknown } as MockRes;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

// Track promoted upload dirs created by the real ingest+promote so we clean up.
const promoted: string[] = [];
afterEach(async () => {
  while (promoted.length) {
    await fs.rm(promoted.pop()!, { recursive: true, force: true }).catch(() => {});
  }
});

function uniqueTop(): string {
  return `uptest_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

describe('createAnalyzeUploadHandler', () => {
  it('ingests, promotes the inner folder, and launches analysis (202)', async () => {
    const top = uniqueTop();
    const createJob = vi.fn(() => ({ id: 'job-1', status: 'queued' }));
    const launch = vi.fn((_j, dir: string) => promoted.push(dir));
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify([`${top}/a.js`, `${top}/sub/b.js`]) },
        { name: 'files', filename: 'blob', data: Buffer.from('alpha') },
        { name: 'files', filename: 'blob', data: Buffer.from('beta') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(202);
    expect((res.body as { jobId: string }).jobId).toBe('job-1');
    expect(createJob).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
    const dir = launch.mock.calls[0][1] as string;
    const opts = launch.mock.calls[0][2] as { registryName: string };
    // Inner folder promoted: contents live directly under the upload dir.
    expect(await fs.readFile(path.join(dir, 'a.js'), 'utf8')).toBe('alpha');
    expect(await fs.readFile(path.join(dir, 'sub', 'b.js'), 'utf8')).toBe('beta');
    expect(opts.registryName).toBe(top);
    expect(createJob.mock.calls[0][0].repoPath).toBe(dir);
  });

  it('maps a busy job (createJob throws "already in progress") to 409 and promotes nothing', async () => {
    const top = uniqueTop();
    const createJob = vi.fn(() => {
      throw new Error('Analysis already in progress for another repository');
    });
    const launch = vi.fn((_j, dir: string) => promoted.push(dir));
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify([`${top}/a.js`]) },
        { name: 'files', filename: 'blob', data: Buffer.from('x') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(launch).not.toHaveBeenCalled();
    // Nothing promoted onto disk.
    const { UPLOAD_ROOT } = await import('../../src/server/upload-paths.js');
    await expect(fs.access(path.join(UPLOAD_ROOT, top))).rejects.toBeTruthy();
  });

  it('rejects a traversal path in the manifest (400) without launching', async () => {
    const createJob = vi.fn(() => ({ id: 'j', status: 'queued' }));
    const launch = vi.fn();
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify(['../escape.js']) },
        { name: 'files', filename: 'blob', data: Buffer.from('x') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(createJob).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an un-nameable top folder (Windows-reserved → 400)', async () => {
    const createJob = vi.fn(() => ({ id: 'j', status: 'queued' }));
    const launch = vi.fn();
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify(['CON/a.js']) },
        { name: 'files', filename: 'blob', data: Buffer.from('x') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it('strips a crafted .gitnexus index from the promoted upload', async () => {
    const top = uniqueTop();
    const createJob = vi.fn(() => ({ id: 'job-x', status: 'queued' }));
    const launch = vi.fn((_j, dir: string) => promoted.push(dir));
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify([`${top}/.gitnexus/meta.json`, `${top}/a.js`]) },
        { name: 'files', filename: 'blob', data: Buffer.from('{"evil":true}') },
        { name: 'files', filename: 'blob', data: Buffer.from('real') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(202);
    const dir = launch.mock.calls[0][1] as string;
    await expect(fs.access(path.join(dir, '.gitnexus'))).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(dir, 'a.js'), 'utf8')).toBe('real');
  });

  it('rejects a single-segment manifest before creating a job (no slot taken)', async () => {
    const createJob = vi.fn(() => ({ id: 'j', status: 'queued' }));
    const launch = vi.fn();
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify(['loosefile.js']) },
        { name: 'files', filename: 'blob', data: Buffer.from('x') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(createJob).not.toHaveBeenCalled(); // slot never taken → no wedge
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a multi-top-folder manifest (would silently drop folders)', async () => {
    const createJob = vi.fn(() => ({ id: 'j', status: 'queued' }));
    const launch = vi.fn();
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify(['aaa/x.js', 'bbb/y.js']) },
        { name: 'files', filename: 'blob', data: Buffer.from('1') },
        { name: 'files', filename: 'blob', data: Buffer.from('2') },
      ]) as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('releases the single slot (failJob) when a step fails after createJob', async () => {
    const top = uniqueTop();
    const createJob = vi.fn(() => ({ id: 'job-fail', status: 'queued' }));
    // launch throws AFTER createJob + promote — the slot must be released.
    const launch = vi.fn((_j, dir: string) => {
      promoted.push(dir);
      throw new Error('worker fork blew up');
    });
    const failJob = vi.fn();
    const handler = createAnalyzeUploadHandler({ createJob, launch, failJob });

    const res = mockRes();
    await handler(
      mockReq([
        { name: 'manifest', value: JSON.stringify([`${top}/a.js`]) },
        { name: 'files', filename: 'blob', data: Buffer.from('x') },
      ]) as never,
      res as never,
    );

    expect(createJob).toHaveBeenCalledOnce();
    expect(failJob).toHaveBeenCalledWith('job-fail', expect.any(String));
    expect(res.statusCode).toBe(500);
  });
});

describe('requireLocalhostOrigin', () => {
  function call(origin: string | undefined): { passed: boolean; status: number } {
    let passed = false;
    let status = 0;
    const req = { headers: origin === undefined ? {} : { origin } } as never;
    const res = {
      status: (c: number) => {
        status = c;
        return { json: () => {} };
      },
    } as never;
    requireLocalhostOrigin(req, res, () => {
      passed = true;
    });
    return { passed, status };
  }

  it('passes localhost / 127.0.0.1 / no-origin', () => {
    expect(call('http://localhost:5173').passed).toBe(true);
    expect(call('http://127.0.0.1:4747').passed).toBe(true);
    expect(call(undefined).passed).toBe(true);
  });

  it('rejects a public/cross origin with 403', () => {
    const r = call('https://gitnexus.vercel.app');
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });
});
