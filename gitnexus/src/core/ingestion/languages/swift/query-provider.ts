import type { QueryLanguageHooks } from '../query-providers.js';

export const swiftQueryHooks: QueryLanguageHooks = {
  // Only file-scoped declarations are marked unexported.
  notExportedIsFilePrivate: true,
  // Indexes predating Module membership hubs stored same-module visibility
  // as file-to-file IMPORTS edges.
  nonInitializingImportReasons: ['swift-scope: implicit module visibility'],
};
