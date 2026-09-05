import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSwiftPackageConfig } from '../../src/core/ingestion/language-config.js';
import { parseSwiftPackageTargets } from '../../src/core/ingestion/languages/swift/package-manifest.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-swift-package-'));
  created.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('parseSwiftPackageTargets', () => {
  it('reads declared source targets and their explicit paths', () => {
    const targets = parseSwiftPackageTargets(`
      let package = Package(
        targets: [
          .target(
            name: "App",
            dependencies: [.product(name: "Logging", package: "swift-log")]
          ),
          .target(name: "LocalFoundation", path: "Sources/Foundation"),
          .testTarget(name: "AppTests", dependencies: ["App"]),
        ]
      )
    `);

    expect(targets).toEqual([
      { name: 'App', path: 'Sources/App' },
      { name: 'LocalFoundation', path: 'Sources/Foundation' },
      { name: 'AppTests', path: 'Tests/AppTests' },
    ]);
  });

  it('ignores target-like text in comments and strings', () => {
    const targets = parseSwiftPackageTargets(`
      // .target(name: "Commented")
      let note = ".target(name: \\"String\\")"
      /* .target(name: "Blocked") */
      let unused = Target.target(name: "Unused")
      let package = Package(targets: [
        makeTarget(.target(name: "Nested")),
        .target(name: "DynamicPath", path: computedPath),
        .target(name: "Real"),
      ])
    `);

    expect(targets).toEqual([{ name: 'Real', path: 'Sources/Real' }]);
  });
});

describe('loadSwiftPackageConfig', () => {
  it('keeps inferred grouping targets separate from manifest declarations', async () => {
    const root = await makeRepo({
      'Package.swift': `
        let package = Package(targets: [
          .target(name: "App"),
          .target(name: "LocalFoundation", path: "Sources/Foundation"),
        ])
      `,
      'Sources/App/main.swift': '',
      'Sources/Foundation/Thing.swift': '',
      'Sources/Undeclared/Other.swift': '',
    });

    const config = await loadSwiftPackageConfig(root);
    expect(config?.targets).toEqual(
      new Map([
        ['App', 'Sources/App'],
        ['Foundation', 'Sources/Foundation'],
        ['Undeclared', 'Sources/Undeclared'],
      ]),
    );
    expect(config?.declaredTargets).toEqual(
      new Map([
        ['App', 'Sources/App'],
        ['LocalFoundation', 'Sources/Foundation'],
      ]),
    );
  });

  it('keeps manifest declarations unavailable when Package.swift is absent', async () => {
    const root = await makeRepo({ 'Sources/Foundation/Thing.swift': '' });
    await expect(loadSwiftPackageConfig(root)).resolves.toEqual({
      targets: new Map([['Foundation', 'Sources/Foundation']]),
    });
  });
});
