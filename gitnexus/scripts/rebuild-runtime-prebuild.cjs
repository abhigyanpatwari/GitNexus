#!/usr/bin/env node
/**
 * Rebuild the tree-sitter runtime prebuild for the current Linux architecture.
 *
 * The upstream linux-x64 and linux-arm64 runtime prebuilds need GLIBCXX_3.4.31
 * (GCC 13), which Ubuntu 22.04 and Debian 12 lack (#4165). Run this inside the
 * pinned Ubuntu 22.04 image recorded in runtime-manifest.json, once per
 * architecture; it replaces only the current architecture's entry.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { isArm64NapiSharedObject, isX64NapiSharedObject } = require('./arm64-prebuild.cjs');
const { buildEnvironment } = require('./rebuild-bundled-grammar-prebuilds.cjs');

const output = path.resolve(__dirname, '../prebuilds/bundled');
const manifestFile = path.join(output, 'runtime-manifest.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ARCHITECTURES = {
  x64: { tuple: 'linux-x64', name: 'x86-64', matches: isX64NapiSharedObject },
  arm64: { tuple: 'linux-arm64', name: 'AArch64', matches: isArm64NapiSharedObject },
};
// Ubuntu 22.04 and Debian 12 ship libstdc++ up to GLIBCXX_3.4.30.
const LIMITS = { GLIBC: '2.17', GLIBCXX: '3.4.29', CXXABI: '1.3.9' };

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

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function inspectBinary(file, architecture) {
  if (!architecture.matches(fs.readFileSync(file))) {
    throw new Error(`Not an ${architecture.name} N-API shared object: ${file}`);
  }
  const readelf = (...args) => execFileSync('readelf', args.concat(file), { encoding: 'utf8' });
  const versions = [
    ...new Set(readelf('--version-info').match(/(?:GLIBCXX|GLIBC|CXXABI|GCC)_[\d.]+/g)),
  ].sort();
  for (const [family, max] of Object.entries(LIMITS)) {
    for (const version of versions.filter((value) => value.startsWith(`${family}_`))) {
      if (compareVersions(version.slice(family.length + 1), max) > 0) {
        throw new Error(`${file} requires ${version}, above ${family}_${max}`);
      }
    }
  }
  const stack = readelf('--program-headers', '--wide')
    .split('\n')
    .find((line) => line.includes('GNU_STACK'));
  if (!stack || !/\sRW\s/.test(stack)) throw new Error(`Missing non-executable GNU_STACK: ${file}`);
  return {
    architecture: architecture.name,
    gnuStack: 'RW',
    needed: [...readelf('--dynamic').matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(
      (match) => match[1],
    ),
    requiredSymbolVersions: versions,
    maxGLIBC: LIMITS.GLIBC,
    maxGLIBCXX: LIMITS.GLIBCXX,
    maxCXXABI: LIMITS.CXXABI,
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'Run on Linux x64 or ARM64 inside the image recorded in prebuilds/bundled/runtime-manifest.json,\nwith Node, npm, Python, make, GCC/G++, tar and readelf. See prebuilds/bundled/README.md.',
    );
    return;
  }
  const architecture = ARCHITECTURES[process.arch];
  if (process.platform !== 'linux' || !architecture) {
    throw new Error('Regeneration requires an actual Linux x64 or ARM64 Node process.');
  }
  const manifest = readJson(manifestFile);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-runtime-prebuild-'));
  const buildEnv = buildEnvironment();
  const run = (command, args, cwd = work, env = process.env) =>
    execFileSync(command, args, { cwd, env, stdio: 'inherit' });
  try {
    const { grammar } = manifest.build.validation;
    const installs = { ...manifest.build.dependencies, [grammar.name]: grammar };
    fs.writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: Object.fromEntries(
          Object.entries(installs).map(([name, entry]) => [name, entry.version]),
        ),
      }),
    );
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']);
    const lock = readJson(path.join(work, 'package-lock.json'));
    for (const [name, entry] of Object.entries(installs)) {
      const installed = lock.packages[`node_modules/${name}`];
      if (installed?.version !== entry.version || installed?.integrity !== entry.integrity) {
        throw new Error(`Build dependency differs from recorded input: ${name}`);
      }
    }
    const header = manifest.build.nodeHeaders;
    const headerArchive = path.join(work, 'node-headers.tar.gz');
    await download(header.url, headerArchive, header.sha256);
    run('tar', ['-xzf', headerArchive, '-C', work]);
    const headers = path.join(work, `node-v${header.version}`);

    const archive = path.join(work, 'tree-sitter.tgz');
    await download(manifest.source.url, archive, manifest.source.sha256, manifest.source.integrity);
    const dir = path.join(work, 'node_modules', manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    run('tar', ['-xzf', archive, '-C', dir, '--strip-components=1']);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg.name !== manifest.name || pkg.version !== manifest.version) {
      throw new Error(`Unexpected upstream package identity: ${pkg.name}@${pkg.version}`);
    }
    run(
      process.execPath,
      [
        path.join(work, 'node_modules/node-gyp/bin/node-gyp.js'),
        'rebuild',
        `--arch=${process.arch}`,
        `--nodedir=${headers}`,
        '--jobs=2',
      ],
      dir,
      buildEnv,
    );
    const release = path.join(dir, 'build/Release');
    const files = fs.readdirSync(release).filter((name) => name.endsWith('.node'));
    if (files.length !== 1) throw new Error('Expected one native runtime binding');
    const binary = path.join(release, files[0]);
    const elf = inspectBinary(binary, architecture);

    // node-gyp-build prefers build/Release, so this loads the binary just built.
    const load = createRequire(path.join(work, 'package.json'));
    const Parser = load(manifest.name);
    const parser = new Parser();
    parser.setLanguage(load(grammar.name));
    const root = parser.parse(grammar.sample).rootNode;
    if (root.hasError || root.namedChildCount === 0) throw new Error('Runtime parse failed');

    const version = (command) =>
      execFileSync(command, ['--version'], { env: buildEnv, encoding: 'utf8' }).split('\n')[0];
    const bytes = fs.readFileSync(binary);
    const entry = {
      tuple: architecture.tuple,
      file: `${manifest.name}@${manifest.version}/${architecture.tuple}/${manifest.name}.node`,
      sha256: sha256(bytes),
      toolchain: {
        compiler: `${version(buildEnv.CC)}; ${version(buildEnv.CXX)}`,
        linker: version('ld'),
        libc: version('ldd'),
        hostNode: process.versions.node,
      },
      elf,
    };
    manifest.binaries = [
      ...manifest.binaries.filter((other) => other.tuple !== entry.tuple),
      entry,
    ].sort((a, b) => a.tuple.localeCompare(b.tuple));
    // No committed output changes until provenance, the ABI ceiling, native
    // loading and parsing have all passed.
    const target = path.join(output, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      `Rebuilt and parsed the ${entry.tuple} runtime; review binary and manifest changes.`,
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
