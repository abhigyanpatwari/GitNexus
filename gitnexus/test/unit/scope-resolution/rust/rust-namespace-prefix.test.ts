/**
 * Rust opts out of the shared "already namespaced" guard (#2741 review).
 *
 * `tagNamespacePrefixes` skips a def whose `qualifiedName` already equals, or is
 * prefixed by, its enclosing namespace path — correct for C++/C#, where the
 * qualified name really does carry the namespace. Rust qualified names never do,
 * so that guard fired on a coincidence: in `mod a { pub fn a() }` the member's
 * name equals its module's name, the prefix was skipped, and the member was left
 * looking like it belonged to the PARENT module.
 */
import { describe, it, expect } from 'vitest';
import { emitRustScopeCaptures } from '../../../../src/core/ingestion/languages/rust/index.js';
import { extract } from '../../../../src/core/ingestion/scope-extractor.js';
import { rustProvider } from '../../../../src/core/ingestion/languages/rust.js';
import { populateRustOwners } from '../../../../src/core/ingestion/languages/rust/method-owners.js';

function defsFor(source: string) {
  const parsed = extract(emitRustScopeCaptures(source, 'src/lib.rs'), 'src/lib.rs', rustProvider);
  populateRustOwners(parsed);
  return parsed.localDefs;
}

describe('Rust namespace-prefix tagging', () => {
  it('tags a member whose name matches its own module', () => {
    const fn = defsFor('pub mod a { pub fn a() -> usize { 1 } }\n').find(
      (d) => d.type === 'Function',
    );
    expect(fn).toMatchObject({ qualifiedName: 'a', namespacePrefix: 'a' });
  });

  it('tags a member whose name differs from its module', () => {
    const fn = defsFor('pub mod tools { pub fn dispatch() -> usize { 1 } }\n').find(
      (d) => d.type === 'Function',
    );
    expect(fn).toMatchObject({ qualifiedName: 'dispatch', namespacePrefix: 'tools' });
  });

  it('composes nested module prefixes', () => {
    const fn = defsFor('pub mod outer { pub mod inner { pub fn f() -> usize { 1 } } }\n').find(
      (d) => d.type === 'Function',
    );
    expect(fn).toMatchObject({ namespacePrefix: 'outer.inner' });
  });

  it('leaves a crate-root item untagged', () => {
    const fn = defsFor('pub fn f() -> usize { 1 }\n').find((d) => d.type === 'Function');
    expect(fn?.namespacePrefix).toBeUndefined();
  });

  it('does not tag the module def itself', () => {
    const ns = defsFor('pub mod a { pub fn a() -> usize { 1 } }\n').find(
      (d) => d.type === 'Namespace',
    );
    expect(ns?.namespacePrefix).toBeUndefined();
  });
});
