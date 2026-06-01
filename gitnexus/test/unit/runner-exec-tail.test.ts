import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercises the `require.main === module` direct-exec entrypoint of the runner
// (#1945) end-to-end: the pure `buildRunnerArgv` is covered in
// resolve-invocation.test.ts, but the spawn + exit-code propagation + missing-
// runner diagnostic only live in the exec tail. We spawn a real child `node`
// against the canonical run.cjs with GITNEXUS_INVOCATION forcing a mode (so no
// live PATH probe) and a fake `gitnexus` on PATH.
//
// POSIX-only: the fake runner is a shebang shell script. The Windows-specific
// branch (shell:true so cmd.exe resolves `.cmd`/`.ps1` shims) is exercised by
// CI's windows-latest job, not here.
const CANONICAL_CJS = path.resolve(
  __dirname,
  '..',
  '..',
  'hooks',
  'claude',
  'resolve-analyze-cmd.cjs',
);
const onPosix = process.platform !== 'win32';

describe('run.cjs direct-exec entrypoint (#1945)', () => {
  it.skipIf(!onPosix)(
    'execs the resolved runner, passes args through, and propagates its exit code',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'gn-runner-'));
      const fake = path.join(dir, 'gitnexus');
      // Fake global `gitnexus` that echoes its argv and exits 42.
      writeFileSync(fake, '#!/bin/sh\necho "fake-gitnexus $@"\nexit 42\n');
      chmodSync(fake, 0o755);

      const res = spawnSync(process.execPath, [CANONICAL_CJS, 'analyze', '--foo'], {
        env: {
          ...process.env,
          GITNEXUS_INVOCATION: 'gitnexus',
          PATH: `${dir}:${process.env.PATH}`,
        },
        encoding: 'utf-8',
      });

      expect(res.status).toBe(42); // exit code propagated, not swallowed
      expect(res.stdout).toContain('fake-gitnexus analyze --foo'); // args passthrough + inherited stdio
    },
  );

  it.skipIf(!onPosix)(
    'prints a diagnostic and exits 1 when the resolved runner is absent from PATH',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'gn-runner-empty-'));
      const res = spawnSync(process.execPath, [CANONICAL_CJS, 'analyze'], {
        // Force gitnexus mode but give an empty PATH so the spawn ENOENTs.
        env: { ...process.env, GITNEXUS_INVOCATION: 'gitnexus', PATH: dir },
        encoding: 'utf-8',
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('could not launch');
    },
  );
});
