import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionBuildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: ['node18'],
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

const webviewBuildOptions = {
  entryPoints: ['src/webview/graph-app.ts'],
  bundle: true,
  outfile: 'dist/webview/graph.js',
  platform: 'browser',
  target: ['es2022'],
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const extensionContext = await esbuild.context(extensionBuildOptions);
  const webviewContext = await esbuild.context(webviewBuildOptions);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  console.log('watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionBuildOptions),
    esbuild.build(webviewBuildOptions),
  ]);
}
