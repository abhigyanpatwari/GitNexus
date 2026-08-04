/**
 * Shared harness for the suites that drive the REAL `mountSSEProgress` relay
 * over a REAL HTTP server (server-sse-payload.test.ts and analyze-api.test.ts).
 *
 * Both files had grown their own listen/port/close dance plus their own SSE
 * frame parser, and the parsers had already diverged in what they do with a
 * missing frame. The bug these suites exist to catch is only observable END TO
 * END, so the harness stays real — one Express app, one ephemeral port, one
 * JobManager — and only the boilerplate is shared (the embedding-seed.ts
 * precedent: a helper module has no describe-registration problem, unlike
 * importing a sibling test file).
 */
import express from 'express';
import http from 'node:http';
import { JobManager } from '../../src/server/analyze-job.js';
import { mountSSEProgress } from '../../src/server/sse-progress.js';

export interface SSEHarness {
  /** The JobManager the mounted relay reads. Drive the test through this. */
  readonly manager: JobManager;
  /** `http://127.0.0.1:<ephemeral port>` — prefix for the mounted route. */
  readonly baseUrl: string;
  /** Disposes the JobManager and closes the server. Call from `afterEach`. */
  close(): Promise<void>;
}

/**
 * Mount the relay at `routePath` on a fresh Express app bound to an ephemeral
 * localhost port. `routePath` mirrors whichever production mount in
 * `createServer()` the suite is standing in for.
 */
export const startSSEHarness = async (routePath: string): Promise<SSEHarness> => {
  const manager = new JobManager();
  const app = express();
  mountSSEProgress(app, routePath, manager);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    manager,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      manager.dispose();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

/**
 * The parsed JSON payload of the named terminal SSE frame, or `undefined` when
 * the stream carried no such frame — "the client was never told" is an outcome
 * these suites assert on, so an absent frame must not throw.
 */
export const terminalFrame = (body: string, event: 'complete' | 'failed'): unknown => {
  const frame = body.split('\n\n').find((f) => f.includes(`event: ${event}`));
  const dataLine = frame?.split('\n').find((line) => line.startsWith('data: '));
  return dataLine === undefined ? undefined : JSON.parse(dataLine.slice('data: '.length));
};

/** How many terminal frames of any kind the client received. */
export const terminalFrameCount = (body: string): number =>
  body.split('\n\n').filter((f) => /^event: (complete|failed)$/m.test(f)).length;
