#!/usr/bin/env node
/**
 * WORKAROUND: tree-sitter-dart@1.0.0 NAN → NAPI binding conversion
 *
 * Background:
 *   tree-sitter-dart@1.0.0 uses NAN (Native Abstractions for Node.js) for its
 *   native binding. NAN modules fail with "Module did not self-register" when
 *   loaded in Node.js worker_threads alongside NAPI-based tree-sitter modules.
 *   All other tree-sitter grammars in this project use NAPI, which is thread-safe.
 *
 * How this workaround works:
 *   1. Replaces the NAN-based binding.cc with a NAPI-based one
 *   2. Updates binding.gyp to use node-addon-api instead of nan
 *   3. Installs node-addon-api as a local dependency
 *   4. Rebuilds the native binding
 *
 * TODO: Remove this script when tree-sitter-dart publishes a version with NAPI
 *       bindings (or when an alternative package is available).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dartDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-dart');
const bindingCcPath = path.join(dartDir, 'bindings', 'node', 'binding.cc');
const bindingGypPath = path.join(dartDir, 'binding.gyp');

const NAPI_BINDING_CC = `#include <napi.h>

typedef struct TSLanguage TSLanguage;

extern "C" TSLanguage *tree_sitter_dart();

// "tree-sitter", "language" hashed with BLAKE2
const napi_type_tag LANGUAGE_TYPE_TAG = {
  0x8AF2E5212AD58ABF, 0xD5006CAD83ABBA16
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports["name"] = Napi::String::New(env, "dart");
    auto language = Napi::External<TSLanguage>::New(env, tree_sitter_dart());
    language.TypeTag(&LANGUAGE_TYPE_TAG);
    exports["language"] = language;
    return exports;
}

NODE_API_MODULE(tree_sitter_dart_binding, Init)
`;

const NAPI_BINDING_GYP = `{
  "targets": [
    {
      "target_name": "tree_sitter_dart_binding",
      "dependencies": [
        "<!(node -p \\"require('node-addon-api').targets\\"):node_addon_api_except"
      ],
      "include_dirs": [
        "src"
      ],
      "sources": [
        "bindings/node/binding.cc",
        "src/parser.c",
        "src/scanner.c"
      ],
      "cflags_c": [
        "-std=c99"
      ]
    }
  ]
}
`;

try {
  if (!fs.existsSync(bindingCcPath)) {
    process.exit(0);
  }

  const currentBinding = fs.readFileSync(bindingCcPath, 'utf8');
  let needsRebuild = false;

  // Check if still using NAN
  if (currentBinding.includes('nan.h')) {
    console.log('[tree-sitter-dart] Converting NAN binding to NAPI for worker_threads compatibility...');
    fs.writeFileSync(bindingCcPath, NAPI_BINDING_CC);
    fs.writeFileSync(bindingGypPath, NAPI_BINDING_GYP);
    needsRebuild = true;

    // Install node-addon-api if not present
    const napiDir = path.join(dartDir, 'node_modules', 'node-addon-api');
    if (!fs.existsSync(napiDir)) {
      console.log('[tree-sitter-dart] Installing node-addon-api...');
      execSync('npm install node-addon-api', {
        cwd: dartDir,
        stdio: 'pipe',
        timeout: 60000,
      });
    }
  }

  // Check if native binding exists
  const bindingNode = path.join(dartDir, 'build', 'Release', 'tree_sitter_dart_binding.node');
  if (!fs.existsSync(bindingNode)) {
    needsRebuild = true;
  }

  if (needsRebuild) {
    console.log('[tree-sitter-dart] Rebuilding native binding with NAPI...');
    execSync('npx node-gyp rebuild', {
      cwd: dartDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('[tree-sitter-dart] NAPI binding built successfully');
  }
} catch (err) {
  console.warn('[tree-sitter-dart] Could not build NAPI binding:', err.message);
  console.warn('[tree-sitter-dart] Dart support will be unavailable in worker threads.');
  console.warn('[tree-sitter-dart] You may need to manually run: cd node_modules/tree-sitter-dart && npx node-gyp rebuild');
}
