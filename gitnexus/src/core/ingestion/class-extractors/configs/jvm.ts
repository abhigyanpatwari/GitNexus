// gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import { synthesizeJavaTypeIdentity } from '../../utils/ast-helpers.js';

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
    // Anonymous class bodies (`new Runnable() { ... }`) — the matching
    // JAVA_QUERIES pattern only captures `object_creation_expression`
    // WITH a `class_body`, and `extractName` below returns undefined for
    // any other shape, so plain `new Foo()` constructor calls never
    // produce a Class node (#2550).
    'object_creation_expression',
    // Enum constant bodies (`enum E { A { ... } }`) — javac's other
    // anonymous shape, named E$N by the same authority (#2555).
    'enum_constant',
  ],
  fileScopeNodeTypes: ['package_declaration'],
  ancestorScopeNodeTypes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  extractName(node) {
    return synthesizeJavaTypeIdentity(node)?.name;
  },
  extractType(node) {
    return synthesizeJavaTypeIdentity(node)?.label;
  },
  // An anonymous body whose name CANNOT be synthesized must not become a
  // Class node at all. Without this skip, `extract()`'s
  // `extractTypeNameFromNode` fallback fabricates a name — the CONSTRUCTED
  // type for `new Runnable() { ... }` (phantom `Class:...:Runnable`,
  // empirically caught in review) or the constant's own identifier for an
  // `enum_constant` (`Class:...:A`).
  shouldSkipClassCapture({ definitionNode }) {
    return (
      definitionNode !== null &&
      definitionNode !== undefined &&
      (definitionNode.type === 'object_creation_expression' ||
        definitionNode.type === 'enum_constant') &&
      synthesizeJavaTypeIdentity(definitionNode) === undefined
    );
  },
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
