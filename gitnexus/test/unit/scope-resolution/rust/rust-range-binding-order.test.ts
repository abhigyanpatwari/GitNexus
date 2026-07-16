import { describe, expect, it } from 'vitest';
import type { ParsedFile, ScopeResolutionIndexes } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rustScopeResolver } from '../../../../src/core/ingestion/languages/rust/scope-resolver.js';
import { populateRustRangeBindings } from '../../../../src/core/ingestion/languages/rust/range-binding.js';

/**
 * Regression coverage for #2481: field and identity-method type bindings must
 * be published for the whole workspace before any file resolves its pending
 * assignments. Before the two-phase split, an importer processed ahead of its
 * defining file missed those bindings purely because of file order.
 */

interface ResolverLike {
  languageProvider: Parameters<typeof extractParsedFile>[0];
  populateOwners: (p: ParsedFile) => void;
}

function parse(src: string, path: string): ParsedFile {
  const resolver = rustScopeResolver as unknown as ResolverLike;
  const parsed = extractParsedFile(resolver.languageProvider, src, path);
  if (parsed === undefined) throw new Error(`scope extraction failed for ${path}`);
  resolver.populateOwners(parsed);
  return parsed;
}

function makeEmptyIndexes(): ScopeResolutionIndexes {
  return {
    bindings: new Map(),
    bindingAugmentations: new Map(),
    imports: [],
    scopeTree: { roots: [] },
    methodDispatch: new Map(),
    sccs: [],
  } as unknown as ScopeResolutionIndexes;
}

function boundTypeOf(parsed: ParsedFile, variableName: string): string | undefined {
  for (const scope of parsed.scopes) {
    const binding = scope.typeBindings.get(variableName);
    if (binding !== undefined) return binding.rawName;
  }
  return undefined;
}

const DEFINER = `pub struct City {
    pub name: String,
}

impl City {
    pub fn save(&self) {}
}
`;

const IMPORTER = `fn make_city() -> City {
    City { name: String::new() }
}

fn run() {
    let city = make_city();
    let copy = city.clone();
    let label = city.name;
    copy.save();
    let _ = label;
}
`;

describe('populateRustRangeBindings publish order (#2481)', () => {
  it('binds cross-file member types when the importer is processed before the definer', () => {
    const importer = parse(IMPORTER, 'src/app.rs');
    const definer = parse(DEFINER, 'src/city.rs');
    const fileContents = new Map<string, string>([
      ['src/app.rs', IMPORTER],
      ['src/city.rs', DEFINER],
    ]);

    populateRustRangeBindings([importer, definer], makeEmptyIndexes(), { fileContents });

    expect(boundTypeOf(importer, 'copy')).toBe('City');
    expect(boundTypeOf(importer, 'label')).toBe('String');
  });

  it('produces the same bindings when the definer is processed first', () => {
    const definer = parse(DEFINER, 'src/city.rs');
    const importer = parse(IMPORTER, 'src/app.rs');
    const fileContents = new Map<string, string>([
      ['src/city.rs', DEFINER],
      ['src/app.rs', IMPORTER],
    ]);

    populateRustRangeBindings([definer, importer], makeEmptyIndexes(), { fileContents });

    expect(boundTypeOf(importer, 'copy')).toBe('City');
    expect(boundTypeOf(importer, 'label')).toBe('String');
  });
});
