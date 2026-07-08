import { describe, expect, it } from 'vitest';
import {
  splitGoImportStatement,
  interpretGoImport,
  resolveGoImportTarget,
} from '../../../../src/core/ingestion/languages/go/index.js';
import { getGoParser } from '../../../../src/core/ingestion/languages/go/query.js';
import type { CaptureMatch } from 'gitnexus-shared';

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

describe('Go import target resolution', () => {
  it('resolves module root imports to root package files', () => {
    const result = resolveGoImportTarget(
      'example.com/lib',
      'cmd/app/main.go',
      new Set(['root.go', 'extra.go', 'internal/model/model.go', 'root_test.go']),
      { modulePath: 'example.com/lib' },
    );

    expect(result).toEqual(['extra.go', 'root.go']);
  });

  it('resolves sub-package imports under module root', () => {
    const result = resolveGoImportTarget(
      'example.com/lib/internal/models',
      'cmd/app/main.go',
      new Set(['internal/models/user.go', 'internal/models/repo.go', 'root.go']),
      { modulePath: 'example.com/lib' },
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).sort()).toEqual([
      'internal/models/repo.go',
      'internal/models/user.go',
    ]);
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
