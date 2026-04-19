import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');
const sharedRoot = path.join(workspaceRoot, 'gitnexus-shared');
const gitnexusRoot = path.join(workspaceRoot, 'gitnexus');
const gitnexusServerEntry = path.join(gitnexusRoot, 'dist', 'server', 'api.js');

const runNpm = (args, cwd) => {
  const result = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (!existsSync(path.join(sharedRoot, 'node_modules', 'typescript'))) {
  runNpm(['ci'], sharedRoot);
}

if (!existsSync(path.join(gitnexusRoot, 'node_modules', 'tsx'))) {
  runNpm(['ci'], gitnexusRoot);
}

if (!existsSync(gitnexusServerEntry)) {
  runNpm(['run', 'build'], gitnexusRoot);
}
