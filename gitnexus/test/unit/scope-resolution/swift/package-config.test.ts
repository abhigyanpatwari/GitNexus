/**
 * Package.swift target loading (PR 3105 / #2964).
 *
 * `loadSwiftPackageConfig` must distinguish a declaration map
 * (`origin: 'package.swift'`) from an inferred `Sources/*` folder map
 * (`origin: 'directories'`). Grouping uses either; explicit import
 * resolve uses only the declared origin.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSwiftPackageConfig,
  parseSwiftPackageManifest,
} from '../../../../src/core/ingestion/language-config.js';

const roots: string[] = [];

function repo(files: Readonly<Record<string, string | null>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-pkg-'));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (contents === null) {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const MODELS_APP = `
let package = Package(
    name: "Demo",
    targets: [
        .target(name: "Models"),
        .target(name: "App"),
    ]
)
`;

describe('parseSwiftPackageManifest', () => {
  it('maps .target(name:) with no path to Sources/<name>', () => {
    const parsed = parseSwiftPackageManifest(MODELS_APP);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
    expect(parsed.targets.get('App')).toBe('Sources/App');
  });

  it('honors an explicit path:', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "Core", path: "Modules/Core")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Core')).toBe('Modules/Core');
  });

  it('maps .testTarget to Tests/<name>', () => {
    const parsed = parseSwiftPackageManifest(`.testTarget(name: "AppTests")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('AppTests')).toBe('Tests/AppTests');
  });

  it('skips binary / plugin / systemLibrary targets', () => {
    const parsed = parseSwiftPackageManifest(`
      .binaryTarget(name: "Lib", path: "Lib.xcframework")
      .plugin(name: "Gen")
      .systemLibrary(name: "CFoo")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.size).toBe(0);
  });

  it('treats #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
#if os(macOS)
    .target(name: "MacOnly")
#endif
    .target(name: "Models")
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a helper-built targets: list as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: makeTargets())
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a computed name: as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: targetName)`);
    expect(parsed.complete).toBe(false);
  });
});

describe('loadSwiftPackageConfig', () => {
  it('returns a declared map from Package.swift and ignores undeclared Sources/* folders', async () => {
    const root = repo({
      'Package.swift': MODELS_APP,
      'Sources/Models/User.swift': '',
      'Sources/App/main.swift': '',
      'Sources/Foundation/Thing.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect([...cfg!.targets.keys()].sort()).toEqual(['App', 'Models']);
    expect(cfg!.targets.has('Foundation')).toBe(false);
  });

  it('returns an empty declared map when the manifest only has skipped target kinds', async () => {
    const root = repo({
      'Package.swift': `
let package = Package(
    name: "OnlyBinary",
    targets: [.binaryTarget(name: "Lib", path: "Lib.xcframework")]
)
`,
      'Sources/Foundation/Thing.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect(cfg!.targets.size).toBe(0);
  });

  it('infers Sources/* folders when Package.swift is missing', async () => {
    const root = repo({
      'Sources/App/main.swift': '',
      'Sources/Models/User.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
    expect(cfg!.targets.get('Models')).toBe('Sources/Models');
  });

  it('infers directories when Package.swift is unreadable (is a directory)', async () => {
    const root = repo({
      'Package.swift': null,
      'Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
  });

  it('infers directories when the manifest has completeness hazards', async () => {
    const root = repo({
      'Package.swift': `
#if os(Linux)
    .target(name: "LinuxOnly")
#endif
`,
      'Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
    expect(cfg!.targets.has('LinuxOnly')).toBe(false);
  });

  it('returns null when there is no manifest and no source folders', async () => {
    const root = repo({ 'README.md': '' });
    expect(await loadSwiftPackageConfig(root)).toBeNull();
  });
});
