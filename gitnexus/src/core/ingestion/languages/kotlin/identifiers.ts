/** Semantic identifier spelling; source graph names and ranges remain unchanged. */
export const canonicalName = (name: string): string =>
  name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name;
