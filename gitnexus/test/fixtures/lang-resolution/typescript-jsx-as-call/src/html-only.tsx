// Pure-HTML JSX — `<div>`, `<span>`, `<button>`. By JSX convention,
// lowercase-first-character identifiers are native DOM elements (NOT
// React components). The query's `(#match? @reference.name "^[A-Z]")`
// predicate filters these out, so this caller must NOT emit any CALLS
// edges to identifiers `div` / `span` / `button`.
export const useHtml = () => (
  <div>
    <span>text</span>
    <button>click</button>
  </div>
);
