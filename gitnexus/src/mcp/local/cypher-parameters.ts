/**
 * Which `$name` parameters a caller's Cypher statement names but its `params`
 * lack. The engine reports such a statement only at run time, with an error
 * that names no exception category, so the cypher tool checks the text first
 * to tell the caller's mistake from an engine failure.
 */

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Index of the quote that closes the literal opened at `open`, or -1. */
function closingQuote(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (quote !== '`' && text[i] === '\\') {
      i++;
    } else if (text[i] === quote) {
      // A doubled backtick is an escaped backtick inside a quoted name.
      if (quote === '`' && text[i + 1] === '`') i++;
      else return i;
    }
  }
  return -1;
}

/**
 * The parameter names `statement` refers to, skipping string literals, quoted
 * names and comments, or undefined when it cannot be read with confidence: an
 * unterminated literal or comment, or a `$` followed by neither a plain name
 * nor a quoted one (a positional parameter, a lone `$`). The engine keys a
 * quoted parameter by its spelling with the backticks, so that is its name.
 */
function referencedParameters(statement: string): Set<string> | undefined {
  const names = new Set<string>();
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = closingQuote(statement, i);
      if (end < 0) return undefined;
      i = end + 1;
    } else if (statement.startsWith('//', i)) {
      const end = statement.indexOf('\n', i);
      i = end < 0 ? statement.length : end + 1;
    } else if (statement.startsWith('/*', i)) {
      const end = statement.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 2;
    } else if (c === '$' && statement[i + 1] === '`') {
      const end = closingQuote(statement, i + 1);
      if (end < 0) return undefined;
      names.add(statement.slice(i + 1, end + 1));
      i = end + 1;
    } else if (c === '$') {
      const name = PARAMETER_NAME.exec(statement.slice(i + 1))?.[0];
      if (!name) return undefined;
      names.add(name);
      i += 1 + name.length;
    } else {
      i++;
    }
  }
  return names;
}

/**
 * The parameters `statement` names that `params` does not supply, in order of
 * first use. Empty when it names none, when all are supplied, or when the
 * statement cannot be read with confidence.
 */
export function missingCypherParameters(
  statement: string,
  params: Readonly<Record<string, unknown>>,
): string[] {
  const referenced = referencedParameters(statement);
  if (!referenced) return [];
  return [...referenced].filter((name) => !Object.hasOwn(params, name));
}
