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
  type SwiftPackageConfig,
  swiftDeclaredTargetPrefix,
} from '../../../../src/core/ingestion/language-config.js';
import {
  coerceDeclaredSwiftTargets,
  groupSwiftFilesByModule,
} from '../../../../src/core/ingestion/languages/swift/target-grouping.js';
import { loadSwiftWorkspaceConfig } from '../../../../src/core/ingestion/languages/swift/workspace-config.js';
import { parseXcodeProject } from '../../../../src/core/ingestion/languages/swift/xcode-project.js';
import { _captureLogger } from '../../../../src/core/logger.js';

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
    const src = `
      .target(name: "Core", path: "Modules/Core")
    `;
    const parsed = parseSwiftPackageManifest(src);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('maps .testTarget to Tests/<name>', () => {
    const parsed = parseSwiftPackageManifest(`.testTarget(name: "AppTests")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('AppTests')).toBe('Tests/AppTests');
  });

  it('skips binary / systemLibrary targets, which have no Swift sources', () => {
    const parsed = parseSwiftPackageManifest(`
      .binaryTarget(name: "Lib", path: "Lib.xcframework")
      .systemLibrary(name: "CFoo")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.size).toBe(0);
  });

  it('keeps plugin targets as modules under Plugins/, marked non-importable', () => {
    const parsed = parseSwiftPackageManifest(`.plugin(name: "Gen", capability: .buildTool())`);
    expect(parsed.targets.get('Gen')).toBe('Plugins/Gen');
    expect([...parsed.plugins]).toEqual(['Gen']);
    expect(parsed.implicitDirs.get('Gen')).toBe('plugin');
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

  it('treats a computed path: as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", path: corePath)`);
    expect(parsed.complete).toBe(false);
  });

  it('ignores a block-commented factory', () => {
    const parsed = parseSwiftPackageManifest(`
      /* .target(name: "Ghost") */
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('records path: "." as the package root', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Lib", path: ".")`);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Lib', '.']],
    });
  });

  it('ignores a // commented factory', () => {
    const parsed = parseSwiftPackageManifest(`
      // .target(name: "Ghost")
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a dependency .target(name:) as a declared target', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "App", dependencies: [.target(name: "Core")])
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('App')).toBe('Sources/App');
    expect(parsed.targets.has('Core')).toBe(false);
  });

  it('prefers an explicit path over an earlier same-name factory', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "Core")
      .target(name: "Core", path: "Modules/Core")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Core')).toBe('Modules/Core');
  });

  it('treats a string-interpolated path as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", path: "Modules/\\(name)")`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a parenthesized name string as a complete factory', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Foo (experimental)")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Foo (experimental)')).toBe('Sources/Foo (experimental)');
  });

  it('ignores a commented parenthesis while balancing a factory', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "Core", // )
       path: "Modules/Core")
    `);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('ignores a block-comment parenthesis while balancing a factory', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", /* ) */ path: "Modules/Core")`);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('treats a mixed literal + helper-built targets: list as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: [.target(name: "Core")] + makeTargets())
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a helper-built list concatenated before literals as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: makeTargets() + [.target(name: "Core")])
`);
    expect(parsed.complete).toBe(false);
  });

  it('does not treat .library(..., targets: names) as a helper-built list', () => {
    const parsed = parseSwiftPackageManifest(`
      .library(name: "Demo", targets: libTargets)
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('ignores a factory-like spelling inside a string literal', () => {
    const parsed = parseSwiftPackageManifest(`
      let example = ".target(name: 'Ghost')"
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('treats a variable-prefix targets: concatenation as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: extraTargets + [.target(name: "Core")])
`);
    expect(parsed.complete).toBe(false);
  });

  it('skips a commented name: field and uses the real one', () => {
    const parsed = parseSwiftPackageManifest(`.target(/* name: "Ghost" */ name: "Models")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a commented #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
      // #if os(macOS)
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a block-commented #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
/*
#if os(macOS)
    .target(name: "MacOnly")
#endif
*/
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('MacOnly')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('rejects a name string with a Swift escape', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "\\u{43}ore")`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not treat https:// on the same line as a commented factory', () => {
    const parsed = parseSwiftPackageManifest(
      'let package = Package(name: "Demo", dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")], targets: [.target(name: "T")])',
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('T')).toBe('Sources/T');
  });

  it('ignores a commented helper-built targets: list', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(
    name: "Demo",
    targets: [
        .target(name: "Models"),
    ]
)
// targets: makeTargets()
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('ignores a helper-built targets: spelling inside a string', () => {
    const parsed = parseSwiftPackageManifest(`
let note = "targets: makeTargets()"
let package = Package(name: "Demo", targets: [.target(name: "Models")])
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('treats Package(targets: variable) as incomplete even when a factory was collected', () => {
    const parsed = parseSwiftPackageManifest(`
func unused() { _ = Target.target(name: "Ghost") }
let package = Package(name: "Demo", targets: actualTargets)
.target(name: "Incidental")
`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not collect a factory outside Package(targets: [...])', () => {
    const parsed = parseSwiftPackageManifest(`
func unused() { _ = Target.target(name: "Ghost") }
let package = Package(name: "Demo", targets: [.target(name: "Incidental")])
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Incidental')).toBe('Sources/Incidental');
  });

  it('treats a computed element inside the targets: array as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: [makeTargets()])
`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not collect factories when Package omits targets:', () => {
    const parsed = parseSwiftPackageManifest(`
let unused = Target.target(name: "Ghost")
let package = Package(name: "Empty")
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not treat a line comment after a label colon as live source', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(
    name: "Demo",
    targets: [
        .target(name: // .target(name: "Ghost")
            "Models"),
    ]
)
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });
});

describe('swiftDeclaredTargetPrefix', () => {
  it('treats . and ./ as the package root', () => {
    expect(swiftDeclaredTargetPrefix('.')).toBe('');
    expect(swiftDeclaredTargetPrefix('./')).toBe('');
    expect(swiftDeclaredTargetPrefix('./.')).toBe('');
  });

  it('strips a leading ./ from a relative target path', () => {
    expect(swiftDeclaredTargetPrefix('./Sources/Core')).toBe('Sources/Core/');
    expect(swiftDeclaredTargetPrefix('Sources/Core')).toBe('Sources/Core/');
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
    expect(cfg!.declaredTargets?.size).toBe(0);
    // Grouping still uses inferred folders so App/Foundation stay isolated.
    expect(cfg!.targets.get('Foundation')).toBe('Sources/Foundation');
    expect(coerceDeclaredSwiftTargets(cfg)?.size).toBe(0);
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

  it('declares a one-line manifest that includes an https:// dependency URL', async () => {
    const root = repo({
      'Package.swift':
        'let package = Package(name: "Demo", dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")], targets: [.target(name: "T")])',
      'Sources/T/T.swift': '',
    });
    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect(cfg!.declaredTargets?.get('T')).toBe('Sources/T');
    expect(cfg!.targets.get('T')).toBe('Sources/T');
  });
});

const pkg = (...targets: string[]): string =>
  `let package = Package(name: "P", targets: [${targets.join(', ')}])`;

const moduleKeys = (cfg: SwiftPackageConfig | null): string[] =>
  (cfg?.modules ?? []).map((m) => m.key).sort();

describe('loadSwiftPackageConfig — SwiftPM directory rules', () => {
  it('prefers the first predefined parent when inferring folders with no manifest', async () => {
    const root = repo({ 'Sources/Foo/a.swift': '', 'srcs/Foo/b.swift': '' });
    expect((await loadSwiftPackageConfig(root))?.targets.get('Foo')).toBe('Sources/Foo');
  });

  it('picks one predefined parent per package: the first of Sources, Source, src, srcs', async () => {
    const root = repo({
      'Package.swift': pkg(
        '.target(name: "A")',
        '.target(name: "B")',
        '.testTarget(name: "BTests")',
      ),
      'Source/A/a.swift': '',
      'srcs/B/b.swift': '',
      'Tests/BTests/t.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);

    expect(cfg?.targets.get('A')).toBe('Source/A');
    // SwiftPM does not fall through per target: B belongs under Source/ too.
    expect(cfg?.targets.get('B')).toBe('Source/B');
    expect(cfg?.targets.get('BTests')).toBe('Tests/BTests');
  });

  it('looks for test targets under the source parent when there is no Tests/', async () => {
    const root = repo({
      'Package.swift': pkg('.testTarget(name: "LibTests")'),
      'Sources/LibTests/t.swift': '',
    });

    expect((await loadSwiftPackageConfig(root))?.targets.get('LibTests')).toBe('Sources/LibTests');
  });

  it('reads sources: and exclude: lists, and treats a computed list as unreadable', () => {
    const parsed = parseSwiftPackageManifest(
      pkg(
        '.target(name: "Lib", exclude: ["Legacy", "README.md"], sources: ["Core", "Main.swift"])',
      ),
    );
    expect(parsed.filters.get('Lib')).toEqual({
      sources: ['Core', 'Main.swift'],
      exclude: ['Legacy', 'README.md'],
    });
    expect(parseSwiftPackageManifest(pkg('.target(name: "Lib", exclude: excluded)')).complete).toBe(
      false,
    );
  });

  it('reads the highest Package@swift-X.Y.swift over Package.swift', async () => {
    const root = repo({
      'Package.swift': pkg('.target(name: "Old")'),
      'Package@swift-5.9.swift': pkg('.target(name: "New59")'),
      'Package@swift-5.10.swift': pkg('.target(name: "New510")'),
    });

    const cfg = await loadSwiftPackageConfig(root);

    expect([...cfg!.targets.keys()]).toEqual(['New510']);
  });

  it('groups plugins but keeps them out of the import declaration map', async () => {
    const root = repo({ 'Package.swift': pkg('.target(name: "Lib")', '.plugin(name: "Gen")') });

    const cfg = await loadSwiftPackageConfig(root);

    expect(cfg?.targets.get('Gen')).toBe('Plugins/Gen');
    expect([...cfg!.declaredTargets!.keys()]).toEqual(['Lib']);
  });
});

describe('loadSwiftWorkspaceConfig — nested packages and Xcode projects (#3355)', () => {
  it('adds each nested package target keyed by its repo-relative directory', async () => {
    const root = repo({
      'Core/Net/Package.swift': pkg('.target(name: "Net")'),
      'Core/Net/Sources/Net/Client.swift': '',
      'Features/Login/Package.swift': pkg(
        '.target(name: "Login")',
        '.testTarget(name: "LoginTests")',
      ),
      'Features/Login/Sources/Login/View.swift': '',
      'Features/Login/Tests/LoginTests/ViewTests.swift': '',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.origin).toBe('directories');
    expect(moduleKeys(cfg)).toEqual([
      'Core/Net/Sources/Net',
      'Features/Login/Sources/Login',
      'Features/Login/Tests/LoginTests',
    ]);
    expect(cfg?.modules?.find((m) => m.key === 'Core/Net/Sources/Net')).toMatchObject({
      name: 'Net',
      importable: true,
    });
    expect(cfg?.moduleNamesComplete).toBe(true);
    expect(coerceDeclaredSwiftTargets(cfg)).toBeNull();
  });

  it('keeps two packages declaring the same target name as two modules', async () => {
    const root = repo({
      'Core/A/Package.swift': pkg('.target(name: "Core")'),
      'Core/B/Package.swift': pkg('.target(name: "Core")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);
    const groups = groupSwiftFilesByModule(
      ['Core/A/Sources/Core/X.swift', 'Core/B/Sources/Core/Y.swift'],
      (p) => p,
      cfg,
    );

    expect(groups.get('Core/A/Sources/Core')).toEqual(['Core/A/Sources/Core/X.swift']);
    expect(groups.get('Core/B/Sources/Core')).toEqual(['Core/B/Sources/Core/Y.swift']);
  });

  it('groups a nested file under its own package even when a root target shares the tail', async () => {
    const root = repo({
      'Package.swift': pkg('.target(name: "Core")'),
      'Features/A/Package.swift': pkg('.target(name: "Core")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);
    const groups = groupSwiftFilesByModule(
      ['Sources/Core/Root.swift', 'Features/A/Sources/Core/Nested.swift'],
      (p) => p,
      cfg,
    );

    expect(groups.get('Sources/Core')).toEqual(['Sources/Core/Root.swift']);
    expect(groups.get('Features/A/Sources/Core')).toEqual(['Features/A/Sources/Core/Nested.swift']);
  });

  it('keeps the root declaration for legacy callers and lists every module', async () => {
    const root = repo({
      'Package.swift': MODELS_APP,
      'Features/Login/Package.swift': pkg('.target(name: "Login")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.origin).toBe('package.swift');
    expect([...coerceDeclaredSwiftTargets(cfg)!.keys()].sort()).toEqual(['App', 'Models']);
    expect(moduleKeys(cfg)).toEqual([
      'Features/Login/Sources/Login',
      'Sources/App',
      'Sources/Models',
    ]);
  });

  it('joins a custom path with the package directory and drops one escaping the repo', async () => {
    const root = repo({
      'Pkgs/Lib/Package.swift': pkg(
        '.target(name: "Lib", path: "Code")',
        '.target(name: "Shared", path: "../Shared")',
        '.target(name: "Outside", path: "../../../Outside")',
        '.target(name: "Root", path: "../..")',
        '.target(name: "Drive", path: "C:/Elsewhere")',
      ),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(moduleKeys(cfg)).toEqual(['Pkgs/Lib/Code', 'Pkgs/Shared']);
  });

  it('infers Sources/* folders for a hazardous nested manifest and marks names incomplete', async () => {
    const root = repo({
      'Core/Hazard/Package.swift': '#if os(Linux)\n.target(name: "L")\n#endif\n',
      'Core/Hazard/Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(moduleKeys(cfg)).toEqual(['Core/Hazard/Sources/App']);
    expect(cfg?.moduleNamesComplete).toBe(false);
  });

  it('skips manifests under build output, dependencies, and bundle directories', async () => {
    const root = repo({
      '.build/checkouts/Dep/Package.swift': pkg('.target(name: "Dep")'),
      'node_modules/x/Package.swift': pkg('.target(name: "X")'),
      'App.xcodeproj/Package.swift': pkg('.target(name: "Proj")'),
      'Assets.xcassets/Package.swift': pkg('.target(name: "Assets")'),
      'App.xcworkspace/Package.swift': pkg('.target(name: "Ws")'),
      'en.lproj/Package.swift': pkg('.target(name: "Loc")'),
      'Res.bundle/Package.swift': pkg('.target(name: "Res")'),
      'Core/Real/Package.swift': pkg('.target(name: "Real")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(moduleKeys(cfg)).toEqual(['Core/Real/Sources/Real']);
  });

  it('reads Xcode target membership and marks names incomplete when a project is unreadable', async () => {
    const root = repo({
      'App/App.xcodeproj/project.pbxproj': PBXPROJ,
      'App/Broken.xcodeproj/project.pbxproj': '{ objects = {',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.modules?.find((m) => m.name === 'App')).toMatchObject({
      key: 'xcode:App/App.xcodeproj:App',
      files: ['App/App/AppMain.swift', 'App/Shared/Util.swift', 'App/Widget/Shared.swift'],
    });
    expect(cfg?.moduleNamesComplete).toBe(false);
  });

  it('warns and keeps shallower packages when the walk passes the depth cap', async () => {
    const deep = Array.from({ length: 26 }, (_, i) => `d${i}`).join('/');
    const root = repo({
      'Core/Shallow/Package.swift': pkg('.target(name: "Shallow")'),
      [`${deep}/Package.swift`]: pkg('.target(name: "Deep")'),
    });

    const cap = _captureLogger();
    try {
      const cfg = await loadSwiftWorkspaceConfig(root);
      expect(moduleKeys(cfg)).toEqual(['Core/Shallow/Sources/Shallow']);
      expect(cfg?.moduleNamesComplete).toBe(false);
      expect(cap.text()).toContain('workspace scan');
    } finally {
      cap.restore();
    }
  });

  it('returns null with no manifest, project, or source folders anywhere', async () => {
    const root = repo({ 'README.md': '' });
    expect(await loadSwiftWorkspaceConfig(root)).toBeNull();
  });
});

describe('parseXcodeProject', () => {
  it('resolves group paths, SOURCE_ROOT references, and synchronized folders with exceptions', () => {
    const parsed = parseXcodeProject(PBXPROJ, 'App');

    expect(parsed.complete).toBe(true);
    expect(parsed.targets).toEqual([
      {
        name: 'App',
        moduleName: 'App',
        files: ['App/App/AppMain.swift', 'App/Shared/Util.swift', 'App/Widget/Shared.swift'],
        folders: [],
        excluded: [],
      },
      {
        name: 'Widget',
        moduleName: 'WidgetKitExt',
        files: ['App/Shared/Util.swift'],
        folders: ['App/Widget'],
        excluded: ['App/Widget/Preview.swift'],
      },
    ]);
  });

  it('reports an unparseable project as incomplete', () => {
    expect(parseXcodeProject('{ objects = ', '')).toEqual({ targets: [], complete: false });
  });

  it.each(['\\U12xz', '\\Uzzzz', '\\U12'])(
    'reports a malformed %s escape as incomplete',
    (escape) => {
      const project = `{ objects = { R = { isa = PBXProject; mainGroup = G; targets = ( ); }; G = { isa = PBXGroup; name = "${escape}"; }; }; rootObject = R; }`;
      expect(parseXcodeProject(project, '').complete).toBe(false);
    },
  );
});

/**
 * Two targets: `App` via a classic sources phase (one `<group>` file, one
 * `SOURCE_ROOT` file, one SDK framework that must be ignored), and `Widget`
 * via an Xcode 16 synchronized folder, plus the shared SOURCE_ROOT file.
 * The folder's exceptions remove `Preview.swift` from `Widget` (which lists
 * the folder) and add `Shared.swift` to `App` (which does not). `Widget`
 * sets a literal `PRODUCT_MODULE_NAME`.
 */
const PBXPROJ = `// !$*UTF8*$!
{
  archiveVersion = 1;
  objectVersion = 77;
  objects = {
    ROOT /* Project object */ = { isa = PBXProject; mainGroup = MAIN; projectDirPath = ""; targets = ( TAPP, TWID, ); };
    MAIN = { isa = PBXGroup; children = ( GAPP, FUTIL, FSDK, SYNC, ); sourceTree = "<group>"; };
    GAPP /* App */ = { isa = PBXGroup; children = ( FMAIN, ); path = App; sourceTree = "<group>"; };
    FMAIN = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppMain.swift; sourceTree = "<group>"; };
    FUTIL = { isa = PBXFileReference; path = "Shared/Util.swift"; sourceTree = SOURCE_ROOT; };
    FSDK = { isa = PBXFileReference; path = System/Library/Frameworks/UIKit.framework; sourceTree = SDKROOT; };
    SYNC = { isa = PBXFileSystemSynchronizedRootGroup; exceptions = ( EXC, EXCAPP, ); path = Widget; sourceTree = "<group>"; };
    EXC = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = ( Preview.swift, ); target = TWID; };
    EXCAPP = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = ( Shared.swift, ); target = TAPP; };
    TAPP = { isa = PBXNativeTarget; buildPhases = ( PAPP, ); name = App; };
    PAPP = { isa = PBXSourcesBuildPhase; files = ( BMAIN, BUTIL, BSDK, ); };
    BMAIN = { isa = PBXBuildFile; fileRef = FMAIN; };
    BUTIL = { isa = PBXBuildFile; fileRef = FUTIL; };
    BSDK = { isa = PBXBuildFile; fileRef = FSDK; };
    TWID = { isa = PBXNativeTarget; buildConfigurationList = CLWID; buildPhases = ( PWID, ); fileSystemSynchronizedGroups = ( SYNC, ); name = Widget; };
    CLWID = { isa = XCConfigurationList; buildConfigurations = ( CDEBUG, ); };
    CDEBUG = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_MODULE_NAME = WidgetKitExt; PRODUCT_NAME = "$(TARGET_NAME)"; }; name = Debug; };
    PWID = { isa = PBXSourcesBuildPhase; files = ( BUTIL2, ); };
    BUTIL2 = { isa = PBXBuildFile; fileRef = FUTIL; };
  };
  rootObject = ROOT;
}
`;

describe('loadSwiftWorkspaceConfig — compiler module names and filters (#3355)', () => {
  it('names a SwiftPM module the way the compiler does and rebases sources:/exclude:', async () => {
    const root = repo({
      'Pkgs/Kit/Package.swift': pkg(
        '.target(name: "my-kit", sources: ["Core"], exclude: ["Core/Legacy"])',
      ),
      'Pkgs/Kit/Sources/my-kit/Core/A.swift': '',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.modules).toEqual([
      {
        key: 'Pkgs/Kit/Sources/my-kit',
        name: 'my_kit',
        dir: 'Pkgs/Kit/Sources/my-kit',
        importable: true,
        sources: ['Pkgs/Kit/Sources/my-kit/Core'],
        excluded: ['Pkgs/Kit/Sources/my-kit/Core/Legacy'],
      },
    ]);
  });
});
