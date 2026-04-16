// gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

export const javaClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Java,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  fileScopeNodeTypes: ['package_declaration'],
  ancestorScopeNodeTypes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

export const kotlinClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  typeDeclarationNodes: ['class_declaration', 'object_declaration', 'companion_object'],
  fileScopeNodeTypes: ['package_header'],
  ancestorScopeNodeTypes: ['class_declaration', 'object_declaration', 'companion_object'],
  extractType(node) {
    if (node.type !== 'class_declaration') return undefined;
    return node.children.some((child) => child?.text === 'interface') ? 'Interface' : 'Class';
  },
};
