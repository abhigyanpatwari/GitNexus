import type { QueryLanguageHooks } from '../query-providers.js';

export const pythonQueryHooks: QueryLanguageHooks = {
  callCompatibility: {
    acceptsTarget: ({ filePath, type }) =>
      filePath.endsWith('.py') && (type === 'Class' || type === 'Function'),
    relationTypes: ['CALLS', 'EXTENDS'],
    async check(...args) {
      const [{ pythonProvider }, { findBrokenKeywordCalls }] = await Promise.all([
        import('../python.js'),
        import('./signature-changes.js'),
      ]);
      return findBrokenKeywordCalls(pythonProvider, ...args);
    },
  },
  typeImportAttribution: {
    supportsFile: (filePath) => filePath.toLowerCase().endsWith('.py'),
    implicitImportSyntax: { marker: '*', pattern: 'import[^a-zA-Z0-9_]*[*]' },
    createClassifier: async (target) =>
      (await import('./type-imports.js')).createPythonTypeImportClassifier(target),
  },
};
