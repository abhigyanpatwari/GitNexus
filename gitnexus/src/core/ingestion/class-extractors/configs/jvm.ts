// gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';
import { synthesizeJavaAnonymousClassName } from '../../utils/ast-helpers.js';

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
  ],
  fileScopeNodeTypes: ['package_declaration'],
  ancestorScopeNodeTypes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  extractName(node) {
    if (node.type === 'object_creation_expression') {
      return synthesizeJavaAnonymousClassName(node);
    }
    return undefined;
  },
  // An anonymous body whose name CANNOT be synthesized (no supported host
  // type declaration) must not become a Class node at all. Without this
  // skip, `extract()`'s `extractTypeNameFromNode` fallback names the node
  // after the CONSTRUCTED type — emitting a phantom `Class:...:Runnable`
  // for `new Runnable() { ... }` (empirically caught in review).
  shouldSkipClassCapture({ definitionNode }) {
    return (
      definitionNode !== null &&
      definitionNode !== undefined &&
      definitionNode.type === 'object_creation_expression' &&
      synthesizeJavaAnonymousClassName(definitionNode) === undefined
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
