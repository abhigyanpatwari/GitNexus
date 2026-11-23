import type { QueryLanguageHooks } from '../query-providers.js';

export const isPythonSourceFile = (filePath: string): boolean => /\.py$/i.test(filePath);

export const pythonQueryHooks: QueryLanguageHooks = {
  callCompatibility: {
    acceptsTarget: ({ filePath, type }) =>
      isPythonSourceFile(filePath) && (type === 'Class' || type === 'Function'),
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
    supportsFile: isPythonSourceFile,
    implicitImportSyntax: { marker: '*', pattern: 'import[^a-zA-Z0-9_]*[*]' },
    createClassifier: async (target) =>
      (await import('./type-imports.js')).createPythonTypeImportClassifier(target),
  },
};
