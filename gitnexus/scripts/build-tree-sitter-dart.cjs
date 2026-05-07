#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dartDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-dart');
const bindingGyp = path.join(dartDir, 'binding.gyp');
const bindingNode = path.join(dartDir, 'build', 'Release', 'tree_sitter_dart_binding.node');

try {
  if (!fs.existsSync(bindingGyp) || fs.existsSync(bindingNode)) {
    process.exit(0);
  }

  try {
    require.resolve('node-addon-api');
    require.resolve('node-gyp-build');
  } catch (resolveErr) {
    console.warn(
      '[tree-sitter-dart] Skipping build: hoisted build deps not resolvable (%s).',
      resolveErr.message,
    );
    console.warn(
      '[tree-sitter-dart] Dart parsing will be unavailable. Install without --no-optional and with scripts enabled to build.',
    );
    process.exit(0);
  }

  // ── Patch NAN → NAPI bindings ──────────────────────────────────────────
  // tree-sitter-dart@1.0.0 ships old NAN-style bindings that are
  // incompatible with the tree-sitter@0.21.x runtime bundled by GitNexus.
  // Rewrite binding.cc, binding.gyp, and index.js to NAPI style (same
  // pattern used by tree-sitter-go, tree-sitter-python, etc.).
  const bindingCc = path.join(dartDir, 'bindings', 'node', 'binding.cc');
  const indexJs = path.join(dartDir, 'bindings', 'node', 'index.js');

  if (fs.existsSync(bindingCc)) {
    const currentCc = fs.readFileSync(bindingCc, 'utf8');
    if (currentCc.includes('Nan::') || !currentCc.includes('Napi::')) {
      console.log('[tree-sitter-dart] Patching binding.cc (NAN → NAPI)...');
      fs.writeFileSync(
        bindingCc,
        [
          '#include <napi.h>',
          '',
          'typedef struct TSLanguage TSLanguage;',
          '',
          'extern "C" TSLanguage *tree_sitter_dart();',
          '',
          '// "tree-sitter", "language" is a convention that lets the',
          '// temporary `node-tree-sitter` binding find the language.',
          'Napi::Object Init(Napi::Env env, Napi::Object exports) {',
          '  exports["name"] = Napi::String::New(env, "dart");',
          '  auto language = Napi::External<TSLanguage>::New(env, tree_sitter_dart());',
          '  language.TypeTag(&language);',
          '  exports["language"] = language;',
          '  return exports;',
          '}',
          '',
          'NODE_API_MODULE(tree_sitter_dart_binding, Init)',
          '',
        ].join('\n'),
      );
    }
  }

  if (fs.existsSync(bindingGyp)) {
    const currentGyp = fs.readFileSync(bindingGyp, 'utf8');
    if (currentGyp.includes('nan') || !currentGyp.includes('node-addon-api')) {
      console.log('[tree-sitter-dart] Patching binding.gyp (NAN → NAPI)...');
      fs.writeFileSync(
        bindingGyp,
        JSON.stringify(
          {
            targets: [
              {
                target_name: 'tree_sitter_dart_binding',
                dependencies: ['<!(node -p "require(\'node-addon-api\').targets"):node_addon_api'],
                include_dirs: ['src'],
                sources: ['bindings/node/binding.cc', 'src/parser.c', 'src/scanner.c'],
                cflags_c: ['-std=c11'],
                cflags_cc: ['-std=c++17'],
                defines: ['NAPI_VERSION=8', 'NODE_ADDON_API_DISABLE_DEPRECATED'],
                xcode_settings: {
                  OTHER_CFLAGS: ['-std=c11'],
                  OTHER_CPLUSPLUSFLAGS: ['-std=c++17'],
                },
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );
    }
  }

  if (fs.existsSync(indexJs)) {
    const currentIdx = fs.readFileSync(indexJs, 'utf8');
    if (!currentIdx.includes('node-gyp-build')) {
      console.log('[tree-sitter-dart] Patching index.js (node-gyp-build loader)...');
      fs.writeFileSync(
        indexJs,
        [
          'try {',
          "  module.exports = require('node-gyp-build')(__dirname + '/../..');",
          '} catch (e) {',
          "  throw new Error('tree-sitter-dart native binding not found: ' + e.message);",
          '}',
          '',
        ].join('\n'),
      );
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────
  console.log('[tree-sitter-dart] Building native binding...');
  execSync('npx node-gyp rebuild', {
    cwd: dartDir,
    stdio: 'pipe',
    timeout: 180000,
  });
  console.log('[tree-sitter-dart] Native binding built successfully');
} catch (err) {
  console.warn('[tree-sitter-dart] Could not build native binding:', err.message);
  console.warn(
    '[tree-sitter-dart] Dart parsing will be unavailable. Non-Dart functionality is unaffected.',
  );
  process.exit(0);
}
