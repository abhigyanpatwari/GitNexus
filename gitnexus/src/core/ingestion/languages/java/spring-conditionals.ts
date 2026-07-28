import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringConditionalMetadataAttacher,
  hasSpringConditionalRelevantAnnotation,
  type SpringConditionalOwnerFact,
} from '../../frameworks/spring/conditionals.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getJavaSpringConditionalFacts } from './capture-side-channel.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { javaSpringAnnotationFacts, type JavaAnnotationSyntaxFact } from './spring-di.js';

export type JavaSpringConditionalAnnotationFact = JavaAnnotationSyntaxFact;

export type JavaSpringConditionalFact =
  SpringConditionalOwnerFact<JavaSpringConditionalAnnotationFact>;

function scopeId(filePath: string, node: SyntaxNode, kind: 'Class' | 'Function') {
  return makeScopeId({
    filePath,
    range: nodeToCapture('@spring-condition.owner', node).range,
    kind,
  });
}

/**
 * Capture Spring condition syntax while Java's existing class traversal already
 * has the AST node in hand. Framework/FQN semantics are resolved later.
 */
export function captureJavaSpringConditionalFacts(
  classNode: SyntaxNode,
  filePath: string,
): JavaSpringConditionalFact[] {
  const facts: JavaSpringConditionalFact[] = [];
  const classAnnotations = javaSpringAnnotationFacts(classNode);
  if (hasSpringConditionalRelevantAnnotation(classAnnotations)) {
    facts.push({
      ownerScopeId: scopeId(filePath, classNode, 'Class'),
      ownerKind: 'class',
      annotations: classAnnotations,
    });
  }

  const body = classNode.childForFieldName('body');
  if (body === null) return facts;
  for (const member of body.namedChildren) {
    if (member.type !== 'method_declaration') continue;
    const annotations = javaSpringAnnotationFacts(member);
    if (!hasSpringConditionalRelevantAnnotation(annotations)) continue;
    facts.push({
      ownerScopeId: scopeId(filePath, member, 'Function'),
      ownerKind: 'callable',
      annotations,
    });
  }
  return facts;
}

export const attachJavaSpringConditionalMetadata = createSpringConditionalMetadataAttacher({
  getFacts: getJavaSpringConditionalFacts,
  isPackageVisibilityIncomplete: isJavaPackageSiblingVisibilityIncomplete,
});
