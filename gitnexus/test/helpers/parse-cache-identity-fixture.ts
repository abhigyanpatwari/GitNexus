import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PARSE_CACHE_BASE_FILES,
  PARSE_CACHE_BASE_ROOTS,
  PARSE_CACHE_PACKAGE_INPUTS,
  resolveParseCacheIdentity,
  type ParseCacheIdentityResolveOptions,
} from '../../src/core/parse-cache-identity.js';
import { GRAMMAR_SOURCES } from '../../src/core/tree-sitter/grammar-sources.js';
import { VENDORED_GRAMMAR_PACKAGES } from '../../src/core/tree-sitter/vendored-grammars.js';

/** Real artifact trees with deliberately unloadable bindings: identity must only read bytes. */
export function createParseIdentityFixture(kind: 'source' | 'distribution' = 'source') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-parse-identity-'));
  const write = (relative: string, contents = 'export const value = 1;\n') => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  const build = (name: 'src' | 'dist') => {
    const ext = name === 'src' ? '.ts' : '.js';
    for (const owned of PARSE_CACHE_BASE_ROOTS) write(`${name}/${owned}/input${ext}`);
    for (const owned of PARSE_CACHE_BASE_FILES) write(`${name}/${owned.replace(/\.ts$/, ext)}`);
    write(`${name}/core/analyzer${ext}`);
    write(`${name}/core/ingestion/pipeline-phases/parse-impl${ext}`);
    write(`${name}/core/ingestion/workers/parse-worker.js`);
    write(`${name}/core/ingestion/cfg/harvest${ext}`);
    write(`${name}/core/ingestion/languages/cobol/flow${ext}`);
    write(`${name}/core/ingestion/languages/cobol/flow-source${ext}`);
    if (name === 'dist') write(`${name}/_shared/index.js`);
  };
  write('package.json', '{"name":"gitnexus-fixture","version":"1.0.0","type":"module"}');
  build(kind === 'source' ? 'src' : 'dist');
  write(
    'node_modules/gitnexus-shared/package.json',
    JSON.stringify({
      name: 'gitnexus-shared',
      version: '1.0.0',
      main: './dist/index.js',
    }),
  );
  write('node_modules/gitnexus-shared/src/index.ts');
  write('node_modules/gitnexus-shared/dist/index.js');
  const addPackage = (name: string, dependencies: Record<string, string> = {}) => {
    const location = `${VENDORED_GRAMMAR_PACKAGES.has(name) ? 'vendor' : 'node_modules'}/${name}`;
    write(`${location}/package.json`, JSON.stringify({ name, version: '1.0.0', dependencies }));
    write(`${location}/index.js`, 'throw new Error("identity evaluated a native loader");\n');
    write(`${location}/prebuilds/test/binding.node`, 'native fixture bytes');
    return location;
  };
  for (const name of new Set([
    ...PARSE_CACHE_PACKAGE_INPUTS,
    ...Object.values(GRAMMAR_SOURCES).map((source) => source.packageName),
    ...VENDORED_GRAMMAR_PACKAGES,
  ]))
    addPackage(name);
  const options: ParseCacheIdentityResolveOptions = {
    nativeRuntimePathsForTest: {
      executable: path.join(root, 'runtime/node'),
      alpineMarker: path.join(root, 'runtime/alpine-release'),
    },
  };
  const moduleUrl = pathToFileURL(
    path.join(root, kind === 'source' ? 'src/core/analyzer.ts' : 'dist/core/analyzer.js'),
  ).href;
  const resolve = (extra: ParseCacheIdentityResolveOptions = {}) =>
    resolveParseCacheIdentity(moduleUrl, { ...options, ...extra });
  const identity = (extra: ParseCacheIdentityResolveOptions = {}) => {
    const result = resolve(extra);
    if (result.ok === false) throw new Error(result.reason);
    return result.identity;
  };
  return {
    root,
    write,
    build,
    addPackage,
    moduleUrl,
    options,
    resolve,
    identity,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
