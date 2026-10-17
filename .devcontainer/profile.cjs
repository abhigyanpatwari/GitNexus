'use strict';
const fs = require('node:fs');
const path = require('node:path');

function replaceOnce(text, pattern, replacement) {
  const matches = text.match(new RegExp(pattern.source, 'g'));
  if (matches?.length !== 1) throw new Error(`Canonical devcontainer layout changed: ${pattern}`);
  return text.replace(pattern, () => replacement);
}

function profile(
  source,
  { native = false, ui = false, image, imageOnly = false, ref = 'main', playwright } = {},
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) throw new Error('Invalid clone branch');
  if (image && !/^[a-z0-9][a-z0-9./:_@-]+$/.test(image)) throw new Error('Invalid image reference');
  let result = source;
  if (image) {
    const start = result.indexOf('  "build": {');
    const end = result.indexOf('\n  // Runs on the HOST', start);
    if (start < 0 || end < 0) throw new Error('Canonical build block changed');
    result = result.slice(0, start) + `  "image": ${JSON.stringify(image)},\n` + result.slice(end);
    // The published devcontainer image already contains this feature.
    result = replaceOnce(result, /"features": \{[\s\S]*?\n  \},/, '"features": {},');
  } else {
    result = replaceOnce(result, /"dockerfile": "Dockerfile"/, '"dockerfile": "../Dockerfile"');
    result = replaceOnce(result, /"context": "\."/, '"context": ".."');
    if (ui) {
      if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(playwright))
        throw new Error('Locked Playwright version required');
      result = replaceOnce(
        result,
        /"BUN_VERSION":/,
        `"INSTALL_BROWSER_DEPS": "true",\n      "PLAYWRIGHT_VERSION": ${JSON.stringify(playwright)},\n      "BUN_VERSION":`,
      );
    }
  }
  if (native) {
    result = replaceOnce(
      result,
      /"workspaceMount": "[^"\n]+"/,
      '"workspaceMount": "source=gitnexus-workspace-${devcontainerId},target=/workspace,type=volume"',
    );
    result = replaceOnce(
      result,
      /"CODEX_HOME":/,
      '"GITNEXUS_CLONE_URL": "https://github.com/abhigyanpatwari/GitNexus.git",\n    ' +
        `"GITNEXUS_CLONE_REF": ${JSON.stringify(ref)},\n    "CODEX_HOME":`,
    );
    result = replaceOnce(
      result,
      /"updateContentCommand":/,
      '"onCreateCommand": "node /usr/local/share/gitnexus-devcontainer/bootstrap-native.cjs",\n  "updateContentCommand":',
    );
  }
  if (imageOnly) {
    const start = result.indexOf('  "build": {');
    const end = result.indexOf('\n  // Runs on the HOST', start);
    const features = result.match(/"features": \{[\s\S]*?\n  \},/);
    if (start < 0 || end < 0 || !features)
      throw new Error('Image build requires the canonical build and feature blocks');
    // Publish toolchain metadata only. Lifecycle hooks and host mounts belong
    // to the consuming profile, avoiding duplicate hook execution on attach.
    return '{\n' + result.slice(start, end) + '\n  ' + features[0].slice(0, -1) + '\n}\n';
  }
  if (ui) {
    result = replaceOnce(
      result,
      /"CODEX_HOME":/,
      '"GITNEXUS_DEV_UI": "1",\n    "PLAYWRIGHT_BROWSERS_PATH": "/home/node/.cache/ms-playwright",\n    "CODEX_HOME":',
    );
    result = replaceOnce(
      result,
      /"source=npm-cache-/,
      '"source=playwright-cache-${devcontainerId},target=/home/node/.cache/ms-playwright,type=volume",\n    "source=npm-cache-',
    );
    result = replaceOnce(
      result,
      /"capAdd": \["SYS_ADMIN"\],/,
      '"capAdd": ["SYS_ADMIN"],\n  "runArgs": ["--shm-size=1g"],',
    );
  }
  return result;
}

module.exports = { profile };
if (require.main === module) {
  const args = process.argv.slice(2);
  const known = new Set(['native', 'ui', 'prebuilt', 'image-build', '--ui', '--image', '--ref']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown profile argument: ${args[i]}`);
    if (['--image', '--ref'].includes(args[i])) i++;
  }
  if (!['native', 'ui', 'prebuilt', 'image-build'].includes(args[0]))
    throw new Error(
      'Usage: node .devcontainer/profile.cjs native|ui|prebuilt|image-build [--ui] [--image IMAGE] [--ref BRANCH]',
    );
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (args.includes('--image') && !value('--image')) throw new Error('--image requires a value');
  if (args.includes('--ref') && !value('--ref')) throw new Error('--ref requires a value');
  const lock = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../gitnexus-web/package-lock.json')),
  );
  const output = path.join(__dirname, 'generated');
  const contents = profile(fs.readFileSync(path.join(__dirname, 'devcontainer.json'), 'utf8'), {
    native: args[0] === 'native',
    ui: args[0] === 'ui' || args.includes('--ui'),
    image:
      value('--image') ||
      (args[0] === 'prebuilt'
        ? `ghcr.io/abhigyanpatwari/gitnexus-devcontainer:main${args.includes('--ui') ? '-ui' : ''}`
        : undefined),
    imageOnly: args[0] === 'image-build',
    ref: value('--ref'),
    playwright: lock.packages['node_modules/@playwright/test'].version,
  });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'devcontainer.json'), contents);
  fs.copyFileSync(
    path.join(__dirname, 'devcontainer-lock.json'),
    path.join(output, 'devcontainer-lock.json'),
  );
  console.log(
    'Generated .devcontainer/generated/devcontainer.json; select it when reopening in container. Regenerate after updating the main configuration.',
  );
}
