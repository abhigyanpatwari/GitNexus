import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(packageRoot, 'release');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(releaseRoot, stamp);

const builderArgs = process.argv.slice(2);
const builderCommand = [
  'npx electron-builder',
  '--config electron-builder.yml',
  `--config.directories.output=release/${stamp}`,
  '--publish never',
  ...builderArgs,
].join(' ');

fs.mkdirSync(outputDir, { recursive: true });

execSync('npm run bundle', {
  cwd: packageRoot,
  stdio: 'inherit',
});

execSync(builderCommand, {
  cwd: packageRoot,
  stdio: 'inherit',
});

console.log(`[build] artifacts written to release/${stamp}`);