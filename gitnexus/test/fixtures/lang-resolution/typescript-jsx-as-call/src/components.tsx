// Component targets used by the JSX-as-call tests. The bodies are
// trivial — what matters is that they're declared as named arrow
// functions returning JSX (the canonical React component shape) so the
// scope-resolution pipeline emits Function defs for them.

export const Foo = (): string => 'foo';

export const Bar = (): string => 'bar';

export const Inner = (): string => 'inner';

export const Outer = (): string => 'outer';
