import { describe, expect, it } from 'vitest';
import {
  splitGoImportStatement,
  interpretGoImport,
  resolveGoImportTarget,
} from '../../../../src/core/ingestion/languages/go/index.js';
import { getGoParser } from '../../../../src/core/ingestion/languages/go/query.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { resolveGoImportBinding } from '../../../../src/core/ingestion/languages/go/import-binding.js';
import type { GoWorkspaceConfig } from '../../../../src/core/ingestion/languages/go/workspace-config.js';

function parseThenSplit(src: string): CaptureMatch[] {
  const tree = getGoParser().parse(src);
  const out: CaptureMatch[] = [];
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child?.type === 'import_declaration') out.push(...splitGoImportStatement(child as any));
  }
  return out;
}

function capt(name: string, text: string) {
  return { name, text, range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 } };
}

describe('Go import decomposition', () => {
  it('decomposes single default import', () => {
    const matches = parseThenSplit('import "fmt"');
    expect(matches.length).toBe(1);
    expect(matches[0]['@import.source']?.text).toBe('fmt');
    expect(matches[0]['@import.kind']?.text).toBe('namespace');
    expect(matches[0]['@import.name']?.text).toBe('fmt');
  });

  it.each([
    ['"example.com/app/handlers/v2"', 'handlers'],
    ['h "example.com/app/handlers/v2"', 'h'],
    ['"example.com/app/v2/handlers"', 'handlers'],
    ['"example.com/app/v2beta"', 'v2beta'],
    ['"gopkg.in/yaml.v3"', 'yaml'],
    ['yamlv3 "gopkg.in/yaml.v3"', 'yamlv3'],
    ['"gopkg.in/yaml.v3beta"', 'yaml.v3beta'],
  ])('uses the same package qualifier for %s as route extraction', (spec, expected) => {
    const matches = parseThenSplit(`import ${spec}`);
    expect(matches[0]['@import.name']?.text).toBe(expected);
    const parsed = interpretGoImport(matches[0]);
    expect(parsed).not.toBeNull();
    expect(parsed && 'localName' in parsed ? parsed.localName : undefined).toBe(expected);
  });

  it('decomposes grouped imports', () => {
    const src = `import (
  "fmt"
  "os"
)`;
    const matches = parseThenSplit(src);
    expect(matches.length).toBe(2);
  });

  it('decomposes aliased import', () => {
    const matches = parseThenSplit('import util "example.com/pkg/util"');
    expect(matches.length).toBe(1);
    expect(matches[0]['@import.kind']?.text).toBe('alias');
    expect(matches[0]['@import.name']?.text).toBe('util');
    expect(matches[0]['@import.source']?.text).toBe('example.com/pkg/util');
  });

  it('filters blank imports', () => {
    const matches = parseThenSplit('import _ "example.com/sideeffect"');
    expect(matches.length).toBe(0);
  });

  it('handles dot imports', () => {
    const matches = parseThenSplit('import . "example.com/dsl"');
    expect(matches.length).toBe(1);
    expect(matches[0]['@import.kind']?.text).toBe('dot');
  });
});

describe('Go import interpretation', () => {
  it('interprets namespace import', () => {
    const result = interpretGoImport({
      '@import.kind': capt('@import.kind', 'namespace'),
      '@import.name': capt('@import.name', 'models'),
      '@import.source': capt('@import.source', 'example.com/app/models'),
    });
    expect(result).toEqual({
      kind: 'namespace',
      localName: 'models',
      importedName: 'models',
      targetRaw: 'example.com/app/models',
      implicitLocalName: true,
    });
  });

  it('interprets alias import', () => {
    const result = interpretGoImport({
      '@import.kind': capt('@import.kind', 'alias'),
      '@import.name': capt('@import.name', 'util'),
      '@import.alias': capt('@import.alias', 'util'),
      '@import.source': capt('@import.source', 'example.com/pkg/util'),
    });
    expect(result).toEqual({
      kind: 'namespace',
      localName: 'util',
      importedName: 'util',
      targetRaw: 'example.com/pkg/util',
    });
  });

  it('interprets dot import as wildcard', () => {
    const result = interpretGoImport({
      '@import.kind': capt('@import.kind', 'dot'),
      '@import.name': capt('@import.name', 'dsl'),
      '@import.source': capt('@import.source', 'example.com/dsl'),
    });
    expect(result).toEqual({ kind: 'wildcard', targetRaw: 'example.com/dsl' });
  });
});

describe('Go import binding names', () => {
  it.each([
    ['"example.com/app/api/v2"', 'v2'],
    ['"example.com/app/storage"', 'endpoints'],
    ['alias "example.com/app/storage"', 'alias'],
    ['storage "example.com/app/storage"', 'storage'],
  ])('resolves %s from the package clause while preserving aliases', (spec, expected) => {
    const parsed = interpretGoImport(parseThenSplit(`import ${spec}`)[0]);
    if (!parsed) throw new Error('Expected parsed import');
    const result = resolveGoImportBinding(
      parsed,
      () => ['pkg/one.go', 'pkg/two.go'],
      () => `package ${expected === 'v2' ? 'v2' : 'endpoints'}\n`,
    );
    expect(result).toMatchObject({ kind: 'namespace', localName: expected });
  });

  it('retains only the dependency if package clauses conflict', () => {
    const parsed = interpretGoImport(parseThenSplit('import "example.com/app/pkg"')[0]);
    if (!parsed) throw new Error('Expected parsed import');
    expect(
      resolveGoImportBinding(
        parsed,
        () => ['a.go', 'b.go'],
        (file) => (file === 'a.go' ? 'package a' : 'package b'),
      ),
    ).toEqual({ kind: 'side-effect', targetRaw: 'example.com/app/pkg' });
  });

  it('does not guess a binding from an unreadable target', () => {
    const parsed = interpretGoImport(parseThenSplit('import "example.com/app/pkg"')[0]);
    if (!parsed) throw new Error('Expected parsed import');
    expect(
      resolveGoImportBinding(
        parsed,
        () => ['missing.go'],
        () => undefined,
      ),
    ).toEqual({
      kind: 'side-effect',
      targetRaw: 'example.com/app/pkg',
    });
  });
});

/** The config a repository whose only go.mod sits at its root captures. */
function rootModule(modulePath: string): GoWorkspaceConfig {
  return { modules: [{ modulePath, dir: '' }], workFiles: [] };
}

describe('Go import target resolution', () => {
  it('resolves module root imports to root package files', () => {
    const result = resolveGoImportTarget(
      'example.com/lib',
      'cmd/app/main.go',
      new Set(['root.go', 'extra.go', 'internal/model/model.go', 'root_test.go']),
      rootModule('example.com/lib'),
    );

    expect(result).toEqual(['extra.go', 'root.go']);
  });

  it('resolves sub-package imports under module root', () => {
    const result = resolveGoImportTarget(
      'example.com/lib/internal/models',
      'cmd/app/main.go',
      new Set(['internal/models/user.go', 'internal/models/repo.go', 'root.go']),
      rootModule('example.com/lib'),
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).sort()).toEqual([
      'internal/models/repo.go',
      'internal/models/user.go',
    ]);
  });

  it.each(['github.com/vendor/dep/internal/models', 'fmt', 'example.com/modular/internal/models'])(
    'rejects imports outside the go.mod module: %s',
    (targetRaw) => {
      const result = resolveGoImportTarget(
        targetRaw,
        'main.go',
        new Set(['internal/models/user.go', 'main.go']),
        rootModule('example.com/mod'),
      );

      expect(result).toBeNull();
    },
  );

  it('treats a semantic import-version suffix as part of the module path', () => {
    const result = resolveGoImportTarget(
      'example.com/mod/v2/internal/models',
      'cmd/app/main.go',
      new Set(['internal/models/user.go']),
      rootModule('example.com/mod/v2'),
    );

    expect(result).toEqual(['internal/models/user.go']);
  });

  it('rejects single-segment GOPATH suffix that collides with a local dir', () => {
    // "github.com/other/team/pkg" suffix-stripped would eventually
    // reach "pkg" which matches the local pkg/ dir — but we require
    // ≥2 segments in the GOPATH fallback, so it must not resolve.
    const result = resolveGoImportTarget(
      'github.com/other/team/pkg',
      'main.go',
      new Set(['pkg/util.go', 'main.go']),
    );

    expect(result).toBeNull();
  });

  it('resolves multi-segment GOPATH suffix that matches local dir', () => {
    // "github.com/other/team/pkg" where "team/pkg/" exists locally
    // — the 2-segment suffix "team/pkg" should still resolve.
    const result = resolveGoImportTarget(
      'github.com/other/team/pkg',
      'main.go',
      new Set(['team/pkg/util.go', 'main.go']),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result as string[]).toEqual(['team/pkg/util.go']);
  });
});

describe('Go import target resolution across several go.mod files', () => {
  /** No root module; neither service directory is named after its module. */
  const SERVICES: GoWorkspaceConfig = {
    modules: [
      { modulePath: 'github.com/acme/billing', dir: 'billing-service' },
      { modulePath: 'github.com/acme/orders', dir: 'orders-service' },
    ],
    workFiles: [],
  };
  /** A root module and a nested one whose tree it must not include. */
  const ROOT_AND_TOOLS: GoWorkspaceConfig = {
    modules: [
      { modulePath: 'example.com/app', dir: '' },
      { modulePath: 'example.com/tools', dir: 'tools' },
    ],
    workFiles: [],
  };
  const SERVICE_FILES = [
    'orders-service/internal/repository/store.go',
    'orders-service/cmd/main.go',
    'billing-service/internal/repository/store.go',
    'scripts/internal/repository/legacy.go',
  ];
  const ROOT_FILES = [
    'main.go',
    'internal/models/user.go',
    'tools/internal/models/gen.go',
    'tools/main.go',
  ];

  it.each<[string, GoWorkspaceConfig, readonly string[], string, string, string[] | null]>([
    [
      "the owning module's directory, not every directory with that tail",
      SERVICES,
      SERVICE_FILES,
      'github.com/acme/orders/internal/repository',
      'orders-service/cmd/main.go',
      ['orders-service/internal/repository/store.go'],
    ],
    [
      "a sibling module's directory",
      SERVICES,
      SERVICE_FILES,
      'github.com/acme/billing/internal/repository',
      'orders-service/cmd/main.go',
      ['billing-service/internal/repository/store.go'],
    ],
    [
      'nothing for a dependency that shares the tail',
      SERVICES,
      SERVICE_FILES,
      'github.com/vendor/dep/internal/repository',
      'orders-service/cmd/main.go',
      null,
    ],
    [
      'the GOPATH match for an importer outside every module',
      SERVICES,
      SERVICE_FILES,
      'github.com/vendor/scripts/internal/repository',
      'scripts/main.go',
      ['scripts/internal/repository/legacy.go'],
    ],
    [
      "the root module's own directory only",
      ROOT_AND_TOOLS,
      ROOT_FILES,
      'example.com/app/internal/models',
      'main.go',
      ['internal/models/user.go'],
    ],
    [
      "nothing inside the nested module for the root module's path",
      ROOT_AND_TOOLS,
      ROOT_FILES,
      'example.com/app/tools/internal/models',
      'main.go',
      null,
    ],
    [
      "a nested module's root package",
      ROOT_AND_TOOLS,
      ROOT_FILES,
      'example.com/tools',
      'main.go',
      ['tools/main.go'],
    ],
  ])('resolves to %s', (_case, config, files, targetRaw, fromFile, expected) => {
    expect(resolveGoImportTarget(targetRaw, fromFile, new Set(files), config)).toEqual(expected);
  });
});
