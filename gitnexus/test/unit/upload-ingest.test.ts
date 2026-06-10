import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  resolveContainedDest,
  ingestUpload,
  DEFAULT_INGEST_LIMITS,
} from '../../src/server/upload-ingest.js';
import { STAGING_PREFIX } from '../../src/server/upload-paths.js';

// ── resolveContainedDest (pure sanitizer — the load-bearing control) ──────────

describe('resolveContainedDest', () => {
  const ROOT = path.resolve('/tmp/gitnexus-sandbox');

  it('contains a legitimate nested path under the root', () => {
    expect(resolveContainedDest(ROOT, 'myrepo/src/index.js')).toBe(
      path.join(ROOT, 'myrepo', 'src', 'index.js'),
    );
  });

  it('allows spaces in names (regression: NUL check must not reject spaces)', () => {
    expect(resolveContainedDest(ROOT, 'my repo/a b.js')).toBe(path.join(ROOT, 'my repo', 'a b.js'));
  });

  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['mid traversal', 'a/../../b'],
    ['dot-dot segment', 'a/../b'],
    ['dot segment', 'a/./b'],
    ['absolute path', '/etc/shadow'],
    ['backslash', 'a\\b'],
    ['empty', ''],
  ])('rejects %s', (_label, rel) => {
    expect(() => resolveContainedDest(ROOT, rel)).toThrow();
  });

  it('rejects a NUL byte', () => {
    expect(() => resolveContainedDest(ROOT, `a${String.fromCharCode(0)}b/x.js`)).toThrow();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(() => resolveContainedDest(ROOT, ['a', 'b'])).toThrow();
  });

  it('rejects an over-deep path (>64 segments)', () => {
    const deep = Array.from({ length: 70 }, (_, i) => `d${i}`).join('/') + '/f.js';
    expect(() => resolveContainedDest(ROOT, deep)).toThrow();
  });

  it('rejects an over-long path (>4096 chars)', () => {
    const long = 'a/'.repeat(2100) + 'f.js';
    expect(() => resolveContainedDest(ROOT, long)).toThrow();
  });

  it('rejects a sibling-prefix escape (root + sep, not bare startsWith)', () => {
    // A rel that would resolve to a sibling dir sharing the root's string prefix.
    expect(() => resolveContainedDest(ROOT, '../gitnexus-sandbox-evil/x.js')).toThrow();
  });
});

// ── ingestUpload (multipart streaming + containment + caps + cleanup) ──────────

const BOUNDARY = '----gitnexustestboundary';

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

function mockReq(body: Buffer, headers: Record<string, string>): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { headers: typeof headers };
  r.headers = headers;
  return r;
}

describe('ingestUpload', () => {
  // Each test gets its own staging parent (via the IngestOptions root override)
  // so assertions never read the shared global ~/.gitnexus/uploads, which other
  // upload test files mutate concurrently under vitest's parallel forks.
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ingest-test-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('writes a manifest-described tree into the sandbox and returns its shape', async () => {
    const { body, headers } = multipart([
      { name: 'manifest', value: JSON.stringify(['myrepo/a.js', 'myrepo/sub/b.js']) },
      { name: 'files', filename: 'blob', data: Buffer.from('alpha') },
      { name: 'files', filename: 'blob', data: Buffer.from('beta') },
    ]);
    const result = await ingestUpload(mockReq(body, headers), undefined, { root });

    expect(result.stageRoot.startsWith(await fs.realpath(root))).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.topLevelName).toBe('myrepo');
    expect(result.totalBytes).toBe('alpha'.length + 'beta'.length);
    expect(await fs.readFile(path.join(result.stageRoot, 'myrepo', 'a.js'), 'utf8')).toBe('alpha');
    expect(await fs.readFile(path.join(result.stageRoot, 'myrepo', 'sub', 'b.js'), 'utf8')).toBe(
      'beta',
    );
  });

  it('rejects a traversal path in the manifest and removes the staging dir', async () => {
    const { body, headers } = multipart([
      { name: 'manifest', value: JSON.stringify(['../escape.js']) },
      { name: 'files', filename: 'blob', data: Buffer.from('x') },
    ]);
    await expect(ingestUpload(mockReq(body, headers), undefined, { root })).rejects.toMatchObject({
      status: 400,
    });
    // The staging dir created by this call must not survive the rejection —
    // the isolated root makes this exact (no concurrent test can add entries),
    // and a missing/broken root throws rather than passing vacuously.
    const entries = await fs.readdir(root);
    expect(entries.filter((e) => e.startsWith(STAGING_PREFIX))).toEqual([]);
  });

  it('rejects a file part that arrives before the manifest', async () => {
    const { body, headers } = multipart([
      { name: 'files', filename: 'blob', data: Buffer.from('x') },
      { name: 'manifest', value: JSON.stringify(['a/x.js']) },
    ]);
    await expect(ingestUpload(mockReq(body, headers), undefined, { root })).rejects.toThrow(
      /Manifest must precede/,
    );
  });

  it('rejects when total bytes exceed the cap (413)', async () => {
    const { body, headers } = multipart([
      { name: 'manifest', value: JSON.stringify(['r/big.bin']) },
      { name: 'files', filename: 'blob', data: Buffer.alloc(64, 1) },
    ]);
    await expect(
      ingestUpload(mockReq(body, headers), { maxTotalBytes: 16 }, { root }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('rejects an empty upload (0 files)', async () => {
    const { body, headers } = multipart([{ name: 'manifest', value: JSON.stringify([]) }]);
    await expect(ingestUpload(mockReq(body, headers), undefined, { root })).rejects.toThrow();
  });

  it('exposes sane default caps', () => {
    expect(DEFAULT_INGEST_LIMITS.maxTotalBytes).toBe(250 * 1024 * 1024);
    expect(DEFAULT_INGEST_LIMITS.maxFiles).toBe(20000);
  });
});
