import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

it('exits the standalone model process when its owner disconnects', async () => {
  const entry = new URL('../../dist/core/embeddings/embedding-sidecar.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry)}); process.send('ready');`],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const ready = new Promise((resolve) => child.once('message', resolve));
  try {
    expect(await Promise.race([ready, exit])).toBe('ready');
    child.disconnect();
    expect(await exit, stderr).toBe(1);
  } finally {
    if (child.connected) child.disconnect();
    await exit;
  }
});
