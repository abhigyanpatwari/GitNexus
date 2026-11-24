import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { javaPlatformTypeInventory } from '../../../dist/core/ingestion/languages/java/platform-packages.js';

test('wildcard import lookup covers the public top-level types exported by JDK 21', () => {
  assert.ok(
    process.env.JAVA_HOME && path.isAbsolute(process.env.JAVA_HOME),
    'Set JAVA_HOME to an absolute JDK 21 path',
  );
  const java = path.join(
    process.env.JAVA_HOME,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java',
  );
  const source = fileURLToPath(new URL('./PlatformTypes.java', import.meta.url));
  const generated = execFileSync(java, [source], { encoding: 'utf8' });
  assert.deepEqual(javaPlatformTypeInventory.split('\n'), generated.trimEnd().split(/\r?\n/));
});
