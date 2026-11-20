import type { QueryLanguageHooks } from '../query-providers.js';

// Only pub declarations are accessible through a file's namespace from another file.
export const zigQueryHooks: QueryLanguageHooks = { notExportedIsFilePrivate: true };
