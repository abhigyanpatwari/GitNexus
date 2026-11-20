import type { QueryLanguageHooks } from '../query-providers.js';

export const DART_PACKAGE_IDENTITY_REASON = 'dart-scope: package identity dependency';

export const dartQueryHooks: QueryLanguageHooks = {
  nonInitializingImportReasons: [DART_PACKAGE_IDENTITY_REASON],
};
