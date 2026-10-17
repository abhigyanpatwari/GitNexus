import { describe, expect, it } from 'vitest';
import { getCParser } from '../gitnexus/src/core/ingestion/languages/c/query.js';
import { splitCInclude } from '../gitnexus/src/core/ingestion/languages/c/import-decomposer.js';
import { interpretCImport } from '../gitnexus/src/core/ingestion/languages/c/interpret.js';
import { cScopeResolver } from '../gitnexus/src/core/ingestion/languages/c/scope-resolver.js';
import type { SyntaxNode } from '../gitnexus/src/core/ingestion/utils/ast-helpers.js';

function parseInclude(spelling: string) {
  const tree = getCParser().parse(`#include ${spelling}\n`);
  const node = tree.rootNode.namedChildren.find((child) => child.type === 'preproc_include');
  expect(node, 'native parser must produce an include node').toBeDefined();
  const captures = splitCInclude(node as SyntaxNode);
  return captures === null ? null : interpretCImport(captures);
}

// Header identity is public behavior. Bare targets or targets carrying their
// literal delimiters are both valid; no private marker field is prescribed.
function headerIdentity(target: string): string {
  if (
    (target.startsWith('<') && target.endsWith('>')) ||
    (target.startsWith('"') && target.endsWith('"'))
  )
    return target.slice(1, -1);
  return target;
}

const files = new Set([
  'src/main.c',
  'src/stdio.h',
  'include/project.h',
  'src/local.h',
  'include/util.h',
]);

describe.each([
  { name: 'workspace headers', files, resolutionConfig: undefined },
  {
    name: 'discovered headers',
    files: new Set(['src/main.c']),
    resolutionConfig: new Set([...files].filter((file) => file.endsWith('.h'))),
  },
])('hidden oracle: retained C include provenance ($name)', ({ files, resolutionConfig }) => {
  it.each([
    ['<stdio.h>', 'stdio.h', null],
    ['<project.h>', 'project.h', null],
    ['"stdio.h"', 'stdio.h', 'src/stdio.h'],
    ['"local.h"', 'local.h', 'src/local.h'],
    ['"../include/util.h"', '../include/util.h', 'include/util.h'],
  ] as const)('retains and resolves literal %s', (spelling, header, expected) => {
    const parsedImport = parseInclude(spelling);
    expect(parsedImport, `literal include ${spelling} must be retained`).not.toBeNull();
    expect(parsedImport!.kind).toBe('wildcard');
    expect(headerIdentity(parsedImport!.targetRaw), 'retained header identity').toBe(header);
    const resolved = cScopeResolver.resolveImportTarget(
      parsedImport!.targetRaw,
      'src/main.c',
      files,
      resolutionConfig,
      { parsedFiles: [], parsedImport: parsedImport! },
    );
    const targets = resolved === null ? [] : typeof resolved === 'string' ? [resolved] : resolved;
    expect(targets, `include ${spelling} resolution`).toEqual(expected === null ? [] : [expected]);
  });

  it('does not invent a literal import for a computed macro include', () => {
    expect(parseInclude('HEADER_MACRO')).toBeNull();
  });
});
