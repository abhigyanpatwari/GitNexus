import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringNonHttpHandlerMetadataAttacher,
  hasSpringNonHttpHandlerRelevantAnnotation,
  type SpringNonHttpHandlerFact,
} from '../../frameworks/spring/non-http-handlers.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getJavaSpringNonHttpHandlerFacts } from './capture-side-channel.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { javaSpringAnnotationFacts, type JavaAnnotationSyntaxFact } from './spring-di.js';

export type JavaSpringNonHttpHandlerFact = SpringNonHttpHandlerFact<JavaAnnotationSyntaxFact>;

/** Capture callable syntax while the Java class AST is already in hand. */
export function captureJavaSpringNonHttpHandlerFacts(
  classNode: SyntaxNode,
  filePath: string,
): JavaSpringNonHttpHandlerFact[] {
  const facts: JavaSpringNonHttpHandlerFact[] = [];
  const body = classNode.childForFieldName('body');
  if (body === null) return facts;
  for (const member of body.namedChildren) {
    if (member.type !== 'method_declaration') continue;
    const annotations = javaSpringAnnotationFacts(member);
    if (!hasSpringNonHttpHandlerRelevantAnnotation(annotations)) continue;
    const ownerRange = nodeToCapture('@spring-non-http-handler.owner', member).range;
    facts.push({
      ownerScopeId: makeScopeId({ filePath, range: ownerRange, kind: 'Function' }),
      ownerFilePath: filePath,
      ownerRange,
      annotations,
    });
  }
  return facts;
}

export const attachJavaSpringNonHttpHandlerMetadata = createSpringNonHttpHandlerMetadataAttacher({
  getFacts: getJavaSpringNonHttpHandlerFacts,
  isPackageVisibilityIncomplete: isJavaPackageSiblingVisibilityIncomplete,
});
