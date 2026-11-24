import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const DIST_WORKER = fileURLToPath(
  new URL('../../../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
);
it('includes the source path in embedded-NUL warnings', { timeout: 20_000 }, async () => {
  const filePath = 'src/NullByteDemo.java';
  const source = 'public interface Demo { /** embedded \0 */ void after(); }';
  // The worker logger writes directly to fd 2, so capture it at a child-process boundary.
  const runner = `
      const { Worker } = require('node:worker_threads');
      const { pathToFileURL } = require('node:url');
      const worker = new Worker(pathToFileURL(${JSON.stringify(DIST_WORKER)}));
      let dispatched = false;
      worker.on('message', (message) => {
        if (message && message.type === 'ready' && !dispatched) {
          dispatched = true;
          worker.postMessage({
            type: 'sub-batch',
            files: [{ path: ${JSON.stringify(filePath)}, content: ${JSON.stringify(source)} }],
          });
        } else if (message && message.type === 'sub-batch-done') {
          process.stdout.write('SUB_BATCH_DONE\\n');
        }
      });
      worker.on('error', (error) => {
        process.stderr.write(String(error && error.stack ? error.stack : error));
        process.exit(1);
      });
    `;
  const child = spawn(process.execPath, ['--eval', runner], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`timed out waiting for parse worker; stdout=${stdout}; stderr=${stderr}`));
      }, 15_000);
      let complete = false;
      const finishIfComplete = (): void => {
        if (
          !complete &&
          stdout.includes('SUB_BATCH_DONE') &&
          stderr.includes('replaced embedded NUL bytes before tree-sitter parsing')
        ) {
          complete = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        finishIfComplete();
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        finishIfComplete();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (!complete) {
          clearTimeout(timeout);
          reject(new Error(`parse worker exited early: code=${code}, signal=${signal}`));
        }
      });
    });
    const warningLine = stderr
      .split('\n')
      .find((line) => line.includes('replaced embedded NUL bytes before tree-sitter parsing'));
    if (!warningLine) throw new Error(`missing embedded-NUL warning in stderr: ${stderr}`);
    assert.partialDeepStrictEqual(JSON.parse(warningLine), {
      level: 40,
      file: filePath,
      nullByteCount: 1,
      msg: 'replaced embedded NUL bytes before tree-sitter parsing',
    });
  } finally {
    child.kill();
  }
});
