// Namespaced component — the canonical `<Container.Title />` idiom
// (used by libraries like Radix UI, shadcn/ui, Headless UI). Exposes a
// `Container` object whose members are themselves React components, so
// JSX consumers write `<Container.Title>` instead of importing each
// piece individually.
//
// The TSX grammar represents `<Foo.Bar />` as `jsx_self_closing_element
// name: (member_expression ...)`. Our query's `@reference.call.member`
// capture decomposes the member chain so the downstream member-call
// resolver can route the edge to the right `Title` definition.

const Title = () => 'title';

export const Container = { Title };
