import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * afterPack hook — runs after electron-builder assembles the app directory,
 * before any installer (NSIS, DMG, AppImage) is sealed.
 *
 * On Windows, lbugjs.node PE-imports "node.exe" by name. Electron's binary
 * is not named node.exe, so LoadLibrary fails. We copy the real node.exe into
 * resources/runtime/node.exe so main.ts can use it as the subprocess host.
 * This fires for both --dir and --win builds, fixing the smoke test and installer.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const runtimeDir = path.join(context.appOutDir, 'resources', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));

  console.log(`[after-pack] Copied node.exe → ${path.join(runtimeDir, 'node.exe')}`);
}
