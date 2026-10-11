import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { finalizeScopeModel } from '../../../../src/core/ingestion/finalize-orchestrator.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rustScopeResolver } from '../../../../src/core/ingestion/languages/rust/scope-resolver.js';
import { populateRustRangeBindings } from '../../../../src/core/ingestion/languages/rust/range-binding.js';
import { lookupNameClaim } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';

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
  return finalizeScopeModel([]);
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

function populateWorkspace(sources: Record<string, string>) {
  const parsedFiles = Object.entries(sources).map(([path, source]) => parse(source, path));
  const indexes = finalizeScopeModel(parsedFiles, {
    hooks: {
      importsBindAtLexicalScope: true,
      resolveImportTarget: (targetRaw) => {
        const moduleName = targetRaw.split('::')[1];
        const targetPath = `src/${moduleName}.rs`;
        return targetPath in sources ? targetPath : null;
      },
    },
  });
  populateRustRangeBindings(parsedFiles, indexes, {
    fileContents: new Map(Object.entries(sources)),
  });
  return parsedFiles[0]!;
}

describe('Rust factory inference respects initializer ownership', () => {
  it('does not attach a later shadowing declaration type to an earlier receiver', () => {
    const sources = {
      'src/lib.rs': `fn run() {
  use crate::left::make_left;
  use crate::right::make_right;
  let item = make_left();
  item.save();
  let item = make_right();
  item.save();
}`,
      'src/left.rs': 'pub struct Left {} pub fn make_left() -> Left { Left {} }',
      'src/right.rs': 'pub struct Right {} pub fn make_right() -> Right { Right {} }',
    };
    const parsed = populateWorkspace(sources);
    const indexes = finalizeScopeModel([parsed]);
    const receiverScope = parsed.scopes.find((scope) => scope.typeBindings.has('item'))!;
    const earlier = lookupNameClaim(receiverScope.id, 'item', indexes, {
      position: { startLine: 5, startCol: 2 },
    });
    const later = lookupNameClaim(receiverScope.id, 'item', indexes, {
      position: { startLine: 7, startCol: 2 },
    });
    expect(earlier.bindings.map((binding) => binding.def.nodeId)).toEqual([
      'def:src/lib.rs#4:2:Variable:item',
    ]);
    expect(earlier.typeBinding).toBeUndefined();
    expect(later.bindings.map((binding) => binding.def.nodeId)).toEqual([
      'def:src/lib.rs#6:2:Variable:item',
    ]);
    expect(later.typeBinding?.rawName).toBe('Right');
    expect(later.typeBinding?.declaredAtScope).toContain('src/right.rs');
    expect(later.typeBinding?.bindingRange?.startLine).toBe(6);
  });

  it.each([
    ['unresolved target', 'use crate::missing::make;'],
    ['missing export', 'use crate::empty::make;'],
  ])('does not infer a workspace homonym through a %s', (_label, localImport) => {
    const parsed = populateWorkspace({
      'src/lib.rs': `fn run() { ${localImport} let item = make(); for entry in make() {} }`,
      'src/unrelated.rs': 'pub struct Wrong {} pub fn make() -> Vec<Wrong> { vec![] }',
      'src/empty.rs': 'pub fn another() {}',
    });
    const inferred = parsed.scopes.flatMap((scope) =>
      [...scope.typeBindings].filter(
        ([name, type]) =>
          (name === 'item' || name === 'entry') && /^(Vec|Wrong)$/.test(type.rawName),
      ),
    );
    expect(inferred).toEqual([]);
  });

  it('does not infer imported factory returns through a parameter', () => {
    const parsed = populateWorkspace({
      'src/lib.rs':
        'use crate::target::make; fn run(make: F) { let item = make(); for entry in make() {} }',
      'src/target.rs': 'pub struct Wrong {} pub fn make() -> Vec<Wrong> { vec![] }',
    });
    expect(
      parsed.scopes
        .flatMap((scope) => [...scope.typeBindings])
        .filter(
          ([name, type]) =>
            (name === 'item' || name === 'entry') && /^(Vec|Wrong)$/.test(type.rawName),
        ),
    ).toEqual([]);
  });

  it.each([
    'let (make, _) = supplied; let item = make();',
    'for make in supplied { let item = make(); }',
    'match supplied { make => { let item = make(); } }',
    'if let Some(make) = supplied { let item = make(); }',
    'let closure = |make| { let item = make(); };',
  ])('does not bypass the runtime pattern in %s', (body) => {
    const parsed = populateWorkspace({
      'src/lib.rs': `use crate::target::make; fn run() { ${body} }`,
      'src/target.rs': 'pub struct Wrong {} pub fn make() -> Wrong { Wrong {} }',
    });
    expect(
      parsed.scopes
        .flatMap((scope) => [...scope.typeBindings])
        .filter(([name, type]) => name === 'item' && type.rawName === 'Wrong'),
    ).toEqual([]);
  });

  it('retains each locally imported producer declaration scope for equal return spellings', () => {
    const parsed = populateWorkspace({
      'src/lib.rs': `
        fn left() { use crate::left::make; let left_item = make(); for left_entry in make() {} }
        fn right() { use crate::right::make; let right_item = make(); for right_entry in make() {} }
      `,
      'src/left.rs': 'pub struct Item {} pub fn make() -> Vec<Item> { vec![] }',
      'src/right.rs': 'pub struct Item {} pub fn make() -> Vec<Item> { vec![] }',
    });
    for (const side of ['left', 'right']) {
      const item = parsed.scopes
        .flatMap((scope) => [...scope.typeBindings])
        .find(([name, type]) => name === `${side}_item` && type.rawName === 'Vec')?.[1];
      const entry = parsed.scopes
        .flatMap((scope) => [...scope.typeBindings])
        .find(([name]) => name === `${side}_entry`)?.[1];
      expect(item?.declaredAtScope).toContain(`src/${side}.rs`);
      expect(entry?.rawName).toBe('Item');
      expect(entry?.declaredAtScope).toContain(`src/${side}.rs`);
    }
  });

  it('does not let a later local binding change its own initializer factory', () => {
    const parsed = populateWorkspace({
      'src/lib.rs': 'fn run() { use crate::target::make; let make = make(); }',
      'src/target.rs': 'pub struct Item {} pub fn make() -> Item { Item {} }',
    });
    const inferred = parsed.scopes
      .flatMap((scope) => [...scope.typeBindings])
      .find(([name, type]) => name === 'make' && type.rawName === 'Item')?.[1];
    expect(inferred?.declaredAtScope).toContain('src/target.rs');
  });

  it('does not infer destructured field types through an unresolved local type import', () => {
    const parsed = populateWorkspace({
      'src/lib.rs':
        'fn run() { use crate::missing::Container; let Container { item } = supplied; }',
      'src/target.rs': 'pub struct Wrong {} pub struct Container { pub item: Wrong }',
    });
    expect(
      parsed.scopes
        .flatMap((scope) => [...scope.typeBindings])
        .filter(([name, type]) => name === 'item' && type.rawName === 'Wrong'),
    ).toEqual([]);
  });
});

describe('Rust local module import targets', () => {
  it('retains both module and custom-root layouts for an unknown standalone source', () => {
    const owner = parse('mod user; use user::User;', 'app.rs');
    const moduleChild = parse('pub struct User {}', 'app/user.rs');
    const rootChild = parse('pub struct User {}', 'user.rs');
    const files = new Set([owner.filePath, moduleChild.filePath, rootChild.filePath]);
    const context = {
      parsedFiles: [owner, moduleChild, rootChild],
      parsedImport: owner.parsedImports[0],
    };
    const target = rustScopeResolver.resolveImportTarget(
      'user::User',
      owner.filePath,
      files,
      undefined,
      context,
    );
    expect(Array.isArray(target) ? [...target].sort() : target).toEqual(['app/user.rs', 'user.rs']);
  });

  it('resolves a modern relative use against its declared child module before a crate-root homonym', () => {
    const owner = parse('pub mod handler; pub use handler::Handler;', 'src/models/mod.rs');
    const child = parse('pub struct Handler {}', 'src/models/handler.rs');
    const homonym = parse('pub struct Handler {}', 'src/handler.rs');
    const files = new Set([owner.filePath, child.filePath, homonym.filePath]);
    const context = { parsedFiles: [owner, child, homonym], parsedImport: owner.parsedImports[0] };
    expect(
      rustScopeResolver.resolveImportTarget(
        'handler::Handler',
        owner.filePath,
        files,
        undefined,
        context,
      ),
    ).toBe(child.filePath);
    expect(
      rustScopeResolver.resolveImportTarget(
        'crate::handler::Handler',
        owner.filePath,
        files,
        undefined,
        context,
      ),
    ).toBe(homonym.filePath);
  });
});
