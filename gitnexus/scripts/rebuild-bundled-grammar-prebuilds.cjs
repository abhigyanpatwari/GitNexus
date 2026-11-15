#!/usr/bin/env node
/** Rebuild only the five audited npm-package Linux ARM64 overlays. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { isArm64NapiSharedObject } = require('./arm64-prebuild.cjs');

const output = path.resolve(__dirname, '../prebuilds/bundled');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const samples = {
  'tree-sitter-cpp': [[null, 'class Box { public: int value; };']],
  'tree-sitter-java': [[null, 'class Box { int value; }']],
  'tree-sitter-ruby': [[null, 'class Box\n def value\n  1\n end\nend']],
  'tree-sitter-javascript': [[null, 'export function value() { return 1; }']],
  'tree-sitter-typescript': [
    ['typescript', 'const value: number = 1;'],
    ['tsx', 'const value = <div>hello</div>;'],
  ],
};

function buildEnvironment(env = process.env) {
  // Keep tool discovery and the user directory, but exclude compiler, make and
  // gyp overrides so the recorded GCC toolchain and flags match the build.
  return { PATH: env.PATH, HOME: env.HOME, CC: 'gcc', CXX: 'g++' };
}

async function download(url, file, expectedSha256, integrity) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    sha256(bytes) !== expectedSha256 ||
    (integrity && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity)
  ) {
    throw new Error(`Source checksum mismatch: ${url}`);
  }
  fs.writeFileSync(file, bytes);
}

function verifySources(dir, files) {
  for (const [file, expected] of Object.entries(files)) {
    if (sha256(fs.readFileSync(path.join(dir, file))) !== expected) {
      throw new Error(`Upstream source changed: ${dir}/${file}`);
    }
  }
}

function inspectBinary(file) {
  const bytes = fs.readFileSync(file);
  if (!isArm64NapiSharedObject(bytes)) {
    throw new Error(`Not an AArch64 N-API shared object: ${file}`);
  }
  const readelf = (...args) => execFileSync('readelf', args.concat(file), { encoding: 'utf8' });
  const versions = [
    ...new Set(readelf('--version-info').match(/(?:GLIBCXX|GLIBC|CXXABI|GCC)_[\d.]+/g)),
  ].sort();
  const limits = { GLIBC: '2.17', GLIBCXX: '3.4.21', CXXABI: '1.3.9' };
  for (const [family, max] of Object.entries(limits)) {
    for (const version of versions.filter((value) => value.startsWith(`${family}_`))) {
      const parts = version
        .slice(family.length + 1)
        .split('.')
        .map(Number);
      const ceiling = max.split('.').map(Number);
      const difference = parts
        .map((part, i) => part - (ceiling[i] ?? 0))
        .find((part) => part !== 0);
      if (difference > 0) throw new Error(`${file} requires ${version}, above ${family}_${max}`);
    }
  }
  const stack = readelf('--program-headers', '--wide')
    .split('\n')
    .find((line) => line.includes('GNU_STACK'));
  if (!stack || !/\sRW\s/.test(stack)) throw new Error(`Missing non-executable GNU_STACK: ${file}`);
  return {
    architecture: 'AArch64',
    gnuStack: 'RW',
    needed: [...readelf('--dynamic').matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(
      (match) => match[1],
    ),
    requiredSymbolVersions: versions,
    maxGLIBC: limits.GLIBC,
    maxGLIBCXX: limits.GLIBCXX,
    maxCXXABI: limits.CXXABI,
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'Run on Linux ARM64 with Node, npm, Python, make, GCC/G++, tar and readelf.\nRebuilds the five pinned upstream packages into prebuilds/bundled; see its README.md.',
    );
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'arm64') {
    throw new Error(
      'Regeneration requires an actual Linux ARM64 Node process; npm_config_arch is insufficient.',
    );
  }
  const manifest = readJson(path.join(output, 'manifest.json'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-bundled-prebuilds-'));
  const buildEnv = buildEnvironment();
  const run = (command, args, cwd = work, env = process.env) =>
    execFileSync(command, args, { cwd, env, stdio: 'inherit' });
  try {
    const dependencies = Object.fromEntries(
      Object.entries(manifest.build.dependencies).map(([name, entry]) => [name, entry.version]),
    );
    dependencies['tree-sitter'] = manifest.build.runtime;
    fs.writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({ private: true, dependencies }),
    );
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']);
    const lock = readJson(path.join(work, 'package-lock.json'));
    for (const [name, entry] of Object.entries(manifest.build.dependencies)) {
      const installed = lock.packages[`node_modules/${name}`];
      if (installed.version !== entry.version || installed.integrity !== entry.integrity) {
        throw new Error(`Build dependency differs from recorded input: ${name}`);
      }
    }
    const header = manifest.build.nodeHeaders;
    const headerArchive = path.join(work, 'node-headers.tar.gz');
    await download(header.url, headerArchive, header.sha256);
    run('tar', ['-xzf', headerArchive, '-C', work]);
    const headers = path.join(work, `node-v${header.version}`);
    const Parser = createRequire(path.join(work, 'package.json'))('tree-sitter');
    const built = [];
    // Build serially: node-gyp writes a shared node-addon-api Makefile whose
    // relative target paths depend on the grammar's position in node_modules.
    for (const entry of manifest.packages) {
      const archive = path.join(work, `${entry.name}.tgz`);
      await download(entry.source.url, archive, entry.source.sha256, entry.source.integrity);
      const dir = path.join(work, 'node_modules', entry.name);
      fs.mkdirSync(dir, { recursive: true });
      run('tar', ['-xzf', archive, '-C', dir, '--strip-components=1']);
      const pkg = readJson(path.join(dir, 'package.json'));
      if (pkg.name !== entry.name || pkg.version !== entry.version) {
        throw new Error(`Unexpected upstream package identity: ${entry.name}`);
      }
      verifySources(dir, entry.source.files);
      run(
        process.execPath,
        [
          path.join(work, 'node_modules/node-gyp/bin/node-gyp.js'),
          'rebuild',
          '--arch=arm64',
          `--nodedir=${headers}`,
          '--jobs=2',
        ],
        dir,
        buildEnv,
      );
      verifySources(dir, entry.source.files);
      const release = path.join(dir, 'build/Release');
      const files = fs.readdirSync(release).filter((name) => name.endsWith('.node'));
      if (files.length !== 1) throw new Error(`Expected one native binding: ${entry.name}`);
      const binary = path.join(release, files[0]);
      const elf = inspectBinary(binary);
      const language = require(binary);
      for (const [variant, source] of samples[entry.name]) {
        const parser = new Parser();
        parser.setLanguage(variant ? language[variant] : language);
        const root = parser.parse(source).rootNode;
        if (root.hasError || root.namedChildCount === 0)
          throw new Error(`Parse failed: ${entry.name} ${variant ?? ''}`);
      }
      const bytes = fs.readFileSync(binary);
      built.push({ entry: { ...entry, sha256: sha256(bytes), elf }, bytes });
    }
    const version = (command) =>
      execFileSync(command, ['--version'], { env: buildEnv, encoding: 'utf8' }).split('\n')[0];
    manifest.build = {
      ...manifest.build,
      compiler: `${version(buildEnv.CC)}; ${version(buildEnv.CXX)}`,
      linker: version('ld'),
      sysroot: version('ldd'),
      hostArchitecture: process.arch,
      hostNode: process.versions.node,
      compilerFlags: [],
      validation: {
        execution: 'Linux ARM64 Node process',
        nodeVersions: [process.versions.node],
        grammarExports: ['cpp', 'java', 'ruby', 'javascript', 'typescript', 'tsx'],
        parseFailures: 0,
      },
    };
    manifest.packages = built.map(({ entry }) => entry);
    // No committed output changes until every package passes provenance,
    // ABI-baseline, native loading and parsing checks.
    for (const { entry, bytes } of built) fs.writeFileSync(path.join(output, entry.file), bytes);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      `Rebuilt and parsed ${built.length} audited ARM64 bindings; review binary and manifest changes.`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildEnvironment };
