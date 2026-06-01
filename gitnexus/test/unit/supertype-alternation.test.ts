import { describe, it, expect } from 'vitest';
import {
  buildSupertypeAlternation,
  normalizeSupertypeName,
} from '../../src/core/ingestion/heritage-extractors/supertype-alternation.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Mock AST node helpers (mirror heritage-extraction.test.ts style)
// ---------------------------------------------------------------------------

interface MockNode {
  type: string;
  text: string;
  fields?: Record<string, MockNode>;
  named?: MockNode[];
}

function n(type: string, text: string, opts: Partial<MockNode> = {}): MockNode {
  return { type, text, fields: opts.fields, named: opts.named };
}

/** Adapt a MockNode tree into the SyntaxNode surface the normalizer uses. */
function asSyntaxNode(node: MockNode): SyntaxNode {
  const named = node.named ?? [];
  return {
    type: node.type,
    text: node.text,
    namedChildCount: named.length,
    namedChild: (i: number) => (named[i] ? asSyntaxNode(named[i]) : null),
    childForFieldName: (name: string) => {
      const child = node.fields?.[name];
      return child ? asSyntaxNode(child) : null;
    },
  } as unknown as SyntaxNode;
}

function norm(node: MockNode): string {
  return normalizeSupertypeName(asSyntaxNode(node));
}

// ---------------------------------------------------------------------------
// buildSupertypeAlternation
// ---------------------------------------------------------------------------

describe('buildSupertypeAlternation', () => {
  it('emits a single shape without brackets', () => {
    expect(buildSupertypeAlternation({ shapes: ['identifier'] }, 'heritage.extends')).toBe(
      '(identifier) @heritage.extends',
    );
  });

  it('emits a bracketed one-of for multiple shapes', () => {
    expect(
      buildSupertypeAlternation(
        { shapes: ['type_identifier', 'generic_type', 'scoped_type_identifier'] },
        'heritage.extends',
      ),
    ).toBe('[(type_identifier) (generic_type) (scoped_type_identifier)] @heritage.extends');
  });

  it('de-duplicates repeated shapes', () => {
    expect(
      buildSupertypeAlternation({ shapes: ['identifier', 'identifier'] }, 'heritage.implements'),
    ).toBe('(identifier) @heritage.implements');
  });

  it('throws on an empty shape list', () => {
    expect(() => buildSupertypeAlternation({ shapes: [] }, 'heritage.extends')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeSupertypeName — per-shape, modeled on real grammar AST shapes
// ---------------------------------------------------------------------------

describe('normalizeSupertypeName', () => {
  it('returns the text of a bare identifier-like leaf', () => {
    expect(norm(n('type_identifier', 'Base'))).toBe('Base');
    expect(norm(n('identifier', 'Base'))).toBe('Base');
    expect(norm(n('constant', 'Base'))).toBe('Base');
  });

  it('returns empty for null/undefined', () => {
    expect(normalizeSupertypeName(null)).toBe('');
    expect(normalizeSupertypeName(undefined)).toBe('');
  });

  // Java / Rust generic_type -> name field
  it('strips generics via name field (Foo<T> -> Foo)', () => {
    const node = n('generic_type', 'Foo<T>', {
      fields: { name: n('type_identifier', 'Foo') },
      named: [n('type_identifier', 'Foo'), n('type_arguments', '<T>')],
    });
    expect(norm(node)).toBe('Foo');
  });

  // Java scoped_type_identifier (children only: pkg, Base)
  it('takes the trailing segment of a scoped_type_identifier (pkg.Base -> Base)', () => {
    const node = n('scoped_type_identifier', 'pkg.Base', {
      fields: { name: n('type_identifier', 'Base') },
      named: [n('type_identifier', 'pkg'), n('type_identifier', 'Base')],
    });
    expect(norm(node)).toBe('Base');
  });

  // Java scoped_type_identifier with NO name field (children-only fallback)
  it('falls back to last named child when no name field (pkg.Base -> Base)', () => {
    const node = n('scoped_type_identifier', 'pkg.Base', {
      named: [n('type_identifier', 'pkg'), n('type_identifier', 'Base')],
    });
    expect(norm(node)).toBe('Base');
  });

  // C# qualified_name
  it('takes name field of qualified_name (ns.Base -> Base)', () => {
    const node = n('qualified_name', 'ns.Base', {
      fields: { qualifier: n('identifier', 'ns'), name: n('identifier', 'Base') },
      named: [n('identifier', 'ns'), n('identifier', 'Base')],
    });
    expect(norm(node)).toBe('Base');
  });

  // C# generic_name (children: identifier + type_argument_list)
  it('strips C# generic_name (IFoo<T> -> IFoo)', () => {
    const node = n('generic_name', 'IFoo<T>', {
      named: [n('identifier', 'IFoo'), n('type_argument_list', '<T>')],
    });
    expect(norm(node)).toBe('IFoo');
  });

  // C# primary_constructor_base_type -> type field (qualified_name)
  it('resolves C# primary_constructor_base_type to its base name (pkg.Base(X) -> Base)', () => {
    const node = n('primary_constructor_base_type', 'pkg.Base(X)', {
      fields: {
        type: n('qualified_name', 'pkg.Base', {
          fields: { name: n('identifier', 'Base') },
        }),
      },
    });
    expect(norm(node)).toBe('Base');
  });

  // TS / JS member_expression -> property
  it('takes property of a member_expression (ns.Base -> Base)', () => {
    const node = n('member_expression', 'ns.Base', {
      fields: {
        object: n('identifier', 'ns'),
        property: n('property_identifier', 'Base'),
      },
    });
    expect(norm(node)).toBe('Base');
  });

  // TS nested_type_identifier -> name field
  it('takes name of a nested_type_identifier (ns.B -> B)', () => {
    const node = n('nested_type_identifier', 'ns.B', {
      fields: { module: n('identifier', 'ns'), name: n('type_identifier', 'B') },
    });
    expect(norm(node)).toBe('B');
  });

  // Python attribute -> attribute field
  it('takes attribute of a Python attribute (models.Model -> Model)', () => {
    const node = n('attribute', 'models.Model', {
      fields: {
        object: n('identifier', 'models'),
        attribute: n('identifier', 'Model'),
      },
    });
    expect(norm(node)).toBe('Model');
  });

  // Python subscript -> value field
  it('takes value of a Python subscript (Generic[T] -> Generic)', () => {
    const node = n('subscript', 'Generic[T]', {
      fields: { value: n('identifier', 'Generic') },
    });
    expect(norm(node)).toBe('Generic');
  });

  // Go qualified_type -> name field
  it('takes name of a Go qualified_type (pkg.Base -> Base)', () => {
    const node = n('qualified_type', 'pkg.Base', {
      fields: {
        package: n('package_identifier', 'pkg'),
        name: n('type_identifier', 'Base'),
      },
    });
    expect(norm(node)).toBe('Base');
  });

  // Rust scoped_type_identifier -> name field
  it('takes name of a Rust scoped_type_identifier (ns::Trait -> Trait)', () => {
    const node = n('scoped_type_identifier', 'ns::Trait', {
      fields: { path: n('identifier', 'ns'), name: n('type_identifier', 'Trait') },
    });
    expect(norm(node)).toBe('Trait');
  });

  // C++ qualified_identifier wrapping a template_type (children-walk fallback)
  it('resolves C++ qualified_identifier wrapping a template_type (ns::Base<T> -> Base)', () => {
    const templateType = n('template_type', 'Base<T>', {
      fields: { name: n('type_identifier', 'Base') },
      named: [n('type_identifier', 'Base'), n('template_argument_list', '<T>')],
    });
    const node = n('qualified_identifier', 'ns::Base<T>', {
      fields: { scope: n('namespace_identifier', 'ns'), name: templateType },
      named: [n('namespace_identifier', 'ns'), templateType],
    });
    expect(norm(node)).toBe('Base');
  });

  // Kotlin user_type with qualifier (children: pkg, Bar)
  it('takes trailing identifier of a Kotlin qualified user_type (pkg.Bar -> Bar)', () => {
    const node = n('user_type', 'pkg.Bar', {
      named: [n('type_identifier', 'pkg'), n('type_identifier', 'Bar')],
    });
    expect(norm(node)).toBe('Bar');
  });

  // Kotlin explicit_delegation -> inner user_type, NOT the delegate expr
  it('Kotlin explicit_delegation resolves to the supertype, not the delegate (Bar by baz -> Bar)', () => {
    const node = n('explicit_delegation', 'Bar by baz', {
      named: [
        n('user_type', 'Bar', { named: [n('type_identifier', 'Bar')] }),
        n('call_expression', 'baz', { named: [n('simple_identifier', 'baz')] }),
      ],
    });
    expect(norm(node)).toBe('Bar');
  });

  // Kotlin constructor_invocation -> inner user_type, skip value_arguments
  it('Kotlin constructor_invocation resolves to the supertype (Bar(x) -> Bar)', () => {
    const node = n('constructor_invocation', 'Bar(x)', {
      named: [
        n('user_type', 'Bar', { named: [n('type_identifier', 'Bar')] }),
        n('value_arguments', '(x)', { named: [n('identifier', 'x')] }),
      ],
    });
    expect(norm(node)).toBe('Bar');
  });

  // Ruby scope_resolution -> name field
  it('takes trailing constant of a Ruby scope_resolution (Base::Sup -> Sup)', () => {
    const node = n('scope_resolution', 'Base::Sup', {
      fields: { scope: n('constant', 'Base'), name: n('constant', 'Sup') },
    });
    expect(norm(node)).toBe('Sup');
  });
});
