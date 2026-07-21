import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet, type RequestOptions } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type HttpsGet = (
  url: string | URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ENETDOWN',
  'ENETUNREACH',
]);

class RetryableDownloadError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

const parseRetryAfter = (value: string | string[] | undefined): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const safeRequestLabel = (target: string): string => {
  const parsed = new URL(target);
  return `${parsed.origin}${parsed.pathname}`;
};

const isRetryableError = (error: unknown): error is Error =>
  error instanceof RetryableDownloadError ||
  (error instanceof Error && RETRYABLE_CODES.has((error as NodeJS.ErrnoException).code ?? ''));

const downloadAttempt = async (
  initialUrl: string,
  partial: string,
  deadline: number,
  get: HttpsGet,
  maxBytes: number,
): Promise<void> => {
  if (new URL(initialUrl).protocol !== 'https:') {
    throw new Error('move-flow downloads require HTTPS');
  }
  let target = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('download timed out');

    const result = await new Promise<{ redirect?: string }>((resolve, reject) => {
      let activeResponse: IncomingMessage | null = null;
      let pipelineStarted = false;
      const req = get(target, {}, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          let redirect: URL;
          try {
            redirect = new URL(response.headers.location, target);
          } catch {
            response.destroy();
            reject(new Error(`invalid redirect from ${safeRequestLabel(target)}`));
            return;
          }
          response.destroy();
          if (redirect.protocol !== 'https:') {
            reject(new Error(`refusing non-HTTPS redirect to ${redirect.protocol}`));
            return;
          }
          resolve({ redirect: redirect.toString() });
          return;
        }

        if (status !== 200) {
          response.destroy();
          const message = `HTTP ${status} for ${safeRequestLabel(target)}`;
          if (status === 408 || status === 429 || status >= 500) {
            reject(
              new RetryableDownloadError(message, parseRetryAfter(response.headers['retry-after'])),
            );
          } else {
            reject(new Error(message));
          }
          return;
        }

        const rawLength = response.headers['content-length'];
        const contentLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy();
          reject(new Error(`download exceeds ${maxBytes} bytes`));
          return;
        }

        let received = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            callback(
              received > maxBytes ? new Error(`download exceeds ${maxBytes} bytes`) : null,
              chunk,
            );
          },
        });
        activeResponse = response;
        pipelineStarted = true;
        void pipeline(response, limit, createWriteStream(partial)).then(() => resolve({}), reject);
      });
      const timeout = setTimeout(
        () => req.destroy(Object.assign(new Error('download timed out'), { code: 'ETIMEDOUT' })),
        Math.max(1, remaining),
      );
      req.once('close', () => clearTimeout(timeout));
      req.once('error', (error) => {
        if (pipelineStarted) {
          // Once the body pipeline owns the response, it must be the only
          // operation that settles this attempt. Otherwise cleanup/retry can
          // reuse the partial path while the old response is still writing.
          activeResponse?.destroy(error);
          return;
        }
        reject(error);
      });
    });

    if (!result.redirect) return;
    target = result.redirect;
  }

  throw new Error('too many redirects');
};

export const downloadToFile = async (
  url: string,
  destination: string,
  timeoutMs: number,
  get: HttpsGet = httpsGet,
  maxBytes = MAX_ARCHIVE_BYTES,
): Promise<void> => {
  const partial = `${destination}.partial`;
  const deadline = Date.now() + timeoutMs;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await rm(partial, { force: true });
      try {
        await downloadAttempt(url, partial, deadline, get, maxBytes);
        await rename(partial, destination);
        return;
      } catch (error) {
        await rm(partial, { force: true });
        if (!isRetryableError(error) || attempt === MAX_ATTEMPTS) throw error;
        const retryAfter =
          error instanceof RetryableDownloadError ? error.retryAfterMs : attempt * 100;
        const remaining = deadline - Date.now();
        if (remaining <= 1) throw error;
        await wait(Math.min(Math.max(0, retryAfter), remaining - 1));
      }
    }
  } finally {
    await rm(partial, { force: true });
  }
};

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
