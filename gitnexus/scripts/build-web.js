import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function shouldBuildWeb(argv = process.argv, env = process.env) {
  return argv.includes('--web') || env.GITNEXUS_BUILD_WEB === '1';
}

export function shouldPreserveWebOutput(env = process.env) {
  return (
    env.npm_lifecycle_event === 'prepare' &&
    (env.npm_command === 'pack' || env.npm_command === 'publish')
  );
}

/**
 * Build and copy the web UI when explicitly requested.
 *
 * The injected fs/exec implementations make lifecycle behavior executable in
 * unit tests without compiling either package.
 */
export function runWebBuild({
  root,
  dist,
  timeoutMs,
  argv = process.argv,
  env = process.env,
  fsImpl = fs,
  exec = execSync,
}) {
  const webRoot = path.resolve(root, '..', 'gitnexus-web');
  const webDest = path.join(dist, '..', 'web');

  if (!shouldBuildWeb(argv, env)) {
    if (shouldPreserveWebOutput(env)) {
      console.log('[build] preserving prepack web UI during npm prepare');
    } else {
      fsImpl.rmSync(webDest, { recursive: true, force: true });
      console.log(
        '[build] skipping web UI and removed stale output ' +
          '(pass --web or set GITNEXUS_BUILD_WEB=1 to include it)',
      );
    }
    return { status: 'skipped', webDest };
  }

  if (!fsImpl.existsSync(path.join(webRoot, 'package.json'))) {
    throw new Error(
      `[build] web UI requested, but gitnexus-web was not found at ${webRoot}. ` +
        'Run this command from the complete monorepo checkout.',
    );
  }

  console.log('[build] building gitnexus-web…');
  if (!fsImpl.existsSync(path.join(webRoot, 'node_modules'))) {
    // Deliberately untimed: this is a full second install, and killing it
    // partway through leaves a broken tree and a misleading ETIMEDOUT.
    // CI should install gitnexus-web itself (cached, its own step) so this
    // fallback only fires for a local `npm pack` / `npm publish`.
    console.log('[build] installing gitnexus-web dependencies (no local node_modules)…');
    exec('npm ci', { cwd: webRoot, stdio: 'inherit' });
  }
  exec('npm run build', { cwd: webRoot, stdio: 'inherit', timeout: timeoutMs });

  const builtIndex = path.join(webRoot, 'dist', 'index.html');
  if (!fsImpl.existsSync(builtIndex)) {
    throw new Error(`[build] gitnexus-web build completed without ${builtIndex}`);
  }

  fsImpl.rmSync(webDest, { recursive: true, force: true });
  fsImpl.cpSync(path.join(webRoot, 'dist'), webDest, { recursive: true });
  console.log('[build] copied web UI → gitnexus/web/');
  return { status: 'built', webDest };
}
