import { Container } from './namespaced';

// Namespaced JSX — `<Container.Title />`. The query's
// `@reference.call.member` capture splits this into:
//
//   receiver: `Container`  (an identifier)
//   property: `Title`      (the leaf identifier)
//
// Note: Member-form JSX is NOT filtered by the PascalCase predicate —
// HTML element names can't contain dots, so any `.`-form is unambiguously
// a component reference.
export const useNamespaced = () => <Container.Title />;
