import { Bar } from './components';

// Paired JSX element (`<Bar>...</Bar>`). The query captures
// `jsx_opening_element` (NOT `jsx_closing_element`) so each JSX use
// emits exactly one CALLS edge — the closing tag would double-count.
export const useBar = () => <Bar>child text</Bar>;
