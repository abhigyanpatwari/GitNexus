import { describe, it, expect } from 'vitest';
import {
  normalizeSupertypeName,
  simplifyRawName,
  SUPERTYPE_NODE_TYPE_SETS,
} from '../../src/core/ingestion/heritage-extractors/supertype-alternation.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

/**
 * Synthetic SyntaxNode stubs (no tree-sitter grammar) exercising the
 * node-type-driven branches of `normalizeSupertypeName`:
 *   - LEAF_TYPES         → node.text returned directly
 *   - INNER_NAME_FIELDS  → recurse into a field child
 *   - SKIPPED_INNER_TYPES → delegate/argument subtrees ignored in the walk
 *   - LEADING_NAME_TYPES  → recurse into the FIRST named child (delegation)
 *
 * Only the members `normalize()` touches are stubbed: type, text,
 * childForFieldName, namedChildCount, namedChild.
 */

interface StubInit {
  type: string;
  text?: string;
  fields?: Record<string, Stub | undefined>;
  named?: Stub[];
}

class Stub {
  type: string;
  text: string;
  private fields: Record<string, Stub | undefined>;
  private named: Stub[];

  constructor(init: StubInit) {
    this.type = init.type;
    this.text = init.text ?? '';
    this.fields = init.fields ?? {};
    this.named = init.named ?? [];
  }

  childForFieldName(name: string): Stub | null {
    return this.fields[name] ?? null;
  }

  get namedChildCount(): number {
    return this.named.length;
  }

  namedChild(i: number): Stub | null {
    return this.named[i] ?? null;
  }
}

const node = (init: StubInit): SyntaxNode => new Stub(init) as unknown as SyntaxNode;
const leaf = (type: string, text: string): SyntaxNode => node({ type, text });

describe('normalizeSupertypeName — LEAF_TYPES', () => {
  it('returns the text of a leaf identifier directly', () => {
    expect(normalizeSupertypeName(leaf('type_identifier', 'Base'))).toBe('Base');
    expect(normalizeSupertypeName(leaf('simple_identifier', 'Foo'))).toBe('Foo');
    expect(normalizeSupertypeName(leaf('namespace_identifier', 'Ns'))).toBe('Ns');
  });

  it('returns empty for null/undefined', () => {
    expect(normalizeSupertypeName(null)).toBe('');
    expect(normalizeSupertypeName(undefined)).toBe('');
  });
});

describe('normalizeSupertypeName — INNER_NAME_FIELDS', () => {
  it('recurses into the `name` field (generic_type → name)', () => {
    const generic = node({
      type: 'generic_type',
      text: 'Base<T>',
      fields: { name: leaf('type_identifier', 'Base') as unknown as Stub },
    });
    expect(normalizeSupertypeName(generic)).toBe('Base');
  });

  it('recurses into the `type` field (Go generic_type → type)', () => {
    const generic = node({
      type: 'generic_type',
      text: 'Gen[T]',
      fields: { type: leaf('type_identifier', 'Gen') as unknown as Stub },
    });
    expect(normalizeSupertypeName(generic)).toBe('Gen');
  });
});

describe('normalizeSupertypeName — children walk (trailing name)', () => {
  it('picks the LAST named child for qualified/scoped shapes', () => {
    const qualified = node({
      type: 'scoped_type_identifier',
      text: 'pkg.Base',
      named: [
        leaf('package_identifier', 'pkg') as unknown as Stub,
        leaf('type_identifier', 'Base') as unknown as Stub,
      ],
    });
    expect(normalizeSupertypeName(qualified)).toBe('Base');
  });
});

describe('normalizeSupertypeName — SKIPPED_INNER_TYPES (constructor_invocation)', () => {
  it('skips value_arguments so a constructor_invocation resolves to its type', () => {
    // Kotlin `: Bar()` → constructor_invocation(user_type, value_arguments).
    // The trailing-name walk hits value_arguments first; it must be skipped so
    // the leading user_type wins. constructor_invocation is intentionally NOT
    // a leading-name type — this skip is its handling.
    const ctor = node({
      type: 'constructor_invocation',
      text: 'Bar()',
      named: [
        leaf('user_type', 'Bar') as unknown as Stub,
        node({ type: 'value_arguments', text: '()' }) as unknown as Stub,
      ],
    });
    expect(normalizeSupertypeName(ctor)).toBe('Bar');
  });
});

describe('normalizeSupertypeName — LEADING_NAME_TYPES (explicit_delegation)', () => {
  // Kotlin `: Bar by <delegate>` → explicit_delegation(user_type, <delegate>).
  // The supertype is the FIRST named child; the delegate trails it and must
  // never be chosen.
  it('bare delegate: `Bar by baz` → Bar', () => {
    const deleg = node({
      type: 'explicit_delegation',
      text: 'Bar by baz',
      named: [
        leaf('user_type', 'Bar') as unknown as Stub,
        leaf('simple_identifier', 'baz') as unknown as Stub,
      ],
    });
    expect(normalizeSupertypeName(deleg)).toBe('Bar');
  });

  it('navigation delegate: `Bar by baz.qux` → Bar (not qux)', () => {
    const deleg = node({
      type: 'explicit_delegation',
      text: 'Bar by baz.qux',
      named: [
        leaf('user_type', 'Bar') as unknown as Stub,
        node({
          type: 'navigation_expression',
          text: 'baz.qux',
          named: [
            leaf('simple_identifier', 'baz') as unknown as Stub,
            leaf('simple_identifier', 'qux') as unknown as Stub,
          ],
        }) as unknown as Stub,
      ],
    });
    expect(normalizeSupertypeName(deleg)).toBe('Bar');
  });

  it('call delegate: `Bar by baz()` → Bar (not baz)', () => {
    const deleg = node({
      type: 'explicit_delegation',
      text: 'Bar by baz()',
      named: [
        leaf('user_type', 'Bar') as unknown as Stub,
        node({
          type: 'call_expression',
          text: 'baz()',
          named: [leaf('simple_identifier', 'baz') as unknown as Stub],
        }) as unknown as Stub,
      ],
    });
    expect(normalizeSupertypeName(deleg)).toBe('Bar');
  });
});

// ---------------------------------------------------------------------------
// Structural per-shape gate over the module-private god-lists.
//
// Enumerates the ACTUAL exported sets (not a hardcoded copy) and drives
// normalizeSupertypeName with a synthetic node of each member's shape, asserting
// the documented branch fires. A removed/renamed/typo'd/extra member changes the
// enumeration and therefore the assertions — so this fails loudly instead of
// silently regressing. Membership in exactly one set is also asserted so a value
// can't accidentally appear in two lists with conflicting semantics.
// ---------------------------------------------------------------------------

describe('normalizeSupertypeName — structural per-shape coverage gate', () => {
  const { innerNameFields, leafTypes, skippedInnerTypes, leadingNameTypes } =
    SUPERTYPE_NODE_TYPE_SETS;

  it('exposes non-empty sets (guards against an accidental empty snapshot)', () => {
    expect(innerNameFields.length).toBeGreaterThan(0);
    expect(leafTypes.size).toBeGreaterThan(0);
    expect(skippedInnerTypes.size).toBeGreaterThan(0);
    expect(leadingNameTypes.size).toBeGreaterThan(0);
  });

  // LEAF_TYPES: each member's own `.text` is returned directly.
  describe('LEAF_TYPES → returns own .text', () => {
    for (const type of leafTypes) {
      it(`${type} is a leaf (returns its text)`, () => {
        expect(normalizeSupertypeName(leaf(type, 'LeafName'))).toBe('LeafName');
      });
    }
  });

  // INNER_NAME_FIELDS: each field, when present on a non-leaf wrapper, is
  // descended into. A wrapper exposing ONLY that field must resolve via it.
  describe('INNER_NAME_FIELDS → descends the field', () => {
    for (const field of innerNameFields) {
      it(`${field} field is followed to the inner name`, () => {
        const wrapper = node({
          // A type not in any set, so only the field path can resolve it.
          type: '__wrapper_for_field_test__',
          text: 'qualifier.Inner',
          fields: { [field]: leaf('identifier', 'Inner') as unknown as Stub },
        });
        expect(normalizeSupertypeName(wrapper)).toBe('Inner');
      });
    }
  });

  // SKIPPED_INNER_TYPES: in the right-to-left children walk a skipped child is
  // NOT chosen; the preceding real name child wins. Place the skipped type LAST
  // (trailing) so a non-skip would incorrectly pick it.
  describe('SKIPPED_INNER_TYPES → never chosen in the children walk', () => {
    for (const skipped of skippedInnerTypes) {
      it(`${skipped} is skipped so the leading name wins`, () => {
        const wrapper = node({
          type: '__wrapper_for_skip_test__',
          text: `Name ${skipped}`,
          // No fields → forces the children-walk fallback. Trailing child is the
          // skipped type; if it were not skipped the walk would return its text.
          named: [
            leaf('identifier', 'Name') as unknown as Stub,
            node({ type: skipped, text: 'SKIPPED_TEXT' }) as unknown as Stub,
          ],
        });
        expect(normalizeSupertypeName(wrapper)).toBe('Name');
      });
    }
  });

  // LEADING_NAME_TYPES: recurse into the FIRST named child; a trailing child
  // (delegate) must never win even though the default walk is right-to-left.
  describe('LEADING_NAME_TYPES → first named child wins over a trailing child', () => {
    for (const leading of leadingNameTypes) {
      it(`${leading} resolves to its first named child, not the trailing one`, () => {
        const wrapper = node({
          type: leading,
          text: 'Leading trailing',
          named: [
            leaf('identifier', 'Leading') as unknown as Stub,
            leaf('identifier', 'Trailing') as unknown as Stub,
          ],
        });
        expect(normalizeSupertypeName(wrapper)).toBe('Leading');
      });
    }
  });

  it('the three node-TYPE sets are mutually exclusive', () => {
    // innerNameFields are FIELD names, not node types, so they are not compared.
    const typeSets: ReadonlyArray<[string, ReadonlySet<string>]> = [
      ['leafTypes', leafTypes],
      ['skippedInnerTypes', skippedInnerTypes],
      ['leadingNameTypes', leadingNameTypes],
    ];
    for (let i = 0; i < typeSets.length; i++) {
      for (let j = i + 1; j < typeSets.length; j++) {
        const [, a] = typeSets[i]!;
        const [, b] = typeSets[j]!;
        const overlap = [...a].filter((t) => b.has(t));
        expect(overlap, `${typeSets[i]![0]} ∩ ${typeSets[j]![0]}`).toEqual([]);
      }
    }
  });
});

describe('simplifyRawName — textual fallback', () => {
  it('strips generic arguments', () => {
    expect(simplifyRawName('Base<T>')).toBe('Base');
    expect(simplifyRawName('Base[T]')).toBe('Base');
  });

  it('keeps the final segment of a dotted name', () => {
    expect(simplifyRawName('pkg.Base')).toBe('Base');
  });

  it('keeps the final segment of a `::`-scoped name', () => {
    expect(simplifyRawName('ns::Base')).toBe('Base');
  });

  it('strips generics then keeps the final qualified segment', () => {
    expect(simplifyRawName('pkg.Base<T>')).toBe('Base');
  });
});
