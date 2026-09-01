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

/**
 * Capture callable syntax while the Java class AST is already in hand.
 *
 * Annotation arguments are read in a second pass, only for callables that
 * already carry a handler annotation, so the destination-bearing arguments
 * (`topics`, `queues`, `destination`, `cron`) reach the fact without adding
 * structured argument text to every annotation in the repository. Java can
 * decide that on the simple name alone; Kotlin runs the same two passes but
 * widens the first one with the file's import aliases, because a Kotlin handler
 * annotation may be written under a name no list can contain.
 */
export function captureJavaSpringNonHttpHandlerFacts(
  classNode: SyntaxNode,
  filePath: string,
): JavaSpringNonHttpHandlerFact[] {
  const facts: JavaSpringNonHttpHandlerFact[] = [];
  const body = classNode.childForFieldName('body');
  if (body === null) return facts;
  for (const member of body.namedChildren) {
    if (member.type !== 'method_declaration') continue;
    if (!hasSpringNonHttpHandlerRelevantAnnotation(javaSpringAnnotationFacts(member))) continue;
    const annotations = javaSpringAnnotationFacts(member, { includeArguments: true });
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
