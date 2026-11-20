import type { QueryLanguageHooks } from '../query-providers.js';

export const tsJsHooks: QueryLanguageHooks = {
  async notExportedIsFilePrivate(filePath, content) {
    const { hasFilePrivateExportSemantics } = await import('./file-private-exports.js');
    return hasFilePrivateExportSemantics(filePath, content);
  },
};
