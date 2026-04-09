/**
 * Go Language Provider
 *
 * Assembles all Go-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Go traits:
 *   - importSemantics: 'wildcard' (Go imports entire packages)
 *   - callRouter: present (Go method calls may need routing)
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as goConfig } from '../type-extractors/go.js';
import { goExportChecker } from '../export-detection.js';
import { resolveGoImport } from '../import-resolvers/go.js';
import { GO_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { goConfig as goFieldConfig } from '../field-extractors/configs/go.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { goMethodConfig } from '../method-extractors/configs/go.js';

export const goProvider = defineLanguage({
  id: SupportedLanguages.Go,
  extensions: ['.go'],
  treeSitterQueries: GO_QUERIES,
  typeConfig: goConfig,
  exportChecker: goExportChecker,
  importResolver: resolveGoImport,
  importSemantics: 'wildcard',
  fieldExtractor: createFieldExtractor(goFieldConfig),
  methodExtractor: createMethodExtractor(goMethodConfig),
  classExtractor: createClassExtractor({
    language: SupportedLanguages.Go,
    typeDeclarationNodes: ['type_declaration'],
    fileScopeNodeTypes: ['package_clause'],
    extractName(node) {
      const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
      return typeSpec?.childForFieldName('name')?.text;
    },
    extractType(node) {
      const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
      const typeNode = typeSpec?.childForFieldName('type');
      if (typeNode?.type === 'struct_type') return 'Struct';
      if (typeNode?.type === 'interface_type') return 'Interface';
      return undefined;
    },
  }),
});
