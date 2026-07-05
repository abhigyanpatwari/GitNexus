import * as ns from './base';

// Qualified-generic bases: `extends ns.Box<string>` (extends_clause value is a
// member_expression, type_arguments a sibling) and `implements ns.IFoo<string>`
// (implements_clause -> generic_type wrapping a nested_type_identifier). Both
// resolve by their trailing simple name (Box / IFoo).
export class Service extends ns.Box<string> implements ns.IFoo<string> {
  foo(t: string): void {}
}

// Qualified non-generic bases: `extends ns.Base` (member_expression) and
// `implements ns.IBar` (nested_type_identifier).
export class Plain extends ns.Base implements ns.IBar {
  bar(): void {}
}
